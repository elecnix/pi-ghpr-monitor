---
name: ghpr-monitor
description: Monitor a GitHub PR for comments, conflicts, and CI failures. Use when asked to watch a PR, monitor CI, track review comments, or wait for PR updates. Triggers on "monitor PR", "watch PR", "track PR status", "keep an eye on".
---

# GH PR Monitor Skill

This skill provides the `ghpr-monitor` tool and `/ghpr-monitor` command for monitoring GitHub pull requests.

## Quick Start

### Start monitoring a PR

```
/ghpr-monitor v2nic/gh-pr-review 42
```

Or tell the agent to start monitoring:

> "Monitor PR #42 on v2nic/gh-pr-review"

The agent will invoke `ghpr-monitor` with action `start`.

### Stop monitoring

```
/ghpr-monitor off
```

Or tell the agent:

> "Stop monitoring the PR"

The agent will invoke `ghpr-monitor` with action `stop`.

### Check status

> "What's the monitoring status?"

The agent will invoke `ghpr-monitor` with action `status`.

## How It Works

1. The monitor polls the GitHub PR at regular intervals (default: 60 seconds)
2. It checks for:
   - Unresolved review threads (new comments)
   - Merge conflicts
   - Failing CI checks
   - Pending CI checks
3. When changes are detected, it injects a notification into your session
4. The agent sees the notification and can take action (respond to comments, fix conflicts, etc.)

## Parameters

- **owner** — Repository owner (required for start)
- **repo** — Repository name (required for start)
- **pr_number** — Pull request number (required for start)
- **mode** — What to watch: `all`, `comments`, `conflicts`, `actions` (default: `all`)
- **interval** — Polling interval in seconds (default: 60, minimum: 10)

## Requirements

- `gh` CLI must be installed and authenticated
- The extension must be loaded in Pi (install from `v2nic/pi-ghpr-monitor`)