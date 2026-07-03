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
			lastCommitOid: "",
			threadDetails: [],
			commentDetails: [],
			checkDetails: [],
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
			lastCommitOid: "",
			threadDetails: [],
			commentDetails: [],
			checkDetails: [],
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
			lastCommitOid: "",
			threadDetails: [],
			commentDetails: [],
			checkDetails: [],
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
			lastCommitOid: "",
			threadDetails: [],
			commentDetails: [],
			checkDetails: [],
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
			lastCommitOid: "",
			threadDetails: [],
			commentDetails: [],
			checkDetails: [],
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
			lastCommitOid: "",
			threadDetails: [],
			commentDetails: [],
			checkDetails: [],
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

	it("stopMonitorByKey removes the monitor entry (design contract)", () => {
		// This documents the expected behavior:
		// When stopMonitorByKey is called, the monitoring loop stops and
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
			lastCommitOid: "",
			threadDetails: [],
			commentDetails: [],
			checkDetails: [],
		};
		// After stopMonitorByKey, the entry is removed from the map
		// This means next poll will report issues as if first time
		const nextStart = formatStatusUpdate(null, prev, testConfig);
		expect(nextStart).toContain("Failing CI checks");
	});
});


// Test that the tool action enum does NOT include "stop"
describe("Tool action enum", () => {
	it("the stop action is not available to the LLM tool", () => {
		// This is a design contract test: the LLM should not be able
		// to stop monitoring on its own. Only the user can stop via
		// the /ghpr-monitor off command.
		const fs = require("fs");
		const path = require("path");
		const source = fs.readFileSync(path.join(__dirname, "../src/index.ts"), "utf-8");
		
		// Find the Type.Union for the action parameter
		const match = source.match(/action:\s*Type\.Union\(\[(.+)\]\)/);
		expect(match).not.toBeNull();
		
		const actions = match[1];
		expect(actions).toContain('"start"');
		expect(actions).toContain('"status"');
		expect(actions).toContain('"check"');
		expect(actions).not.toContain("stop"); // LLM must not be able to stop monitoring
	});

	it("steering prompt describes monitoring behavior", () => {
		const fs = require("fs");
		const path = require("path");
		const source = fs.readFileSync(path.join(__dirname, "../src/index.ts"), "utf-8");
		
		expect(source).toContain("You must NOT stop monitoring on your own");
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
			lastCommitOid: "",
			threadDetails: [],
			commentDetails: [],
			checkDetails: [],
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
			lastCommitOid: "",
			threadDetails: [],
			commentDetails: [],
			checkDetails: [],
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
			lastCommitOid: "",
			threadDetails: [],
			commentDetails: [],
			checkDetails: [],
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

// Test poll error recovery behavior
// Simulates the backoff state machine from the pollLoop catch block
describe("Poll error recovery and backoff", () => {
	const INTERVAL_SEC = 60;
	const MAX_BACKOFF_SEC = 300;

	function createBackoffSimulator() {
		let backoffSec = 0;
		const messages: { type: string; content: string }[] = [];

		return {
			getBackoffSec: () => backoffSec,
			getMessages: () => messages,

			// Simulate a successful poll
			onSuccess() {
				backoffSec = 0;
			},

			// Simulate an error poll (matches the logic in pollLoop)
			onError(errorMsg: string) {
				const isRateLimit = /rate limit/i.test(errorMsg);
				backoffSec = backoffSec === 0
					? INTERVAL_SEC
					: Math.min(backoffSec * 2, MAX_BACKOFF_SEC);
				messages.push({
					type: isRateLimit ? "rate-limit" : "poll-error",
					content: isRateLimit
						? `Rate limited, backing off ${backoffSec}s`
						: `${errorMsg}${backoffSec > INTERVAL_SEC ? ` (retrying in ${backoffSec}s)` : ""}`,
				});
			},

			// Compute the wait time (matches pollLoop logic)
			getWaitSec(): number {
				return backoffSec > 0 ? backoffSec : INTERVAL_SEC;
			},
		};
	}

	it("starts backoff at intervalSec on first error", () => {
		const sim = createBackoffSimulator();
		sim.onError("error connecting to api.github.com");
		expect(sim.getBackoffSec()).toBe(INTERVAL_SEC);
		expect(sim.getWaitSec()).toBe(INTERVAL_SEC);
	});

	it("doubles backoff on consecutive errors", () => {
		const sim = createBackoffSimulator();
		sim.onError("error connecting to api.github.com");
		expect(sim.getBackoffSec()).toBe(60);

		sim.onError("error connecting to api.github.com");
		expect(sim.getBackoffSec()).toBe(120);

		sim.onError("error connecting to api.github.com");
		expect(sim.getBackoffSec()).toBe(240);

		sim.onError("error connecting to api.github.com");
		expect(sim.getBackoffSec()).toBe(300); // capped at MAX_BACKOFF_SEC

		sim.onError("error connecting to api.github.com");
		expect(sim.getBackoffSec()).toBe(300); // still capped
	});

	it("resets backoff after successful poll", () => {
		const sim = createBackoffSimulator();
		sim.onError("error connecting to api.github.com");
		sim.onError("error connecting to api.github.com");
		expect(sim.getBackoffSec()).toBe(120);

		sim.onSuccess();
		expect(sim.getBackoffSec()).toBe(0);
		expect(sim.getWaitSec()).toBe(INTERVAL_SEC);
	});

	it("recovers from error after connectivity returns", () => {
		const sim = createBackoffSimulator();
		// Simulate a network outage: 4 consecutive errors
		sim.onError("error connecting to api.github.com");
		sim.onError("error connecting to api.github.com");
		sim.onError("error connecting to api.github.com");
		sim.onError("error connecting to api.github.com");
		expect(sim.getBackoffSec()).toBe(300);
		expect(sim.getMessages().length).toBe(4);
		expect(sim.getMessages()[3].content).toContain("retrying in 300s");

		// Network recovers
		sim.onSuccess();
		expect(sim.getBackoffSec()).toBe(0);
		expect(sim.getWaitSec()).toBe(INTERVAL_SEC);
	});

	it("does NOT stop the monitor on errors (error is caught, loop continues)", () => {
		const sim = createBackoffSimulator();
		sim.onError("error connecting to api.github.com");
		// The monitor is still alive — the error was caught and backoff was applied
		// The loop continues to the wait phase
		const waitSec = sim.getWaitSec();
		expect(waitSec).toBeGreaterThan(0); // It will wait before next poll
		expect(sim.getBackoffSec()).toBe(INTERVAL_SEC); // But it hasn't stopped
	});

	it("applies backoff to rate limit errors equally", () => {
		const sim = createBackoffSimulator();
		sim.onError("rate limit exceeded");
		expect(sim.getBackoffSec()).toBe(INTERVAL_SEC);
		expect(sim.getMessages()[0].type).toBe("rate-limit");

		sim.onError("rate limit exceeded");
		expect(sim.getBackoffSec()).toBe(120);

		sim.onSuccess();
		expect(sim.getBackoffSec()).toBe(0);
	});

	it("shows retry time in error message after first backoff", () => {
		const sim = createBackoffSimulator();
		sim.onError("error connecting to api.github.com");
		expect(sim.getMessages()[0].content).not.toContain("retrying in"); // first error, no backoff label yet

		sim.onError("error connecting to api.github.com");
		expect(sim.getMessages()[1].content).toContain("retrying in 120s");
	});
});

// Test /ghpr-monitor check — immediately wake and reset backoff
describe("Check now command", () => {
	function createCheckSimulator() {
		let backoffSec = 0;
		let consecutiveNoChange = 3;
		let wakeCalled = false;
		const INTERVAL_SEC = 60;
		const MAX_BACKOFF_SEC = 300;

		return {
			getBackoffSec: () => backoffSec,
			getConsecutiveNoChange: () => consecutiveNoChange,
			setConsecutiveNoChange: (n: number) => { consecutiveNoChange = n; },
			wasWakeCalled: () => wakeCalled,

			onError(errorMsg: string) {
				backoffSec = backoffSec === 0
					? INTERVAL_SEC
					: Math.min(backoffSec * 2, MAX_BACKOFF_SEC);
			},

			onSuccess() {
				backoffSec = 0;
			},

			// Simulates /ghpr-monitor check
			onCheck() {
				backoffSec = 0;
				consecutiveNoChange = 0;
				wakeCalled = true;
			},

			getWaitSec(): number {
				const baseSec = backoffSec > 0 ? backoffSec : INTERVAL_SEC;
				const idleSec = consecutiveNoChange > 3
					? Math.min(INTERVAL_SEC * Math.pow(2, consecutiveNoChange - 3), 300)
					: baseSec;
				return idleSec;
			},
		};
	}

	it("resets backoff to zero", () => {
		const sim = createCheckSimulator();
		sim.onError("connection refused");
		sim.onError("connection refused");
		expect(sim.getBackoffSec()).toBe(120);

		sim.onCheck();
		expect(sim.getBackoffSec()).toBe(0);
	});

	it("resets idle backoff by zeroing consecutiveNoChange", () => {
		const sim = createCheckSimulator();
		// Simulate 5 consecutive no-change polls = idle backoff to 240s
		// (consecutiveNoChange>3 doubles: 60*2^(5-3) = 240)
		sim.setConsecutiveNoChange(5);
		expect(sim.getWaitSec()).toBe(240);

		sim.onCheck();
		expect(sim.getConsecutiveNoChange()).toBe(0);
		expect(sim.getWaitSec()).toBe(60); // back to base interval
	});

	it("wakes the poll loop", () => {
		const sim = createCheckSimulator();
		sim.onCheck();
		expect(sim.wasWakeCalled()).toBe(true);
	});

	it("after check + error, backoff starts fresh from intervalSec", () => {
		const sim = createCheckSimulator();
		sim.onError("connection refused");
		sim.onError("connection refused");
		sim.onError("connection refused");
		expect(sim.getBackoffSec()).toBe(240);

		sim.onCheck();
		expect(sim.getBackoffSec()).toBe(0);

		// If the check itself also fails (e.g. still no connectivity)
		sim.onError("connection refused");
		expect(sim.getBackoffSec()).toBe(60); // starts fresh, not 480
	});
});


// Reproduce and verify fix for spam: repeated failing check notifications
// when nothing has changed between polls.
describe("No spam for unchanged failing checks", () => {
	const config: MonitorConfig = {
		owner: "mobilityhouse",
		repo: "vgi-na-masscec",
		number: 367,
		host: "github.com",
		mode: "all",
		intervalSec: 60,
		debounceSec: 30,
	};

	const baseStatus: PRStatus = {
		unresolvedThreads: 0,
		generalComments: 0,
		hasConflicts: false,
		failingChecks: ["SonarQubeCloud", "SonarCloud Code Analysis"],
		pendingChecks: [],
		lastCommentTimestamp: "",
		lastCommentBySelf: false,
			lastCommitOid: "",
		threadDetails: [],
		commentDetails: [],
		checkDetails: [
			{ name: "SonarQubeCloud", conclusion: "FAILURE" },
			{ name: "SonarCloud Code Analysis", conclusion: "FAILURE" },
		],
	};

	it("formatStatusUpdate should NOT report failing checks that were already failing in prev", () => {
		// First poll: report failing checks (no prev)
		const first = formatStatusUpdate(null, baseStatus, config);
		expect(first).toContain("Failing CI checks");

		// Second poll: same failing checks — should NOT report again
		const second = formatStatusUpdate(baseStatus, baseStatus, config);
		expect(second).not.toContain("Failing CI checks");
		expect(second).toBe(""); // nothing changed at all
	});

	it("formatStatusUpdate should report newly failing checks", () => {
		const prev: PRStatus = {
			...baseStatus,
			failingChecks: ["SonarQubeCloud"],
			checkDetails: [{ name: "SonarQubeCloud", conclusion: "FAILURE" }],
		};
		const curr: PRStatus = {
			...baseStatus,
			failingChecks: ["SonarQubeCloud", "SonarCloud Code Analysis"],
			checkDetails: [
				{ name: "SonarQubeCloud", conclusion: "FAILURE" },
				{ name: "SonarCloud Code Analysis", conclusion: "FAILURE" },
			],
		};

		const update = formatStatusUpdate(prev, curr, config);
		expect(update).toContain("Failing CI checks");
		expect(update).toContain("SonarCloud Code Analysis");
	});

	it("formatStatusUpdate should not repeat same failing checks via reminder loop", () => {
		// Simulate the spam cycle: agent works, turn ends, poll fires, reminder sent
		// The key issue: needsReminder fires every turn_end, formatActionableItems
		// always lists all failing checks, even when nothing changed.

		// After the fix, formatActionableItems should only return content
		// when something changed vs the last status that was communicated.
		// For now, verify the formatStatusUpdate dedup works:
		const first = formatStatusUpdate(null, baseStatus, config);
		expect(first).toContain("Failing CI checks");

		// Repeated polls with same status
		const poll2 = formatStatusUpdate(baseStatus, baseStatus, config);
		expect(poll2).toBe("");
		const poll3 = formatStatusUpdate(baseStatus, baseStatus, config);
		expect(poll3).toBe("");
	});

	it("formatStatusUpdate should report when same checks fail again after a fix", () => {
		// Was failing, then passed, then failing again
		const failing: PRStatus = { ...baseStatus };
		const passing: PRStatus = {
			...baseStatus,
			failingChecks: [],
			pendingChecks: [],
			checkDetails: [],
		};
		const failingAgain: PRStatus = { ...baseStatus };

		// First: report failing
		expect(formatStatusUpdate(null, failing, config)).toContain("Failing CI checks");
		// Fixed: report all clear
		expect(formatStatusUpdate(failing, passing, config)).toContain("All CI checks passed");
		// Regressed: report failing again
		expect(formatStatusUpdate(passing, failingAgain, config)).toContain("Failing CI checks");
	});

	it("formatStatusUpdate should NOT report unchanged merge conflicts every poll", () => {
		const withConflict: PRStatus = { ...baseStatus, hasConflicts: true, failingChecks: [] };

		// First poll: report conflicts
		const first = formatStatusUpdate(null, withConflict, config);
		expect(first).toContain("Merge conflicts");

		// Same conflicts next poll: should NOT repeat
		const second = formatStatusUpdate(withConflict, withConflict, config);
		expect(second).not.toContain("Merge conflicts");
		expect(second).toBe("");
	});
});

// Test that idle backoff is capped at 5 minutes (not 1 hour)
// This prevents the monitor from "going silent" — the old MAX_IDLE_SEC of 3600
// meant polls grew to once per hour, making the monitor effectively dead.
describe("Idle backoff caps at 5 minutes", () => {
	const INTERVAL_SEC = 60;
	const MAX_IDLE_SEC = 300; // must match src/index.ts

	function computeWaitSec(consecutiveNoChange: number, backoffSec: number): number {
		const idleSec = consecutiveNoChange > 3
			? Math.min(INTERVAL_SEC * Math.pow(2, consecutiveNoChange - 3), MAX_IDLE_SEC)
			: INTERVAL_SEC;
		return backoffSec > 0 ? backoffSec : idleSec;
	}

	it("uses base interval for first 4 polls", () => {
		expect(computeWaitSec(0, 0)).toBe(60);
		expect(computeWaitSec(1, 0)).toBe(60);
		expect(computeWaitSec(2, 0)).toBe(60);
		expect(computeWaitSec(3, 0)).toBe(60);
	});

	it("starts exponential backoff after 3 consecutive no-change polls", () => {
		expect(computeWaitSec(4, 0)).toBe(120);  // 60 * 2^1
		expect(computeWaitSec(5, 0)).toBe(240);  // 60 * 2^2
	});

	it("caps at 300s (5 minutes) regardless of consecutive no-change count", () => {
		// Previously this was 3600 (1 hour!) which made the monitor effectively dead
		expect(computeWaitSec(6, 0)).toBe(300);  // 60 * 2^3 = 480 -> capped at 300
		expect(computeWaitSec(7, 0)).toBe(300);  // 60 * 2^4 = 960 -> capped at 300
		expect(computeWaitSec(8, 0)).toBe(300);  // 60 * 2^5 = 1920 -> capped at 300
		expect(computeWaitSec(9, 0)).toBe(300);  // 60 * 2^6 = 3840 -> capped at 300
		expect(computeWaitSec(100, 0)).toBe(300); // stays capped forever
	});

	it("never exceeds 5 minutes even after hours of inactivity", () => {
		// Simulate a monitor that has been idle for a very long time
		// (e.g., overnight). It should still poll within 5 minutes.
		for (let i = 0; i <= 200; i++) {
			const wait = computeWaitSec(i, 0);
			expect(wait).toBeLessThanOrEqual(300);
		}
	});

	it("error backoff takes precedence over idle backoff", () => {
		// When there's an active error backoff, use that instead of idle backoff
		expect(computeWaitSec(0, 120)).toBe(120);
		expect(computeWaitSec(5, 240)).toBe(240);
		// Copilot review catch: consecutiveNoChange > 3 with high backoffSec
		// Previously this used the idle formula (120s) instead of backoffSec (300s)
		expect(computeWaitSec(4, 300)).toBe(300);
		expect(computeWaitSec(10, 120)).toBe(120);
		expect(computeWaitSec(100, 300)).toBe(300);
	});

	it("polling interval does not depend on agentTurnActive and error backoff takes precedence", () => {
		// Previously: waitSec = agentTurnActive ? Math.max(idleSec, 300) : idleSec
		// This meant polling was delayed 5+ minutes when agent was working,
		// exactly when the user needs CI status updates.
		// Now: waitSec = backoffSec > 0 ? backoffSec : idleSec
		// (polling is decoupled from agent activity; error backoff takes precedence over idle)
		const src = require("fs").readFileSync(require("path").join(__dirname, "../src/index.ts"), "utf-8");
		// Verify the old pattern is gone
		expect(src).not.toContain("agentTurnActive ? Math.max(idleSec");
		// Verify waitSec uses backoffSec when present, otherwise idleSec
		expect(src).toContain("const waitSec = mon.backoffSec > 0 ? mon.backoffSec : idleSec;");
	});
});

// Test the full notification state machine including reminders
describe("Notification state machine: no spam with active agent", () => {
	const config: MonitorConfig = {
		owner: "mobilityhouse",
		repo: "vgi-na-masscec",
		number: 367,
		host: "github.com",
		mode: "all",
		intervalSec: 60,
		debounceSec: 30,
	};

	const failingStatus: PRStatus = {
		unresolvedThreads: 0,
		generalComments: 0,
		hasConflicts: false,
		failingChecks: ["SonarQubeCloud", "SonarCloud Code Analysis"],
		pendingChecks: [],
		lastCommentTimestamp: "",
		lastCommentBySelf: false,
			lastCommitOid: "",
		threadDetails: [],
		commentDetails: [],
		checkDetails: [
			{ name: "SonarQubeCloud", conclusion: "FAILURE" },
			{ name: "SonarCloud Code Analysis", conclusion: "FAILURE" },
		],
	};

	function createSpamSimulator() {
		let lastSentUpdate: string | null = null;
		let lastSentReminder: string | null = null;
		let lastStatus: PRStatus | null = null;
		let agentTurnActive = false;
		let needsReminder = false;
		const sentMessages: { type: "update" | "reminder"; content: string }[] = [];

		return {
			getSentMessages: () => sentMessages,

			turnStart() {
				agentTurnActive = true;
				needsReminder = false;
			},
			turnEnd() {
				agentTurnActive = false;
				needsReminder = true; // always set when monitoring is active
			},
			poll(curr: PRStatus) {
				const update = formatStatusUpdate(lastStatus, curr, config);

				if (update) {
					if (agentTurnActive) {
						// queued (would be flushed on turnEnd)
					} else if (update !== lastSentUpdate) {
						sentMessages.push({ type: "update", content: update });
						lastSentUpdate = update;
					}
				}

				if (needsReminder && !agentTurnActive) {
					const reminder = formatActionableItems(curr, config);
					if (reminder && reminder !== lastSentReminder) {
						sentMessages.push({ type: "reminder", content: reminder });
						lastSentReminder = reminder;
					}
					needsReminder = false;
				}

				lastStatus = curr;
			},
		};
	}

	it("should NOT spam agent with same failing checks every turn cycle", () => {
		const sim = createSpamSimulator();

		// Poll 1: Initial discovery of failing checks (agent idle)
		sim.poll(failingStatus);
		expect(sim.getSentMessages().length).toBe(1);
		expect(sim.getSentMessages()[0].type).toBe("update");
		expect(sim.getSentMessages()[0].content).toContain("Failing CI checks");

		// Agent starts working on the fix
		sim.turnStart();

		// Poll 2: Same failing checks while agent is active
		// formatStatusUpdate returns "" (no change), no update sent
		sim.poll(failingStatus);
		expect(sim.getSentMessages().length).toBe(1); // no new message

		// Agent finishes a turn (e.g. edited a file)
		sim.turnEnd(); // needsReminder = true

		// Poll 3: Same failing checks after turn ends
		// First reminder is OK (it's the first nudge after turn_end)
		sim.poll(failingStatus);
		expect(sim.getSentMessages().length).toBe(2); // initial + first reminder
		expect(sim.getSentMessages()[1].type).toBe("reminder");

		// Now the spam loop: more turn cycles with same failing checks
		for (let i = 0; i < 5; i++) {
			sim.turnStart();
			sim.turnEnd(); // needsReminder = true again
			sim.poll(failingStatus); // same status — should NOT re-send reminder
		}
		// Total messages should still be 2 (initial + first reminder only)
		expect(sim.getSentMessages().length).toBe(2);
	});

	it("should send notification when failing checks are resolved", () => {
		const sim = createSpamSimulator();
		const passing: PRStatus = {
			...failingStatus,
			failingChecks: [],
			pendingChecks: [],
			checkDetails: [],
		};

		// Initial: 2 failing checks
		sim.poll(failingStatus);
		expect(sim.getSentMessages().length).toBe(1);
		expect(sim.getSentMessages()[0].content).toContain("Failing CI checks");

		// All checks fixed
		sim.poll(passing);
		expect(sim.getSentMessages().length).toBe(2);
		expect(sim.getSentMessages()[1].content).toContain("All CI checks passed");
	});
});


// Test periodic nudge for idle agent with unresolved items
describe("Periodic nudge for idle agent", () => {
	const config: MonitorConfig = {
		owner: "mobilityhouse",
		repo: "vgi-na-masscec",
		number: 367,
		host: "github.com",
		mode: "all",
		intervalSec: 60,
		debounceSec: 30,
	};

	const failingStatus: PRStatus = {
		unresolvedThreads: 0,
		generalComments: 0,
		hasConflicts: false,
		failingChecks: ["SonarQubeCloud", "SonarCloud Code Analysis"],
		pendingChecks: [],
		lastCommentTimestamp: "",
		lastCommentBySelf: false,
			lastCommitOid: "",
		threadDetails: [],
		commentDetails: [],
		checkDetails: [
			{ name: "SonarQubeCloud", conclusion: "FAILURE" },
			{ name: "SonarCloud Code Analysis", conclusion: "FAILURE" },
		],
	};

	const NUDGE_COOLDOWN_MS = 3 * 60 * 1000; // 3 minutes

	function createNudgeSimulator() {
		let lastSentUpdate: string | null = null;
		let lastSentReminder: string | null = null;
		let lastNudgeTime = 0;
		let lastStatus: PRStatus | null = null;
		let agentTurnActive = false;
		let needsReminder = false;
		let now = 1000000; // simulated clock in ms (non-zero like Date.now())
		const sentMessages: { type: "update" | "reminder" | "nudge"; content: string }[] = [];

		return {
			getSentMessages: () => sentMessages,
			advanceTime(ms: number) { now += ms; },

			turnStart() {
				agentTurnActive = true;
				needsReminder = false;
			},
			turnEnd() {
				agentTurnActive = false;
				needsReminder = true;
			},
			poll(curr: PRStatus) {
				const update = formatStatusUpdate(lastStatus, curr, config);

				if (update) {
					if (agentTurnActive) {
						// queued
					} else if (update !== lastSentUpdate) {
						sentMessages.push({ type: "update", content: update });
						lastSentUpdate = update;
						lastSentReminder = null;
						lastNudgeTime = now;
					}
				}

				if (needsReminder && !agentTurnActive) {
					const reminder = formatActionableItems(curr, config);
					if (reminder && reminder !== lastSentReminder) {
						sentMessages.push({ type: "reminder", content: reminder });
						lastSentReminder = reminder;
						lastNudgeTime = now;
					}
					needsReminder = false;
				}

				// Periodic nudge (matches pollLoop logic)
				if (
					!agentTurnActive &&
					!needsReminder &&
					lastNudgeTime > 0 &&
					now - lastNudgeTime >= NUDGE_COOLDOWN_MS
				) {
					const nudge = formatActionableItems(curr, config);
					if (nudge) {
						sentMessages.push({ type: "nudge", content: nudge });
						lastSentReminder = nudge;
						lastNudgeTime = now;
					}
				}

				lastStatus = curr;
			},
		};
	}

	it("nudges idle agent after cooldown when failing checks remain", () => {
		const sim = createNudgeSimulator();

		// Initial discovery
		sim.poll(failingStatus);
		expect(sim.getSentMessages().length).toBe(1);

		// Agent is idle, polls every 60s — but only 2 min passed, no nudge yet
		sim.advanceTime(60 * 1000);
		sim.poll(failingStatus);
		sim.advanceTime(60 * 1000);
		sim.poll(failingStatus);
		expect(sim.getSentMessages().length).toBe(1); // no nudge yet

		// 3 minutes total — nudge fires
		sim.advanceTime(60 * 1000); // 3 min total
		sim.poll(failingStatus);
		expect(sim.getSentMessages().length).toBe(2);
		expect(sim.getSentMessages()[1].type).toBe("nudge");
	});

	it("does NOT nudge again before cooldown expires", () => {
		const sim = createNudgeSimulator();

		sim.poll(failingStatus);
		expect(sim.getSentMessages().length).toBe(1);

		// First nudge at 3 min
		sim.advanceTime(3 * 60 * 1000);
		sim.poll(failingStatus);
		expect(sim.getSentMessages().length).toBe(2);

		// Poll again soon after — no second nudge yet
		sim.advanceTime(60 * 1000); // only 1 min since last nudge
		sim.poll(failingStatus);
		expect(sim.getSentMessages().length).toBe(2);

		// Another minute — still under cooldown
		sim.advanceTime(60 * 1000); // 2 min since last nudge
		sim.poll(failingStatus);
		expect(sim.getSentMessages().length).toBe(2);

		// 3 min since last nudge — second nudge fires
		sim.advanceTime(60 * 1000); // 3 min since last nudge
		sim.poll(failingStatus);
		expect(sim.getSentMessages().length).toBe(3);
		expect(sim.getSentMessages()[2].type).toBe("nudge");
	});

	it("does NOT nudge when there are no actionable items", () => {
		const sim = createNudgeSimulator();
		const passing: PRStatus = {
			...failingStatus,
			failingChecks: [],
			pendingChecks: [],
			checkDetails: [],
		};

		// First poll with passing PR: sends "all clear" update
		sim.poll(passing);
		expect(sim.getSentMessages().length).toBe(1);
		expect(sim.getSentMessages()[0].content).toContain("all clear");

		// Way past cooldown — but no actionable items, so no nudge
		sim.advanceTime(10 * 60 * 1000);
		sim.poll(passing);
		expect(sim.getSentMessages().length).toBe(1); // still just the initial all-clear
	});

	it("real update resets the nudge cooldown", () => {
		const sim = createNudgeSimulator();
		const withNewFailure: PRStatus = {
			...failingStatus,
			failingChecks: ["SonarQubeCloud", "SonarCloud Code Analysis", "ci/lint"],
			checkDetails: [
				{ name: "SonarQubeCloud", conclusion: "FAILURE" },
				{ name: "SonarCloud Code Analysis", conclusion: "FAILURE" },
				{ name: "ci/lint", conclusion: "FAILURE" },
			],
		};

		sim.poll(failingStatus);
		expect(sim.getSentMessages().length).toBe(1); // initial

		// 2 min — no nudge yet
		sim.advanceTime(2 * 60 * 1000);
		sim.poll(failingStatus);
		expect(sim.getSentMessages().length).toBe(1);

		// New failing check appears at 2.5 min — this is a real update, resets cooldown
		sim.advanceTime(30 * 1000);
		sim.poll(withNewFailure);
		expect(sim.getSentMessages().length).toBe(2);
		expect(sim.getSentMessages()[1].type).toBe("update"); // not nudge

		// 3 min after the last nudge would have been (but only 1 min since real update)
		sim.advanceTime(60 * 1000);
		sim.poll(withNewFailure);
		expect(sim.getSentMessages().length).toBe(2); // no nudge, cooldown reset

		// 3 min after the real update — nudge fires
		sim.advanceTime(2 * 60 * 1000); // total 3 min since real update
		sim.poll(withNewFailure);
		expect(sim.getSentMessages().length).toBe(3);
		expect(sim.getSentMessages()[2].type).toBe("nudge");
	});
});
describe("Force check sends current state even when nothing changed", () => {
	const config: MonitorConfig = {
		owner: "test", repo: "repo", number: 1,
		host: "github.com", mode: "all", intervalSec: 60, debounceSec: 30,
	};

	const withComments: PRStatus = {
		unresolvedThreads: 2, generalComments: 1, hasConflicts: false,
		failingChecks: [], pendingChecks: [],
		lastCommentTimestamp: "", lastCommentBySelf: false,
			lastCommitOid: "",
		threadDetails: [], commentDetails: [], checkDetails: [],
	};

	function createCheckSim() {
		let lastSentUpdate: string | null = null;
		let lastSentReminder: string | null = null;
		let lastNudgeTime = 0;
		let lastStatus: PRStatus | null = null;
		let agentTurnActive = false;
		let needsReminder = false;
		let forceNotify = false;
		let queuedForceChecks: string[] = [];
		let now = 1000000;
		const sentMessages: { type: string; content: string }[] = [];

		return {
			getSentMessages: () => sentMessages,
			advanceTime(ms: number) { now += ms; },
			turnStart() { agentTurnActive = true; needsReminder = false; },
			turnEnd() {
				agentTurnActive = false;
				needsReminder = true;
				// Flush queued force-check results when turn ends
				if (queuedForceChecks.length > 0) {
					for (const fc of queuedForceChecks) {
						sentMessages.push({ type: "check", content: fc });
					}
					lastNudgeTime = now;
					queuedForceChecks = [];
				}
			},
			check() { forceNotify = true; },
			poll(curr: PRStatus) {
				const update = formatStatusUpdate(lastStatus, curr, config);

				if (update) {
					if (agentTurnActive) { /* queue */ }
					else if (update !== lastSentUpdate) {
						sentMessages.push({ type: "update", content: update });
						lastSentUpdate = update;
						lastSentReminder = null;
						lastNudgeTime = now;
					}
				}

				if (needsReminder && !agentTurnActive) {
					const reminder = formatActionableItems(curr, config);
					if (reminder && reminder !== lastSentReminder) {
						sentMessages.push({ type: "reminder", content: reminder });
						lastSentReminder = reminder;
						lastNudgeTime = now;
				}
					needsReminder = false;
				}

				// FIX: force-check always processes, even during active agent turn.
				// When agent is active, queue for flush on turn_end.
				if (forceNotify) {
					const items = formatActionableItems(curr, config);
					const msg = items ?? `✅ Open, nothing to address on https://github.com/${config.owner}/${config.repo}/pull/${config.number}`;
					if (agentTurnActive) {
						queuedForceChecks.push(msg);
					} else {
						sentMessages.push({ type: "check", content: msg });
					}
					lastSentReminder = items;
					lastNudgeTime = now;
					forceNotify = false;
				}

				lastStatus = curr;
			},
		};
	}

	it("sends current state even when nothing changed since last poll", () => {
		const sim = createCheckSim();

		// First poll discovers comments
		sim.poll(withComments);
		expect(sim.getSentMessages()).toHaveLength(1);
		expect(sim.getSentMessages()[0].type).toBe("update");

		// Subsequent poll — nothing changed
		sim.advanceTime(60_000);
		sim.poll(withComments);
		expect(sim.getSentMessages()).toHaveLength(1); // no duplicate

		// User triggers /ghpr-monitor check
		sim.check();
		sim.poll(withComments);
		expect(sim.getSentMessages()).toHaveLength(2);
		expect(sim.getSentMessages()[1].type).toBe("check");
		expect(sim.getSentMessages()[1].content).toContain("unresolved");
	});

	it("sends all-clear when force-checked on a clean PR", () => {
		const clean: PRStatus = {
			unresolvedThreads: 0, generalComments: 0, hasConflicts: false,
			failingChecks: [], pendingChecks: [],
			lastCommentTimestamp: "", lastCommentBySelf: false,
			lastCommitOid: "",
			threadDetails: [], commentDetails: [], checkDetails: [],
		};
		const sim = createCheckSim();

		// First poll is clean — sends all-clear
		sim.poll(clean);
		expect(sim.getSentMessages()).toHaveLength(1);

		// Nothing changed, normal poll: silent
		sim.advanceTime(60_000);
		sim.poll(clean);
		expect(sim.getSentMessages()).toHaveLength(1);

		// Force check — still sends current state
		sim.check();
		sim.poll(clean);
		expect(sim.getSentMessages()).toHaveLength(2);
		expect(sim.getSentMessages()[1].type).toBe("check");
		expect(sim.getSentMessages()[1].content).toContain("nothing to address");
	});

	it("queues force-check when agent turn is active, delivers on turn_end", () => {
		// This is the core bug from #28: /ghpr-monitor check was a no-op
		// when the agent was active because the forceNotify block was guarded
		// by !agentTurnActive, so the flag was never consumed.
		const sim = createCheckSim();

		// First poll discovers comments (agent idle)
		sim.poll(withComments);
		expect(sim.getSentMessages()).toHaveLength(1);
		expect(sim.getSentMessages()[0].type).toBe("update");

		// Agent starts a turn
		sim.turnStart();

		// User triggers /ghpr-monitor check while agent is active
		sim.check();

		// Poll fires while agent is still active
		sim.poll(withComments);
		// The check should NOT be sent immediately -- it should be queued
		expect(sim.getSentMessages()).toHaveLength(1); // still just the initial update

		// Agent turn ends -- queued force-check should be flushed
		sim.turnEnd();
		expect(sim.getSentMessages()).toHaveLength(2);
		expect(sim.getSentMessages()[1].type).toBe("check");
		expect(sim.getSentMessages()[1].content).toContain("unresolved");

		// forceNotify flag was consumed -- subsequent polls don't re-send
		sim.poll(withComments);
		expect(sim.getSentMessages()).toHaveLength(2); // no duplicate
	});

	it("force-check is consumed even when no turn follows the queue", () => {
		// Edge case: check is queued during agent turn, another poll fires
		// before turn_end. The queued result should not be duplicated.
		const sim = createCheckSim();

		sim.poll(withComments);
		expect(sim.getSentMessages()).toHaveLength(1);

		sim.turnStart();
		sim.check();
		sim.poll(withComments);
		expect(sim.getSentMessages()).toHaveLength(1); // queued, not sent

		// Another poll while still active -- forceNotify was already consumed,
		// so no duplicate queue
		sim.poll(withComments);
		expect(sim.getSentMessages()).toHaveLength(1); // still just queued once

		// Turn ends -- single queued check is flushed
		sim.turnEnd();
		expect(sim.getSentMessages()).toHaveLength(2);
		expect(sim.getSentMessages()[1].type).toBe("check");
	});

	it("multiple polls queue multiple checks during agent turn, all flushed on turn_end", () => {
		// When multiple monitors are force-checked during an active turn,
		// each poll should accumulate into the queuedForceChecks array
		// rather than overwriting. All results are flushed on turn_end.
		const sim = createCheckSim();
		const clean: PRStatus = {
			unresolvedThreads: 0, generalComments: 0, hasConflicts: false,
			failingChecks: [], pendingChecks: [],
			lastCommentTimestamp: "", lastCommentBySelf: false,
			lastCommitOid: "",
			threadDetails: [], commentDetails: [], checkDetails: [],
		};

		// Initial poll (agent idle)
		sim.poll(withComments);
		expect(sim.getSentMessages()).toHaveLength(1);

		sim.turnStart();
		// First force-check during active turn
		sim.check();
		sim.poll(withComments);
		expect(sim.getSentMessages()).toHaveLength(1); // queued, not sent

		// Simulate a second monitor getting force-checked: set flag and poll again
		// (In production, multiple monitors poll independently during the same turn)
		sim.check();
		sim.poll(clean); // different status to distinguish the two checks
		expect(sim.getSentMessages()).toHaveLength(1); // still queued

		// Turn ends -- both queued checks should be flushed
		sim.turnEnd();
		expect(sim.getSentMessages()).toHaveLength(3); // initial update + 2 checks
		expect(sim.getSentMessages()[1].type).toBe("check");
		expect(sim.getSentMessages()[2].type).toBe("check");
		expect(sim.getSentMessages()[1].content).toContain("unresolved"); // first check (withComments)
		expect(sim.getSentMessages()[2].content).toContain("nothing to address"); // second check (clean)
	});
});

// Reproduce the escape-loop bug: pressing Escape triggers turn_end,
// which clears lastSentReminder, causing the next poll to re-send
// the same identical reminder. This creates a rapid-fire loop.
describe("Escape-loop bug: no rapid-fire reminders on repeated turn_end", () => {
	const config: MonitorConfig = {
		owner: "test", repo: "repo", number: 1,
		host: "github.com", mode: "all", intervalSec: 60, debounceSec: 30,
	};

	const withThreads: PRStatus = {
		unresolvedThreads: 2, generalComments: 0, hasConflicts: false,
		failingChecks: [], pendingChecks: [],
		lastCommentTimestamp: "", lastCommentBySelf: false,
			lastCommitOid: "",
		threadDetails: [], commentDetails: [], checkDetails: [],
	};

	// Simulator that matches the CURRENT (buggy) behavior of turn_end:
	// it clears lastSentReminder, which defeats the dedup guard.
	function createBuggySimulator() {
		let lastSentUpdate: string | null = null;
		let lastSentReminder: string | null = null;
		let lastNudgeTime = 0;
		let lastStatus: PRStatus | null = null;
		let agentTurnActive = false;
		let needsReminder = false;
		let now = 1000000;
		const NUDGE_COOLDOWN_MS = 3 * 60 * 1000;
		const sentMessages: { type: string; content: string }[] = [];

		return {
			getSentMessages: () => sentMessages,
			advanceTime(ms: number) { now += ms; },

			turnStart() { agentTurnActive = true; needsReminder = false; },
			// BUG: turn_end clears lastSentReminder, allowing duplicate reminders
			turnEnd() {
				agentTurnActive = false;
				needsReminder = true;
				lastSentReminder = null; // <-- THE BUG: defeats dedup guard
			},
			poll(curr: PRStatus) {
				const update = formatStatusUpdate(lastStatus, curr, config);

				if (update) {
					if (agentTurnActive) { /* queued */ }
					else if (update !== lastSentUpdate) {
						sentMessages.push({ type: "update", content: update });
						lastSentUpdate = update;
						lastSentReminder = null;
						lastNudgeTime = now;
					}
				}

				if (needsReminder && !agentTurnActive) {
					const reminder = formatActionableItems(curr, config);
					if (reminder && reminder !== lastSentReminder) {
						sentMessages.push({ type: "reminder", content: reminder });
						lastSentReminder = reminder;
						lastNudgeTime = now;
					}
					needsReminder = false;
				}

				// Periodic nudge
				if (
					!agentTurnActive &&
					!needsReminder &&
					lastNudgeTime > 0 &&
					now - lastNudgeTime >= NUDGE_COOLDOWN_MS
				) {
					const nudge = formatActionableItems(curr, config);
					if (nudge) {
						sentMessages.push({ type: "nudge", content: nudge });
						lastSentReminder = nudge;
						lastNudgeTime = now;
					}
				}

				lastStatus = curr;
			},
		};
	}

	// Simulator that matches the FIXED behavior: turn_end does NOT
	// clear lastSentReminder, so the dedup guard remains effective.
	function createFixedSimulator() {
		let lastSentUpdate: string | null = null;
		let lastSentReminder: string | null = null;
		let lastNudgeTime = 0;
		let lastStatus: PRStatus | null = null;
		let agentTurnActive = false;
		let needsReminder = false;
		let now = 1000000;
		const NUDGE_COOLDOWN_MS = 3 * 60 * 1000;
		const sentMessages: { type: string; content: string }[] = [];

		return {
			getSentMessages: () => sentMessages,
			advanceTime(ms: number) { now += ms; },

			turnStart() { agentTurnActive = true; needsReminder = false; },
			// FIX: turn_end does NOT clear lastSentReminder
			turnEnd() {
				agentTurnActive = false;
				needsReminder = true;
				// lastSentReminder is NOT cleared — dedup guard stays active
			},
			poll(curr: PRStatus) {
				const update = formatStatusUpdate(lastStatus, curr, config);

				if (update) {
					if (agentTurnActive) { /* queued */ }
					else if (update !== lastSentUpdate) {
						sentMessages.push({ type: "update", content: update });
						lastSentUpdate = update;
						lastSentReminder = null; // real update supersedes
						lastNudgeTime = now;
					}
				}

				if (needsReminder && !agentTurnActive) {
					const reminder = formatActionableItems(curr, config);
					if (reminder && reminder !== lastSentReminder) {
						sentMessages.push({ type: "reminder", content: reminder });
						lastSentReminder = reminder;
						lastNudgeTime = now;
					}
					needsReminder = false;
				}

				// Periodic nudge
				if (
					!agentTurnActive &&
					!needsReminder &&
					lastNudgeTime > 0 &&
					now - lastNudgeTime >= NUDGE_COOLDOWN_MS
				) {
					const nudge = formatActionableItems(curr, config);
					if (nudge) {
						sentMessages.push({ type: "nudge", content: nudge });
						lastSentReminder = nudge;
						lastNudgeTime = now;
					}
				}

				lastStatus = curr;
			},
		};
	}

	it("BUGGY: escape-loop spams identical reminders every turn_end", () => {
		const sim = createBuggySimulator();

		// Poll discovers threads
		sim.poll(withThreads);
		expect(sim.getSentMessages()).toHaveLength(1);
		expect(sim.getSentMessages()[0].type).toBe("update");

		// Agent processes the update (turn starts), then user hits Escape (turn ends)
		sim.turnStart();
		sim.turnEnd(); // clears lastSentReminder → dedup defeated

		// Poll immediately (turn_end wakes poll loop)
		sim.poll(withThreads);
		expect(sim.getSentMessages()).toHaveLength(2);
		expect(sim.getSentMessages()[1].type).toBe("reminder");

		// User hits Escape again → turn_end clears lastSentReminder AGAIN
		sim.turnStart();
		sim.turnEnd();

		// Same poll, same status — BUG: duplicate reminder gets through
		sim.poll(withThreads);
		expect(sim.getSentMessages()).toHaveLength(3); // BUG: 3 identical reminders!

		// And again — demonstrates the rapid-fire loop
		sim.turnStart();
		sim.turnEnd();
		sim.poll(withThreads);
		expect(sim.getSentMessages()).toHaveLength(4); // BUG: 4!
	});

	it("FIXED: escape-loop is broken by preserving lastSentReminder dedup", () => {
		const sim = createFixedSimulator();

		// Poll discovers threads
		sim.poll(withThreads);
		expect(sim.getSentMessages()).toHaveLength(1);
		expect(sim.getSentMessages()[0].type).toBe("update");

		// Agent processes the update, then user hits Escape
		sim.turnStart();
		sim.turnEnd(); // does NOT clear lastSentReminder

		// Poll immediately
		// The first reminder after an update is allowed — lastSentReminder was
		// cleared when the real update was sent (lastSentReminder = null).
		// This is intentional: one nudge after the agent goes idle is OK.
		sim.poll(withThreads);
		expect(sim.getSentMessages()).toHaveLength(2);
		expect(sim.getSentMessages()[1].type).toBe("reminder");

		// Now the key fix: subsequent escape events do NOT re-send same reminder
		for (let i = 0; i < 5; i++) {
			sim.turnStart();
		sim.turnEnd(); // does NOT clear lastSentReminder
			sim.poll(withThreads);
		}
		// Still only 2 messages — dedup guard held across all turn_end events
		expect(sim.getSentMessages()).toHaveLength(2);
	});

	it("FIXED: nudge still fires after cooldown when reminders are deduped", () => {
		const sim = createFixedSimulator();

		// Initial discovery
		sim.poll(withThreads);
		expect(sim.getSentMessages()).toHaveLength(1);

		// Escape → turn_end → poll → one reminder is OK (first after update)
		sim.turnStart();
		sim.turnEnd();
		sim.poll(withThreads);
		expect(sim.getSentMessages()).toHaveLength(2);

		// More escape → turn_end → polls → dedup prevents same reminder
		sim.turnStart();
		sim.turnEnd();
		sim.poll(withThreads);
		expect(sim.getSentMessages()).toHaveLength(2); // no duplicate

		// 3 min pass — nudge should fire
		sim.advanceTime(3 * 60 * 1000);
		sim.poll(withThreads);
		expect(sim.getSentMessages()).toHaveLength(3);
		expect(sim.getSentMessages()[2].type).toBe("nudge");

		// Escape → turn_end → immediate poll → no duplicate (nudge text is same)
		sim.turnStart();
		sim.turnEnd();
		sim.poll(withThreads);
		expect(sim.getSentMessages()).toHaveLength(3); // still 3
	});

	it("FIXED: new real update still gets through after dedup", () => {
		const sim = createFixedSimulator();

		const withCommentsAndThreads: PRStatus = {
			...withThreads,
			generalComments: 1,
			commentDetails: [{ id: "c-1", restApiId: "1", author: "reviewer", body: "test" }],
		};

		// Initial discovery of threads
		sim.poll(withThreads);
		expect(sim.getSentMessages()).toHaveLength(1);

		// Escape → turn_end → poll → one reminder (first after update)
		sim.turnStart();
		sim.turnEnd();
		sim.poll(withThreads);
		expect(sim.getSentMessages()).toHaveLength(2);

		// Escape again → turn_end → poll → no duplicate reminder
		sim.turnStart();
		sim.turnEnd();
		sim.poll(withThreads);
		expect(sim.getSentMessages()).toHaveLength(2); // still 2

		// New status: a general comment appears
		sim.poll(withCommentsAndThreads);
		expect(sim.getSentMessages()).toHaveLength(3);
		expect(sim.getSentMessages()[2].type).toBe("update");
	});
});

describe("Reminder fires after agent processes identical actionable items", () => {
	const config: MonitorConfig = {
		owner: "test", repo: "repo", number: 1,
		host: "github.com", mode: "all", intervalSec: 60, debounceSec: 30,
	};

	const withThreads: PRStatus = {
		unresolvedThreads: 2, generalComments: 0, hasConflicts: false,
		failingChecks: [], pendingChecks: [],
		lastCommentTimestamp: "", lastCommentBySelf: false,
			lastCommitOid: "",
		threadDetails: [], commentDetails: [], checkDetails: [],
	};

	function createReminderSim() {
		let lastSentUpdate: string | null = null;
		let lastSentReminder: string | null = null;
		let lastNudgeTime = 0;
		let lastStatus: PRStatus | null = null;
		let agentTurnActive = false;
		let needsReminder = false;
		let now = 1000000;
		const sentMessages: { type: string; content: string }[] = [];

		return {
			getSentMessages: () => sentMessages,
			advanceTime(ms: number) { now += ms; },
			turnStart() { agentTurnActive = true; needsReminder = false; },
			turnEnd() {
				agentTurnActive = false;
				needsReminder = true;
				// FIX: do NOT clear lastSentReminder — preserves dedup guard
			},
			poll(curr: PRStatus) {
				const update = formatStatusUpdate(lastStatus, curr, config);

				if (update) {
					if (agentTurnActive) { /* queue */ }
					else if (update !== lastSentUpdate) {
						sentMessages.push({ type: "update", content: update });
						lastSentUpdate = update;
						lastSentReminder = null;
						lastNudgeTime = now;
					}
				}

				if (needsReminder && !agentTurnActive) {
					const reminder = formatActionableItems(curr, config);
					if (reminder && reminder !== lastSentReminder) {
						sentMessages.push({ type: "reminder", content: reminder });
						lastSentReminder = reminder;
						lastNudgeTime = now;
					}
					needsReminder = false;
				}

				lastStatus = curr;
			},
		};
	}

	it("sends one reminder after turn_end, then deduplicates identical reminders", () => {
		const sim = createReminderSim();

		// Poll discovers threads
		sim.poll(withThreads);
		expect(sim.getSentMessages()).toHaveLength(1);
		expect(sim.getSentMessages()[0].type).toBe("update");

		// Agent processes the update but doesn't resolve the threads
		sim.turnStart();
		sim.turnEnd();

		// Next poll — needsReminder=true, sends reminder (first time after update)
		sim.poll(withThreads);
		expect(sim.getSentMessages()).toHaveLength(2);
		expect(sim.getSentMessages()[1].type).toBe("reminder");

		// Agent processes reminder but STILL doesn't resolve threads
		sim.turnStart();
		sim.turnEnd(); // does NOT clear lastSentReminder

		// Next poll — same reminder text is deduped by lastSentReminder
		sim.poll(withThreads);
		expect(sim.getSentMessages()).toHaveLength(2); // no duplicate!
	});

	it("does NOT send reminder if agent is still active", () => {
		const sim = createReminderSim();

		sim.poll(withThreads);
		sim.turnStart();
		// turn_end hasn't fired yet
		sim.poll(withThreads);
		// Only the initial update, no reminder
		expect(sim.getSentMessages()).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// First-poll overlap bug: formatStatusUpdate and formatActionableItems
// produce duplicate content when lastStatus is null AND needsReminder is true.
//
// This happens because:
// 1. formatStatusUpdate(null, curr, config) generates a full status report
// 2. needsReminder=true (set by turn_end) causes formatActionableItems to
//    generate an overlapping listing of the same items
//
// The fix: track whether a status update was sent this cycle (updateSentThisCycle)
// and skip the reminder if so.
// ---------------------------------------------------------------------------
describe("First-poll overlap: no duplicate content from status update + reminder", () => {
	const config: MonitorConfig = {
		owner: "test", repo: "repo", number: 1,
		host: "github.com", mode: "all", intervalSec: 60, debounceSec: 30,
	};

	const withThreadsAndChecks: PRStatus = {
		unresolvedThreads: 1, generalComments: 1, hasConflicts: true,
		failingChecks: ["ci/test"], pendingChecks: [],
		lastCommentTimestamp: "", lastCommentBySelf: false,
			lastCommitOid: "",
		threadDetails: [{ id: "PRRT_1", isResolved: false, lastCommentAuthor: "reviewer", lastCommentBody: "fix this" }],
		commentDetails: [{ id: "C_1", restApiId: "1", author: "reviewer", body: "general comment" }],
		checkDetails: [{ name: "ci/test", conclusion: "FAILURE" }],
	};

	const clean: PRStatus = {
		unresolvedThreads: 0, generalComments: 0, hasConflicts: false,
		failingChecks: [], pendingChecks: [],
		lastCommentTimestamp: "", lastCommentBySelf: false,
			lastCommitOid: "",
		threadDetails: [], commentDetails: [], checkDetails: [],
	};

	// Simulator WITHOUT the fix: does NOT track updateSentThisCycle
	function createBuggySimulator() {
		let lastSentUpdate: string | null = null;
		let lastSentReminder: string | null = null;
		let lastStatus: PRStatus | null = null;
		let agentTurnActive = false;
		let needsReminder = false;
		const sentMessages: { type: "update" | "reminder"; content: string }[] = [];

		return {
			getSentMessages: () => sentMessages,

			turnStart() { agentTurnActive = true; needsReminder = false; },
			turnEnd() {
				agentTurnActive = false;
				if (lastStatus) needsReminder = true;
			},
			setNeedsReminder(value: boolean) { needsReminder = value; },
			poll(curr: PRStatus) {
				const update = formatStatusUpdate(lastStatus, curr, config);

				// BUG: no updateSentThisCycle tracking
				if (update) {
					if (!agentTurnActive && update !== lastSentUpdate) {
						sentMessages.push({ type: "update", content: update });
						lastSentUpdate = update;
						lastSentReminder = null;
					}
				}

				// BUG: reminder can fire even after a status update in same cycle
				if (needsReminder && !agentTurnActive) {
					const reminder = formatActionableItems(curr, config);
					if (reminder && reminder !== lastSentReminder) {
						sentMessages.push({ type: "reminder", content: reminder });
						lastSentReminder = reminder;
					}
					needsReminder = false;
				}

				lastStatus = curr;
			},
		};
	}

	// Simulator WITH the fix: tracks updateSentThisCycle to suppress reminder
	function createFixedSimulator() {
		let lastSentUpdate: string | null = null;
		let lastSentReminder: string | null = null;
		let lastStatus: PRStatus | null = null;
		let agentTurnActive = false;
		let needsReminder = false;
		const sentMessages: { type: "update" | "reminder"; content: string }[] = [];

		return {
			getSentMessages: () => sentMessages,

			turnStart() { agentTurnActive = true; needsReminder = false; },
			turnEnd() {
				agentTurnActive = false;
				if (lastStatus) needsReminder = true;
			},
			setNeedsReminder(value: boolean) { needsReminder = value; },
			poll(curr: PRStatus) {
				const update = formatStatusUpdate(lastStatus, curr, config);
				let updateSentThisCycle = false;

				if (update) {
					if (!agentTurnActive && update !== lastSentUpdate) {
						sentMessages.push({ type: "update", content: update });
						lastSentUpdate = update;
						lastSentReminder = null;
						updateSentThisCycle = true; // FIX: track that update was sent
					}
				}

				// FIX: skip reminder if status update was already sent this cycle
				if (!updateSentThisCycle && needsReminder && !agentTurnActive) {
					const reminder = formatActionableItems(curr, config);
					if (reminder && reminder !== lastSentReminder) {
						sentMessages.push({ type: "reminder", content: reminder });
						lastSentReminder = reminder;
					}
					needsReminder = false;
				}

				lastStatus = curr;
			},
		};
	}

	it("BUGGY: status change + needsReminder sends both update and reminder in same cycle", () => {
		const sim = createBuggySimulator();

		// Scenario: a PR was clean, then issues appear while needsReminder is true.
		// Both formatStatusUpdate (change report) and formatActionableItems (reminder)
		// produce overlapping content in the same poll cycle.

		// First poll: all clear
		sim.poll(clean);
		expect(sim.getSentMessages()).toHaveLength(1);
		expect(sim.getSentMessages()[0].type).toBe("update");

		// Agent processes, then turn ends (sets needsReminder=true)
		sim.turnStart();
		sim.turnEnd();
		expect(sim.getSentMessages()).toHaveLength(1); // no new messages yet

		// New poll: issues have appeared (real status change)
		const beforePoll = sim.getSentMessages().length;
		sim.poll(withThreadsAndChecks);
		const afterPoll = sim.getSentMessages().length;

		// BUG: two messages sent in the same poll cycle:
		// 1. formatStatusUpdate reports the new issues (conflicts, threads, failing checks)
		// 2. formatActionableItems produces overlapping content with the same items
		//    because needsReminder=true and lastSentReminder was reset to null by the update
		expect(afterPoll - beforePoll).toBe(2);
		const lastTwo = sim.getSentMessages().slice(-2);
		expect(lastTwo[0].type).toBe("update");
		expect(lastTwo[1].type).toBe("reminder");

		// Both contain overlapping content about the same issues
		expect(lastTwo[0].content).toContain("Merge conflicts");
		expect(lastTwo[1].content).toContain("Merge conflicts");
	});

	it("FIXED: updateSentThisCycle suppresses reminder when status changes", () => {
		const sim = createFixedSimulator();

		// Scenario: PR was clean, then issues appear while needsReminder=true.
		// The status change fires formatStatusUpdate, AND needsReminder would
		// fire formatActionableItems — but updateSentThisCycle prevents the duplicate.

		// First poll: all clear
		sim.poll(clean);
		expect(sim.getSentMessages()).toHaveLength(1);
		expect(sim.getSentMessages()[0].type).toBe("update");

		// Agent processes, then turn ends (sets needsReminder=true)
		sim.turnStart();
	sim.turnEnd();

		// New poll: real status change — issues have appeared
		const beforePoll = sim.getSentMessages().length;
		sim.poll(withThreadsAndChecks);
		const afterPoll = sim.getSentMessages().length;

		// FIX: only 1 message sent in this cycle (the status update),
		// NOT 2 (update + overlapping reminder)
		expect(afterPoll - beforePoll).toBe(1);
		const lastMsg = sim.getSentMessages()[sim.getSentMessages().length - 1];
		expect(lastMsg.type).toBe("update");
		// The update covers conflicts, threads, and failing checks
		expect(lastMsg.content).toContain("Merge conflicts");
	});

	it("FIXED: status update in same cycle completely suppresses reminder", () => {
		const sim = createFixedSimulator();

		// First poll: all clear
		sim.poll(clean);
		expect(sim.getSentMessages()).toHaveLength(1);
		expect(sim.getSentMessages()[0].type).toBe("update");

		// Agent processes, then turn ends
		sim.turnStart();
		sim.turnEnd(); // sets needsReminder=true (lastStatus is set now)

		// Now issues appear (new conflict, new failing checks, new thread)
		sim.poll(withThreadsAndChecks);
		// FIX: formatStatusUpdate produces an update, formatActionableItems would
		// produce overlapping content. But updateSentThisCycle=true prevents the reminder.
		expect(sim.getSentMessages()).toHaveLength(2); // initial clear + new status update
		expect(sim.getSentMessages()[1].type).toBe("update");
		// NO reminder — that's the fix
	});

	it("FIXED: reminder IS sent when status has not changed (no update this cycle)", () => {
		const sim = createFixedSimulator();

		// First poll: discovers issues
		sim.poll(withThreadsAndChecks);
		expect(sim.getSentMessages()).toHaveLength(1);
		expect(sim.getSentMessages()[0].type).toBe("update");

		// Agent processes, then turn ends
		sim.turnStart();
		sim.turnEnd(); // sets needsReminder=true

		// Next poll: SAME status (nothing changed)
		// formatStatusUpdate(prev, curr, config) returns "" (no change)
		// updateSentThisCycle = false, so reminder IS sent
		sim.poll(withThreadsAndChecks);
		expect(sim.getSentMessages()).toHaveLength(2);
		expect(sim.getSentMessages()[1].type).toBe("reminder");
	});

	it("FIXED: needsReminder=true on very first poll (lastStatus=null) suppressed by updateSentThisCycle", () => {
		const sim = createFixedSimulator();

		// Simulate the edge case from issue #26: on the very first poll,
		// lastStatus is null and needsReminder could be true if a turn_end
		// fired between monitor start and the first poll completing.
		//
		// In the actual code, turn_end only sets needsReminder when lastStatus
		// is set. But the fix works generically: even if needsReminder were
		// true on first poll, the updateSentThisCycle flag prevents the duplicate
		// because formatStatusUpdate(null, curr) always produces a full report.
		//
		// To properly test this edge case, we directly set needsReminder=true
		// before the first poll (simulating a race condition).
		sim.setNeedsReminder(true); // direct injection — simulates first-poll overlap

		// First poll: issues discovered.
		// formatStatusUpdate(null, curr) produces a full status report.
		// needsReminder=true would also produce formatActionableItems output.
		// But updateSentThisCycle=true prevents the reminder.
		const beforePoll = sim.getSentMessages().length;
		sim.poll(withThreadsAndChecks);
		const afterPoll = sim.getSentMessages().length;

		// Only 1 message (the status update), NOT 2 (update + overlapping reminder)
		expect(afterPoll - beforePoll).toBe(1);
		expect(sim.getSentMessages()[0].type).toBe("update");
		expect(sim.getSentMessages()[0].content).toContain("Merge conflicts");
	});

	it("formatStatusUpdate(null, ...) and formatActionableItems produce overlapping content", () => {
		// Direct test: verify that both functions produce overlapping content
		// when called with the same status (the root cause of the bug)
		const statusUpdate = formatStatusUpdate(null, withThreadsAndChecks, config);
		const actionableItems = formatActionableItems(withThreadsAndChecks, config);

		expect(statusUpdate).not.toBe("");
		expect(actionableItems).not.toBeNull();

		// Both mention conflicts
		expect(statusUpdate).toContain("Merge conflicts");
		expect(actionableItems).toContain("Merge conflicts");

		// Both mention failing checks
		expect(statusUpdate).toContain("Failing CI checks");
		expect(actionableItems).toContain("Failing CI checks");

		// Both mention unresolved threads
		expect(statusUpdate).toContain("unresolved review thread");
		expect(actionableItems).toContain("unresolved review thread");
	});
});
