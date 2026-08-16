import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { StoredLabGoal } from "@getpaseo/protocol/lab/types";
import { evaluateCommand } from "./evaluator.js";

describe("evaluateCommand", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "paseo-lab-evaluator-"));
  });
  afterEach(async () => rm(cwd, { recursive: true, force: true }));

  test("records immutable evidence for both a passing and failing frozen command", async () => {
    const goal = {
      evaluatorVersion: "lab-evaluator/v1",
    } as StoredLabGoal;
    const passed = await evaluateCommand({
      goal,
      cwd,
      command: "node -e \"process.stdout.write('ok')\"",
      now: () => new Date("2026-08-16T00:00:00.000Z"),
    });
    const failed = await evaluateCommand({
      goal,
      cwd,
      command: "node -e \"process.stderr.write('bad'); process.exit(7)\"",
      now: () => new Date("2026-08-16T00:00:01.000Z"),
    });

    expect(passed).toMatchObject({ passed: true, evidence: { exitCode: 0, stdout: "ok" } });
    expect(failed).toMatchObject({ passed: false, evidence: { exitCode: 7, stderr: "bad" } });
    expect(failed.evidence.artifactHash).toHaveLength(64);
    expect(failed.evidence.candidateHash).toHaveLength(64);
  });
});
