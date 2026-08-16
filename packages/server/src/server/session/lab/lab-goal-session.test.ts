import { describe, expect, test } from "vitest";
import pino from "pino";
import { LabGoalSession } from "./lab-goal-session.js";
import { createStub } from "../../test-utils/class-mocks.js";
import { findByType } from "../../test-utils/session-stubs.js";
import type { SessionOutboundMessage } from "../../messages.js";
import type { LabGoalService } from "../../lab/service.js";

describe("LabGoalSession", () => {
  test("returns a persisted goal from the create RPC", async () => {
    const emitted: SessionOutboundMessage[] = [];
    const goal = {
      id: "goal_1",
      title: "Health endpoint",
      repositoryPath: "/tmp/project",
      mode: "deliver" as const,
      objective: "Add a health endpoint",
      acceptanceCriteria: ["test"],
      allowedActions: [],
      forbiddenActions: ["deploy"],
      roleProviders: [
        { role: "builder" as const, provider: "codex" as const, enabled: true },
        { role: "reviewer" as const, provider: "claude" as const, enabled: true },
      ],
      budget: {
        maxRounds: 2,
        maxAgents: 2,
        maxDurationMinutes: 30,
        maxRepairRounds: 1,
        estimatedCostUsd: null,
      },
      state: "draft" as const,
      stateBeforePause: null,
      repairRound: 0,
      createdAt: "2026-08-16T00:00:00.000Z",
      updatedAt: "2026-08-16T00:00:00.000Z",
      transitions: [],
      gateRecords: [],
    };
    const session = new LabGoalSession({
      host: { emit: (message) => emitted.push(message) },
      service: createStub<LabGoalService>({ create: async () => goal }),
      logger: pino({ level: "silent" }),
    });

    await session.dispatch({
      type: "lab.goal.create.request",
      requestId: "request-1",
      title: goal.title,
      repositoryPath: goal.repositoryPath,
      mode: goal.mode,
      objective: goal.objective,
      acceptanceCriteria: goal.acceptanceCriteria,
      allowedActions: goal.allowedActions,
      forbiddenActions: goal.forbiddenActions,
      roleProviders: goal.roleProviders,
      budget: goal.budget,
    });

    expect(findByType(emitted, "lab.goal.create.response")?.payload).toEqual({
      requestId: "request-1",
      goal,
      error: null,
    });
  });
});
