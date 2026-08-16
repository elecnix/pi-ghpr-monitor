# pi-ghpr-monitor

A [Pi](https://github.com/mariozechner/pi-coding-agent) extension that monitors GitHub Pull Requests and injects status updates into your agent session.

This extension is a thin adapter that wraps the [`gh monitor`](https://github.com/elecnix/gh-monitor) CLI. The CLI handles polling, snapshotting, change-diffing, and notification templating; the adapter owns harness integration — the `/ghpr-monitor` command, the `ghpr-monitor` LLM tool, turn-batching, footer status, and agent-specific nudges.

## What It Does

When you're working on a PR, you want your AI agent to stay informed about changes — new review comments, merge conflicts, CI failures — so it can take action automatically. This extension makes that possible by:

1. **Registering a `/ghpr-monitor` command** for direct user control
2. **Registering a `ghpr-monitor` tool** the LLM can invoke itself (start/status/check/merge/preferences — plus `stop`, an explicit last resort for obsolete or redundant monitors)
3. **Shelling out to `gh monitor`** which handles polling via the GitHub API
4. **Injecting notifications** into the session as PR conditions change

## Key Features

### Smart Notification Delivery

- **Informational, never turn-triggering** — status notifications are delivered as custom messages: shown in the TUI and appended to the agent's conversation history, so the agent sees them on its next turn without being woken up. Only the deliberate PR/issue create-hook nudges and explicit user commands (`/ghpr-monitor !`, steer messages) start a turn.
- **Degraded-API events are deduped** — while an API surface is down (e.g. rate-limited), the CLI re-emits a `degraded` event on every failed poll; the adapter surfaces only the first event per episode so the agent's context is not spammed. Any successful poll ends the episode.
- **Throttled during active turns** — updates are queued while the agent is working, then flushed at turn end. No mid-turn steering, no spam.
- **Reminders after idle** — if actionable items remain when the agent finishes a turn, a nudge is sent on the next poll cycle so nothing falls through the cracks.
- **Change detection** — only sends updates when something actually changed (new comments, CI status changes, etc.).
- **Session notifications for errors** — poll errors appear in the TUI, not as LLM messages.

### Enriched Notifications

Status updates include detail the agent needs without re-fetching:

```
💬 2 unresolved review thread(s) on owner/repo#42:
  - [reviewer1] Please fix the typo (id: PRRT_123)
  - [reviewer2] This needs a test (id: PRRT_456)
❌ Failing CI checks on owner/repo#42:
  - ci/test (FAILURE)
  - ci/lint (TIMED_OUT)
📝 1 general comment(s) on owner/repo#42:
  - [sonarqubecloud] Quality Gate Passed (id: IC_kwDOO45Fys7-N7xS)
  Add a 👍 reaction to a comment to acknowledge it and stop notifications.
```

### New-Commit Notifications

When a new commit is pushed to the PR, the agent is nudged to re-check the PR description. The nudge names **who** pushed the commit and any **co-authors** parsed from the commit's `Co-authored-by:` trailers (on by default):

```
📝 New commit abc1234 pushed to owner/repo#42 by alice, co-authored by Bob, Carol. Review the PR description to ensure it still accurately reflects the latest changes.
```

- **`by <author>`** — the commit author's GitHub login, falling back to the git author name. Omitted when the author is unknown.
- **`, co-authored by <names>`** — co-authors from the commit's `Co-authored-by:` trailers. Omitted when the commit has none (so a commit with no co-authors simply reads `… by alice. Review …`).

You can override this message with the `descriptionStaleness` preference, which supports these template variables:

| Variable           | Description                                          |
|--------------------|------------------------------------------------------|
| `{commitShortOid}` | Short 7-character commit SHA                          |
| `{commitOid}`      | Full commit SHA                                       |
| `{commitUrl}`      | Link to the commit on GitHub                          |
| `{commitAuthor}`   | Commit author (GitHub login, or git author name)     |
| `{commitCoauthors}`| Comma-separated co-author names; empty when none      |

…plus the common `{owner}`, `{repo}`, `{number}`, `{host}`, `{prLabel}`, `{prUrl}`. Set it with:

```
ghpr-monitor(action="preferences", value='{"descriptionStaleness": "🔁 {commitAuthor} pushed {commitShortOid} to {prLabel} (co-authors: {commitCoauthors})"}')
```

### Acknowledging Comments

Comments with a 👍 (thumbs up) reaction are automatically filtered out of notifications. This breaks infinite loops where the agent keeps responding to the same bot comment. The notification includes a hint so the agent knows it can add a 👍 reaction to dismiss a comment.

### Merged/Closed Detection

When the PR is merged or closed, the extension sends a final notification and stops monitoring automatically.

### Monitoring Lifecycle

The LLM tool exposes `start`, `status`, `check`, `merge`, `preferences` — and `stop`. Stopping is an **explicit, last-resort operation**: the agent should only use `action='stop'` when a monitor is known to be obsolete or redundant (e.g. the same PR is already monitored elsewhere, or the task that needed it is done). Monitors otherwise run until the PR is merged/closed (or a watched run completes), or until the user stops them with `/ghpr-monitor off`. This keeps the agent watching for review comments even when CI is green.

## Installation

```bash
pi install git:github.com/elecnix/pi-ghpr-monitor
```

Or add to your project's `.pi/settings.json`:

```json
{
  "packages": ["git:github.com/elecnix/pi-ghpr-monitor"]
}
```

## Usage

### Command: `/ghpr-monitor`

```
/ghpr-monitor https://github.com/owner/repo/pull/42                        Start monitoring
/ghpr-monitor https://github.com/owner/repo/pull/42 Address any CI failure    Start with a message
/ghpr-monitor owner/repo 42                                                 Start monitoring PR #42
/ghpr-monitor owner/repo 42 Review all open threads                          Start with a message
/ghpr-monitor https://github.com/owner/repo/actions/runs/30433642            Watch a single workflow run until it completes
/ghpr-monitor on                                                            Resume monitoring
/ghpr-monitor off                                                           Stop monitoring
```

Any text after the URL or `owner/repo number` is sent to the agent as a steer message. Use it to give the agent context about what you want it to do on the PR.

### Tool: `ghpr-monitor`

The agent can start monitoring, check status, and stop monitoring:

```
ghpr-monitor(action="start", url="https://github.com/elecnix/gh-pr-review/pull/42")
ghpr-monitor(action="start", owner="elecnix", repo="gh-pr-review", pr_number=42)
ghpr-monitor(action="start", owner="elecnix", repo="gh-pr-review", run_id=30433642)   # watch a single workflow run
ghpr-monitor(action="status")
ghpr-monitor(action="stop")                                        # stop all monitors
ghpr-monitor(action="stop", url="owner/repo#42")                   # stop a specific monitor
```

The agent can stop monitoring with `action='stop'` — an explicit, last-resort operation for when a monitor is known to be obsolete or redundant. Otherwise monitoring continues until the PR is merged, the run completes, or the user stops it with `/ghpr-monitor off`.

### Watching a standalone workflow run

Use `run_id` (with `owner`+`repo`, no `pr_number`) — or paste an Actions run URL into `/ghpr-monitor` — to watch a **single GitHub Actions workflow run** until it completes. This is the standalone counterpart to PR CI watching: instead of polling a PR for check suites, it polls `GET /repos/{owner}/{repo}/actions/runs/{run_id}` and emits one notification per genuinely-new status transition, then **auto-stops** when the run's status becomes `completed`.

The run id is the numeric id in a run's URL: `…/actions/runs/<id>`.

| Event | When |
|------|------|
| `⏸️ run-queued` | Run transitions to `queued` |
| `⏳ run-in-progress` | Run starts running (`in_progress`) |
| `🏁 run-completed` | Run finishes — the notification carries the conclusion (`success`, `failure`, `cancelled`, `timed_out`, `neutral`, …) |

PR/issue monitoring is unchanged; `run_id` is mutually exclusive with `pr_number`/`url`. The notification templates are overridable via the `runQueued`, `runInProgress`, and `runCompleted` preferences.

### Typical Workflow

1. You start monitoring: `/ghpr-monitor https://github.com/elecnix/gh-pr-review/pull/42` — or just tell the agent to watch the PR
2. The agent uses the `ghpr-monitor` tool and begins polling
3. When changes are detected, a notification is injected into the session:
   - **💬 New review comments** — the agent reads and addresses them
   - **⚠️ Merge conflicts** — the agent resolves them
   - **❌ Failing CI checks** — the agent fixes the issues
   - **✅ All checks pass** — the agent confirms it's ready to merge
4. When the PR is merged or closed, monitoring stops automatically (e.g. `🔀 PR https://github.com/owner/repo/pull/42 was merged. Monitoring stopped.`)
5. The agent adds 👍 reactions to dismiss bot comments it doesn't need to act on
6. You stop monitoring explicitly: `/ghpr-monitor off` — or the agent stops a monitor known to be obsolete or redundant via `action='stop'` (last resort)

## How It Works

The extension shells out to [`gh monitor`](https://github.com/elecnix/gh-monitor), which polls the PR at a configurable interval (default: 60 seconds) and emits one NDJSON event per genuinely-new change. The adapter relays these events into the Pi session. The CLI checks for:

- **Unresolved review threads** — new comments that need attention
- **Merge conflicts** — the PR can't be merged
- **Failing CI checks** — builds or tests are broken
- **Pending CI checks** — checks still running
- **General comments** — including bot comments (filterable via 👍 reaction)
- **New commits** — a new commit nudges the agent to re-check the PR description, naming the author and any co-authors
- **PR state** — merged or closed PRs trigger automatic shutdown

When conditions change between polls, it formats a human-readable update and delivers it to the agent via `pi.sendUserMessage()` so it reaches the LLM even on fresh sessions. A concise summary is also shown in the TUI via a custom message renderer registered for the `ghpr-monitor` custom type.

## Configuration

The tool accepts these parameters:

| Parameter   | Type   | Default | Description                                    |
|-------------|--------|---------|------------------------------------------------|
| `action`    | string | —       | `start`, `status`, `check`, `merge`, `preferences`, or `stop` (`stop` is a last resort for obsolete/redundant monitors) |
| `url`       | string | —       | GitHub PR URL (alternative to owner+repo+pr_number) |
| `owner`     | string | —       | Repository owner (required for `start`)        |
| `repo`      | string | —       | Repository name (required for `start`)         |
| `pr_number` | number | —       | PR number (required for `start`)               |
| `mode`      | string | `all`   | Watch mode: `all`, `comments`, `conflicts`, `actions` |
| `interval`  | number | `60`    | Polling interval in seconds (minimum: 10)      |
| `events`    | array  | —       | Per-event-kind allowlist. When set, only notifications whose detected kinds intersect this list are delivered; all others are suppressed. Omit to receive every kind (the default). Entries are notification template keys, e.g. `conflict`, `new-failing-checks`, `merged`, `closed`, `run-completed`. Matching is case-insensitive; unknown kinds are rejected. |

## Requirements

- [Pi](https://github.com/mariozechner/pi-coding-agent) coding agent
- [gh](https://cli.github.com/) CLI installed and authenticated with access to the target repository

## Reducing notification noise with `events`

By default the monitor delivers a notification for every event kind: every CI transition, every comment, every review, every new commit, plus the merge-blocking ones. An orchestrator or automation caller that only wants to act on a subset can pass an `events` allowlist at `start`; the adapter forwards it to `gh monitor --events`, which suppresses unlisted kinds before they reach the agent session.

```ts
// Only act on merge conflicts, newly-failing checks, and the terminal merge/close:
ghpr-monitor(action='start', url='owner/repo#42', events=['conflict','new-failing-checks','merged','closed'])

// Watch a workflow run but only notify on completion (skip queued/in-progress):
ghpr-monitor(action='start', owner='owner', repo='repo', run_id=30433642, events=['run-completed'])
```

The recognised event kinds are the notification template keys: `new-unresolved-threads`, `new-general-comments`, `conflict`, `new-failing-checks`, `ci-all-green`, `review-approved`, `review-changes-requested`, `review-dismissed`, `new-commit`, `merged`, `closed`, `first-poll`, `all-clear`, `issue-closed`, `issue-reopened`, `issue-new-comment`, `issue-mention`, `run-queued`, `run-in-progress`, `run-completed`, `repo-new-pr`, `repo-new-issue`. Matching is case-insensitive. Omit `events` to receive everything; an empty array is treated the same as omitting it (the CLI rejects an empty `--events` value, so the adapter does not forward one). Unknown kinds are rejected by `gh monitor` with a clear error.

## Development

```bash
# Install dependencies
npm install

# Run tests
npm test

# Type check
npm run typecheck

# Test locally
pi -e ./src/index.ts
```

## Testing

```bash
# Unit and throttle tests
npm test

# Type check
npm run typecheck

# Test locally
pi -e ./src/index.ts
```

The project includes unit tests for the analyzer functions, throttling logic, and E2E tests with a mock GitHub server.

## License

MIT
