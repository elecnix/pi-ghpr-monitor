# pi-ghpr-monitor

A [Pi](https://github.com/mariozechner/pi-coding-agent) extension that monitors GitHub Pull Requests and injects status updates into your agent session.

## What It Does

Polls a GitHub PR (or issue, or standalone GitHub Actions workflow run) at a configurable interval and notifies the agent when things change — new review comments, merge conflicts, CI failures, or general comments. PR/issue monitoring stops automatically when the resource is merged/closed; workflow-run monitoring stops automatically when the run's status becomes `completed`.

## Key Files

- `src/index.ts` — Extension entry point, registers the `/ghpr-monitor` command and `ghpr-monitor` tool, owns the poll loops (PR, issue, run)
- `src/analyzer.ts` — Analyzes PR/issue data from the GitHub GraphQL API, diffing against previous poll state to detect changes; also holds the run snapshot/diff/footer helpers
- `src/run-monitor.ts` — Pure, testable helpers for standalone workflow-run monitoring (REST fetch, URL parsing, monitor keys) — kept free of pi-tui deps so it can be unit-tested in isolation
- `src/preferences.ts` — User-overridable notification templates (PR, issue, and run)
- `test/` — Unit tests, E2E tests with mock servers, throttle tests, run-monitor tests

## Dev Setup

```bash
npm install
npm test          # unit + throttle tests
npm run typecheck # type check
pi -e ./src/index.ts  # test locally
```