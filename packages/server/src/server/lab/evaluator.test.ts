import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { StoredLabGoal } from "@getpaseo/protocol/lab/types";
import { promisify } from "node:util";
import { evaluateChangePolicy, evaluateCommand } from "./evaluator.js";

const execFileAsync = promisify(execFile);

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

  test("blocks forbidden or out-of-scope changes before command Gates run", async () => {
    await execFileAsync("git", ["init"], { cwd });
    await writeFile(join(cwd, "evaluator-secret.ts"), "modified");
    await writeFile(join(cwd, "outside.ts"), "modified");
    const result = await evaluateChangePolicy({
      goal: {
        evaluatorVersion: "lab-evaluator/v1",
        allowedActions: ["src/**"],
        forbiddenActions: ["evaluator-*.ts"],
      } as StoredLabGoal,
      cwd,
      now: () => new Date("2026-08-16T00:00:00.000Z"),
    });

    expect(result).toMatchObject({ passed: false, evidence: { kind: "policy", exitCode: 1 } });
    expect(result.violations).toEqual(
      expect.arrayContaining(["evaluator-secret.ts", "outside.ts"]),
    );
  });
});
