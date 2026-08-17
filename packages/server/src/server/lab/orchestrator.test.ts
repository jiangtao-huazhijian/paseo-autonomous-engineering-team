import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { BoundCreateAgentCommand } from "../agent/create-agent/create.js";
import type { AgentManager } from "../agent/agent-manager.js";
import type { CreatePaseoWorktreeWorkflowResult } from "../worktree-session.js";
import { LabGoalOrchestrator } from "./orchestrator.js";
import { LabGoalService } from "./service.js";

describe("LabGoalOrchestrator", () => {
  let home: string;
  let service: LabGoalService;
  const stableWorkspaceSnapshot = async () => ({
    fingerprint: "unchanged-worktree",
    summary: "HEAD test\n",
  });

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "paseo-lab-orchestrator-"));
    service = new LabGoalService({
      paseoHome: home,
      now: () => new Date("2026-08-16T00:00:00.000Z"),
    });
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  test("creates one isolated worktree and one builder before entering review", async () => {
    const goal = await service.create({
      title: "Health endpoint",
      repositoryPath: "/repo",
      mode: "deliver",
      objective: "Add GET /health",
      acceptanceCriteria: ["npm test"],
      allowedActions: ["src/**"],
      forbiddenActions: ["evaluator/**"],
      roleProviders: [
        { role: "builder", provider: "codex" },
        { role: "reviewer", provider: "claude" },
      ],
      budget: { maxRounds: 3, maxAgents: 2, maxDurationMinutes: 60, maxRepairRounds: 2 },
    });
    const queued = await service.action(goal.id, "queue");
    let receivedPrompt = "";
    const orchestrator = new LabGoalOrchestrator({
      service,
      logger: pino({ level: "silent" }),
      now: () => new Date("2026-08-16T00:00:00.000Z"),
      captureWorkspaceSnapshot: stableWorkspaceSnapshot,
      createWorktree: async () =>
        ({
          workspace: { workspaceId: "wks_lab", cwd: "/worktree" },
        }) as CreatePaseoWorktreeWorkflowResult,
      createAgent: (async () =>
        ({
          snapshot: { id: "agent_builder" },
          initialPromptError: null,
        }) as never) as BoundCreateAgentCommand,
      evaluateCommand: async ({ command, now }) => ({
        passed: true,
        evidence: {
          id: "evidence_pass",
          kind: "command",
          candidateHash: "candidate",
          command,
          exitCode: 0,
          stdout: "ok",
          stderr: "",
          environmentFingerprint: "environment",
          artifactHash: "artifact",
          createdAt: now().toISOString(),
        },
      }),
      agentManager: {
        runAgent: async (_agentId, prompt) => {
          receivedPrompt = String(prompt);
          return {
            canceled: false,
            finalText: String(prompt).includes("independent Reviewer")
              ? '{"issues":[]}'
              : "Implemented health endpoint",
            timeline: [],
            sessionId: "s",
          };
        },
        cancelAgentRun: async () => ({ status: "settled" }),
      } as Pick<AgentManager, "runAgent" | "cancelAgentRun">,
    });

    await orchestrator.start(queued.id);

    const updated = await service.inspect(goal.id);
    expect(updated).toMatchObject({ state: "completed", workspaceId: "wks_lab" });
    expect(updated?.assignments.find((assignment) => assignment.role === "builder")).toMatchObject({
      agentId: "agent_builder",
      workspaceId: "wks_lab",
      state: "succeeded",
    });
    expect(updated?.assignments.find((assignment) => assignment.role === "reviewer")).toMatchObject(
      {
        provider: "claude",
        state: "succeeded",
      },
    );
    expect(receivedPrompt).toContain("GET /health");
    expect(receivedPrompt).toContain("evaluator/**");
  });

  test("preserves evidence and escalates when a Reviewer changes the shared worktree", async () => {
    const goal = await service.create({
      title: "Reviewer must not edit",
      repositoryPath: "/repo",
      mode: "deliver",
      objective: "Inspect a Builder change without modifying it",
      acceptanceCriteria: ["npm test"],
      allowedActions: ["src/**"],
      forbiddenActions: [],
      roleProviders: [
        { role: "builder", provider: "codex" },
        { role: "reviewer", provider: "claude" },
      ],
      budget: { maxRounds: 1, maxAgents: 2, maxDurationMinutes: 60, maxRepairRounds: 0 },
    });
    const queued = await service.action(goal.id, "queue");
    let snapshotCalls = 0;
    const orchestrator = new LabGoalOrchestrator({
      service,
      logger: pino({ level: "silent" }),
      now: () => new Date("2026-08-16T00:00:00.000Z"),
      captureWorkspaceSnapshot: async () => {
        snapshotCalls += 1;
        return snapshotCalls === 1
          ? { fingerprint: "before", summary: "HEAD builder\n M src/app.ts" }
          : { fingerprint: "after", summary: "HEAD builder\n M src/app.ts\n M test/app.test.ts" };
      },
      createWorktree: async () =>
        ({
          workspace: { workspaceId: "wks_lab", cwd: "/worktree" },
        }) as CreatePaseoWorktreeWorkflowResult,
      createAgent: (async () =>
        ({
          snapshot: { id: "agent" },
          initialPromptError: null,
        }) as never) as BoundCreateAgentCommand,
      evaluateCommand: async () => {
        throw new Error("evaluator must not run after a Reviewer write");
      },
      agentManager: {
        runAgent: async (_agentId, prompt) => ({
          canceled: false,
          finalText: String(prompt).includes("independent Reviewer")
            ? '{"issues":[]}'
            : "Builder finished",
          timeline: [],
          sessionId: "s",
        }),
        cancelAgentRun: async () => ({ status: "settled" }),
      } as Pick<AgentManager, "runAgent" | "cancelAgentRun">,
    });

    await orchestrator.start(queued.id);

    const updated = await service.inspect(goal.id);
    expect(updated).toMatchObject({ state: "needs_human" });
    expect(updated?.assignments.find((assignment) => assignment.role === "reviewer")).toMatchObject({
      state: "failed",
      error: expect.stringContaining("changed the shared Goal worktree"),
    });
    expect(updated?.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "policy",
          command: "reviewer read-only worktree snapshot",
          exitCode: 1,
          stdout: expect.stringContaining("After reviewer"),
        }),
      ]),
    );
  });

  test("replays a resume after a running Builder has been cancelled", async () => {
    const goal = await service.create({
      title: "Resumable Builder",
      repositoryPath: "/repo",
      mode: "deliver",
      objective: "Make the change",
      acceptanceCriteria: ["npm test"],
      allowedActions: ["src/**"],
      forbiddenActions: [],
      roleProviders: [
        { role: "builder", provider: "codex" },
        { role: "reviewer", provider: "claude" },
      ],
      budget: { maxRounds: 3, maxAgents: 2, maxDurationMinutes: 60, maxRepairRounds: 2 },
    });
    await service.action(goal.id, "queue");

    let runCount = 0;
    let settleFirst: ((value: never) => void) | undefined;
    let settleSecond: ((value: never) => void) | undefined;
    const orchestrator = new LabGoalOrchestrator({
      service,
      logger: pino({ level: "silent" }),
      now: () => new Date("2026-08-16T00:00:00.000Z"),
      captureWorkspaceSnapshot: stableWorkspaceSnapshot,
      createWorktree: async () =>
        ({
          workspace: { workspaceId: "wks_lab", cwd: "/worktree" },
        }) as CreatePaseoWorktreeWorkflowResult,
      createAgent: (async () =>
        ({
          snapshot: { id: "agent_builder" },
          initialPromptError: null,
        }) as never) as BoundCreateAgentCommand,
      evaluateCommand: async ({ command, now }) => ({
        passed: true,
        evidence: {
          id: "evidence_pass",
          kind: "command",
          candidateHash: "candidate",
          command,
          exitCode: 0,
          stdout: "ok",
          stderr: "",
          environmentFingerprint: "environment",
          artifactHash: "artifact",
          createdAt: now().toISOString(),
        },
      }),
      agentManager: {
        runAgent: async (_agentId, prompt) => {
          if (String(prompt).includes("independent Reviewer")) {
            return {
              canceled: false,
              finalText: '{"issues":[]}',
              timeline: [],
              sessionId: "review",
            };
          }
          runCount += 1;
          return new Promise((resolve) => {
            if (runCount === 1) settleFirst = resolve as (value: never) => void;
            else settleSecond = resolve as (value: never) => void;
          }) as never;
        },
        cancelAgentRun: async () => ({ status: "settled" }),
      } as Pick<AgentManager, "runAgent" | "cancelAgentRun">,
    });

    const firstRun = orchestrator.start(goal.id);
    await vi.waitFor(async () => {
      expect((await service.inspect(goal.id))?.assignments[0]?.state).toBe("running");
    });
    await service.action(goal.id, "pause");
    await orchestrator.control(goal.id, "pause");
    await service.action(goal.id, "resume");
    await orchestrator.control(goal.id, "resume");
    settleFirst?.({ canceled: true, finalText: "", timeline: [], sessionId: "first" } as never);
    await firstRun;
    await vi.waitFor(() => expect(runCount).toBe(2));
    settleSecond?.({
      canceled: false,
      finalText: "Implemented after resume",
      timeline: [],
      sessionId: "second",
    } as never);
    await vi.waitFor(async () => {
      expect((await service.inspect(goal.id))?.state).toBe("completed");
    });
  });

  test("routes failed frozen evidence back to the same Builder and re-tests after repair", async () => {
    const goal = await service.create({
      title: "Repair evaluator failure",
      repositoryPath: "/repo",
      mode: "deliver",
      objective: "Fix the deliberately failing check",
      acceptanceCriteria: ["npm test"],
      allowedActions: ["src/**"],
      forbiddenActions: ["evaluator/**"],
      roleProviders: [
        { role: "builder", provider: "codex" },
        { role: "reviewer", provider: "claude" },
        { role: "verifier", provider: "copilot" },
      ],
      budget: { maxRounds: 3, maxAgents: 3, maxDurationMinutes: 60, maxRepairRounds: 2 },
    });
    const queued = await service.action(goal.id, "queue");
    let builderRuns = 0;
    let evaluatorRuns = 0;
    const orchestrator = new LabGoalOrchestrator({
      service,
      logger: pino({ level: "silent" }),
      now: () => new Date("2026-08-16T00:00:00.000Z"),
      captureWorkspaceSnapshot: stableWorkspaceSnapshot,
      createWorktree: async () =>
        ({
          workspace: { workspaceId: "wks_lab", cwd: "/worktree" },
        }) as CreatePaseoWorktreeWorkflowResult,
      createAgent: (async () =>
        ({
          snapshot: { id: "agent_builder" },
          initialPromptError: null,
        }) as never) as BoundCreateAgentCommand,
      agentManager: {
        runAgent: async (_agentId, prompt) => {
          if (String(prompt).includes("independent Reviewer")) {
            return {
              canceled: false,
              finalText: '{"issues":[]}',
              timeline: [],
              sessionId: "review",
            };
          }
          if (String(prompt).includes("read-only Verifier")) {
            return {
              canceled: false,
              finalText:
                '{"issues":[{"severity":"high","summary":"Reproduced failure","reproduction":"npm test","files":["src/test.ts"]}]}',
              timeline: [],
              sessionId: "verify",
            };
          }
          builderRuns += 1;
          return {
            canceled: false,
            finalText: `Builder pass ${builderRuns}`,
            timeline: [],
            sessionId: "s",
          };
        },
        cancelAgentRun: async () => ({ status: "settled" }),
      } as Pick<AgentManager, "runAgent" | "cancelAgentRun">,
      evaluateCommand: async ({ command, now }) => {
        evaluatorRuns += 1;
        const passed = evaluatorRuns > 1;
        return {
          passed,
          evidence: {
            id: `evidence_${evaluatorRuns}`,
            kind: "command",
            candidateHash: `candidate_${evaluatorRuns}`,
            command,
            exitCode: passed ? 0 : 1,
            stdout: "",
            stderr: passed ? "" : "intentional failure",
            environmentFingerprint: "environment",
            artifactHash: `artifact_${evaluatorRuns}`,
            createdAt: now().toISOString(),
          },
        };
      },
    });

    await orchestrator.start(queued.id);
    await vi.waitFor(async () => expect((await service.inspect(goal.id))?.state).toBe("completed"));

    const completed = await service.inspect(goal.id);
    expect(builderRuns).toBe(2);
    expect(evaluatorRuns).toBe(2);
    expect(completed?.repairRound).toBe(1);
    expect(completed?.issues.find((issue) => issue.finder === "evaluator")).toMatchObject({
      ownerAssignmentId: completed?.assignments[0]?.id,
      severity: "high",
      status: "resolved",
    });
    expect(completed?.issues.find((issue) => issue.finder === "verifier")).toMatchObject({
      severity: "high",
      status: "resolved",
    });
    expect(
      completed?.assignments.find((assignment) => assignment.role === "verifier"),
    ).toMatchObject({
      provider: "copilot",
      state: "succeeded",
    });
    expect(completed?.evidence).toHaveLength(7);
  });

  test("hard-stops before creating an Agent when the wall-time budget is exhausted", async () => {
    const goal = await service.create({
      title: "Expired Goal",
      repositoryPath: "/repo",
      mode: "deliver",
      objective: "Never run",
      acceptanceCriteria: ["npm test"],
      allowedActions: ["src/**"],
      forbiddenActions: [],
      roleProviders: [
        { role: "builder", provider: "codex" },
        { role: "reviewer", provider: "claude" },
      ],
      budget: { maxRounds: 1, maxAgents: 2, maxDurationMinutes: 1, maxRepairRounds: 0 },
    });
    const queued = await service.action(goal.id, "queue");
    let createCalls = 0;
    const orchestrator = new LabGoalOrchestrator({
      service,
      logger: pino({ level: "silent" }),
      now: () => new Date("2026-08-16T00:02:00.000Z"),
      createWorktree: async () => {
        throw new Error("must not create worktree");
      },
      createAgent: (async () => {
        createCalls += 1;
        return {} as never;
      }) as BoundCreateAgentCommand,
      agentManager: {
        runAgent: async () => ({ canceled: false, finalText: "", timeline: [], sessionId: "s" }),
        cancelAgentRun: async () => ({ status: "settled" }),
      } as Pick<AgentManager, "runAgent" | "cancelAgentRun">,
    });

    await orchestrator.start(queued.id);

    expect((await service.inspect(goal.id))?.state).toBe("budget_exhausted");
    expect(createCalls).toBe(0);
  });

  test("recovers a persisted reviewing Goal using its registered workspace", async () => {
    const goal = await service.create({
      title: "Recover review",
      repositoryPath: "/repo",
      mode: "deliver",
      objective: "Resume only the review phase",
      acceptanceCriteria: ["npm test"],
      allowedActions: ["src/**"],
      forbiddenActions: [],
      roleProviders: [
        { role: "builder", provider: "codex" },
        { role: "reviewer", provider: "claude" },
      ],
      budget: { maxRounds: 2, maxAgents: 2, maxDurationMinutes: 60, maxRepairRounds: 1 },
    });
    const planning = await service
      .action(goal.id, "queue")
      .then((queued) => service.action(queued.id, "start"));
    const implementing = await service.advance(planning.id, "implementing", "simulated restart");
    await service.bindWorkspace(implementing.id, "wks_saved");
    await service.addAssignment(goal.id, {
      id: "assignment_builder",
      role: "builder",
      provider: "codex",
      model: null,
      agentId: "agent_builder",
      workspaceId: "wks_saved",
      state: "succeeded",
      startedAt: null,
      endedAt: null,
      lastProgress: null,
      error: null,
    });
    await service.advance(goal.id, "reviewing", "restart during review");
    let resolvedWorkspace = "";
    const orchestrator = new LabGoalOrchestrator({
      service,
      logger: pino({ level: "silent" }),
      now: () => new Date("2026-08-16T00:00:00.000Z"),
      captureWorkspaceSnapshot: stableWorkspaceSnapshot,
      resolveWorkspaceCwd: async (id) => {
        resolvedWorkspace = id;
        return "/restored-worktree";
      },
      createWorktree: async () => {
        throw new Error("must not create a second worktree");
      },
      createAgent: (async () =>
        ({
          snapshot: { id: "agent_reviewer" },
          initialPromptError: null,
        }) as never) as BoundCreateAgentCommand,
      agentManager: {
        runAgent: async (_agentId, prompt) => ({
          canceled: false,
          finalText: String(prompt).includes("independent Reviewer") ? '{"issues":[]}' : "",
          timeline: [],
          sessionId: "s",
        }),
        cancelAgentRun: async () => ({ status: "settled" }),
      } as Pick<AgentManager, "runAgent" | "cancelAgentRun">,
      evaluateCommand: async ({ command, now }) => ({
        passed: true,
        evidence: {
          id: "evidence_recovered",
          kind: "command",
          candidateHash: "candidate",
          command,
          exitCode: 0,
          stdout: "ok",
          stderr: "",
          environmentFingerprint: "environment",
          artifactHash: "artifact",
          createdAt: now().toISOString(),
        },
      }),
    });

    await orchestrator.start(goal.id);

    expect(resolvedWorkspace).toBe("wks_saved");
    expect((await service.inspect(goal.id))?.state).toBe("completed");
  });

  test("escalates unavailable Provider failures instead of falsely marking the Goal failed", async () => {
    const goal = await service.create({
      title: "Provider attention",
      repositoryPath: "/repo",
      mode: "deliver",
      objective: "Wait for credentials",
      acceptanceCriteria: ["npm test"],
      allowedActions: ["src/**"],
      forbiddenActions: [],
      roleProviders: [
        { role: "builder", provider: "codex" },
        { role: "reviewer", provider: "claude" },
      ],
      budget: { maxRounds: 1, maxAgents: 2, maxDurationMinutes: 60, maxRepairRounds: 0 },
    });
    const queued = await service.action(goal.id, "queue");
    const orchestrator = new LabGoalOrchestrator({
      service,
      logger: pino({ level: "silent" }),
      now: () => new Date("2026-08-16T00:00:00.000Z"),
      createWorktree: async () =>
        ({
          workspace: { workspaceId: "wks_lab", cwd: "/worktree" },
        }) as CreatePaseoWorktreeWorkflowResult,
      createAgent: (async () => {
        throw new Error("Provider codex unavailable: authentication required");
      }) as BoundCreateAgentCommand,
      agentManager: {
        runAgent: async () => ({ canceled: false, finalText: "", timeline: [], sessionId: "s" }),
        cancelAgentRun: async () => ({ status: "settled" }),
      } as Pick<AgentManager, "runAgent" | "cancelAgentRun">,
    });

    await orchestrator.start(queued.id);

    expect(await service.inspect(goal.id)).toMatchObject({ state: "needs_human" });
  });
});
