/**
 * Structural tests — verify key architecture patterns are present in src/index.ts.
 *
 * These are white-box tests: they read the source and ensure critical
 * logic patterns exist. If a fix is accidentally reverted, the test
 * fails with a clear message.
 *
 * Updated for multi-PR monitoring architecture.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const src = fs.readFileSync(
  path.join(__dirname, "..", "src", "index.ts"),
  "utf-8",
);

describe("multi-PR monitoring architecture", () => {
	it("uses a Map<string, ActiveMonitor> instead of a single monitorState", () => {
		expect(src).toContain("monitors: Map<string, ActiveMonitor>");
	});

	it("defines the ActiveMonitor interface with per-monitor state", () => {
		expect(src).toContain("interface ActiveMonitor");
		expect(src).toContain("lastStatus: PRStatus | null");
		expect(src).toContain("lastStatusTimestamp: Date | null");
		expect(src).toContain("backoffSec: number");
		expect(src).toContain("consecutiveNoChange: number");
		expect(src).toContain("controller: AbortController");
		expect(src).toContain("forceNotify: boolean");
		expect(src).toContain("needsReminder: boolean");
	});

	it("startMonitor adds to the map instead of replacing", () => {
		const startFn = src.slice(
			src.indexOf("function startMonitor(config: MonitorConfig)"),
			src.indexOf("function stopMonitorByKey"),
		);
		expect(startFn).toContain("monitors.set(key, mon)");
		expect(startFn).toContain("monitors.has(key)");
		expect(startFn).not.toContain("stopMonitor()"); // must NOT stop existing monitors
	});

	it("supports stopping individual monitors by key", () => {
		expect(src).toContain("function stopMonitorByKey(key: string)");
		expect(src).toContain("monitors.delete(key)");
	});

	it("supports stopping all monitors", () => {
		expect(src).toContain("function stopAllMonitors()");
		expect(src).toContain("monitors.clear()");
	});

	it("generates a unique key per PR", () => {
		expect(src).toContain("function prKey(");
		expect(src).toContain("export function prKey");
	});

	it("footer aggregates all monitored PRs", () => {
		expect(src).toContain("monitors.size");
		expect(src).toContain("issuesCount");
		expect(src).toContain("clearCount");
	});

	it("pollLoop takes an ActiveMonitor parameter instead of separate config+signal", () => {
		expect(src).toContain("async function pollLoop(mon: ActiveMonitor)");
	});

	it("merged/closed PR removes from monitors map", () => {
		expect(src).toContain("monitors.delete(key)");
	});

	it("session_shutdown stops all monitors", () => {
		expect(src).toContain("stopAllMonitors()");
	});

	it("tool supports stop action for LLM to stop a specific monitor", () => {
		const actionMatch = src.match(/action:\s*StringEnum\(\[([^\]]+)\]/);
		expect(actionMatch).not.toBeNull();
		const actions = actionMatch![1];
		expect(actions).toContain("start");
		expect(actions).toContain("status");
		expect(actions).toContain("check");
		expect(actions).toContain("stop");
	});

	it("command supports off with optional PR identifier", () => {
		expect(src).toContain("resolveMonitorKey");
	});

	it("steering prompt mentions multi-PR capability", () => {
		expect(src).toContain("Multiple PRs can be monitored simultaneously");
	});
});

describe("forceNotify fix", () => {
	it("forceNotify is per-monitor state in ActiveMonitor", () => {
		expect(src).toContain("forceNotify: boolean");
	});

	it("sets forceNotify = true in /ghpr-monitor check command", () => {
		// Check that forceNotify is set on the monitor object
		expect(src).toContain("mon.forceNotify = true");
	});

	it("sets forceNotify = true in tool check action", () => {
		expect(src).toContain("mon.forceNotify = true");
	});

	it("forceNotify block sends actionable items or all-clear via enriched notification", () => {
		const block = src.slice(
			src.indexOf("if (mon.forceNotify && !agentTurnActive)"),
			src.indexOf("Periodic nudge"),
		);
		expect(block).toContain("formatActionableItems(curr, config)");
		expect(block).toContain("formatAgentNotification(curr, config)");
		expect(block).toContain("sendPRNotification");
		expect(block).toContain("queuedForceCheck");
	});

	it("forceNotify block cleared after use", () => {
		const block = src.slice(
			src.indexOf("if (mon.forceNotify && !agentTurnActive)"),
			src.indexOf("Periodic nudge"),
		);
		expect(block).toContain("mon.forceNotify = false");
	});
});

describe("per-monitor state isolation", () => {
	it("each ActiveMonitor has its own backoff state", () => {
		expect(src).toMatch(/backoffSec:\s*number/);
	});

	it("each ActiveMonitor has its own lastStatus", () => {
		expect(src).toMatch(/lastStatus:\s*PRStatus \| null/);
	});

	it("each ActiveMonitor has its own pollWakeResolve", () => {
		expect(src).toMatch(/pollWakeResolve:\s*\(\(\) => void\) \| null/);
	});

	it("each ActiveMonitor has its own consecutiveNoChange counter", () => {
		expect(src).toMatch(/consecutiveNoChange:\s*number/);
	});

	it("check command resets backoff per specific monitor", () => {
		// When checking a specific monitor, only that monitor's state is reset
		expect(src).toContain("mon.backoffSec = 0");
		expect(src).toContain("mon.consecutiveNoChange = 0");
	});
});

describe("pollLoop per-monitor state management", () => {
	it("pollLoop references mon.lastStatus, mon.backoffSec etc.", () => {
		const pollLoopIdx = src.indexOf("async function pollLoop(mon: ActiveMonitor)");
		expect(pollLoopIdx).toBeGreaterThan(-1);
		const pollBlock = src.slice(pollLoopIdx, src.indexOf("// Format the current monitor status"));
		// Per-monitor state is used inside pollLoop
		expect(pollBlock).toContain("mon.lastStatus");
		expect(pollBlock).toContain("mon.backoffSec");
		expect(pollBlock).toContain("mon.consecutiveNoChange");
		expect(pollBlock).toContain("mon.forceNotify");
		expect(pollBlock).toContain("mon.lastNudgeTime");
		expect(pollBlock).toContain("mon.lastSentReminder");
	});

	it("pollLoop uses mon.config for PR identification", () => {
		const pollLoopIdx = src.indexOf("async function pollLoop(mon: ActiveMonitor)");
		const pollBlock = src.slice(pollLoopIdx, src.indexOf("// Format the current monitor status"));
		expect(pollBlock).toContain("config.owner");
		expect(pollBlock).toContain("config.repo");
		expect(pollBlock).toContain("config.number");
	});

	it("pollLoop deletes from monitors on merge/close", () => {
		const pollLoopIdx = src.indexOf("async function pollLoop(mon: ActiveMonitor)");
		const pollBlock = src.slice(pollLoopIdx, src.indexOf("// Format the current monitor status"));
		expect(pollBlock).toContain("monitors.delete(key)");
		expect(pollBlock).toContain("updateFooter()");
	});
});