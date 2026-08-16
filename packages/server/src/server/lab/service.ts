import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type {
  CreateLabGoalInput,
  LabAgentAssignment,
  LabEvidence,
  LabGateRecord,
  LabIssue,
  StoredLabGoal,
} from "@getpaseo/protocol/lab/types";
import { LabGoalStore } from "./store.js";
import { resumeLabGoal, transitionLabGoal } from "./state-machine.js";

export type LabGoalAction =
  | "queue"
  | "pause"
  | "resume"
  | "cancel"
  | "start"
  | "mark-blocked"
  | "waive-issue";

export interface LabGoalOrchestrator {
  start(goalId: string): Promise<void>;
  control?(
    goalId: string,
    action: Extract<LabGoalAction, "pause" | "resume" | "cancel">,
  ): Promise<void>;
}

export class LabGoalService {
  private readonly store: LabGoalStore;
  private readonly now: () => Date;
  private orchestrator: LabGoalOrchestrator | null = null;

  constructor(options: { paseoHome: string; now?: () => Date }) {
    this.store = new LabGoalStore(join(options.paseoHome, "lab", "goals"));
    this.now = options.now ?? (() => new Date());
  }

  async create(input: CreateLabGoalInput): Promise<StoredLabGoal> {
    const timestamp = this.now().toISOString();
    const roleProviders = input.roleProviders.map((role) => ({
      ...role,
      enabled: role.enabled ?? true,
    }));
    const activeRoles = roleProviders.filter((role) => role.enabled);
    const builder = activeRoles.find((role) => role.role === "builder");
    const reviewer = activeRoles.find((role) => role.role === "reviewer");
    if (!builder || !reviewer) {
      throw new Error("A goal requires enabled builder and reviewer roles");
    }
    if (builder.provider === reviewer.provider) {
      throw new Error("Builder and reviewer must use different providers");
    }
    return this.store.create({
      ...input,
      roleProviders,
      state: "draft",
      stateBeforePause: null,
      repairRound: 0,
      frozenAt: timestamp,
      evaluatorVersion: "lab-evaluator/v1",
      workspaceId: null,
      assignments: [],
      createdAt: timestamp,
      updatedAt: timestamp,
      transitions: [],
      gateRecords: [],
      evidence: [],
      issues: [],
      auditEvents: [],
    });
  }

  setOrchestrator(orchestrator: LabGoalOrchestrator): void {
    this.orchestrator = orchestrator;
  }

  /**
   * Replays only work that has not reached a human/evaluator decision point.
   * The persisted Goal record remains the source of truth across daemon restarts.
   */
  async recover(): Promise<void> {
    if (!this.orchestrator) return;
    const resumable = (await this.list()).filter((goal) =>
      ["queued", "planning", "implementing"].includes(goal.state),
    );
    for (const goal of resumable) {
      void this.orchestrator.start(goal.id).catch(() => undefined);
    }
  }

  async list(): Promise<StoredLabGoal[]> {
    return this.store.list();
  }

  async inspect(id: string): Promise<StoredLabGoal | null> {
    return this.store.get(id);
  }

