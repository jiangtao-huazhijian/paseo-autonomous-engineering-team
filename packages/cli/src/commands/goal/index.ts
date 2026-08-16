import { readFile } from "node:fs/promises";
import { Command } from "commander";
import type { CreateLabGoalInput, StoredLabGoal } from "@getpaseo/protocol/lab/types";
import { LabGoalSpecSchema } from "@getpaseo/protocol/lab/types";
import {
  withOutput,
  type CommandError,
  type ListResult,
  type OutputSchema,
  type SingleResult,
} from "../../output/index.js";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";
import { connectToDaemon, getDaemonHost } from "../../utils/client.js";

interface GoalCommandOptions {
  host?: string;
  file?: string;
  queue?: boolean;
  reason?: string;
  issue?: string;
}

interface GoalDaemonClient {
  labGoalCreate(
    input: CreateLabGoalInput,
  ): Promise<{ goal: StoredLabGoal | null; error: string | null }>;
  labGoalList(): Promise<{ goals: StoredLabGoal[]; error: string | null }>;
  labGoalInspect(input: {
    id: string;
  }): Promise<{ goal: StoredLabGoal | null; error: string | null }>;
  labGoalAction(input: {
    id: string;
    action: "queue" | "pause" | "resume" | "cancel" | "waive-issue";
    reason?: string;
    issueId?: string;
  }): Promise<{ goal: StoredLabGoal | null; error: string | null }>;
  close(): Promise<void>;
}

interface GoalRow {
  id: string;
  title: string;
  mode: string;
  state: string;
  workspace: string;
  updatedAt: string;
}

const goalSchema: OutputSchema<GoalRow> = {
  idField: "id",
  columns: [
    { header: "ID", field: "id", width: 14 },
    { header: "TITLE", field: "title", width: 28 },
    { header: "MODE", field: "mode", width: 10 },
    { header: "STATE", field: "state", width: 18 },
    { header: "WORKSPACE", field: "workspace", width: 16 },
    { header: "UPDATED", field: "updatedAt", width: 24 },
  ],
};

const goalInspectSchema: OutputSchema<{ key: string; value: string }> = {
  idField: "key",
  columns: [
    { header: "KEY", field: "key", width: 20 },
    { header: "VALUE", field: "value", width: 96 },
  ],
};

function toGoalRow(goal: StoredLabGoal): GoalRow {
  return {
    id: goal.id,
    title: goal.title,
    mode: goal.mode,
    state: goal.state,
    workspace: goal.workspaceId ?? "-",
    updatedAt: goal.updatedAt,
  };
}

function inspectRows(goal: StoredLabGoal): Array<{ key: string; value: string }> {
  return [
    { key: "Id", value: goal.id },
    { key: "Title", value: goal.title },
    { key: "State", value: goal.state },
    { key: "Mode", value: goal.mode },
    { key: "Repository", value: goal.repositoryPath },
    { key: "Workspace", value: goal.workspaceId ?? "null" },
    { key: "Objective", value: goal.objective },
    { key: "Acceptance", value: goal.acceptanceCriteria.join("\n") },
    { key: "Assignments", value: JSON.stringify(goal.assignments) },
    { key: "Gates", value: JSON.stringify(goal.gateRecords) },
    { key: "Issues", value: JSON.stringify(goal.issues) },
    { key: "Evidence", value: JSON.stringify(goal.evidence) },
    { key: "Audit", value: JSON.stringify(goal.auditEvents) },
    { key: "FinalReport", value: goal.finalReport ?? "null" },
    { key: "Transitions", value: JSON.stringify(goal.transitions) },
  ];
}

async function connectGoalClient(host: string | undefined): Promise<GoalDaemonClient> {
  const resolvedHost = getDaemonHost({ host });
  try {
    return (await connectToDaemon({ host })) as unknown as GoalDaemonClient;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw {
      code: "DAEMON_NOT_RUNNING",
      message: `Cannot connect to daemon at ${resolvedHost}: ${message}`,
      details: "Start the daemon with: paseo daemon start",
    } satisfies CommandError;
  }
}

function toGoalCommandError(code: string, action: string, error: unknown): CommandError {
  if (error && typeof error === "object" && "code" in error) return error as CommandError;
  const message = error instanceof Error ? error.message : String(error);
  return { code, message: `Failed to ${action}: ${message}` };
}

async function readGoalSpec(file: string | undefined): Promise<CreateLabGoalInput> {
  if (!file?.trim()) {
    throw {
      code: "MISSING_GOAL_FILE",
      message: "Provide a Goal specification with --file <goal.json>",
    } satisfies CommandError;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw {
      code: "INVALID_GOAL_FILE",
      message: `Cannot read Goal file: ${message}`,
    } satisfies CommandError;
  }
  const result = LabGoalSpecSchema.safeParse(parsed);
  if (!result.success) {
    throw {
      code: "INVALID_GOAL_SPEC",
      message: `Goal file does not match the required schema: ${result.error.issues[0]?.message ?? "unknown error"}`,
    } satisfies CommandError;
  }
  return result.data;
}

