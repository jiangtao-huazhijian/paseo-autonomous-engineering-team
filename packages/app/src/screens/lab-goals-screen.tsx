import { useCallback, useMemo, useState, useSyncExternalStore, type ReactElement } from "react";
import { ScrollView, Text, View } from "react-native";
import { FlaskConical, Pause, Play, Plus, X } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import type { LabGoalState } from "@getpaseo/protocol/lab/types";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { MenuHeader } from "@/components/headers/menu-header";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useLabGoals } from "@/hooks/use-lab-goals";
import type { AggregatedLabGoal } from "@/lab/aggregated-goals";
import { getHostRuntimeStore, useHosts } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";
import { toErrorMessage } from "@/utils/error-messages";

interface NewGoalDraft {
  title: string;
  repositoryPath: string;
  objective: string;
  acceptanceCriteria: string;
  allowedActions: string;
  forbiddenActions: string;
  builderProvider: string;
  reviewerProvider: string;
  error: string | null;
}

const NEW_GOAL_HEADER = { title: "New goal" };
const END_STATES = new Set<LabGoalState>([
  "completed",
  "cancelled",
  "blocked",
  "failed",
  "budget_exhausted",
]);

class NewGoalFormModel {
  private state: NewGoalDraft = {
    title: "",
    repositoryPath: "",
    objective: "",
    acceptanceCriteria: "",
    allowedActions: "",
    forbiddenActions: "",
    builderProvider: "codex",
    reviewerProvider: "claude",
    error: null,
  };
  private readonly listeners = new Set<() => void>();

  getState = (): NewGoalDraft => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  setTitle = (title: string): void => this.update({ title });
  setRepositoryPath = (repositoryPath: string): void => this.update({ repositoryPath });
  setObjective = (objective: string): void => this.update({ objective });
  setAcceptanceCriteria = (acceptanceCriteria: string): void => this.update({ acceptanceCriteria });
  setAllowedActions = (allowedActions: string): void => this.update({ allowedActions });
  setForbiddenActions = (forbiddenActions: string): void => this.update({ forbiddenActions });
  setBuilderProvider = (builderProvider: string): void => this.update({ builderProvider });
  setReviewerProvider = (reviewerProvider: string): void => this.update({ reviewerProvider });
  setError = (error: string | null): void => this.update({ error });

