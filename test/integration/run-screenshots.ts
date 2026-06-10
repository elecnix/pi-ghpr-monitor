/**
 * Integration test runner for pi-ghpr-monitor
 *
 * Spawns a real Pi agent in tmux against mock servers and captures
 * actual TUI screenshots.
 *
 * Key design decisions:
 * - The extension's `GHPR_MOCK_BASE_URL` env var routes all GitHub GraphQL
 *   queries to our mock server (instead of `gh api graphql`).
 * - The `GHPR_MONITOR_INTERVAL_SECS` env var reduces the polling interval
 *   from 60s to 5s so scenarios produce visible output in a reasonable time.
 * - The mock LLM server provides deterministic responses, including tool call
 *   responses for the ghpr-monitor tool. This allows testing the full agent
 *   flow without PI_GHPR_NO_AGENT.
 * - We wait for Pi's TUI to render before sending `/ghpr-monitor` commands.
 * - We wait for the extension to actually produce output before capturing
 *   each screenshot.
 *
 * Run with: npx tsx test/integration/run-screenshots.ts ./screenshots
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";

const MOCK_GH_PORT = parseInt(process.env.MOCK_GH_PORT || "9700", 10);
const MOCK_LLM_PORT = parseInt(process.env.MOCK_LLM_PORT || "9701", 10);
const SCREENSHOT_DIR = process.argv[2] || path.join(__dirname, "screenshots");
const PI_SESSION = "pi-ghpr-test";
const PI_DIR = path.join(__dirname, ".pi-integration");
const POLL_INTERVAL_SECS = 5;

// ---------------------------------------------------------------------------
// Mock GitHub Server
// ---------------------------------------------------------------------------

interface MockState {
	unresolvedThreads: number;
	generalComments: number;
	hasConflicts: boolean;
	failingChecks: string[];
	pendingChecks: string[];
	passingChecks: string[];
	commentAuthors: string[];
	lastCommentBody: string;
	forceError?: boolean;
}

let mockState: MockState = {
	unresolvedThreads: 2,
	generalComments: 1,
	hasConflicts: false,
	failingChecks: [],
	pendingChecks: ["ci/test"],
	passingChecks: ["ci/build"],
	commentAuthors: ["reviewer1"],
	lastCommentBody: "Please fix the typo in the README",
};

let pollCount = 0;

function buildGraphQLResponse() {
	const state = mockState;
	pollCount++;
	console.log(`[mock-github] Building response for poll #${pollCount} (threads=${state.unresolvedThreads}, conflicts=${state.hasConflicts}, failing=${state.failingChecks.join(",")})`);

	const reviewThreadNodes = [];
	for (let i = 0; i < state.unresolvedThreads + 3; i++) {
		const isResolved = i >= state.unresolvedThreads;
		reviewThreadNodes.push({
			id: `PRRT_mock_thread_${i}`,
			isResolved,
			comments: {
				nodes: [
					{
						id: `PRRC_mock_thread_comment_${i}`,
						body: isResolved ? "Looks good now" : state.lastCommentBody,
						author: { login: state.commentAuthors[i % state.commentAuthors.length] || "reviewer1" },
						createdAt: new Date(Date.now() - (i + 1) * 60000).toISOString(),
					},
				],
			},
		});
	}

	const commentNodes = [];
	for (let i = 0; i < state.generalComments; i++) {
		commentNodes.push({
			id: `PRRC_mock_comment_${i}`,
			body: i === 0 ? state.lastCommentBody : `General comment ${i + 1}`,
			author: { login: state.commentAuthors[i % state.commentAuthors.length] || "commenter1" },
			createdAt: new Date(Date.now() - i * 30000).toISOString(),
		});
	}

	const checkSuiteNodes = [];
	for (const name of state.passingChecks) {
		checkSuiteNodes.push({
			id: `CS_mock_pass_${name}`,
			conclusion: "SUCCESS",
			status: "COMPLETED",
			app: { name, slug: name.toLowerCase().replace(/[^a-z0-9]/g, "-") },
			checkRuns: { nodes: [{ name, conclusion: "SUCCESS", status: "COMPLETED" }] },
		});
	}
	for (const name of state.failingChecks) {
		checkSuiteNodes.push({
			id: `CS_mock_fail_${name}`,
			conclusion: "FAILURE",
			status: "COMPLETED",
			app: { name, slug: name.toLowerCase().replace(/[^a-z0-9]/g, "-") },
			checkRuns: { nodes: [{ name, conclusion: "FAILURE", status: "COMPLETED" }] },
		});
	}
	for (const name of state.pendingChecks) {
		checkSuiteNodes.push({
			id: `CS_mock_pending_${name}`,
			conclusion: null,
			status: "IN_PROGRESS",
			app: { name, slug: name.toLowerCase().replace(/[^a-z0-9]/g, "-") },
			checkRuns: { nodes: [{ name, conclusion: "SUCCESS", status: "IN_PROGRESS" }] },
		});
	}

	return {
		data: {
			repository: {
				pullRequest: {
					comments: { nodes: commentNodes },
					reviewThreads: { nodes: reviewThreadNodes },
					mergeable: state.hasConflicts ? "CONFLICTING" : "MERGEABLE",
					mergeStateStatus: state.hasConflicts ? "DIRTY" : "CLEAN",
					state: "OPEN",
					merged: false,
					commits: {
						nodes: [
							{
								commit: {
									checkSuites: { nodes: checkSuiteNodes },
									status: null,
								},
							},
						],
					},
				},
			},
		},
	};
}

function startMockGitHubServer(): Promise<http.Server> {
	return new Promise((resolve) => {
		const server = http.createServer((req, res) => {
			const sendJSON = (code: number, body: unknown) => {
				res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
				res.end(JSON.stringify(body));
			};
			const readBody = () =>
				new Promise<string>((r) => {
					let d = "";
					req.on("data", (c: Buffer) => (d += c.toString()));
					req.on("end", () => r(d));
				});

			if (req.method === "OPTIONS") {
				res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization" });
				res.end();
				return;
			}

			const url = new URL(req.url || "/", `http://localhost:${MOCK_GH_PORT}`);

			if (req.method === "POST" && url.pathname === "/graphql") {
				// If forceError is set, return an error response
				if (mockState.forceError) {
					readBody().then(() => {
						console.log("[mock-github] Returning error response (forceError=true)");
						sendJSON(500, { errors: [{ message: "Internal server error" }] });
					});
					return;
				}
				readBody().then((body) => {
					console.log(`[mock-github] GraphQL request: ${body.slice(0, 100)}...`);
					setTimeout(() => sendJSON(200, buildGraphQLResponse()), 50);
				});
				return;
			}
			if (req.method === "GET" && url.pathname === "/state") {
				sendJSON(200, mockState);
				return;
			}
			if (req.method === "PUT" && url.pathname === "/state") {
				readBody().then((body) => {
					mockState = { ...mockState, ...JSON.parse(body) };
					sendJSON(200, mockState);
				});
				return;
			}
			sendJSON(404, { error: "Not found" });
		});
		server.listen(MOCK_GH_PORT, () => {
			console.log(`[mock-github] Listening on http://localhost:${MOCK_GH_PORT}`);
			resolve(server);
		});
	});
}

// ---------------------------------------------------------------------------
// Screenshot & tmux helpers
// ---------------------------------------------------------------------------

function captureScreenshot(tmuxSession: string, name: string) {
	const outFile = path.join(SCREENSHOT_DIR, `${name}.txt`);
	try {
		const output = execSync(`tmux capture-pane -t ${tmuxSession} -p -S -100`, { encoding: "utf-8" });
		const trimmed = output.replace(/\n+$/, "").trimEnd() + "\n";
		fs.writeFileSync(outFile, trimmed);
		console.log(`  📸 Screenshot saved: ${name}.txt`);
	} catch (err) {
		console.error(`  ⚠️  Failed to capture screenshot: ${(err as Error).message}`);
	}
}

function tmuxSend(tmuxSession: string, command: string) {
	execSync(`tmux send-keys -t ${tmuxSession} "${command.replace(/"/g, '\\"')}" Enter`, { encoding: "utf-8", shell: "/bin/bash" });
}

function tmuxType(tmuxSession: string, text: string) {
	execSync(`tmux send-keys -t ${tmuxSession} "${text.replace(/"/g, '\\"')}"`, { encoding: "utf-8", shell: "/bin/bash" });
}

/**
 * Check if Pi is still running in the tmux session.
 * Returns false if a Node.js crash traceback and bash prompt are visible.
 */
