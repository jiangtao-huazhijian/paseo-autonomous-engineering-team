# Autonomous Lab history-page fixture

This intentionally starts failing. A valid run must repair `src/history.js`
without editing `evaluator/`, then independently pass `npm test`, `npm run build`,
and the Reviewer gate.

Create a copy or use it as the repository path in the Goal UI. For CLI use,
replace `repositoryPath` in `goal.json` with this fixture's absolute path, then:

```bash
paseo goal create --file goal.json --queue
```

Before a real run, replace the example providers in `goal.json` with Provider
IDs confirmed available by the daemon and configure orchestration preferences.
