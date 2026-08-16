import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { LabEvidence, StoredLabGoal } from "@getpaseo/protocol/lab/types";

const execFileAsync = promisify(execFile);
const LOG_LIMIT = 64 * 1024;

export interface EvaluatorCommandResult {
  evidence: LabEvidence;
  passed: boolean;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function bounded(value: string | Buffer | undefined): string {
  const text = String(value ?? "");
  return text.length > LOG_LIMIT ? `${text.slice(0, LOG_LIMIT)}\n[truncated]` : text;
}

async function gitValue(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, timeout: 15_000 });
    return stdout.trim();
  } catch {
    return "unavailable";
  }
}

export async function evaluateCommand(input: {
  goal: StoredLabGoal;
  cwd: string;
  command: string;
  now: () => Date;
}): Promise<EvaluatorCommandResult> {
  const candidateHash = digest(
    `${await gitValue(input.cwd, ["rev-parse", "HEAD"])}\n${await gitValue(input.cwd, ["status", "--porcelain=v1"])}\n${await gitValue(input.cwd, ["diff", "--binary"])} `,
  );
  const environmentFingerprint = digest(
    JSON.stringify({
      evaluator: input.goal.evaluatorVersion,
      node: process.version,
      platform: process.platform,
    }),
  );
  let exitCode = 0;
  let stdout = "";
  let stderr = "";
  try {
    const result = await execFileAsync(input.command, {
      cwd: input.cwd,
      shell: true,
      timeout: 10 * 60_000,
      maxBuffer: LOG_LIMIT,
      env: { ...process.env, PASEO_LAB_EVALUATOR: "1" },
    });
    stdout = bounded(result.stdout);
    stderr = bounded(result.stderr);
  } catch (error) {
    const result = error as {
      code?: number | string;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };
    exitCode = typeof result.code === "number" ? result.code : 1;
    stdout = bounded(result.stdout);
    stderr = bounded(result.stderr || String(error));
  }
  const artifactHash = digest(`${input.command}\n${exitCode}\n${stdout}\n${stderr}`);
  return {
    passed: exitCode === 0,
    evidence: {
      id: `evidence_${randomUUID()}`,
      kind: "command",
      candidateHash,
      command: input.command,
      exitCode,
      stdout,
      stderr,
      environmentFingerprint,
      artifactHash,
      createdAt: input.now().toISOString(),
    },
  };
}
