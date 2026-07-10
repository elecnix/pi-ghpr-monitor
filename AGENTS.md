# pi-ghpr-monitor

A [Pi](https://github.com/mariozechner/pi-coding-agent) extension that monitors GitHub Pull Requests and injects status updates into your agent session.

## What It Does

A **thin adapter** around the [`gh monitor`](https://github.com/elecnix/gh-monitor) CLI. The adapter shells out to `gh monitor monitor <selector>`, which streams one NDJSON event per genuinely-new change (new review threads, general comments, failing/green CI, merge conflicts, review decisions, new commits, merge/close) and auto-stops when the PR is merged/closed or a watched workflow run completes. The adapter relays each event into the Pi session and owns the harness integration the CLI can't do itself:

- the `/ghpr-monitor` command and the `ghpr-monitor` LLM tool,
- the steering prompt, custom message renderer, and footer status,
- turn-batching (queue events while the agent is working, flush on `turn_end`),
- the `gh pr create` hook (nudge the LLM to monitor a freshly created PR),
- the auto-merge nudge on CI-green,
- notification preference delegation to `gh monitor prefs` plus Pi-only prefs.

Polling, snapshotting, change-diffing, and notification templating live in `gh monitor` — this extension no longer re-implements them.

## Key Files

- `src/index.ts` — Extension entry point: registers the `/ghpr-monitor` command and `ghpr-monitor` tool, spawns `gh monitor`, relays events, owns turn-batching/footer/pr-create-hook/auto-merge.
- `src/gh-monitor-bridge.ts` — Spawns `gh monitor`, parses the NDJSON event stream, and delegates prefs (`gh monitor prefs get/set/reset/path`). Free of pi-tui deps so it's unit-testable. `GH_MONITOR_BIN` overrides the binary (for tests/sandboxes).
- `src/keys.ts` — URL/shorthand parsing (`parsePRUrl`/`parseIssueUrl`/`parseRunUrl`/`parsePRShorthand`), monitor keys (`prKey`/`runKey`/`monitorKey`), and the `MonitorConfig` type.
- `src/render.ts` — pi-tui rendering: `linkifyPRRefs` (OSC-8/markdown hyperlinks), `MonitorState` (per-monitor summary folded from the event stream), and footer/status display.
- `src/adapter-prefs.ts` — Pi-specific prefs (`disableMergeTool`, `prCreateNudge`, `ciGreenMerge`) stored at `~/.config/pi-ghpr-monitor/adapter.json`; templates/ignoredBots/retriggerComments are owned by `gh monitor prefs`.
- `src/pr-create-hook.ts` — Detects `gh pr create` and builds the nudge message.
- `src/logger.ts` — Optional debug logging.
- `test/` — Unit tests for the bridge, keys, render, adapter-prefs, pr-create-hook, logger, and white-box structural tests for the command/tool; `test/integration/` runs a tmux screenshot smoke test against a mock `gh monitor` binary.

## Dev Setup

```bash
npm install
npm test          # vitest unit + structural tests
npx esbuild src/index.ts --bundle --platform=node --target=node22 --outfile=dist/index.js \
  --external:@mariozechner/pi-ai --external:@mariozechner/pi-tui --external:@mariozechner/pi-agent-core --external:@sinclair/typebox
pi -e ./src/index.ts  # test locally (requires the gh-monitor gh extension installed)
```

The adapter requires the [`gh monitor`](https://github.com/elecnix/gh-monitor) `gh` extension to be installed (`gh extension install elecnix/gh-monitor`).