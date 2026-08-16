import type { LabGoalState, StoredLabGoal } from "@getpaseo/protocol/lab/types";

const TERMINAL_STATES = new Set<LabGoalState>([
  "budget_exhausted",
  "blocked",
  "failed",
  "completed",
  "cancelled",
]);

const TRANSITIONS: Readonly<Record<LabGoalState, readonly LabGoalState[]>> = {
  draft: ["queued", "cancelled"],
  queued: ["planning", "budget_exhausted", "paused", "cancelled"],
  planning: [
    "implementing",
    "needs_human",
    "budget_exhausted",
    "blocked",
    "failed",
    "paused",
    "cancelled",
  ],
  implementing: [
    "reviewing",
    "needs_human",
    "budget_exhausted",
    "blocked",
    "failed",
    "paused",
    "cancelled",
  ],
  reviewing: [
    "verifying",
    "repairing",
    "needs_human",
    "budget_exhausted",
    "blocked",
    "failed",
    "paused",
    "cancelled",
  ],
  verifying: [
    "repairing",
    "completed",
    "needs_human",
    "budget_exhausted",
    "blocked",
    "failed",
    "paused",
    "cancelled",
  ],
  repairing: [
    "reviewing",
    "needs_human",
    "budget_exhausted",
    "blocked",
    "failed",
    "paused",
    "cancelled",
  ],
  needs_human: [
    "planning",
    "implementing",
    "reviewing",
    "verifying",
    "repairing",
    "paused",
    "cancelled",
  ],
  budget_exhausted: [],
  blocked: [],
  failed: [],
  completed: [],
  paused: [
    "queued",
    "planning",
    "implementing",
    "reviewing",
    "verifying",
    "repairing",
    "needs_human",
    "cancelled",
  ],
  cancelled: [],
};

export function isTerminalLabGoalState(state: LabGoalState): boolean {
  return TERMINAL_STATES.has(state);
}

export function canTransitionLabGoal(from: LabGoalState, to: LabGoalState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function transitionLabGoal(
  goal: StoredLabGoal,
  to: LabGoalState,
  reason: string,
  now: Date,
): StoredLabGoal {
  if (!canTransitionLabGoal(goal.state, to)) {
    throw new Error(`Cannot transition goal ${goal.id} from ${goal.state} to ${to}`);
  }
  if (to === "completed") {
    const accepted = goal.gateRecords.some(
      (record) => record.gate === "acceptance" && record.verdict === "passed",
    );
    if (!accepted) {
      throw new Error("Only a passed acceptance gate can complete a goal");
    }
  }
  const timestamp = now.toISOString();
  return {
    ...goal,
    state: to,
    stateBeforePause: to === "paused" ? goal.state : null,
    updatedAt: timestamp,
    transitions: [...goal.transitions, { from: goal.state, to, reason, at: timestamp }],
  };
}

export function resumeLabGoal(goal: StoredLabGoal, reason: string, now: Date): StoredLabGoal {
  if (goal.state !== "paused" || !goal.stateBeforePause) {
    throw new Error(`Goal ${goal.id} is not resumable`);
  }
  return transitionLabGoal(goal, goal.stateBeforePause, reason, now);
}