async function runCreate(
  options: GoalCommandOptions,
  _command: Command,
): Promise<SingleResult<GoalRow>> {
  const client = await connectGoalClient(options.host);
  try {
    const created = await client.labGoalCreate(await readGoalSpec(options.file));
    if (created.error || !created.goal) throw new Error(created.error ?? "Goal was not created");
    const result = options.queue
      ? await client.labGoalAction({ id: created.goal.id, action: "queue" })
      : created;
    if (result.error || !result.goal) throw new Error(result.error ?? "Goal was not queued");
    return { type: "single", data: toGoalRow(result.goal), schema: goalSchema };
  } catch (error) {
    throw toGoalCommandError("GOAL_CREATE_FAILED", "create Goal", error);
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function runList(
  options: GoalCommandOptions,
  _command: Command,
): Promise<ListResult<GoalRow>> {
  const client = await connectGoalClient(options.host);
  try {
    const payload = await client.labGoalList();
    if (payload.error) throw new Error(payload.error);
    return { type: "list", data: payload.goals.map(toGoalRow), schema: goalSchema };
  } catch (error) {
    throw toGoalCommandError("GOAL_LIST_FAILED", "list Goals", error);
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function runShow(
  id: string,
  options: GoalCommandOptions,
  _command: Command,
): Promise<ListResult<{ key: string; value: string }>> {
  const client = await connectGoalClient(options.host);
  try {
    const payload = await client.labGoalInspect({ id });
    if (payload.error || !payload.goal) throw new Error(payload.error ?? `Goal not found: ${id}`);
    return { type: "list", data: inspectRows(payload.goal), schema: goalInspectSchema };
  } catch (error) {
    throw toGoalCommandError("GOAL_SHOW_FAILED", "show Goal", error);
  } finally {
    await client.close().catch(() => undefined);
  }
}

function actionCommand(action: "queue" | "pause" | "resume" | "cancel") {
  return async (
    id: string,
    options: GoalCommandOptions,
    _command: Command,
  ): Promise<SingleResult<GoalRow>> => {
    const client = await connectGoalClient(options.host);
    try {
      const payload = await client.labGoalAction({ id, action, reason: options.reason });
      if (payload.error || !payload.goal) throw new Error(payload.error ?? `Goal not found: ${id}`);
      return { type: "single", data: toGoalRow(payload.goal), schema: goalSchema };
    } catch (error) {
      throw toGoalCommandError(`GOAL_${action.toUpperCase()}_FAILED`, `${action} Goal`, error);
    } finally {
      await client.close().catch(() => undefined);
    }
  };
}

async function runWaive(
  id: string,
  options: GoalCommandOptions,
  _command: Command,
): Promise<SingleResult<GoalRow>> {
  if (!options.issue?.trim()) {
    throw {
      code: "MISSING_ISSUE",
      message: "Provide --issue <issue-id> to waive",
    } satisfies CommandError;
  }
  const client = await connectGoalClient(options.host);
  try {
    const payload = await client.labGoalAction({
      id,
      action: "waive-issue",
      issueId: options.issue,
      reason: options.reason || "Explicit human waiver",
    });
    if (payload.error || !payload.goal) throw new Error(payload.error ?? `Goal not found: ${id}`);
    return { type: "single", data: toGoalRow(payload.goal), schema: goalSchema };
  } catch (error) {
    throw toGoalCommandError("GOAL_WAIVE_FAILED", "waive Issue", error);
  } finally {
    await client.close().catch(() => undefined);
  }
}

export function createGoalCommand(): Command {
  const goal = new Command("goal").description("Manage durable Autonomous Lab Goals");
  addJsonAndDaemonHostOptions(
    goal
      .command("create")
      .description("Create a Goal from a JSON specification")
      .requiredOption("--file <path>", "Goal JSON file")
      .option("--queue", "Queue immediately after creating"),
  ).action(withOutput(runCreate));
  addJsonAndDaemonHostOptions(goal.command("ls").description("List Goals")).action(
    withOutput(runList),
  );
  addJsonAndDaemonHostOptions(
    goal.command("show").description("Show Goal state, assignments, and gates").argument("<id>"),
  ).action(withOutput(runShow));
  for (const action of ["queue", "pause", "resume", "cancel"] as const) {
    addJsonAndDaemonHostOptions(
      goal
        .command(action)
        .description(`${action[0]?.toUpperCase()}${action.slice(1)} a Goal`)
        .argument("<id>", "Goal ID")
        .option("--reason <text>", "Optional lifecycle reason"),
    ).action(withOutput(actionCommand(action)));
  }
  addJsonAndDaemonHostOptions(
    goal
      .command("waive")
      .description("Record an explicit human waiver for an open Issue")
      .argument("<id>", "Goal ID")
      .requiredOption("--issue <issue-id>", "Open Issue ID")
      .option("--reason <text>", "Required audit reason", "Explicit human waiver"),
  ).action(withOutput(runWaive));
  return goal;
}
