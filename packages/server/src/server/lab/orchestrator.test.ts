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
          receivedPrompt = String(prompt);
          return {
            canceled: false,
            finalText: "Implemented health endpoint",
            timeline: [],
            sessionId: "s",
          };
        },
        cancelAgentRun: async () => ({ status: "settled" }),
      } as Pick<AgentManager, "runAgent" | "cancelAgentRun">,
    });

    await orchestrator.start(queued.id);

    const updated = await service.inspect(goal.id);
    expect(updated).toMatchObject({ state: "reviewing", workspaceId: "wks_lab" });
    expect(updated?.assignments).toMatchObject([
      {
        role: "builder",
        agentId: "agent_builder",
        workspaceId: "wks_lab",
        state: "succeeded",
      },
    ]);
    expect(receivedPrompt).toContain("GET /health");
    expect(receivedPrompt).toContain("evaluator/**");
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
        runAgent: async () => {
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
      expect((await service.inspect(goal.id))?.state).toBe("reviewing");
    });
  });
});
