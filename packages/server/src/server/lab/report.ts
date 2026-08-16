import type { StoredLabGoal } from "@getpaseo/protocol/lab/types";

/** Human-readable handoff generated only from persisted machine/agent records. */
export function renderGoalReport(goal: StoredLabGoal): string {
  const lines = [
    `# Autonomous Lab delivery: ${goal.title}`,
    "",
    `- Goal ID: ${goal.id}`,
    `- State: ${goal.state}`,
    `- Repository: ${goal.repositoryPath}`,
    `- Workspace: ${goal.workspaceId ?? "not created"}`,
    `- Frozen at: ${goal.frozenAt}`,
    `- Evaluator: ${goal.evaluatorVersion}`,
    `- Repair rounds: ${goal.repairRound}/${goal.budget.maxRepairRounds}`,
    "",
    "## Acceptance gates",
    ...goal.gateRecords.map(
      (gate) =>
        `- ${gate.gate}: **${gate.verdict}** — ${gate.summary} (${gate.evidence.join(", ") || "no evidence id"})`,
    ),
    "",
    "## Agent assignments",
    ...goal.assignments.map(
      (assignment) =>
        `- ${assignment.role} (${assignment.provider}): ${assignment.state} — ${assignment.agentId ?? "not created"}`,
    ),
    "",
    "## Issues",
    ...(goal.issues.length === 0
      ? ["- None recorded"]
      : goal.issues.map(
          (issue) => `- [${issue.status}] ${issue.severity} ${issue.id}: ${issue.summary}`,
        )),
    "",
    "## Evidence",
    ...goal.evidence.map(
      (evidence) =>
        `- ${evidence.kind}: exit=${evidence.exitCode ?? "n/a"}; ${evidence.command}; artifact=${evidence.artifactHash}`,
    ),
  ];
  return lines.join("\n");
}
