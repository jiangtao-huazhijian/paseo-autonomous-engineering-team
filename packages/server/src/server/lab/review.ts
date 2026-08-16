import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { LabEvidence, LabIssue, StoredLabGoal } from "@getpaseo/protocol/lab/types";

const ReviewResponseSchema = z.object({
  issues: z.array(
    z.object({
      severity: z.enum(["low", "medium", "high", "critical"]),
      summary: z.string().trim().min(1),
      reproduction: z.string().trim().min(1),
      files: z.array(z.string().trim().min(1)).default([]),
    }),
  ),
});

export function reviewerPrompt(goal: StoredLabGoal): string {
  return [
    "You are the independent Reviewer for a controlled Autonomous Lab Goal.",
    "You are read-only: do not edit files, run write commands, merge, deploy, or change tests.",
    `Goal: ${goal.title}`,
    `Objective:\n${goal.objective}`,
    `Allowed changes:\n${goal.allowedActions.map((item) => `- ${item}`).join("\n") || "- none"}`,
    `Forbidden changes:\n${goal.forbiddenActions.map((item) => `- ${item}`).join("\n") || "- none"}`,
    "Inspect the current diff and behavior. Respond with JSON only:",
    '{"issues":[{"severity":"high","summary":"...","reproduction":"...","files":["..."]}]}',
    "Use an empty issues array when no blocking defect is found. High/critical issues block release.",
  ].join("\n\n");
}

export function reviewOutputToArtifacts(input: {
  goal: StoredLabGoal;
  ownerAssignmentId: string;
  output: string;
  now: () => Date;
}): { evidence: LabEvidence; issues: LabIssue[]; parseError: string | null } {
  const artifactHash = createHash("sha256").update(input.output).digest("hex");
  const evidence: LabEvidence = {
    id: `evidence_${randomUUID()}`,
    kind: "review",
    candidateHash: artifactHash,
    command: "reviewer structured report",
    exitCode: 0,
    stdout: input.output.slice(0, 64 * 1024),
    stderr: "",
    environmentFingerprint: `reviewer:${input.goal.evaluatorVersion}`,
    artifactHash,
    createdAt: input.now().toISOString(),
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.output);
  } catch {
    return { evidence, issues: [], parseError: "Reviewer did not return valid JSON" };
  }
  const result = ReviewResponseSchema.safeParse(parsed);
  if (!result.success) {
    return { evidence, issues: [], parseError: "Reviewer JSON did not match the Issue schema" };
  }
  return {
    evidence,
    parseError: null,
    issues: result.data.issues.map((issue) => ({
      id: `issue_${randomUUID()}`,
      fingerprint: createHash("sha256")
        .update(`review:${issue.files.sort().join("|")}:${issue.summary.toLowerCase().trim()}`)
        .digest("hex"),
      finder: "reviewer",
      ownerAssignmentId: input.ownerAssignmentId,
      severity: issue.severity,
      summary: issue.summary,
      reproduction: issue.reproduction,
      evidenceIds: [evidence.id],
      reacceptance: input.goal.acceptanceCriteria,
      status: "open",
      createdAt: input.now().toISOString(),
      updatedAt: input.now().toISOString(),
      waivedAt: null,
      waivedReason: null,
    })),
  };
}
