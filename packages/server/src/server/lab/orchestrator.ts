import { createHash, randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { EvaluatorCommandResult } from "./evaluator.js";
import { evaluateChangePolicy, evaluateCommand } from "./evaluator.js";
import { reviewerPrompt, reviewOutputToArtifacts } from "./review.js";
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
  evaluateCommand?: (input: {
    goal: StoredLabGoal;
    cwd: string;
    command: string;
    now: () => Date;
  }) => Promise<EvaluatorCommandResult>;
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

function requireReviewer(goal: StoredLabGoal) {
  const reviewer = goal.roleProviders.find((role) => role.role === "reviewer" && role.enabled);
  if (!reviewer) throw new Error(`Goal ${goal.id} has no enabled reviewer`);
  return reviewer;
}

function builderPrompt(goal: StoredLabGoal): string {
  const repairIssues = goal.issues.filter((issue) => issue.status === "open");
  return [
    "You are the Builder in a controlled Autonomous Lab Goal.",
    "You are the only role allowed to modify product code.",
    `Goal: ${goal.title}`,
    `Objective:\n${goal.objective}`,
    `Allowed changes:\n${goal.allowedActions.map((item) => `- ${item}`).join("\n") || "- none declared"}`,
    `Forbidden changes:\n${goal.forbiddenActions.map((item) => `- ${item}`).join("\n") || "- none declared"}`,
    `Frozen acceptance criteria:\n${goal.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}`,
    "Work only in the current worktree. Do not merge, deploy, change evaluator assets, or weaken tests.",
    ...(repairIssues.length > 0
      ? [
          `Open evaluator issues to repair:\n${repairIssues
            .map(
              (issue) =>
                `- ${issue.id} [${issue.severity}] ${issue.summary}\n  Reproduce: ${issue.reproduction}\n  Reaccept: ${issue.reacceptance.join(", ")}`,
            )
            .join("\n")}`,
        ]
      : []),
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
  private readonly continueRequestedGoalIds = new Set<string>();
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
      if (!["planning", "implementing", "repairing"].includes(goal.state)) return;

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
      const afterBuild = await this.options.service.advance(
        goal.id,
        "reviewing",
        goal.state === "repairing"
          ? "Builder repaired evaluator findings; awaiting re-evaluation"
          : "Builder completed; awaiting independent review",
      );
      const shouldContinue = await this.runReviewer(afterBuild, workspaceCwd, assignmentId);
      if (shouldContinue) this.continueRequestedGoalIds.add(goal.id);
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
      } else if (this.continueRequestedGoalIds.delete(goalId)) {
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

  private async runEvaluator(
    reviewingGoal: StoredLabGoal,
    cwd: string,
    ownerAssignmentId: string,
  ): Promise<boolean> {
    const goal = await this.options.service.advance(
      reviewingGoal.id,
      "verifying",
      "Independent evaluator started frozen acceptance gates",
    );
    const commands = goal.acceptanceCriteria.filter(
      (criterion) => !criterion.startsWith("independent_review:"),
    );
    if (commands.length === 0) {
      await this.options.service.advance(goal.id, "needs_human", "No executable acceptance gates");
      return false;
    }
    const policy = await evaluateChangePolicy({ goal, cwd, now: this.now });
    await this.options.service.recordEvidence(goal.id, policy.evidence);
    await this.options.service.recordGate(goal.id, {
      id: `gate_${randomUUID()}`,
      gate: "verification",
      verdict: policy.passed ? "passed" : "failed",
      summary: policy.passed
        ? "Changed-path policy passed"
        : `Changed-path policy failed: ${policy.violations.join(", ")}`,
      evidence: [policy.evidence.id],
      issueFingerprint: policy.passed ? null : policy.evidence.artifactHash,
      createdAt: this.now().toISOString(),
    });
    if (!policy.passed) {
      const routed = await this.options.service.routeIssueForRepair(goal.id, {
        id: `issue_${randomUUID()}`,
        fingerprint: createHash("sha256")
          .update(`policy:${policy.violations.sort().join("|")}`)
          .digest("hex"),
        finder: "evaluator",
        ownerAssignmentId,
        severity: "critical",
        summary: `Candidate violates frozen change policy: ${policy.violations.join(", ")}`,
        reproduction: "git status --porcelain=v1",
        evidenceIds: [policy.evidence.id],
        reacceptance: ["policy:changed-paths", ...goal.acceptanceCriteria],
        status: "open",
        createdAt: this.now().toISOString(),
        updatedAt: this.now().toISOString(),
        waivedAt: null,
        waivedReason: null,
      });
      return routed.state === "repairing";
    }
    const evaluate = this.options.evaluateCommand ?? evaluateCommand;
    for (const command of commands) {
      const result = await evaluate({ goal, cwd, command, now: this.now });
      await this.options.service.recordEvidence(goal.id, result.evidence);
      await this.options.service.recordGate(goal.id, {
        id: `gate_${randomUUID()}`,
        gate: "verification",
        verdict: result.passed ? "passed" : "failed",
        summary: result.passed ? `Passed: ${command}` : `Failed: ${command}`,
        evidence: [result.evidence.id],
        issueFingerprint: result.passed ? null : result.evidence.artifactHash,
        createdAt: this.now().toISOString(),
      });
      if (!result.passed) {
        const fingerprint = createHash("sha256")
          .update(`evaluator:${command}:${result.evidence.artifactHash}`)
          .digest("hex");
        const routed = await this.options.service.routeIssueForRepair(goal.id, {
          id: `issue_${randomUUID()}`,
          fingerprint,
          finder: "evaluator",
          ownerAssignmentId,
          severity: "high",
          summary: `Frozen acceptance command failed: ${command}`,
          reproduction: command,
          evidenceIds: [result.evidence.id],
          reacceptance: goal.acceptanceCriteria,
          status: "open",
          createdAt: this.now().toISOString(),
          updatedAt: this.now().toISOString(),
          waivedAt: null,
          waivedReason: null,
        });
        return routed.state === "repairing";
      }
    }
    const finalGoal = await this.options.service.resolveEvaluatorIssues(goal.id);
    const hasBlockingIssue = finalGoal?.issues.some(
      (issue) => issue.status === "open" && ["high", "critical"].includes(issue.severity),
    );
    if (hasBlockingIssue) {
      await this.options.service.advance(
        goal.id,
        "needs_human",
        "Open blocking review issues remain",
      );
      return false;
    }
    await this.options.service.recordGate(goal.id, {
      id: `gate_${randomUUID()}`,
      gate: "acceptance",
      verdict: "passed",
      summary: "All executable frozen acceptance commands passed",
      evidence: (finalGoal?.evidence ?? []).map((evidence) => evidence.id),
      issueFingerprint: null,
      createdAt: this.now().toISOString(),
    });
    return false;
  }

  private async runReviewer(
    goal: StoredLabGoal,
    cwd: string,
    ownerAssignmentId: string,
  ): Promise<boolean> {
    const reviewer = requireReviewer(goal);
    const existing = goal.assignments.find(
      (assignment) => assignment.role === "reviewer" && assignment.agentId,
    );
    const assignmentId = existing?.id ?? `assignment_${randomUUID()}`;
    let agentId = existing?.agentId ?? null;
    if (!existing) {
      await this.options.service.addAssignment(goal.id, {
        id: assignmentId,
        role: "reviewer",
        provider: reviewer.provider,
        model: reviewer.model ?? null,
        agentId: null,
        workspaceId: goal.workspaceId,
        state: "planned",
        startedAt: null,
        endedAt: null,
        lastProgress: null,
        error: null,
      });
      const created = await this.options.createAgent({
        kind: "mcp",
        provider: formatProviderModel(reviewer.provider, reviewer.model),
        config: {
          provider: reviewer.provider,
          cwd,
          ...(reviewer.model ? { model: reviewer.model } : {}),
        },
        cwd,
        workspaceId: goal.workspaceId ?? undefined,
        title: `[Lab Reviewer] ${goal.title}`,
        labels: { "paseo.lab-goal-id": goal.id, "paseo.lab-role": "reviewer" },
        unattended: true,
        promptFailure: "return-error",
        background: true,
        notifyOnFinish: false,
      });
      if (created.initialPromptError) throw created.initialPromptError;
      agentId = created.snapshot.id;
      await this.options.service.updateAssignment(goal.id, assignmentId, {
        agentId,
        state: "running",
        startedAt: this.now().toISOString(),
      });
    }
    if (!agentId) throw new Error(`Reviewer assignment ${assignmentId} has no agent`);
    await this.options.ensureAgentLoaded?.(agentId);
    const result = await this.options.agentManager.runAgent(agentId, reviewerPrompt(goal));
    if (result.canceled) return false;
    await this.options.service.updateAssignment(goal.id, assignmentId, {
      state: "succeeded",
      endedAt: this.now().toISOString(),
      lastProgress: result.finalText || "Reviewer completed",
    });
    const artifacts = reviewOutputToArtifacts({
      goal,
      ownerAssignmentId,
      output: result.finalText,
      now: this.now,
    });
    await this.options.service.recordEvidence(goal.id, artifacts.evidence);
    if (artifacts.parseError) {
      await this.options.service.advance(goal.id, "needs_human", artifacts.parseError);
      return false;
    }
    const blocking = artifacts.issues.filter((issue) =>
      ["high", "critical"].includes(issue.severity),
    );
    if (blocking.length > 0) {
      const routed = await this.options.service.routeIssueForRepair(goal.id, blocking[0]!);
      for (const issue of artifacts.issues.slice(1))
        await this.options.service.upsertIssue(goal.id, issue);
      return routed.state === "repairing";
    }
    await this.options.service.resolveReviewerIssues(goal.id);
    for (const issue of artifacts.issues) await this.options.service.upsertIssue(goal.id, issue);
    return this.runEvaluator(goal, cwd, ownerAssignmentId);
  }
}
