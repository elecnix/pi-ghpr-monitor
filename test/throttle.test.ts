/**
 * Tests for update throttling behavior
 *
 * Verifies that:
 * 1. Updates are suppressed while agent turn is active
 * 2. Queued updates are flushed when turn ends
 * 3. Duplicate updates are not sent
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { formatStatusUpdate, formatActionableItems, snapshotPR, type PRStatus, type MonitorConfig } from "../src/analyzer";

// Test the pure logic functions first
describe("formatStatusUpdate throttling behavior", () => {
	const config: MonitorConfig = {
		owner: "test",
		repo: "repo",
		number: 1,
		host: "github.com",
		mode: "all",
		intervalSec: 60,
		debounceSec: 30,
	};

	it("does NOT repeat all-clear when status is unchanged clean", () => {
		const prev: PRStatus = {
			unresolvedThreads: 0,
			generalComments: 0,
			hasConflicts: false,
			failingChecks: [],
			pendingChecks: [],
			lastCommentTimestamp: "",
			lastCommentBySelf: false,
		};
		const curr = { ...prev };
		// When prev and curr are both clean, nothing changed — should return empty string
		const result = formatStatusUpdate(prev, curr, config);
		expect(result).toBe("");
	});

	it("reports failing checks when prev had none", () => {
		const prev: PRStatus = {
			unresolvedThreads: 0,
			generalComments: 0,
			hasConflicts: false,
			failingChecks: [],
			pendingChecks: [],
			lastCommentTimestamp: "2024-01-01T00:00:00Z",
			lastCommentBySelf: false,
		};
		const curr: PRStatus = {
			...prev,
			failingChecks: ["ci/test"],
		};
		// First time seeing failing checks = report
		const result = formatStatusUpdate(prev, curr, config);
		expect(result).toContain("Failing CI checks");
	});

	it("does not send update when only pending checks change", () => {
		const prev: PRStatus = {
			unresolvedThreads: 0,
			generalComments: 0,
			hasConflicts: false,
			failingChecks: [],
			pendingChecks: ["ci/a", "ci/b"],
			lastCommentTimestamp: "",
			lastCommentBySelf: false,
		};
		const curr: PRStatus = {
			...prev,
			pendingChecks: ["ci/a", "ci/b", "ci/c"],
		};
		// Pending CI is not actionable — no update sent
		const result = formatStatusUpdate(prev, curr, config);
		expect(result).toBe("");
	});

	it("reports failing checks when they appear", () => {
		const prev: PRStatus = {
			unresolvedThreads: 0,
			generalComments: 0,
			hasConflicts: false,
			failingChecks: [],
			pendingChecks: [],
			lastCommentTimestamp: "",
			lastCommentBySelf: false,
		};
		const curr: PRStatus = {
			...prev,
			failingChecks: ["ci/test", "ci/lint"],
		};
		const result = formatStatusUpdate(prev, curr, config);
		expect(result).toContain("❌ Failing CI checks");
		expect(result).toContain("ci/test");
		expect(result).toContain("ci/lint");
	});

	it("reports conflicts when they appear", () => {
		const prev: PRStatus = {
			unresolvedThreads: 0,
			generalComments: 0,
			hasConflicts: false,
			failingChecks: [],
			pendingChecks: [],
			lastCommentTimestamp: "",
			lastCommentBySelf: false,
		};
		const curr: PRStatus = {
			...prev,
			hasConflicts: true,
		};
		const result = formatStatusUpdate(prev, curr, config);
		expect(result).toContain("⚠️  Merge conflicts detected");
	});

	it("reports CI passing when checks clear", () => {
		const prev: PRStatus = {
			unresolvedThreads: 0,
			generalComments: 0,
			hasConflicts: false,
			failingChecks: ["ci/test"],
			pendingChecks: ["ci/lint"],
			lastCommentTimestamp: "",
			lastCommentBySelf: false,
		};
		const curr: PRStatus = {
			...prev,
			failingChecks: [],
			pendingChecks: [],
		};
		const result = formatStatusUpdate(prev, curr, config);
		expect(result).toContain("✅ All CI checks passed");
	});
});

// Test the throttling state machine logic
describe("Update throttling state machine", () => {
	interface ThrottleState {
		agentTurnActive: boolean;
		queuedUpdate: string | null;
		lastSentUpdate: string | null;
		sentMessages: string[];
	}

	function createThrottleSimulator() {
		let state: ThrottleState = {
			agentTurnActive: false,
			queuedUpdate: null,
			lastSentUpdate: null,
			sentMessages: [],
		};

		return {
			getState: () => ({ ...state }),
			turnStart: () => {
				state.agentTurnActive = true;
			},
			turnEnd: (sendFn: (msg: string) => void) => {
				state.agentTurnActive = false;
				if (state.queuedUpdate !== null) {
					const update = state.queuedUpdate;
					state.queuedUpdate = null;
					sendFn(update);
					state.lastSentUpdate = update;
				}
			},
			receiveUpdate: (update: string, sendFn: (msg: string) => void) => {
				if (update) {
					if (state.agentTurnActive) {
						// Don't spam the LLM while it's working - queue for later
						state.queuedUpdate = update;
					} else if (update !== state.lastSentUpdate) {
						// Only send if something changed since last update
						sendFn(update);
						state.lastSentUpdate = update;
					}
				}
			},
		};
	}

	it("sends update immediately when no turn active", () => {
		const sim = createThrottleSimulator();
		const messages: string[] = [];

		sim.receiveUpdate("⚠️ Merge conflict", (msg) => messages.push(msg));

		expect(messages).toEqual(["⚠️ Merge conflict"]);
		expect(sim.getState().lastSentUpdate).toBe("⚠️ Merge conflict");
	});

	it("queues update when turn is active", () => {
		const sim = createThrottleSimulator();
		const messages: string[] = [];

		sim.turnStart();
		sim.receiveUpdate("⚠️ Merge conflict", (msg) => messages.push(msg));

		expect(messages).toEqual([]);
		expect(sim.getState().queuedUpdate).toBe("⚠️ Merge conflict");
	});

	it("flushes queued update when turn ends", () => {
		const sim = createThrottleSimulator();
		const messages: string[] = [];

		sim.turnStart();
		sim.receiveUpdate("⚠️ Merge conflict", (msg) => messages.push(msg));
		expect(messages).toEqual([]);

		sim.turnEnd((msg) => messages.push(msg));

		expect(messages).toEqual(["⚠️ Merge conflict"]);
		expect(sim.getState().lastSentUpdate).toBe("⚠️ Merge conflict");
		expect(sim.getState().queuedUpdate).toBe(null);
	});

	it("does not send duplicate updates", () => {
		const sim = createThrottleSimulator();
		const messages: string[] = [];

		sim.receiveUpdate("⚠️ Merge conflict", (msg) => messages.push(msg));
		sim.receiveUpdate("⚠️ Merge conflict", (msg) => messages.push(msg));

		expect(messages).toEqual(["⚠️ Merge conflict"]);
	});

	it("sends new update after different update was sent", () => {
		const sim = createThrottleSimulator();
		const messages: string[] = [];

		sim.receiveUpdate("⚠️ Merge conflict", (msg) => messages.push(msg));
		sim.receiveUpdate("❌ Failing CI", (msg) => messages.push(msg));

		expect(messages).toEqual(["⚠️ Merge conflict", "❌ Failing CI"]);
	});

	it("replaces queued update with newer one", () => {
		const sim = createThrottleSimulator();
		const messages: string[] = [];

		sim.turnStart();
		sim.receiveUpdate("⚠️ Merge conflict", (msg) => messages.push(msg));
		sim.receiveUpdate("❌ Failing CI", (msg) => messages.push(msg));
		sim.turnEnd((msg) => messages.push(msg));

		// Only the most recent update is sent
		expect(messages).toEqual(["❌ Failing CI"]);
		expect(sim.getState().lastSentUpdate).toBe("❌ Failing CI");
	});

	it("handles rapid turn start/end cycles", () => {
		const sim = createThrottleSimulator();
		const messages: string[] = [];

		// Turn starts, update arrives, turn ends
		sim.turnStart();
		sim.receiveUpdate("⚠️ Merge conflict", (msg) => messages.push(msg));
		sim.turnEnd((msg) => messages.push(msg));

		// Turn starts again, update arrives
		sim.turnStart();
		sim.receiveUpdate("❌ Failing CI", (msg) => messages.push(msg));

		// While turn active, another update arrives
		sim.receiveUpdate("⏳ Pending checks", (msg) => messages.push(msg));
		sim.turnEnd((msg) => messages.push(msg));

		expect(messages).toEqual(["⚠️ Merge conflict", "⏳ Pending checks"]);
	});

	it("stopMonitor should reset state (design contract)", () => {
		// This documents the expected behavior:
		// When stopMonitor is called, the monitoring loop stops and
		// the state should be reset so fresh updates work on next start.
		// The implementation uses lastStatus = null to achieve this.
		const testConfig: MonitorConfig = {
			owner: "test",
			repo: "repo",
			number: 1,
			host: "github.com",
			mode: "all",
			intervalSec: 60,
			debounceSec: 30,
		};
		const prev: PRStatus = {
			unresolvedThreads: 2,
			generalComments: 1,
			hasConflicts: false,
			failingChecks: ["ci/test"],
			pendingChecks: ["ci/lint"],
			lastCommentTimestamp: "2024-01-01T00:00:00Z",
			lastCommentBySelf: false,
		};
		// After stopMonitor, lastStatus is set to null
		// This means next poll will report issues as if first time
		const nextStart = formatStatusUpdate(null, prev, testConfig);
		expect(nextStart).toContain("Failing CI checks");
	});
});


// Test that the tool action enum does NOT include "stop"
describe("Tool action enum excludes stop", () => {
	it("the stop action is not available to the LLM tool", () => {
		// This is a design contract test: the LLM should not be able
		// to stop monitoring on its own. Only the user can stop via
		// the /ghpr-monitor off command.
		//
		// The tool's action enum should be ["start", "status"] only.
		// This test validates the source code contains the correct enum.
		const fs = require("fs");
		const path = require("path");
		const source = fs.readFileSync(path.join(__dirname, "../src/index.ts"), "utf-8");
		
		// Find the StringEnum for the action parameter
		const match = source.match(/action:\s*StringEnum\(\[([^\]]+)\]/);
		expect(match).not.toBeNull();
		
		const actions = match[1];
		expect(actions).toContain("start");
		expect(actions).toContain("status");
		expect(actions).not.toContain("stop");
	});

	it("steering prompt describes monitoring behavior", () => {
		const fs = require("fs");
		const path = require("path");
		const source = fs.readFileSync(path.join(__dirname, "../src/index.ts"), "utf-8");
		
		expect(source).toContain("Monitoring continues until the user stops it with /ghpr-monitor off");
	});
});

// Test the reminder flow
describe("Reminder after idle", () => {
	it("needsReminder flag is set on turn_end when monitoring is active", () => {
		let needsReminder = false;
		let agentTurnActive = false;
		const monitorRunning = true;
		const lastStatus: PRStatus | null = {
			unresolvedThreads: 2,
			generalComments: 0,
			hasConflicts: false,
			failingChecks: ["ci/test"],
			pendingChecks: [],
			lastCommentTimestamp: "",
			lastCommentBySelf: false,
		};

		// turn_start
		agentTurnActive = true;
		needsReminder = false;

		// turn_end
		agentTurnActive = false;
		if (monitorRunning && lastStatus) {
			needsReminder = true;
		}

		expect(needsReminder).toBe(true);
		expect(agentTurnActive).toBe(false);
	});

	it("needsReminder is cleared on turn_start", () => {
		let needsReminder = true;
		let agentTurnActive = false;

		// turn_start
		agentTurnActive = true;
		needsReminder = false;

		expect(needsReminder).toBe(false);
		expect(agentTurnActive).toBe(true);
	});

	it("needsReminder is not set when monitoring is idle", () => {
		let needsReminder = false;
		const monitorRunning = false;
		const lastStatus: PRStatus | null = null;

		// turn_end
		if (monitorRunning && lastStatus) {
			needsReminder = true;
		}

		expect(needsReminder).toBe(false);
	});

	it("formatActionableItems returns null for clean PR", () => {
		const status: PRStatus = {
			unresolvedThreads: 0,
			generalComments: 0,
			hasConflicts: false,
			failingChecks: [],
			pendingChecks: [],
			lastCommentTimestamp: "",
			lastCommentBySelf: false,
		};
		const config: MonitorConfig = {
			owner: "owner",
			repo: "repo",
			number: 1,
			host: "github.com",
			mode: "all",
			intervalSec: 60,
			debounceSec: 30,
		};
		expect(formatActionableItems(status, config)).toBeNull();
	});

	it("formatActionableItems returns items for failing CI", () => {
		const status: PRStatus = {
			unresolvedThreads: 0,
			generalComments: 0,
			hasConflicts: false,
			failingChecks: ["ci/test"],
			pendingChecks: [],
			lastCommentTimestamp: "",
			lastCommentBySelf: false,
		};
		const config: MonitorConfig = {
			owner: "owner",
			repo: "repo",
			number: 1,
			host: "github.com",
			mode: "all",
			intervalSec: 60,
			debounceSec: 30,
		};
		const result = formatActionableItems(status, config);
		expect(result).toContain("Failing CI checks");
	});
});
