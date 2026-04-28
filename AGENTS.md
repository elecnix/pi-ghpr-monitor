# pi-ghpr-monitor

A [Pi](https://github.com/mariozechner/pi-coding-agent) extension that monitors GitHub Pull Requests and injects status updates into your agent session.

## What It Does

Polls a GitHub PR at a configurable interval and notifies the agent when things change — new review comments, merge conflicts, CI failures, or general comments. Automatically stops when the PR is merged or closed.

## Key Files

- `src/index.ts` — Extension entry point, registers the `/ghpr-monitor` command and `ghpr-monitor` tool
- `src/analyzer.ts` — Analyzes PR data from GitHub GraphQL API, diffing against previous poll state to detect changes
- `test/` — Unit tests, E2E tests with mock servers, throttle tests

## Dev Setup

```bash
npm install
npm test          # unit + throttle tests
npm run typecheck # type check
pi -e ./src/index.ts  # test locally
```