  async action(
    id: string,
    action: LabGoalAction,
    reason?: string,
    issueId?: string,
  ): Promise<StoredLabGoal> {
    const updated = await this.store.update(id, (goal) => {
      const message = reason?.trim() || `User requested ${action}`;
      switch (action) {
        case "queue":
          return transitionLabGoal(goal, "queued", message, this.now());
        case "start":
          return transitionLabGoal(goal, "planning", message, this.now());
        case "pause":
          return transitionLabGoal(goal, "paused", message, this.now());
        case "resume":
          return resumeLabGoal(goal, message, this.now());
        case "cancel":
          return transitionLabGoal(goal, "cancelled", message, this.now());
        case "mark-blocked":
          return transitionLabGoal(goal, "blocked", message, this.now());
        case "waive-issue": {
          if (!issueId) throw new Error("waive-issue requires an issueId");
          const issue = goal.issues.find((candidate) => candidate.id === issueId);
          if (!issue) throw new Error(`Issue not found: ${issueId}`);
          if (issue.status === "resolved")
            throw new Error(`Resolved issue cannot be waived: ${issueId}`);
          const timestamp = this.now().toISOString();
          return {
            ...goal,
            issues: goal.issues.map((candidate) =>
              candidate.id === issueId
                ? {
                    ...candidate,
                    status: "waived",
                    waivedAt: timestamp,
                    waivedReason: message,
                    updatedAt: timestamp,
                  }
                : candidate,
            ),
            auditEvents: [
              ...goal.auditEvents,
              { at: timestamp, action: "waive-issue", detail: `${issueId}: ${message}` },
            ],
            updatedAt: timestamp,
          };
        }
      }
    });
    if (!updated) {
      throw new Error(`Goal not found: ${id}`);
    }
    if (action === "queue" && updated.state === "queued" && this.orchestrator) {
      void this.orchestrator.start(updated.id).catch(() => undefined);
    }
    if (
      (action === "pause" || action === "resume" || action === "cancel") &&
      this.orchestrator?.control
    ) {
      void this.orchestrator.control(updated.id, action).catch(() => undefined);
    }
    return updated;
  }

  /**
   * Reserved for the deterministic orchestrator. The UI deliberately does not
   * expose arbitrary state changes: it can only issue lifecycle actions.
   */
  async advance(id: string, to: StoredLabGoal["state"], reason: string): Promise<StoredLabGoal> {
    const updated = await this.store.update(id, (goal) =>
      transitionLabGoal(goal, to, reason, this.now()),
    );
    if (!updated) {
      throw new Error(`Goal not found: ${id}`);
    }
    return updated;
  }

  async bindWorkspace(id: string, workspaceId: string): Promise<StoredLabGoal> {
    const updated = await this.store.update(id, (goal) => ({
      ...goal,
      workspaceId,
      updatedAt: this.now().toISOString(),
    }));
    if (!updated) throw new Error(`Goal not found: ${id}`);
    return updated;
  }

  async addAssignment(id: string, assignment: LabAgentAssignment): Promise<StoredLabGoal> {
    const updated = await this.store.update(id, (goal) => ({
      ...goal,
      assignments: [...goal.assignments, assignment],
      updatedAt: this.now().toISOString(),
    }));
    if (!updated) throw new Error(`Goal not found: ${id}`);
    return updated;
  }

  async updateAssignment(
    id: string,
    assignmentId: string,
    patch: Partial<LabAgentAssignment>,
  ): Promise<StoredLabGoal> {
    const updated = await this.store.update(id, (goal) => ({
      ...goal,
      assignments: goal.assignments.map((assignment) =>
        assignment.id === assignmentId ? { ...assignment, ...patch } : assignment,
      ),
      updatedAt: this.now().toISOString(),
    }));
    if (!updated) throw new Error(`Goal not found: ${id}`);
    return updated;
  }

  async recordGate(id: string, record: LabGateRecord): Promise<StoredLabGoal> {
    const updated = await this.store.update(id, (goal) => {
      const gateRecord = {
        ...record,
        id: record.id || randomUUID(),
        createdAt: record.createdAt || this.now().toISOString(),
      };
      const withRecord = {
        ...goal,
        gateRecords: [...goal.gateRecords, gateRecord],
        updatedAt: this.now().toISOString(),
      };
      if (gateRecord.verdict === "needs_human") {
        return transitionLabGoal(
          withRecord,
          "needs_human",
          `Gate ${gateRecord.gate} requires human input`,
          this.now(),
        );
      }
      if (gateRecord.gate === "acceptance" && gateRecord.verdict === "passed") {
        return transitionLabGoal(withRecord, "completed", "Acceptance gate passed", this.now());
      }
      return withRecord;
    });
    if (!updated) {
      throw new Error(`Goal not found: ${id}`);
    }
    return updated;
  }

