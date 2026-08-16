import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { StoredLabGoal } from "@getpaseo/protocol/lab/types";
import type { BoundCreateAgentCommand } from "../agent/create-agent/create.js";
import { formatProviderModel } from "../agent/create-agent/create.js";
import type { AgentManager } from "../agent/agent-manager.js";
import type { CreatePaseoWorktreeWorkflowResult } from "../worktree-session.js";
import {
  LabGoalService,
  type LabGoalOrchestrator as LabGoalOrchestratorContract,
} from "./service.js";

type LabAgentManager = Pick<AgentManager, "runAgent" | "cancelAgentRun">;

export interface LabGoalOrchestratorOptions {
  service: LabGoalService;
  logger: Logger;
  createAgent: BoundCreateAgentCommand;
  agentManager: LabAgentManager;
  ensureAgentLoaded?: (agentId: string) => Promise<void>;
  createWorktree: (input: {
    cwd: string;
    worktreeSlug: string;
    branchName: string;
    firstAgentContext: { prompt: string };
    title: string;
  }) => Promise<CreatePaseoWorktreeWorkflowResult>;
  now?: () => Date;
}

function requireBuilder(goal: StoredLabGoal) {
  const builder = goal.roleProviders.find((role) => role.role === "builder" && role.enabled);
  if (!builder) throw new Error(`Goal ${goal.id} has no enabled builder`);
  return builder;
}

function builderPrompt(goal: StoredLabGoal): string {
  return [
    "You are the Builder in a controlled Autonomous Lab Goal.",
    "You are the only role allowed to modify product code.",
    `Goal: ${goal.title}`,
    `Objective:\n${goal.objective}`,
    `Allowed changes:\n${goal.allowedActions.map((item) => `- ${item}`).join("\n") || "- none declared"}`,
    `Forbidden changes:\n${goal.forbiddenActions.map((item) => `- ${item}`).join("\n") || "- none declared"}`,
    `Frozen acceptance criteria:\n${goal.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}`,
    "Work only in the current worktree. Do not merge, deploy, change evaluator assets, or weaken tests.",
    "Implement the objective, run relevant local checks, and report what changed plus any blockers.",
  ].join("\n\n");
}

/**
 * Deterministic runtime entry point for the first V1 execution leg. It does
 * not decide success: after Builder work it stops at REVIEWING, where the
 * later reviewer/evaluator gates take ownership.
 */
export class LabGoalOrchestrator implements LabGoalOrchestratorContract {
  private readonly activeGoalIds = new Set<string>();
  /** A resume arriving while cancellation is still settling is replayed once. */
  private readonly resumeRequestedGoalIds = new Set<string>();
  private readonly now: () => Date;

  constructor(private readonly options: LabGoalOrchestratorOptions) {
    this.now = options.now ?? (() => new Date());
  }

