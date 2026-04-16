# pi-ghpr-monitor

A [Pi](https://github.com/mariozechner/pi-coding-agent) extension that monitors GitHub Pull Requests and injects status updates into your agent session.

## What It Does

When you're working on a PR, you want your AI agent to stay informed about changes — new review comments, merge conflicts, CI failures — so it can take action automatically. This extension makes that possible by:

1. **Registering a `/ghpr-monitor` command** for direct user control
2. **Registering a `ghpr-monitor` tool** the LLM can invoke itself
3. **Polling the PR via the GitHub GraphQL API** (using `gh` CLI authentication)
4. **Injecting notifications** into the session as PR conditions change

The agent becomes a responsible PR partner: it knows about new comments, can respond to conflicts, and tracks CI status — all without you having to check the PR page.

## Installation

```bash
pi install git:github.com/v2nic/pi-ghpr-monitor
```

Or add to your project's `.pi/settings.json`:

```json
{
  "packages": ["git:github.com/v2nic/pi-ghpr-monitor"]
}
```

## Usage

### Command: `/ghpr-monitor`

```
/ghpr-monitor owner/repo 42    Start monitoring PR #42
/ghpr-monitor off              Stop monitoring
```

### Tool: `ghpr-monitor`

The agent can start/stop monitoring itself:

```
ghpr-monitor(action="start", owner="v2nic", repo="gh-pr-review", pr_number=42)
ghpr-monitor(action="stop")
ghpr-monitor(action="status")
```

### Typical Workflow

1. You start monitoring: `/ghpr-monitor v2nic/gh-pr-review 42` — or just tell the agent to watch the PR
2. The agent uses the `ghpr-monitor` tool and begins polling
3. When changes are detected, a notification is injected into the session:
   - **💬 New review comments** — the agent reads and addresses them
   - **⚠️ Merge conflicts** — the agent resolves them
   - **❌ Failing CI checks** — the agent fixes the issues
   - **✅ All checks pass** — the agent confirms it's ready to merge
4. You stop monitoring when done: `/ghpr-monitor off` or tell the agent to stop

## How It Works

The extension uses `gh api graphql` to poll the PR at a configurable interval (default: 60 seconds). It follows the same GraphQL query as [`gh pr-review await`](https://github.com/v2nic/gh-pr-review) from the parent project, checking for:

- **Unresolved review threads** — new comments that need attention
- **Merge conflicts** — the PR can't be merged
- **Failing CI checks** — builds or tests are broken
- **Pending CI checks** — checks still running

When conditions change between polls, it formats a human-readable update and injects it as a message into the active Pi session using `pi.sendMessage()` with a custom type (`ghpr-monitor`).

## Configuration

The tool accepts these parameters:

| Parameter   | Type   | Default | Description                                    |
|-------------|--------|---------|------------------------------------------------|
| `action`    | string | —       | `start`, `stop`, or `status`                   |
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

The project includes mock servers for validation testing:

- **Mock GitHub server** (`test/mock-github-server.ts`) — simulates the GitHub GraphQL API
- **Mock LLM server** (`test/mock-llm-server.ts`) — simulates an OpenAI-compatible API

See [test/README.md](test/README.md) for details on running integration tests.

## License

MIT