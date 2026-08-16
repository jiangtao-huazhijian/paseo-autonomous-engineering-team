import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type {
  CreateLabGoalInput,
  LabGateRecord,
  StoredLabGoal,
} from "@getpaseo/protocol/lab/types";
import { LabGoalStore } from "./store.js";
import { resumeLabGoal, transitionLabGoal } from "./state-machine.js";

export type LabGoalAction = "queue" | "pause" | "resume" | "cancel" | "start" | "mark-blocked";

export class LabGoalService {
  private readonly store: LabGoalStore;
  private readonly now: () => Date;

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
      createdAt: timestamp,
      updatedAt: timestamp,
      transitions: [],
      gateRecords: [],
    });
  }

  async list(): Promise<StoredLabGoal[]> {
    return this.store.list();
  }

  async inspect(id: string): Promise<StoredLabGoal | null> {
    return this.store.get(id);
  }

  async action(id: string, action: LabGoalAction, reason?: string): Promise<StoredLabGoal> {
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
      }
    });
    if (!updated) {
      throw new Error(`Goal not found: ${id}`);
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
