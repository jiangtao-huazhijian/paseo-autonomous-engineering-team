import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { LabGoalService } from "./service.js";

describe("LabGoalService", () => {
  let home: string;
  let service: LabGoalService;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "paseo-lab-goal-"));
    service = new LabGoalService({
      paseoHome: home,
      now: () => new Date("2026-08-16T00:00:00.000Z"),
    });
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  async function createGoal() {
    return service.create({
      title: "Add a health endpoint",
      repositoryPath: "/tmp/project",
      mode: "deliver",
      objective: "Expose GET /health",
      acceptanceCriteria: ["npm test passes"],
      allowedActions: ["write source files"],
      forbiddenActions: ["merge or deploy"],
      roleProviders: [
        { role: "builder", provider: "codex" },
        { role: "reviewer", provider: "claude" },
        { role: "verifier", provider: "cursor", enabled: false },
      ],
      budget: { maxRounds: 2, maxAgents: 2, maxDurationMinutes: 60, maxRepairRounds: 1 },
    });
  }

  test("persists a goal and records its explicit state transitions", async () => {
    const created = await createGoal();
    const queued = await service.action(created.id, "queue");
    const planning = await service.action(queued.id, "start");
    const paused = await service.action(planning.id, "pause");
    const resumed = await service.action(paused.id, "resume");

    expect(resumed.state).toBe("planning");
    expect(resumed.transitions.map((transition) => [transition.from, transition.to])).toEqual([
      ["draft", "queued"],
      ["queued", "planning"],
      ["planning", "paused"],
      ["paused", "planning"],
    ]);
    await expect(new LabGoalService({ paseoHome: home }).inspect(created.id)).resolves.toEqual(
      resumed,
    );
  });

  test("requires independent builder and reviewer providers", async () => {
    await expect(
      service.create({
        title: "invalid",
        repositoryPath: "/tmp/project",
        mode: "deliver",
        objective: "invalid",
        acceptanceCriteria: ["test"],
        allowedActions: [],
        forbiddenActions: [],
        roleProviders: [
          { role: "builder", provider: "codex" },
          { role: "reviewer", provider: "codex" },
        ],
        budget: { maxRounds: 1, maxAgents: 2, maxDurationMinutes: 1, maxRepairRounds: 0 },
      }),
    ).rejects.toThrow("different providers");
  });

  test("does not complete until the evaluator records a passed acceptance gate", async () => {
    const goal = await createGoal();
    const queued = await service.action(goal.id, "queue");
    const planning = await service.action(queued.id, "start");
    const implementing = await service.advance(planning.id, "implementing", "plan accepted");
    const reviewing = await service.advance(implementing.id, "reviewing", "builder finished");
    const verifying = await service.advance(reviewing.id, "verifying", "review passed");
    const completed = await service.recordGate(verifying.id, {
      id: "gate-1",
      gate: "acceptance",
      verdict: "passed",
      summary: "all criteria passed",
      evidence: ["npm test"],
      issueFingerprint: null,
      createdAt: "2026-08-16T00:01:00.000Z",
    });

    expect(completed.state).toBe("completed");
    expect(completed.gateRecords).toHaveLength(1);
    expect(completed.finalReport).toContain("# Autonomous Lab delivery: Add a health endpoint");
    expect(completed.finalReport).toContain("acceptance: **passed**");
  });

  test("restarts queued, planning, and implementing goals after a daemon restart", async () => {
    const goal = await createGoal();
    await service.action(goal.id, "queue");
    const restarted: string[] = [];
    service.setOrchestrator({
      start: async (goalId) => {
        restarted.push(goalId);
      },
    });

    await service.recover();

    expect(restarted).toEqual([goal.id]);
  });

  test("only an explicit audited user action can waive an open Issue", async () => {
    const goal = await createGoal();
    await service.upsertIssue(goal.id, {
      id: "issue-1",
      fingerprint: "fingerprint-1",
      finder: "reviewer",
      ownerAssignmentId: null,
      severity: "high",
      summary: "Accepted product risk",
      reproduction: "Review evidence",
      evidenceIds: [],
      reacceptance: [],
      status: "open",
      createdAt: "2026-08-16T00:00:00.000Z",
      updatedAt: "2026-08-16T00:00:00.000Z",
      waivedAt: null,
      waivedReason: null,
    });

    const waived = await service.action(
      goal.id,
      "waive-issue",
      "Accepted by release owner",
      "issue-1",
    );

    expect(waived.issues[0]).toMatchObject({
      status: "waived",
      waivedReason: "Accepted by release owner",
    });
    expect(waived.auditEvents).toEqual([
      expect.objectContaining({
        action: "waive-issue",
        detail: "issue-1: Accepted by release owner",
      }),
    ]);
  });
});
