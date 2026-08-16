import { describe, expect, test } from "vitest";
import type { StoredLabGoal } from "@getpaseo/protocol/lab/types";
import { reviewOutputToArtifacts } from "./review.js";

describe("reviewOutputToArtifacts", () => {
  test("converts a structured independent review into a fingerprinted Issue", () => {
    const result = reviewOutputToArtifacts({
      goal: {
        evaluatorVersion: "lab-evaluator/v1",
        acceptanceCriteria: ["npm test"],
      } as StoredLabGoal,
      ownerAssignmentId: "assignment_builder",
      output: JSON.stringify({
        issues: [
          {
            severity: "high",
            summary: "Filter does not refresh results",
            reproduction: "Choose failed filter",
            files: ["src/filter.ts"],
          },
        ],
      }),
      now: () => new Date("2026-08-16T00:00:00.000Z"),
    });

    expect(result.parseError).toBeNull();
    expect(result.evidence.kind).toBe("review");
    expect(result.issues).toMatchObject([
      {
        finder: "reviewer",
        ownerAssignmentId: "assignment_builder",
        severity: "high",
        reacceptance: ["npm test"],
      },
    ]);
  });
});