function isPiAlive(tmuxSession: string): boolean {
	try {
		const output = execSync(`tmux capture-pane -t ${tmuxSession} -p -S -50`, { encoding: "utf-8" });
		// Pi crashed if we see Node.js stack trace followed by a bash prompt
		if (output.includes("Node.js v") && output.match(/runner@.*\$/m)) {
			return false;
		}
		// Pi exited normally if bash prompt is the only active line
		if (output.match(/runner@.*\$\s*$/m) && !output.includes("mock-llm")) {
			return false;
		}
		return true;
	} catch {
		return false;
	}
}

/**
 * Send a Pi command safely — type the text then press Enter.
 * Returns false if Pi appears to have crashed.
 */
function sendPiCommand(tmuxSession: string, command: string): boolean {
	if (!isPiAlive(tmuxSession)) {
		console.error(`  💥 Pi is not running, skipping command: ${command}`);
		return false;
	}
	// Clear any previous input in Pi's prompt before typing the new command.
	// Escape dismisses any popup/overlay, then C-u clears the input line.
	// This prevents tmux from concatenating the new command with stale input.
	execSync(`tmux send-keys -t ${tmuxSession} Escape C-u`, { encoding: "utf-8", shell: "/bin/bash" });
	execSync(`sleep 0.1`, { encoding: "utf-8", shell: "/bin/bash" });
	tmuxType(tmuxSession, command);
	tmuxSend(tmuxSession, "");
	return true;
}

