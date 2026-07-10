/**
 * Integration test runner for pi-ghpr-monitor
 *
 * Spawns a real Pi agent in tmux, loads the ghpr-monitor extension (now an
 * adapter around `gh monitor`), and captures actual TUI screenshots.
 *
 * Key design decisions:
 * - The adapter shells out to `gh monitor`; instead of mocking GitHub, we
 *   point the adapter at a MOCK `gh monitor` binary via GH_MONITOR_BIN. The
 *   mock binary emits a canned NDJSON event sequence (first-poll → new
 *   threads → failing CI → conflict → all-green → merged) so the screenshots
 *   are deterministic and need no network.
 * - GH_MONITOR_MOCK_EVENTS holds the canned event sequence (JSON array of
 *   Notification objects) the mock binary replays.
 * - The mock LLM server provides deterministic responses so the full agent
 *   flow works without a real provider.
 *
 * Run with: npx tsx test/integration/run-screenshots.ts ./screenshots
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MOCK_LLM_PORT = parseInt(process.env.MOCK_LLM_PORT || "9701", 10);
const SCREENSHOT_DIR = process.argv[2] || path.join(__dirname, "screenshots");
const PI_SESSION = "pi-ghpr-test";
const PI_DIR = path.join(__dirname, ".pi-integration");
const POLL_INTERVAL_SECS = 5;

const PR_LABEL = "v2nic/gh-pr-review#42";
const PR_URL = "https://github.com/v2nic/gh-pr-review/pull/42";

// Canned event sequence the mock `gh monitor` replays (gh-monitor template
// wording). The mock binary also emits a first-poll event constructed from
// its CLI args.
const MOCK_EVENTS = [
	{ type: "new-unresolved-threads", pr_label: PR_LABEL, message: `💬 2 unresolved review thread(s) on ${PR_LABEL}`, unresolved_threads: 2, general_comments: 1, detail: "src/foo.ts:10 (by reviewer1)\n  Please fix the typo in the README\n  Reply then resolve: gh monitor threads resolve --thread-id PRRT_mock_thread_0" },
	{ type: "new-failing-checks", pr_label: PR_LABEL, message: `❌ Failing CI checks on ${PR_LABEL}: ci/test`, failing_checks: ["ci/test"], unresolved_threads: 2, general_comments: 1 },
	{ type: "conflict", pr_label: PR_LABEL, message: `⚠️  Merge conflicts detected on ${PR_LABEL}`, unresolved_threads: 2, general_comments: 1 },
	{ type: "ci-all-green", pr_label: PR_LABEL, message: `✅ All CI checks passed on ${PR_LABEL}`, unresolved_threads: 0, general_comments: 0 },
	{ type: "merged", pr_label: PR_LABEL, message: `🔀 PR ${PR_LABEL} was merged. Monitoring stopped.`, pr_url: PR_URL },
];

// ---------------------------------------------------------------------------
// Mock `gh monitor` binary
// ---------------------------------------------------------------------------

/**
 * Write a mock `gh monitor` binary to a temp file. It replays the canned event
 * sequence from GH_MONITOR_MOCK_EVENTS (one event every ~2s after an initial
 * first-poll), and exits after a terminal event (merged/closed/run-completed).
 */