  async recordEvidence(id: string, evidence: LabEvidence): Promise<StoredLabGoal> {
    const updated = await this.store.update(id, (goal) => ({
      ...goal,
      evidence: [...goal.evidence, evidence],
      updatedAt: this.now().toISOString(),
    }));
    if (!updated) throw new Error(`Goal not found: ${id}`);
    return updated;
  }

  /** Merge duplicate observations instead of consuming another repair round. */
  async upsertIssue(id: string, issue: LabIssue): Promise<StoredLabGoal> {
    const updated = await this.store.update(id, (goal) => {
      const existing = goal.issues.find((candidate) => candidate.fingerprint === issue.fingerprint);
      const issues = existing
        ? goal.issues.map((candidate) =>
            candidate.fingerprint === issue.fingerprint
              ? {
                  ...candidate,
                  ...issue,
                  id: candidate.id,
                  createdAt: candidate.createdAt,
                  status: candidate.status === "waived" ? "waived" : issue.status,
                }
              : candidate,
          )
        : [...goal.issues, issue];
      return { ...goal, issues, updatedAt: this.now().toISOString() };
    });
    if (!updated) throw new Error(`Goal not found: ${id}`);
    return updated;
  }

  /** Deterministic failure route: duplicate fingerprints never spend a repair round. */
  async routeIssueForRepair(id: string, issue: LabIssue): Promise<StoredLabGoal> {
    const updated = await this.store.update(id, (goal) => {
      const duplicate = goal.issues.some(
        (candidate) => candidate.fingerprint === issue.fingerprint,
      );
      const withIssue = duplicate
        ? goal
        : { ...goal, issues: [...goal.issues, issue], updatedAt: this.now().toISOString() };
      if (duplicate) {
        return transitionLabGoal(
          withIssue,
          "needs_human",
          `Repeated evaluator failure: ${issue.summary}`,
          this.now(),
        );
      }
      if (goal.repairRound >= goal.budget.maxRepairRounds) {
        return transitionLabGoal(
          withIssue,
          "budget_exhausted",
          "Maximum repair rounds exhausted",
          this.now(),
        );
      }
      return transitionLabGoal(
        { ...withIssue, repairRound: goal.repairRound + 1 },
        "repairing",
        `Evaluator failure routed to Builder: ${issue.id}`,
        this.now(),
      );
    });
    if (!updated) throw new Error(`Goal not found: ${id}`);
    return updated;
  }

  async resolveEvaluatorIssues(id: string): Promise<StoredLabGoal> {
    const updated = await this.store.update(id, (goal) => ({
      ...goal,
      issues: goal.issues.map((issue) =>
        issue.finder === "evaluator" && issue.status === "open"
          ? { ...issue, status: "resolved", updatedAt: this.now().toISOString() }
          : issue,
      ),
      updatedAt: this.now().toISOString(),
    }));
    if (!updated) throw new Error(`Goal not found: ${id}`);
    return updated;
  }

  async resolveReviewerIssues(id: string): Promise<StoredLabGoal> {
    const updated = await this.store.update(id, (goal) => ({
      ...goal,
      issues: goal.issues.map((issue) =>
        issue.finder === "reviewer" && issue.status === "open"
          ? { ...issue, status: "resolved", updatedAt: this.now().toISOString() }
          : issue,
      ),
      updatedAt: this.now().toISOString(),
    }));
    if (!updated) throw new Error(`Goal not found: ${id}`);
    return updated;
  }
}

const labServices = new Map<string, LabGoalService>();

/** Shares one serialized store per daemon home across every connected session. */
export function getLabGoalService(paseoHome: string): LabGoalService {
  let service = labServices.get(paseoHome);
  if (!service) {
    service = new LabGoalService({ paseoHome });
    labServices.set(paseoHome, service);
  }
  return service;
}