  private update(patch: Partial<NewGoalDraft>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}

function buildGoalActions(state: LabGoalState): Array<"queue" | "pause" | "resume" | "cancel"> {
  if (state === "draft") return ["queue", "cancel"];
  if (state === "paused") return ["resume", "cancel"];
  if (END_STATES.has(state)) return [];
  return ["pause", "cancel"];
}

export function LabGoalsScreen(): ReactElement {
  const { goals, errors, isLoading, refetch } = useLabGoals();
  const [showNew, setShowNew] = useState(false);
  const [selectedGoal, setSelectedGoal] = useState<AggregatedLabGoal | null>(null);
  const closeSelectedGoal = useCallback(() => setSelectedGoal(null), []);
  const openNew = useCallback(() => setShowNew(true), []);
  const closeNew = useCallback(() => setShowNew(false), []);
  const body = useMemo(() => {
    if (isLoading) return <LabGoalsLoading />;
    if (goals.length === 0) return <LabGoalsEmpty onCreate={openNew} />;
    return (
      <LabGoalsList goals={goals} errors={errors} onChanged={refetch} onSelect={setSelectedGoal} />
    );
  }, [errors, goals, isLoading, openNew, refetch]);
  const headerAction = useMemo(
    () => (
      <Button size="sm" variant="outline" leftIcon={Plus} onPress={openNew}>
        New goal
      </Button>
    ),
    [openNew],
  );

  return (
    <View style={styles.container}>
      <MenuHeader title="Autonomous Lab" rightContent={headerAction} />
      {body}
      {showNew ? <NewGoalSheet onClose={closeNew} onCreated={refetch} /> : null}
      {selectedGoal ? <GoalDetailsSheet goal={selectedGoal} onClose={closeSelectedGoal} /> : null}
    </View>
  );
}

function LabGoalsLoading(): ReactElement {
  return (
    <View style={styles.centered}>
      <LoadingSpinner size="large" color={styles.spinner.color} />
    </View>
  );
}

function LabGoalsEmpty({ onCreate }: { onCreate: () => void }): ReactElement {
  return (
    <View style={styles.centered}>
      <FlaskConical size={styles.emptyIcon.width} color={styles.emptyIcon.color} />
      <Text style={styles.emptyTitle}>No goals yet</Text>
      <Text style={styles.emptyText}>Create a bounded software goal for the autonomous team</Text>
      <Button variant="outline" leftIcon={Plus} onPress={onCreate}>
        New goal
      </Button>
    </View>
  );
}

function LabGoalsList({
  goals,
  errors,
  onChanged,
  onSelect,
}: {
  goals: AggregatedLabGoal[];
  errors: Array<{ serverId: string; serverName: string; message: string }>;
  onChanged: () => void;
  onSelect: (goal: AggregatedLabGoal) => void;
}): ReactElement {
  return (
    <ScrollView contentContainerStyle={styles.scrollContent}>
      {errors.map((error) => (
        <Text
          key={error.serverId}
          style={styles.errorText}
        >{`${error.serverName}: ${error.message}`}</Text>
      ))}
      <View style={settingsStyles.card}>
        {goals.map((goal) => (
          <LabGoalRow
            key={`${goal.serverId}:${goal.id}`}
            goal={goal}
            onChanged={onChanged}
            onSelect={onSelect}
          />
        ))}
      </View>
    </ScrollView>
  );
}

function LabGoalRow({
  goal,
  onChanged,
  onSelect,
}: {
  goal: AggregatedLabGoal;
  onChanged: () => void;
  onSelect: (goal: AggregatedLabGoal) => void;
}): ReactElement {
  const sendAction = useCallback(
    async (action: "queue" | "pause" | "resume" | "cancel") => {
      const client = getHostRuntimeStore().getClient(goal.serverId);
      if (!client) return;
      await client.labGoalAction({ id: goal.id, action });
      onChanged();
    },
    [goal.id, goal.serverId, onChanged],
  );
  const queue = useCallback(() => void sendAction("queue"), [sendAction]);
  const pause = useCallback(() => void sendAction("pause"), [sendAction]);
  const resume = useCallback(() => void sendAction("resume"), [sendAction]);
  const cancel = useCallback(() => void sendAction("cancel"), [sendAction]);
  const openDetails = useCallback(() => onSelect(goal), [goal, onSelect]);
  const actions = buildGoalActions(goal.state);

  return (
    <View style={styles.goalRow}>
      <View style={styles.goalContent}>
        <Text style={styles.goalTitle}>{goal.title}</Text>
        <Text
          style={styles.goalMeta}
        >{`${goal.serverName} · ${goal.state.replaceAll("_", " ")}`}</Text>
        <Text numberOfLines={2} style={styles.goalObjective}>
          {goal.objective}
        </Text>
        <Button size="sm" variant="ghost" onPress={openDetails}>
          Details
        </Button>
      </View>
      <View style={styles.goalActions}>
        {actions.includes("queue") ? (
          <Button size="sm" variant="outline" leftIcon={Play} onPress={queue}>
            Queue
          </Button>
        ) : null}
        {actions.includes("pause") ? (
          <Button size="sm" variant="ghost" leftIcon={Pause} onPress={pause}>
            Pause
          </Button>
        ) : null}
        {actions.includes("resume") ? (
          <Button size="sm" variant="ghost" leftIcon={Play} onPress={resume}>
            Resume
          </Button>
        ) : null}
        {actions.includes("cancel") ? (
          <Button size="sm" variant="ghost" leftIcon={X} onPress={cancel}>
            Cancel
          </Button>
        ) : null}
      </View>
    </View>
  );
}

function GoalDetailsSheet({
  goal,
  onClose,
}: {
  goal: AggregatedLabGoal;
  onClose: () => void;
}): ReactElement {
  const header = useMemo(() => ({ title: goal.title }), [goal.title]);
  return (
    <AdaptiveModalSheet visible header={header} onClose={onClose}>
      <ScrollView contentContainerStyle={styles.detail}>
        <Text style={styles.detailState}>{goal.state.replaceAll("_", " ")}</Text>
        <Text style={styles.detailLabel}>Objective</Text>
        <Text style={styles.detailText}>{goal.objective}</Text>
        <Text style={styles.detailLabel}>Repair budget</Text>
        <Text
          style={styles.detailText}
        >{`${goal.repairRound}/${goal.budget.maxRepairRounds} rounds · ${goal.budget.maxDurationMinutes} min`}</Text>
        <Text style={styles.detailLabel}>Assignments</Text>
        {goal.assignments.map((assignment) => (
          <Text
            key={assignment.id}
            style={styles.detailText}
          >{`${assignment.role} · ${assignment.provider} · ${assignment.state} · ${assignment.agentId ?? "not created"}`}</Text>
        ))}
        <Text style={styles.detailLabel}>Gates</Text>
        {goal.gateRecords.map((gate) => (
          <Text
            key={gate.id}
            style={styles.detailText}
          >{`${gate.gate}: ${gate.verdict} — ${gate.summary}`}</Text>
        ))}
        <Text style={styles.detailLabel}>Issues</Text>
        {goal.issues.map((issue) => (
          <Text
            key={issue.id}
            style={styles.detailText}
          >{`${issue.status} · ${issue.severity} · ${issue.summary}`}</Text>
        ))}
        <Text style={styles.detailLabel}>Evidence</Text>
        {goal.evidence.map((evidence) => (
          <Text
            key={evidence.id}
            style={styles.detailText}
          >{`${evidence.kind} · ${evidence.exitCode ?? "n/a"} · ${evidence.command}`}</Text>
        ))}
        {goal.finalReport ? (
          <>
            <Text style={styles.detailLabel}>Delivery report</Text>
            <Text style={styles.detailText}>{goal.finalReport}</Text>
          </>
        ) : null}
      </ScrollView>
    </AdaptiveModalSheet>
  );
}

function NewGoalSheet({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}): ReactElement {
  const hosts = useHosts();
  const [model] = useState(() => new NewGoalFormModel());
  const draft = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  const [submitting, setSubmitting] = useState(false);
  const firstHost = hosts[0] ?? null;
  const submit = useCallback(async () => {
    const title = draft.title.trim();
    const repositoryPath = draft.repositoryPath.trim();
    const objective = draft.objective.trim();
    const acceptanceCriteria = draft.acceptanceCriteria
      .split("\n")
      .map((item) => item.trim())
      .filter(Boolean);
    const allowedActions = draft.allowedActions
      .split("\n")
      .map((item) => item.trim())
      .filter(Boolean);
    const forbiddenActions = draft.forbiddenActions
      .split("\n")
      .map((item) => item.trim())
      .filter(Boolean);
    if (
      !firstHost ||
      !title ||
      !repositoryPath ||
      !objective ||
      acceptanceCriteria.length === 0 ||
      allowedActions.length === 0
    ) {
      model.setError(
        "Fill in the goal, repository, objective, allowed path glob, and at least one acceptance command",
      );
      return;
    }
    setSubmitting(true);
    model.setError(null);
    try {
      const client = getHostRuntimeStore().getClient(firstHost.serverId);
      if (!client) throw new Error("Host is not connected");
      const response = await client.labGoalCreate({
        title,
        repositoryPath,
        mode: "deliver",
        objective,
        acceptanceCriteria,
        allowedActions,
        forbiddenActions,
        roleProviders: [
          {
            role: "builder",
            provider: draft.builderProvider.trim() as AgentProvider,
            enabled: true,
          },
          {
            role: "reviewer",
            provider: draft.reviewerProvider.trim() as AgentProvider,
            enabled: true,
          },
        ],
        budget: {
          maxRounds: 3,
          maxAgents: 2,
          maxDurationMinutes: 120,
          maxRepairRounds: 2,
          estimatedCostUsd: null,
        },
      });
      if (response.error) throw new Error(response.error);
      onCreated();
      onClose();
    } catch (error) {
      model.setError(toErrorMessage(error));
    } finally {
      setSubmitting(false);
    }
  }, [draft, firstHost, model, onClose, onCreated]);
  const submitPress = useCallback(() => void submit(), [submit]);
  const footer = useMemo(
    () => <NewGoalFooter onClose={onClose} onSubmit={submitPress} submitting={submitting} />,
    [onClose, submitPress, submitting],
  );

  return (
    <AdaptiveModalSheet visible header={NEW_GOAL_HEADER} onClose={onClose} footer={footer}>
      <View style={styles.form}>
        <Field label="Goal">
          <FormTextInput value={draft.title} onChangeText={model.setTitle} />
        </Field>
        <Field label="Repository path">
          <FormTextInput
            value={draft.repositoryPath}
            onChangeText={model.setRepositoryPath}
            autoCapitalize="none"
          />
        </Field>
        <Field label="Objective">
          <FormTextInput value={draft.objective} onChangeText={model.setObjective} multiline />
        </Field>
        <Field label="Acceptance criteria">
          <FormTextInput
            value={draft.acceptanceCriteria}
            onChangeText={model.setAcceptanceCriteria}
            multiline
            placeholder="One criterion per line"
          />
        </Field>
        <Field label="Allowed path globs">
          <FormTextInput
            value={draft.allowedActions}
            onChangeText={model.setAllowedActions}
            multiline
            autoCapitalize="none"
            placeholder={"One glob per line, e.g. src/**"}
          />
        </Field>
        <Field label="Forbidden path globs">
          <FormTextInput
            value={draft.forbiddenActions}
            onChangeText={model.setForbiddenActions}
            multiline
            autoCapitalize="none"
            placeholder={"Optional, e.g. evaluator/**"}
          />
        </Field>
        <Field label="Builder provider">
          <FormTextInput
            value={draft.builderProvider}
            onChangeText={model.setBuilderProvider}
            autoCapitalize="none"
          />
        </Field>
        <Field label="Reviewer provider">
          <FormTextInput
            value={draft.reviewerProvider}
            onChangeText={model.setReviewerProvider}
            autoCapitalize="none"
          />
        </Field>
        {draft.error ? <Text style={styles.formError}>{draft.error}</Text> : null}
      </View>
    </AdaptiveModalSheet>
  );
}

function NewGoalFooter({
  onClose,
  onSubmit,
  submitting,
}: {
  onClose: () => void;
  onSubmit: () => void;
  submitting: boolean;
}): ReactElement {
  return (
    <View style={styles.footer}>
      <Button variant="secondary" onPress={onClose} disabled={submitting}>
        Cancel
      </Button>
      <Button onPress={onSubmit} loading={submitting}>
        Create goal
      </Button>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { flex: 1, backgroundColor: theme.colors.surface0 },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[6],
  },
  scrollContent: { gap: theme.spacing[3], padding: theme.spacing[6] },
  goalRow: {
    flexDirection: "row",
    gap: theme.spacing[4],
    padding: theme.spacing[4],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  goalContent: { flex: 1, gap: theme.spacing[1] },
  goalActions: { alignItems: "flex-end", gap: theme.spacing[2] },
  goalTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  goalMeta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    textTransform: "capitalize",
  },
  goalObjective: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  emptyTitle: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
  errorText: { color: theme.colors.palette.red[300], fontSize: theme.fontSize.xs },
  emptyIcon: { color: theme.colors.foregroundMuted, width: theme.iconSize.lg },
  spinner: { color: theme.colors.foregroundMuted },
  form: { gap: theme.spacing[4] },
  footer: { flexDirection: "row", justifyContent: "flex-end", gap: theme.spacing[3] },
  formError: { color: theme.colors.palette.red[300], fontSize: theme.fontSize.xs },
  detail: { gap: theme.spacing[3] },
  detailState: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    textTransform: "capitalize",
  },
  detailLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    textTransform: "uppercase",
  },
  detailText: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
}));