  // The method mirrors the persisted state-machine leg exactly; splitting it
  // across helpers would obscure the error/recovery boundary.
  // oxlint-disable-next-line complexity
  async start(goalId: string): Promise<void> {
    if (this.activeGoalIds.has(goalId)) return;
    this.activeGoalIds.add(goalId);
    try {
      let goal = await this.options.service.inspect(goalId);
      if (!goal || goal.state === "cancelled" || goal.state === "paused") return;
      if (goal.state === "queued") {
        goal = await this.options.service.advance(
          goal.id,
          "planning",
          "Creating isolated Goal worktree",
        );
      }
      if (goal.state !== "planning" && goal.state !== "implementing") return;

      let workspaceId = goal.workspaceId;
      let workspaceCwd = goal.repositoryPath;
      if (!workspaceId) {
        const worktree = await this.options.createWorktree({
          cwd: goal.repositoryPath,
          worktreeSlug: `lab-${goal.id}`,
          branchName: `lab/${goal.id}`,
          firstAgentContext: { prompt: goal.objective },
          title: `[Lab] ${goal.title}`,
        });
        workspaceId = worktree.workspace.workspaceId;
        workspaceCwd = worktree.workspace.cwd;
        goal = await this.options.service.bindWorkspace(goal.id, workspaceId);
      }

      const existingBuilder = goal.assignments.find(
        (assignment) => assignment.role === "builder" && assignment.agentId,
      );
      const builder = requireBuilder(goal);
      const assignmentId = existingBuilder?.id ?? `assignment_${randomUUID()}`;
      let agentId = existingBuilder?.agentId ?? null;
      if (!existingBuilder) {
        goal = await this.options.service.addAssignment(goal.id, {
          id: assignmentId,
          role: "builder",
          provider: builder.provider,
          model: builder.model ?? null,
          agentId: null,
          workspaceId,
          state: "planned",
          startedAt: null,
          endedAt: null,
          lastProgress: null,
          error: null,
        });
        const created = await this.options.createAgent({
          kind: "mcp",
          provider: formatProviderModel(builder.provider, builder.model),
          config: {
            provider: builder.provider,
            cwd: workspaceCwd,
            ...(builder.model ? { model: builder.model } : {}),
            ...(builder.modeId ? { modeId: builder.modeId } : {}),
          },
          cwd: workspaceCwd,
          workspaceId,
          title: `[Lab Builder] ${goal.title}`,
          labels: {
            "paseo.lab-goal-id": goal.id,
            "paseo.lab-role": "builder",
          },
          ...(builder.modeId ? { mode: builder.modeId } : {}),
          unattended: true,
          promptFailure: "return-error",
          background: true,
          notifyOnFinish: false,
        });
        if (created.initialPromptError) throw created.initialPromptError;
        agentId = created.snapshot.id;
        goal = await this.options.service.updateAssignment(goal.id, assignmentId, {
          agentId,
          state: "running",
          startedAt: this.now().toISOString(),
        });
      }
      if (!agentId) throw new Error(`Builder assignment ${assignmentId} has no agent`);
      if (existingBuilder) {
        goal = await this.options.service.updateAssignment(goal.id, assignmentId, {
          state: "running",
          startedAt: existingBuilder.startedAt ?? this.now().toISOString(),
          endedAt: null,
          error: null,
          lastProgress: "Builder resumed",
        });
      }
      if (goal.state === "planning") {
        goal = await this.options.service.advance(
          goal.id,
          "implementing",
          "Builder started in Goal worktree",
        );
      }

      await this.options.ensureAgentLoaded?.(agentId);
      const result = await this.options.agentManager.runAgent(agentId, builderPrompt(goal));
      const current = await this.options.service.inspect(goal.id);
      if (!current || current.state === "paused" || current.state === "cancelled") return;
      if (result.canceled) {
        await this.options.service.updateAssignment(goal.id, assignmentId, {
          state: "cancelled",
          endedAt: this.now().toISOString(),
          lastProgress: "Builder run cancelled",
        });
        return;
      }
      await this.options.service.updateAssignment(goal.id, assignmentId, {
        state: "succeeded",
        endedAt: this.now().toISOString(),
        lastProgress: result.finalText || "Builder completed",
      });
      await this.options.service.advance(
        goal.id,
        "reviewing",
        "Builder completed; awaiting independent review",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.logger.error({ err: error, goalId }, "Lab Goal builder execution failed");
      const current = await this.options.service.inspect(goalId);
      if (current && !["paused", "cancelled", "completed"].includes(current.state)) {
        const assignment = current.assignments.find(
          (candidate) => candidate.role === "builder" && candidate.state !== "succeeded",
        );
        if (assignment) {
          await this.options.service.updateAssignment(goalId, assignment.id, {
            state: "failed",
            endedAt: this.now().toISOString(),
            error: message,
          });
        }
        await this.options.service.advance(
          goalId,
          "failed",
          `Builder execution failed: ${message}`,
        );
      }
    } finally {
      this.activeGoalIds.delete(goalId);
      if (this.resumeRequestedGoalIds.delete(goalId)) {
        void this.start(goalId);
      }
    }
  }

  async control(goalId: string, action: "pause" | "resume" | "cancel"): Promise<void> {
    if (action === "resume") {
      if (this.activeGoalIds.has(goalId)) {
        this.resumeRequestedGoalIds.add(goalId);
        return;
      }
      await this.start(goalId);
      return;
    }
    const goal = await this.options.service.inspect(goalId);
    const builder = goal?.assignments.find(
      (assignment) =>
        assignment.role === "builder" && assignment.state === "running" && assignment.agentId,
    );
    if (builder?.agentId) {
      await this.options.agentManager.cancelAgentRun(builder.agentId);
      await this.options.service.updateAssignment(goalId, builder.id, {
        state: "cancelled",
        endedAt: this.now().toISOString(),
        lastProgress: `Builder ${action} requested`,
      });
    }
  }
}
