# Test Plan for pi-ghpr-monitor

## Unit Tests

Located in `test/analyzer.test.ts` — tests the pure PR analysis logic:

| Test | Description |
|------|-------------|
| `countUnresolvedThreads` | Returns 0 for empty, counts unresolved only |
| `hasConflicts` | Detects CONFLICTING status |
| `failingChecks` | Detects FAILURE/ERROR/TIMED_OUT conclusions |
| `pendingChecks` | Detects IN_PROGRESS/QUEUED statuses |
| `formatStatusUpdate` | Formats messages for all conditions |

Run with: `npm test`

## Mock Servers

### Mock GitHub Server (`test/mock-github-server.ts`)

Simulates the GitHub GraphQL API for testing without real GitHub access.

Endpoints:
- `POST /graphql` — Returns mock PR data (review threads, comments, check suites, merge status)
- `GET /state` — Get current mock state
- `PUT /state` — Update mock state (simulate PR changes)
- `POST /reset` — Reset to default state

Start standalone: `npx tsx test/mock-github-server.ts [port]`

Default state:
- 2 unresolved threads, 1 general comment
- `ci/test` pending, `ci/build` passing
- No merge conflicts, no failing checks

### Mock LLM Server (`test/mock-llm-server.ts`)

Simulates an OpenAI-compatible chat completions API for testing Pi integration.

Endpoints:
- `POST /v1/chat/completions` — Chat completion with tool call support
- `GET /v1/models` — List models
- `GET /test/messages` — Inspect received messages
- `POST /test/reset` — Reset state

Start standalone: `npx tsx test/mock-llm-server.ts [port]`

Behavior:
- Returns tool calls when "monitor" keyword is detected
- Responds to ghpr-monitor notifications with acknowledgment

## Integration Tests

### tmux Screenshot Tests (`test/integration/`)

Runs against mock servers and captures tmux screenshots for all user stories:

| Scenario | Description |
|----------|-------------|
| 01 Extension loaded | Shows available commands |
| 02 Start monitoring | `/ghpr-monitor` command |
| 03 Initial PR status | Pending CI + unresolved threads |
| 04 New comment arrives | Increase thread count |
| 05 CI fails | Failing checks detected |
| 06 Merge conflicts | CONFLICTING mergeable status |
| 07 All resolved | Everything passing, no threads |
| 08 Stop monitoring | `/ghpr-monitor off` |
| 09 Final status | Show resolved PR state |
| 10 Error handling | API error scenarios |
| 11 Summary | All screenshots listed |

Run: `node test/integration/run-screenshots.js [output-dir]`

Results are saved as text screenshots in `test/integration/screenshots/`.

## GitHub Actions CI

The CI workflow (`.github/workflows/ci.yml`) runs:
1. Unit tests (`npm test`)
2. Integration tests with tmux screenshots
3. Uploads screenshots as artifacts

## Manual Testing with Pi

1. Install the extension: `pi -e ./src/index.ts`
2. Or install as a package: `pi install .`
3. Use the `/ghpr-monitor` command or ask the agent to monitor a PR
4. The agent will use the `ghpr-monitor` tool to start monitoring

### Test with mock server

1. Start mock GitHub server: `npx tsx test/mock-github-server.ts`
2. Set `GH_GH_MOCK_URL=http://localhost:9700` environment variable
3. Run Pi with the extension: `pi -e ./src/index.ts`
4. The extension will use the mock server instead of `gh api graphql`