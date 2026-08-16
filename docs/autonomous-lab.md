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

The first vertical slice provides the durable Goal schema, state machine,
atomic store, daemon session RPCs, SDK calls, and a mobile/web Goal list with
create, queue, pause, resume, and cancel controls:

- `lab.goal.create.request`
- `lab.goal.list.request`
- `lab.goal.inspect.request`
- `lab.goal.action.request`
- `lab.goal.gate-record.request`

It enforces an enabled Builder and Reviewer with different providers. The UI
does not claim that Queue has started a team: the deterministic orchestrator is
the next slice. It must consume these APIs rather than bypassing the state
machine with raw store writes.

## Acceptance checks for this slice

Run the focused tests only (do not run the full suite locally):

```bash
node node_modules/vitest/vitest.mjs run \
  packages/server/src/server/lab/state-machine.test.ts \
  packages/server/src/server/lab/service.test.ts \
  packages/server/src/server/session/lab/lab-goal-session.test.ts \
  --maxWorkers=1
```

Then build the protocol/client producers before validating daemon consumers.