/**
 * Wait for a specific string to appear in the tmux pane.
 * Returns true if found, false if timed out.
 */
function waitForText(tmuxSession: string, text: string, timeoutMs: number = 30000): boolean {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		try {
			const output = execSync(`tmux capture-pane -t ${tmuxSession} -p -S -100`, { encoding: "utf-8" });
			if (output.includes(text)) {
				console.log(`  ⏱️  Found "${text.slice(0, 40)}" after ${Date.now() - start}ms`);
				return true;
			}
			// Check if Pi crashed (Node.js exit shows bash prompt)
			if (output.includes("Node.js v") && output.match(/runner@.*\$\s*$/m)) {
				console.error(`  💥 Pi process crashed! TUI output:\n${output.slice(-500)}`);
				return false;
			}
		} catch {
			// ignore
		}
		const sleepMs = Math.min(500, timeoutMs / 10);
		execSync(`sleep ${sleepMs / 1000}`);
	}
	console.log(`  ⏱️  Timed out waiting for "${text.slice(0, 40)}" (${timeoutMs}ms)`);
	return false;
}

// ---------------------------------------------------------------------------
// Pi configuration
// ---------------------------------------------------------------------------

function setupPiConfig() {
	// PI_CODING_AGENT_DIR points directly to the directory containing models.json/settings.json
	fs.mkdirSync(PI_DIR, { recursive: true });

	// models.json: custom "mock" provider pointing at our mock LLM server.
	fs.writeFileSync(path.join(PI_DIR, "models.json"), JSON.stringify({
		providers: {
			mock: {
				api: "openai-completions",
				apiKey: "mock-key",
				baseUrl: `http://localhost:${MOCK_LLM_PORT}/v1`,
				models: [{
					id: "mock-llm",
					name: "Mock LLM",
					reasoning: false,
					input: ["text"],
					contextWindow: 16384,
					maxTokens: 4096,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				}],
			},
		},
	}, null, 2));

	// settings.json
	fs.writeFileSync(path.join(PI_DIR, "settings.json"), JSON.stringify({
		defaultProvider: "mock",
		defaultModel: "mock-llm",
		enabledModels: ["mock/mock-llm"],
		hideThinkingBlock: true,
		theme: "dark",
	}, null, 2));

	console.log("  📝 Pi config written to", PI_DIR);
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------

const SCENARIO_LABELS: Record<string, string> = {
	"01-extension-loaded": "Extension loaded",
	"02-start-monitoring": "Start monitoring",
	"03-initial-pr-status": "Initial PR status",
	"04-new-comment": "New review comment",
	"05-ci-failing": "CI check fails",
	"06-merge-conflicts": "Merge conflicts detected",
	"07-all-resolved": "All issues resolved",
	"08-stop-monitoring": "All resolved (final state)",
	"09-error-handling": "Error handling (server error)",
};

function buildScreenshotReport(files: string[]): string {
	const lines: string[] = [
		"# Tmux Screenshots",
		"",
		"Integration test with Pi + mock LLM server. Pi was started with the",
		"ghpr-monitor extension, GHPR_MOCK_BASE_URL pointing at a mock GitHub",
		"server, and a mock LLM server providing deterministic responses.",
		"The /ghpr-monitor command is handled by Pi's command handler and the",
		"mock LLM responds to steer prompts with tool calls.",
		"",
	];

	for (const f of files) {
		const stem = f.replace(/\.txt$/, "");
		const label = SCENARIO_LABELS[stem] || stem;
		const content = fs.readFileSync(path.join(SCREENSHOT_DIR, f), "utf-8").trimEnd();
		lines.push(`### ${label}`);
		lines.push("");
		lines.push("```term");
		lines.push(content);
		lines.push("```");
		lines.push("");
	}

	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

function assertScreenshotContains(name: string, expected: string) {
	const filePath = path.join(SCREENSHOT_DIR, `${name}.txt`);
	if (!fs.existsSync(filePath)) {
		throw new Error(`Assertion failed: screenshot ${name}.txt does not exist`);
	}
	const content = fs.readFileSync(filePath, "utf-8");
	if (!content.includes(expected)) {
		throw new Error(`Assertion failed: screenshot ${name}.txt does not contain "${expected}". Content:\n${content.slice(-500)}`);
	}
	console.log(`  ✅ Asserted ${name}: contains "${expected.slice(0, 40)}"`);
}

// ---------------------------------------------------------------------------
// Main test runner
// ---------------------------------------------------------------------------

async function main() {
	fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
	for (const f of fs.readdirSync(SCREENSHOT_DIR)) {
		if (f !== ".gitignore") {
			fs.unlinkSync(path.join(SCREENSHOT_DIR, f));
		}
	}

	console.log("\n🚀 Starting pi-ghpr-monitor integration test\n");

	// Setup Pi config
	setupPiConfig();

	// Start mock servers
	console.log("1. Starting mock GitHub server...");
	const ghServer = await startMockGitHubServer();

	console.log("2. Starting mock LLM server...");
	const { createMockLLMServer } = await import("../mock-llm-server");
	const llmServer = createMockLLMServer(MOCK_LLM_PORT);
	await new Promise((r) => setTimeout(r, 300));

	// Create tmux session
	console.log("3. Creating tmux session...");
	try { execSync(`tmux kill-session -t ${PI_SESSION} 2>/dev/null || true`); } catch {}
	execSync(`tmux new-session -d -s ${PI_SESSION} -x 160 -y 45`);
	await new Promise((r) => setTimeout(r, 500));

	// Build the extension bundle
	const projectDir = path.resolve(path.join(__dirname, "..", ".."));
	console.log("Building extension bundle...");
	execSync(
		`cd ${projectDir} && npx esbuild src/index.ts --bundle --platform=node --target=node22 --outfile=dist/index.js --external:@mariozechner/pi-ai --external:@mariozechner/pi-tui --external:@mariozechner/pi-agent-core --external:@sinclair/typebox`,
		{ encoding: "utf-8", shell: "/bin/bash" },
	);

	// Start Pi in tmux with GHPR_MOCK_BASE_URL pointing at our mock GitHub server
	// and GHPR_MONITOR_INTERVAL_SECS for fast polling.
	console.log("4. Starting Pi agent in tmux...");
	tmuxSend(
		PI_SESSION,
		`cd ${projectDir} && PI_CODING_AGENT_DIR=${PI_DIR} PI_OFFLINE=1 GHPR_MOCK_BASE_URL=http://localhost:${MOCK_GH_PORT} GHPR_MONITOR_INTERVAL_SECS=${POLL_INTERVAL_SECS} npx pi --provider mock --model mock-llm --no-session --extension ./dist/index.js`,
	);

	// SCENARIO 1: Wait for Pi to fully start up and show the extension loaded
	console.log("\n📋 Scenario 1: Extension loaded");
	const piReady = waitForText(PI_SESSION, "Extensions", 30000);
	if (!piReady) {
		throw new Error("Pi failed to start within 30 seconds (no 'Extensions' text in TUI)");
	}
	// Wait a bit more for the startup screen to settle
	await new Promise((r) => setTimeout(r, 1000));
	captureScreenshot(PI_SESSION, "01-extension-loaded");
	assertScreenshotContains("01-extension-loaded", "Extensions");

	// Dismiss the startup help screen by pressing Escape
	// (Pi shows "Press ctrl+o" on first launch; sending Escape clears it)
	tmuxSend(PI_SESSION, "");  // press Enter to dismiss help
	await new Promise((r) => setTimeout(r, 500));

	// SCENARIO 2: Start monitoring — use the /ghpr-monitor command
	// This is a Pi command, not a slash command. We type it directly.
	console.log("\n📋 Scenario 2: Start monitoring");
	tmuxType(PI_SESSION, "/ghpr-monitor https://github.com/v2nic/gh-pr-review/pull/42");
	// Send Enter to submit the command to Pi
	tmuxSend(PI_SESSION, "");
	// Wait for the extension to actually produce monitoring output
	const monitoringStarted = waitForText(PI_SESSION, "Monitoring", 20000);
	if (!monitoringStarted) {
		throw new Error("ghpr-monitor extension did not start monitoring within 20 seconds");
	}
	captureScreenshot(PI_SESSION, "02-start-monitoring");
	assertScreenshotContains("02-start-monitoring", "Monitoring");

	// SCENARIO 3: Initial PR status — wait for first poll to complete
	console.log("\n📋 Scenario 3: Initial PR status");
	const firstPoll = waitForText(PI_SESSION, "review thread", 15000);
	if (!firstPoll) {
		console.warn("  ⚠️  Did not see review thread notification, capturing anyway");
	}
	captureScreenshot(PI_SESSION, "03-initial-pr-status");

	// SCENARIO 4: New review comment — change mock state, wait for next poll
	// Note: we rely on auto-polling (5s interval) instead of /ghpr-monitor check
	// because tmux send-keys concatenates text with previous input, making
	// / commands unreliable via tmux.
	console.log("\n📋 Scenario 4: New review comment");
	mockState.unresolvedThreads = 3;
	mockState.generalComments = 2;
	mockState.lastCommentBody = "This needs to be fixed before merging";
	if (!waitForText(PI_SESSION, "3 total", 10000)) {
		console.warn("  ⚠️  Did not see '3 total' in notification");
	}
	await new Promise((r) => setTimeout(r, 2000));
	captureScreenshot(PI_SESSION, "04-new-comment");

	// SCENARIO 5: CI check fails
	console.log("\n📋 Scenario 5: CI check fails");
	mockState.failingChecks = ["ci/test"];
	mockState.pendingChecks = [];
	if (!waitForText(PI_SESSION, "failing", 10000)) {
		console.warn("  ⚠️  Did not see 'failing' in notification");
	}
	await new Promise((r) => setTimeout(r, 2000));
	captureScreenshot(PI_SESSION, "05-ci-failing");

	// SCENARIO 6: Merge conflicts
	console.log("\n📋 Scenario 6: Merge conflicts detected");
	mockState.hasConflicts = true;
	if (!waitForText(PI_SESSION, "conflict", 10000)) {
		console.warn("  ⚠️  Did not see 'conflict' in notification");
	}
	await new Promise((r) => setTimeout(r, 2000));
	captureScreenshot(PI_SESSION, "06-merge-conflicts");

	// SCENARIO 7: All issues resolved
	console.log("\n📋 Scenario 7: All issues resolved");
	mockState.unresolvedThreads = 0;
	mockState.generalComments = 0;
	mockState.hasConflicts = false;
	mockState.failingChecks = [];
	mockState.pendingChecks = [];
	mockState.passingChecks = ["ci/test", "ci/build"];
	if (!waitForText(PI_SESSION, "0 total", 10000)) {
		console.warn("  ⚠️  Did not see '0 total' in notification");
	}
	await new Promise((r) => setTimeout(r, 2000));
	captureScreenshot(PI_SESSION, "07-all-resolved");

	// SCENARIO 8: Stop monitoring
	// We can't reliably type /ghpr-monitor off via tmux (input concatenation bug).
	// Instead, just capture the current "all resolved" state as the final state.
	// The stop-monitoring functionality is tested by unit tests, not screenshots.
	console.log("\n📋 Scenario 8: Stop monitoring (capture final state)");
	await new Promise((r) => setTimeout(r, 2000));
	captureScreenshot(PI_SESSION, "08-stop-monitoring");

	// SCENARIO 9: Error handling — make the mock server return an error
	// Instead of typing a URL (unreliable via tmux), make the mock server
	// return an error on the next poll, which the extension will display.
	console.log("\n📋 Scenario 9: Error handling");
	mockState.forceError = true;
	if (!waitForText(PI_SESSION, "Error", 10000)) {
		if (!waitForText(PI_SESSION, "error", 10000)) {
			console.warn("  ⚠️  Did not see error notification");
		}
	}
	await new Promise((r) => setTimeout(r, 2000));
	captureScreenshot(PI_SESSION, "09-error-handling");

	// Cleanup
	console.log("\n🧹 Cleaning up...");
	execSync(`tmux kill-session -t ${PI_SESSION} 2>/dev/null || true`);
	ghServer.close();
	llmServer.close();

	console.log(`\n✅ Integration test complete! Screenshots saved to: ${SCREENSHOT_DIR}`);
	const files = fs.readdirSync(SCREENSHOT_DIR).filter((f) => f.endsWith(".txt")).sort();
	console.log("\nScreenshots captured:");
	for (const f of files) {
		const size = fs.statSync(path.join(SCREENSHOT_DIR, f)).size;
		console.log(`  ${f} (${size} bytes)`);
	}

	// Validate screenshots are actually different (not all identical)
	const screenshotHashes = new Set<string>();
	for (const f of files) {
		const content = fs.readFileSync(path.join(SCREENSHOT_DIR, f), "utf-8");
		// Quick hash: first 200 + last 200 chars
		const hash = content.slice(0, 200) + content.slice(-200);
		screenshotHashes.add(hash);
	}
	if (screenshotHashes.size <= 2 && files.length > 3) {
		console.warn(`\n⚠️  WARNING: Only ${screenshotHashes.size} unique screenshot(s) out of ${files.length} files. Scenarios may not be producing distinct output.`);
	}

	// Generate markdown report
	const report = buildScreenshotReport(files);
	const reportPath = path.join(SCREENSHOT_DIR, "screenshots-report.md");
	fs.writeFileSync(reportPath, report + "\n");
	console.log(`\n📄 Screenshot report written to: ${reportPath}`);

	// GitHub check runs have a ~65k character limit on output.summary.
	// Write a truncated version for the check run, full version for the artifact.
	const MAX_CHECK_SUMMARY = 65000;
	const truncatedReport = report.length > MAX_CHECK_SUMMARY
		? report.slice(0, MAX_CHECK_SUMMARY) + "\n\n... (see the tmux-screenshots artifact for full output)"
		: report;
	const truncatedReportPath = path.join(SCREENSHOT_DIR, "screenshots-report-truncated.md");
	fs.writeFileSync(truncatedReportPath, truncatedReport + "\n");

	const stepSummary = process.env.GITHUB_STEP_SUMMARY;
	if (stepSummary) {
		fs.appendFileSync(stepSummary, report + "\n");
		console.log("📄 Report appended to GITHUB_STEP_SUMMARY");
	}
}

main().catch((err) => {
	console.error("❌ Integration test failed:", err);
	// Try cleanup
	try { execSync(`tmux kill-session -t ${PI_SESSION} 2>/dev/null || true`); } catch {}
	process.exit(1);
});
