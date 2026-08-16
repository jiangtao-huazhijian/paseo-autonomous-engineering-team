# Autonomous Engineering Team

This fork adds **Autonomous Lab** to Paseo: a persistent Goal-level control
plane for a small, heterogeneous software engineering team. It is not a
renamed agent list and it is not a free-form "lead agent" prompt.

## V1 boundary

V1 is software-only. It never merges, deploys, changes production systems, or
controls hardware. A user supplies an objective, repository, explicit allowed
and forbidden actions, acceptance criteria, role/provider assignment, and hard
limits. The daemon persists the resulting Goal under:

```
$PASEO_HOME/lab/goals/<goal-id>.json
```

The record is atomically written and includes state history and gate evidence.
No database migration is required: it follows Paseo's file-backed store model.

## State machine

```
draft -> queued -> planning -> implementing -> reviewing -> verifying
                         ^                                  |
                         |          repairable failure       |
                         +----------- repairing <------------+
```

Every non-terminal working state may pause and resume its remembered state, or
cancel. Human input goes to `needs_human`; exhausted hard limits end at
`budget_exhausted`; unrecoverable work ends at `blocked` or `failed`.

`completed` is deliberately special: it is only reachable from `verifying`
after an evaluator has stored a passed `acceptance` gate record. A reviewer or
verifier can diagnose an issue, but cannot certify completion.

## Current implementation slice

The current vertical slice provides the durable Goal schema, state machine,
atomic store, daemon session RPCs, SDK calls, mobile/web Goal controls, and
the first real execution leg:

- `lab.goal.create.request`
- `lab.goal.list.request`
- `lab.goal.inspect.request`
- `lab.goal.action.request`
- `lab.goal.gate-record.request`

Queue creates one dedicated Paseo-managed worktree and one persisted **Builder**
assignment. The Builder is a real Paseo agent, constrained to that worktree and
to the Goal's allowed/forbidden actions; it cannot merge, deploy, or edit
evaluator assets. When the Builder finishes, the Goal enters `reviewing` — it
does **not** claim completion.

The daemon restores queued/planning/implementing Goals after restart. An
existing Builder session is loaded from persistence before the Goal continues.
Pause/cancel request the underlying Builder run to stop; a resume received
while cancellation is settling is replayed after that run exits.

CLI management is available as well:

```bash
paseo goal create --file goal.json --queue
paseo goal ls
paseo goal show <goal-id>
paseo goal pause|resume|cancel <goal-id>
```

`goal.json` must be a complete `LabGoalSpec` (objective, repository, frozen
acceptance criteria, action boundaries, independent role providers, and hard
budget), rather than an underspecified free-form prompt.

## Explicitly not implemented yet

This is not yet a complete heterogeneous team: the independent Reviewer,
Verifier, evaluator command runner, issue-fingerprint/repair loop, and the
evaluator-only acceptance gate are the next slices. Consequently a Builder
finishing in `reviewing` is an intentional stop, not a successful Goal.

## Acceptance checks for this slice

Run the focused tests only (do not run the full suite locally):

```bash
node node_modules/vitest/vitest.mjs run \
  packages/server/src/server/lab/state-machine.test.ts \
  packages/server/src/server/lab/service.test.ts \
  packages/server/src/server/lab/orchestrator.test.ts \
  packages/server/src/server/session/lab/lab-goal-session.test.ts \
  packages/cli/src/commands/goal/index.test.ts \
  --maxWorkers=1
```

Then build the protocol/client producers before validating daemon consumers.
