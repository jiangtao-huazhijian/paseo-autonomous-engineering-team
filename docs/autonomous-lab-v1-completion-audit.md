# Autonomous Lab V1.1 completion audit

Audit date: 2026-08-17
Fork branch: `codex/autonomous-lab-v1`
Status: **not complete — real-environment acceptance remains outstanding**.

This is an evidence ledger, not a roadmap or a completion claim.

| V1.1 completion condition | Current evidence | Status |
| --- | --- | --- |
| Web/PWA can create, view, pause, resume, cancel Goals | `LabGoalsScreen`, Goal API/CLI, app typecheck/lint, focused session tests | Code verified; no paired-phone runtime evidence |
| Builder/Reviewer independent Provider assignments | Goal validates different Builder/Reviewer providers; orchestrator stores assignments | Code verified; no real Provider turns |
| Reviewer default read-only boundary | Git HEAD/status snapshots before and after review; a mutation is preserved as policy Evidence and forces `needs_human` | Code verified; detection, not OS-level sandboxing or real Provider evidence |
| Reviewer/Verifier issue returns to original Builder | Orchestrator repair-loop tests exercise Builder → Reviewer → Evaluator → Verifier → Builder | Simulated runtime verified; no real turns |
| Failed required Gate cannot complete | Evaluator-only internal Gate writer; public Gate RPC removed; state-machine/service tests | Code verified |
| Passing gates + no blocking Issue + Evidence generate completion | Evaluator, policy, issue, report tests | Simulated runtime verified |
| Restart does not lose Goal/Agent/workspace/Gate/Issue/Evidence | File-backed Goal store, recovery tests for reviewing state | Partial: no kill-daemon/real-Agent recovery run |
| Budget/timeout/provider errors land in correct non-success states | wall-time, repair count, Agent count, provider attention tests | Code verified; no live rate-limit test |
| Example 1.5 end-to-end replay | `fixtures/autonomous-lab-history-page` intentionally fails `npm test`, passes build, freezes policy | Fixture verified locally; no Agent-run evidence |
| Actual three independent Providers participate | Local discovery found Claude/Codex/Copilot binaries | **Missing**: daemon unreachable; no preferences file; no authorized smoke run |
| PWA/mobile background behavior | Responsive app route and operations guide | **Missing**: paired phone/PWA run |
| 72-hour soak without state/resource/permission failure | Operations guide defines test | **Missing** |

## Current external-state blocker

Read-only inspection on 2026-08-17 found:

- `~/.paseo/orchestration-preferences.json` is absent;
- local daemon reports `stale_pid` and `unreachable`;
- Claude, Codex, and Copilot binaries are discoverable, but discovery is not a
  provider smoke run.

No daemon restart or real Agent creation was attempted. Restarting may interrupt
unknown user work and creating a real Provider Agent requires the operator's
provider preference and billing/permission decision.

## Required evidence to close V1

1. Operator configures orchestration preferences and confirms the daemon may be
   recovered/restarted.
2. Run the history-page fixture with distinct Builder, Reviewer, and Verifier
   provider IDs; retain Goal JSON, worktree path, all Agent IDs, Evidence, and
   delivery report.
3. Deliberately verify: evaluator-policy tamper attempt, Reviewer high Issue,
   one repair loop, server interruption/recovery, Provider interruption, and
   mobile observation.
4. Run supervised 8-hour, then 24/72-hour soak tests; capture bounded resource
   metrics, audit events, and final state of every Goal.

Until this evidence exists, the correct product status is **implementation
ready for controlled acceptance testing**, not “V1 completed.”
