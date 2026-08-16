# Autonomous Lab operations

This document operates the `codex/autonomous-lab-v1` fork. It does not grant
the system permission to merge, deploy, access production, or control hardware.

## 1. Build and start

Use Node 22 as declared by the repository, install workspace dependencies, and
build the protocol before consumers:

```bash
corepack enable
npm ci
npm run build --workspace @getpaseo/protocol
npm run build --workspace @getpaseo/server
npm run build --workspace @getpaseo/client
npm run build --workspace @getpaseo/app
```

Start the forked daemon using the normal Paseo daemon command. Do not restart a
daemon that has running Goals without first pausing or recording the intended
recovery behavior: a restart interrupts live Provider turns.

## 2. Configure providers before a real Goal

1. Use the forked daemon's provider list and diagnostics to find currently
   enabled Provider IDs.
2. Configure `~/.paseo/orchestration-preferences.json` with the local operator's
   desired implementation, UI, research, planning, and audit provider choices.
3. In a Goal, set Builder and Reviewer to different enabled providers. Verifier
   is optional and must be enabled only after its provider passes diagnostics.
4. Run one small manual Provider smoke run before queueing any unattended Goal.

Do not copy the fixture's example provider IDs blindly. Provider availability,
authentication, model names, and permission modes are local machine state.

## 3. Create and supervise a Goal

Use the PWA/desktop **Autonomous Lab** page, or the CLI:

```bash
paseo goal create --file /absolute/path/goal.json --queue
paseo goal ls
paseo goal show <goal-id>
paseo goal pause <goal-id>
paseo goal resume <goal-id>
paseo goal cancel <goal-id>
```

The Goal must declare absolute repository path, command acceptance criteria,
allowed path globs, forbidden path globs, Provider roles, and hard budgets.

An Issue can only be waived explicitly, with an audit reason:

```bash
paseo goal waive <goal-id> --issue <issue-id> --reason "accepted product risk"
```

Never waive a failed required command merely to force delivery. A completion is
trustworthy only when the persisted Evaluator acceptance Gate is passed.

## 4. First real fixture run

Copy `fixtures/autonomous-lab-history-page` outside the Paseo source checkout,
set the absolute copied path in `goal.json`, replace provider IDs with verified
ones, then queue it. Expected sequence:

1. Initial `npm test` fails; `npm run build` passes.
2. Builder repairs `src/history.js` in the dedicated Goal worktree.
3. Reviewer reports structured findings.
4. Evaluator records command and policy Evidence.
5. Only all frozen Gates passing yields `completed` and a delivery report.

Keep `evaluator/` forbidden. Any change there should become a critical policy
Issue and prevent completion.

## 5. Mobile / PWA access

The app's Goals route is responsive and uses the same authenticated Paseo host
connection as desktop. Pair the mobile client through the existing Paseo relay
or approved local daemon mechanism; do not expose a raw unauthenticated daemon
port to the Internet. Confirm that a paired phone can list a Goal and observe
its Evidence before relying on it overnight.

## 6. Backup, upgrade, and rollback

Back up `$PASEO_HOME` before daemon upgrade. It contains Goal records under
`lab/goals/`, agent persistence, workspace registry, and runtime configuration.

Upgrade procedure:

1. Pause active Goals and inspect their `paseo goal show` records.
2. Back up `$PASEO_HOME` and record the current fork commit.
3. Merge/rebase upstream in a separate branch; run protocol generation,
   focused Lab tests, and the fixture regression.
4. Build the forked app/daemon and resume one non-production fixture Goal.

Rollback procedure:

1. Pause active Goals.
2. Restore the prior fork build and `$PASEO_HOME` backup only after confirming
   schema compatibility.
3. Start the previous daemon and inspect each non-terminal Goal. Recovery
   resumes its persisted phase; if agent ownership is missing it must enter
   `needs_human`, not silently duplicate work.

## 7. Human takeover and incident response

- `needs_human`: inspect evidence, Provider authentication, permissions, and
  worktree state; resume only after a concrete decision.
- `budget_exhausted`: inspect the final report, then either create a new bounded
  Goal or explicitly revise the budget; do not change persisted limits in place.
- Provider failure: preserve evidence and reconfigure/diagnose the provider;
  never substitute Builder for Reviewer.
- Suspected policy bypass: cancel the Goal, preserve the worktree, and inspect
  the policy Evidence before any manual merge.

V1 requires a supervised 8-hour trial before a 24/72-hour soak test. The soak
test must record daemon restart, Provider interruption, and disk/resource
behavior; this document is not evidence that those trials have already passed.
