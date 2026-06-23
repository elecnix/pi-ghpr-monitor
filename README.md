# pi-ghpr-monitor

A [Pi](https://github.com/mariozechner/pi-coding-agent) extension that monitors GitHub Pull Requests and injects status updates into your agent session.

## What It Does

When you're working on a PR, you want your AI agent to stay informed about changes — new review comments, merge conflicts, CI failures — so it can take action automatically. This extension makes that possible by:

1. **Registering a `/ghpr-monitor` command** for direct user control
2. **Registering a `ghpr-monitor` tool** the LLM can invoke itself (start/status only — only you can stop it)
3. **Polling the PR via the GitHub GraphQL API** (using `gh` CLI authentication)
4. **Injecting notifications** into the session as PR conditions change

## Key Features

### Smart Notification Delivery

- **Throttled during active turns** — updates are queued while the agent is working, then flushed when it goes idle. No spam.
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

### Always-On Monitoring

The LLM tool only has `start` and `status` actions. Only the user can stop monitoring with `/ghpr-monitor off`. This ensures the agent keeps watching for review comments even when CI is green.

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
/ghpr-monitor on                                                            Resume monitoring
/ghpr-monitor off                                                           Stop monitoring
```

Any text after the URL or `owner/repo number` is sent to the agent as a steer message. Use it to give the agent context about what you want it to do on the PR.

### Tool: `ghpr-monitor`

The agent can start monitoring or check status:

```
ghpr-monitor(action="start", url="https://github.com/elecnix/gh-pr-review/pull/42")
ghpr-monitor(action="start", owner="elecnix", repo="gh-pr-review", pr_number=42)
ghpr-monitor(action="status")
```

The agent **cannot** stop monitoring — only `/ghpr-monitor off` can do that. This ensures monitoring continues until the PR is merged or you explicitly stop it.

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
6. You stop monitoring explicitly: `/ghpr-monitor off`

## How It Works

The extension uses `gh api graphql` to poll the PR at a configurable interval (default: 60 seconds). It checks for:

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
| `action`    | string | —       | `start` or `status` (not `stop` — only user can stop) |
| `url`       | string | —       | GitHub PR URL (alternative to owner+repo+pr_number) |
| `owner`     | string | —       | Repository owner (required for `start`)        |
| `repo`      | string | —       | Repository name (required for `start`)         |
| `pr_number` | number | —       | PR number (required for `start`)               |
| `mode`      | string | `all`   | Watch mode: `all`, `comments`, `conflicts`, `actions` |
| `interval`  | number | `60`    | Polling interval in seconds (minimum: 10)      |

## Requirements

- [Pi](https://github.com/mariozechner/pi-coding-agent) coding agent
- [gh](https://cli.github.com/) CLI installed and authenticated with access to the target repository

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