function writeMockGhMonitorBinary(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mock-ghmon-"));
	const file = path.join(dir, "mock-gh-monitor");
	const script = `#!/usr/bin/env node
const events = JSON.parse(process.env.GH_MONITOR_MOCK_EVENTS || "[]");
const args = process.argv.slice(2);
let ownerRepo = "", number = "", interval = "60";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "-R") ownerRepo = args[i+1];
  else if (args[i] === "--interval") interval = args[i+1];
  else if (!args[i].startsWith("-") && /^\\d+$/.test(args[i])) number = args[i];
}
const prLabel = number ? ownerRepo + "#" + number : ownerRepo;
const prUrl = number ? "https://github.com/" + ownerRepo + "/pull/" + number : "";
const emit = (o) => console.log(JSON.stringify(o));
emit({ type: "first-poll", pr_label: prLabel, message: "📡 Monitoring " + prLabel + " (polling every " + interval + "s)", pr_url: prUrl });
let i = 0;
const tick = () => {
  if (i >= events.length) return;
  const e = events[i++];
  emit(e);
  if (["merged","closed","run-completed","issue-closed"].includes(e.type)) process.exit(0);
  setTimeout(tick, 2000);
};
setTimeout(tick, 1000);
// Keep alive after the sequence until killed.
setInterval(() => {}, 1000);
`;
	fs.writeFileSync(file, script, { mode: 0o755 });
	return file;
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

function isPiAlive(tmuxSession: string): boolean {
	try {
		const output = execSync(`tmux capture-pane -t ${tmuxSession} -p -S -50`, { encoding: "utf-8" });
		if (output.includes("Node.js v") && output.match(/runner@.*\$/m)) return false;
		if (output.match(/runner@.*\$\s*$/m) && !output.includes("mock-llm")) return false;
		return true;
	} catch {
		return false;
	}
}

function sendPiCommand(tmuxSession: string, command: string): boolean {
	if (!isPiAlive(tmuxSession)) {
		console.error(`  💥 Pi is not running, skipping command: ${command}`);
		return false;
	}
	execSync(`tmux send-keys -t ${tmuxSession} Escape C-u`, { encoding: "utf-8", shell: "/bin/bash" });
	execSync(`sleep 0.1`, { encoding: "utf-8", shell: "/bin/bash" });
	tmuxType(tmuxSession, command);
	tmuxSend(tmuxSession, "");
	return true;
}

function waitForText(tmuxSession: string, text: string, timeoutMs: number = 30000): boolean {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		try {
			const output = execSync(`tmux capture-pane -t ${tmuxSession} -p -S -100`, { encoding: "utf-8" });
			if (output.includes(text)) {
				console.log(`  ⏱️  Found "${text.slice(0, 40)}" after ${Date.now() - start}ms`);
				return true;
			}
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
	fs.mkdirSync(PI_DIR, { recursive: true });
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
	"02-start-monitoring": "Start monitoring (first-poll)",
	"03-new-threads": "New unresolved review threads",
	"04-ci-failing": "CI check fails",
	"05-merge-conflicts": "Merge conflicts detected",
	"06-all-green": "All CI checks passed",
	"07-merged": "PR merged (monitor auto-stops)",
};

function buildScreenshotReport(files: string[]): string {
	const lines: string[] = [
		"# Tmux Screenshots",
		"",
		"Integration test with Pi + mock LLM server. Pi was started with the",
		"ghpr-monitor extension (a `gh monitor` adapter) pointed at a MOCK",
		"`gh monitor` binary (GH_MONITOR_BIN) that replays a canned NDJSON event",
		"sequence, plus a mock LLM server providing deterministic responses.",
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
		if (f !== ".gitignore") fs.unlinkSync(path.join(SCREENSHOT_DIR, f));
	}

	console.log("\n🚀 Starting pi-ghpr-monitor integration test\n");

	setupPiConfig();

	console.log("1. Writing mock `gh monitor` binary...");
	const mockBin = writeMockGhMonitorBinary();

	console.log("2. Starting mock LLM server...");
	const { createMockLLMServer } = await import("../mock-llm-server");
	const llmServer = createMockLLMServer(MOCK_LLM_PORT);
	await new Promise((r) => setTimeout(r, 300));

	console.log("3. Creating tmux session...");
	try { execSync(`tmux kill-session -t ${PI_SESSION} 2>/dev/null || true`); } catch {}
	execSync(`tmux new-session -d -s ${PI_SESSION} -x 160 -y 45`);
	await new Promise((r) => setTimeout(r, 500));

	const projectDir = path.resolve(path.join(__dirname, "..", ".."));
	console.log("Building extension bundle...");
	execSync(
		`cd ${projectDir} && npx esbuild src/index.ts --bundle --platform=node --target=node22 --outfile=dist/index.js --external:@mariozechner/pi-ai --external:@mariozechner/pi-tui --external:@mariozechner/pi-agent-core --external:@sinclair/typebox`,
		{ encoding: "utf-8", shell: "/bin/bash" },
	);

	// Start Pi in tmux with GH_MONITOR_BIN pointing at our mock binary and a
	// canned event sequence. The adapter shells out to that binary instead of
	// the real `gh monitor`.
	console.log("4. Starting Pi agent in tmux...");
	const mockEnv = `GH_MONITOR_BIN=${mockBin} GH_MONITOR_MOCK_EVENTS=${JSON.stringify(JSON.stringify(MOCK_EVENTS))}`;
	tmuxSend(
		PI_SESSION,
		`cd ${projectDir} && PI_CODING_AGENT_DIR=${PI_DIR} PI_OFFLINE=1 ${mockEnv} GHPR_MONITOR_INTERVAL_SECS=${POLL_INTERVAL_SECS} npx pi --provider mock --model mock-llm --no-session --extension ./dist/index.js`,
	);

	// SCENARIO 1: Extension loaded
	console.log("\n📋 Scenario 1: Extension loaded");
	const piReady = waitForText(PI_SESSION, "Extensions", 30000);
	if (!piReady) throw new Error("Pi failed to start within 30 seconds (no 'Extensions' text in TUI)");
	await new Promise((r) => setTimeout(r, 1000));
	captureScreenshot(PI_SESSION, "01-extension-loaded");
	assertScreenshotContains("01-extension-loaded", "Extensions");

	tmuxSend(PI_SESSION, "");
	await new Promise((r) => setTimeout(r, 500));

	// SCENARIO 2: Start monitoring
	console.log("\n📋 Scenario 2: Start monitoring");
	tmuxType(PI_SESSION, `/ghpr-monitor ${PR_URL}`);
	tmuxSend(PI_SESSION, "");
	const monitoringStarted = waitForText(PI_SESSION, "Monitoring", 20000);
	if (!monitoringStarted) throw new Error("ghpr-monitor extension did not start monitoring within 20 seconds");
	captureScreenshot(PI_SESSION, "02-start-monitoring");
	assertScreenshotContains("02-start-monitoring", "Monitoring");

	// SCENARIO 3: New unresolved threads
	console.log("\n📋 Scenario 3: New unresolved review threads");
	waitForText(PI_SESSION, "unresolved review thread", 15000);
	await new Promise((r) => setTimeout(r, 1500));
	captureScreenshot(PI_SESSION, "03-new-threads");

	// SCENARIO 4: CI failing
	console.log("\n📋 Scenario 4: CI check fails");
	waitForText(PI_SESSION, "Failing CI", 15000);
	await new Promise((r) => setTimeout(r, 1500));
	captureScreenshot(PI_SESSION, "04-ci-failing");

	// SCENARIO 5: Merge conflicts
	console.log("\n📋 Scenario 5: Merge conflicts detected");
	waitForText(PI_SESSION, "conflict", 15000);
	await new Promise((r) => setTimeout(r, 1500));
	captureScreenshot(PI_SESSION, "05-merge-conflicts");

	// SCENARIO 6: All green
	console.log("\n📋 Scenario 6: All CI checks passed");
	waitForText(PI_SESSION, "All CI checks passed", 15000);
	await new Promise((r) => setTimeout(r, 1500));
	captureScreenshot(PI_SESSION, "06-all-green");

	// SCENARIO 7: Merged (monitor auto-stops)
	console.log("\n📋 Scenario 7: PR merged (monitor auto-stops)");
	waitForText(PI_SESSION, "merged", 15000);
	await new Promise((r) => setTimeout(r, 1500));
	captureScreenshot(PI_SESSION, "07-merged");

	// Cleanup
	console.log("\n🧹 Cleaning up...");
	execSync(`tmux kill-session -t ${PI_SESSION} 2>/dev/null || true`);
	llmServer.close();
	fs.rmSync(path.dirname(mockBin), { recursive: true, force: true });

	console.log(`\n✅ Integration test complete! Screenshots saved to: ${SCREENSHOT_DIR}`);
	const files = fs.readdirSync(SCREENSHOT_DIR).filter((f) => f.endsWith(".txt")).sort();
	console.log("\nScreenshots captured:");
	for (const f of files) {
		const size = fs.statSync(path.join(SCREENSHOT_DIR, f)).size;
		console.log(`  ${f} (${size} bytes)`);
	}

	const screenshotHashes = new Set<string>();
	for (const f of files) {
		const content = fs.readFileSync(path.join(SCREENSHOT_DIR, f), "utf-8");
		const hash = content.slice(0, 200) + content.slice(-200);
		screenshotHashes.add(hash);
	}
	if (screenshotHashes.size <= 2 && files.length > 3) {
		console.warn(`\n⚠️  WARNING: Only ${screenshotHashes.size} unique screenshot(s) out of ${files.length} files. Scenarios may not be producing distinct output.`);
	}

	const report = buildScreenshotReport(files);
	const reportPath = path.join(SCREENSHOT_DIR, "screenshots-report.md");
	fs.writeFileSync(reportPath, report + "\n");
	console.log(`\n📄 Screenshot report written to: ${reportPath}`);

	const MAX_CHECK_SUMMARY = 65000;
	const truncatedReport = report.length > MAX_CHECK_SUMMARY
		? report.slice(0, MAX_CHECK_SUMMARY) + "\n\n... (see the tmux-screenshots artifact for full output)"
		: report;
	fs.writeFileSync(path.join(SCREENSHOT_DIR, "screenshots-report-truncated.md"), truncatedReport + "\n");

	const stepSummary = process.env.GITHUB_STEP_SUMMARY;
	if (stepSummary) {
		fs.appendFileSync(stepSummary, report + "\n");
		console.log("📄 Report appended to GITHUB_STEP_SUMMARY");
	}
}

main().catch((err) => {
	console.error("❌ Integration test failed:", err);
	try { execSync(`tmux kill-session -t ${PI_SESSION} 2>/dev/null || true`); } catch {}
	process.exit(1);
});