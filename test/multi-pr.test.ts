/**
 * Comprehensive unit tests for multi-PR monitoring feature.
 *
 * Tests the new Map<string, ActiveMonitor> architecture, PR key generation,
 * adding/removing multiple monitors, per-monitor state isolation, footer
 * aggregation, command parsing with multi-PR support, and the stop action restriction.
 *
 * Uses structural/source-inspection patterns (like code-structure.test.ts)
 * since index.ts has Pi SDK dependencies that prevent direct import.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const src = fs.readFileSync(
	path.join(__dirname, "..", "src", "index.ts"),
	"utf-8",
);

// ---------------------------------------------------------------------------
// Inlined pure function tests (same logic as in src/index.ts)
// ---------------------------------------------------------------------------

const PR_URL_RE = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/([0-9]+)/i;

interface ParsedPR {
	owner: string;
	repo: string;
	number: number;
	host: string;
}

function parsePRUrl(input: string): ParsedPR | null {
	const m = input.trim().match(PR_URL_RE);
	if (!m) return null;
	const host = m[1] === "github.com" ? "github.com" : m[1];
	return { owner: m[2], repo: m[3], number: parseInt(m[4], 10), host };
}

function parsePRShorthand(input: string): ParsedPR | null {
	const hashM = input.trim().match(/^([^\s#/]+)\/([^#]+)#([0-9]+)$/);
	if (hashM) {
		return { owner: hashM[1], repo: hashM[2], number: parseInt(hashM[3], 10), host: "github.com" };
	}
	return null;
}

function prKey(owner: string, repo: string, number: number, host?: string): string {
	return (!host || host === "github.com")
		? `${owner}/${repo}#${number}`
		: `${host}/${owner}/${repo}#${number}`;
}

// ---------------------------------------------------------------------------
// PR key generation tests
// ---------------------------------------------------------------------------

describe("prKey", () => {
	it("generates key for github.com PR", () => {
		expect(prKey("v2nic", "pi-ghpr-monitor", 366)).toBe("v2nic/pi-ghpr-monitor#366");
	});

	it("generates key for GitHub Enterprise PR", () => {
		expect(prKey("team", "project", 99, "github.corp.com")).toBe("github.corp.com/team/project#99");
	});

	it("omits github.com prefix for default host", () => {
		const key1 = prKey("owner", "repo", 1);
		const key2 = prKey("owner", "repo", 1, "github.com");
		expect(key1).toBe(key2);
		expect(key1).toBe("owner/repo#1");
	});

	it("different PRs produce different keys", () => {
		expect(prKey("owner", "repo", 1)).not.toBe(prKey("owner", "repo", 2));
		expect(prKey("owner", "repo-a", 1)).not.toBe(prKey("owner", "repo-b", 1));
		expect(prKey("alice", "repo", 1)).not.toBe(prKey("bob", "repo", 1));
	});

	it("same PR produces same key", () => {
		expect(prKey("v2nic", "pi-ghpr-monitor", 42)).toBe(prKey("v2nic", "pi-ghpr-monitor", 42));
	});

	it("URL and shorthand produce same key for same PR", () => {
		const urlResult = parsePRUrl("https://github.com/v2nic/pi-ghpr-monitor/pull/42");
		const shorthandResult = parsePRShorthand("v2nic/pi-ghpr-monitor#42");
		expect(urlResult).not.toBeNull();
		expect(shorthandResult).not.toBeNull();
		if (urlResult && shorthandResult) {
			const keyFromUrl = prKey(urlResult.owner, urlResult.repo, urlResult.number, urlResult.host);
			const keyFromShorthand = prKey(shorthandResult.owner, shorthandResult.repo, shorthandResult.number, shorthandResult.host);
			expect(keyFromUrl).toBe(keyFromShorthand);
		}
	});
});

// ---------------------------------------------------------------------------
// PR URL/shorthand parsing in multi-PR context
// ---------------------------------------------------------------------------

describe("parsePRUrl (multi-PR context)", () => {
	it("parses a standard GitHub PR URL", () => {
		const result = parsePRUrl("https://github.com/v2nic/pi-ghpr-monitor/pull/366");
		expect(result).toEqual({
			owner: "v2nic",
			repo: "pi-ghpr-monitor",
			number: 366,
			host: "github.com",
		});
	});

	it("parses a GitHub Enterprise URL", () => {
		const result = parsePRUrl("https://github.corp.com/team/project/pull/42");
		expect(result).toEqual({
			owner: "team",
			repo: "project",
			number: 42,
			host: "github.corp.com",
		});
	});

	it("returns null for non-PR URLs", () => {
		expect(parsePRUrl("https://github.com/v2nic/pi-ghpr-monitor")).toBeNull();
		expect(parsePRUrl("not a url")).toBeNull();
	});
});

describe("parsePRShorthand (multi-PR context)", () => {
	it("parses owner/repo#number format", () => {
		const result = parsePRShorthand("v2nic/pi-ghpr-monitor#42");
		expect(result).toEqual({
			owner: "v2nic",
			repo: "pi-ghpr-monitor",
			number: 42,
			host: "github.com",
		});
	});

	it("returns null for invalid formats", () => {
		expect(parsePRShorthand("")).toBeNull();
		expect(parsePRShorthand("v2nic/repo")).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Structural tests for multi-PR architecture
// ---------------------------------------------------------------------------

describe("Multi-PR architecture structure", () => {
	it("uses Map<string, ActiveMonitor> instead of single monitorState", () => {
		expect(src).toContain("monitors: Map<string, ActiveMonitor>");
		expect(src).not.toContain("monitorState: MonitorState");
	});

	it("defines the ActiveMonitor interface with per-monitor state", () => {
		expect(src).toContain("interface ActiveMonitor");
		expect(src).toContain("config: MonitorConfig");
		expect(src).toContain("controller: AbortController");
		expect(src).toContain("lastStatus: PRStatus | IssueStatus | null");
		expect(src).toContain("lastStatusTimestamp: Date | null");
		expect(src).toContain("backoffSec: number");
		expect(src).toContain("consecutiveNoChange: number");
		expect(src).toContain("forceNotify: boolean");
		expect(src).toContain("needsReminder: boolean");
	});

	it("startMonitor adds to the map, handles duplicate keys", () => {
		const startFn = src.slice(
			src.indexOf("function startMonitor(config: MonitorConfig)"),
			src.indexOf("function stopMonitorByKey"),
		);
		expect(startFn).toContain("monitors.set(key, mon)");
		expect(startFn).toContain("monitors.has(key)");
		expect(startFn).toContain("alreadyMonitoring");
		// Must NOT call stopMonitor/stopAllMonitors before starting
		expect(startFn).not.toContain("stopMonitor()");
		expect(startFn).not.toContain("stopAllMonitors()");
	});

	it("stopMonitorByKey removes individual monitors", () => {
		expect(src).toContain("function stopMonitorByKey(key: string)");
		const stopFn = src.slice(
			src.indexOf("function stopMonitorByKey(key: string)"),
			src.indexOf("function stopAllMonitors()"),
		);
		expect(stopFn).toContain("monitors.get(key)");
		expect(stopFn).toContain("mon.controller.abort()");
		expect(stopFn).toContain("monitors.delete(key)");
		expect(stopFn).toContain("updateFooter()");
	});

	it("stopAllMonitors clears all monitors", () => {
		expect(src).toContain("function stopAllMonitors()");
		const stopAllFn = src.slice(
			src.indexOf("function stopAllMonitors()"),
			src.indexOf("function updateFooter()"),
		);
		expect(stopAllFn).toContain("monitors.size");
		expect(stopAllFn).toContain("mon.controller.abort()");
		expect(stopAllFn).toContain("monitors.clear()");
		expect(stopAllFn).toContain("updateFooter()");
	});

	it("footer shows one line per PR with clickable links", () => {
		const footerFn = src.slice(
			src.indexOf("function updateFooter()"),
			src.indexOf("async function pollLoop"),
		);
		expect(footerFn).toContain("monitors.size === 0");
		expect(footerFn).toContain("monitors.size === 1");
		expect(footerFn).toContain("linkifyPRRefs(formatFooterStatus");
		expect(footerFn).toContain("lines.join");
		expect(footerFn).toContain("monitors.values()");
	});

	it("formatCurrentStatus lists all monitors", () => {
		const statusFn = src.slice(
			src.indexOf("function formatCurrentStatus()"),
			src.indexOf("function formatCurrentStatus()") + 2000,
		);
		expect(statusFn).toContain("for (const mon of monitors.values())");
		expect(statusFn).toContain("lines.join");
	});

	it("session_shutdown cleans up all monitors", () => {
		const shutdownBlock = src.slice(
			src.indexOf('pi.on("session_shutdown"'),
			src.indexOf("function startMonitor"),
		);
		expect(shutdownBlock).toContain("stopAllMonitors()");
	});

	it("turn_end sets needsReminder for each monitor independently", () => {
		const turnEndIdx = src.indexOf('pi.on("turn_end"');
		const afterTurnEnd = src.slice(turnEndIdx, turnEndIdx + 1500);
		expect(afterTurnEnd).toContain("mon.needsReminder = true");
	});

	it("turn_start resets needsReminder for each monitor", () => {
		const turnStartBlock = src.slice(
			src.indexOf('pi.on("turn_start"'),
			src.indexOf('pi.on("turn_end"'),
		);
		expect(turnStartBlock).toContain("mon.needsReminder = false");
	});

	it("pollLoop takes ActiveMonitor parameter", () => {
		expect(src).toContain("async function pollLoop(mon: ActiveMonitor)");
	});

	it("merged/closed PR auto-removes from monitors map", () => {
		const pollLoopBlock = src.slice(
			src.indexOf("async function pollLoop(mon: ActiveMonitor)"),
			src.indexOf("function formatCurrentStatus()"),
		);
		expect(pollLoopBlock).toContain("monitors.delete(key)");
		expect(pollLoopBlock).toContain("updateFooter()");
	});

	it("check command can check all or specific monitor", () => {
		const checkBlock = src.slice(
			src.indexOf('// Parse: check [PR identifier]'),
			src.indexOf("// Try parsing as a PR URL"),
		);
		expect(checkBlock).toContain("mon.forceNotify = true");
		expect(checkBlock).toContain("resolveMonitorKey");
		expect(checkBlock).toContain("monitors.values()");
	});

	it("off command can stop all or specific monitor", () => {
		const offBlock = src.slice(
			src.indexOf('// Parse: off [PR identifier]'),
			src.indexOf('// Parse: check'),
		);
		expect(offBlock).toContain("stopAllMonitors()");
		expect(offBlock).toContain("stopMonitorByKey");
		expect(offBlock).toContain("resolveMonitorKey");
	});

	it("resolveMonitorKey resolves various PR identifier formats", () => {
		expect(src).toContain("function resolveMonitorKey(input: string)");
		const resolveFn = src.slice(
			src.indexOf("function resolveMonitorKey(input: string)"),
			src.indexOf("function resolveMonitorKey(input: string)") + 2000,
		);
		expect(resolveFn).toContain("parsePRUrl");
		expect(resolveFn).toContain("parsePRShorthand");
		expect(resolveFn).toContain("monitors.has");
	});

	it("tool supports start, status, and check actions (NOT stop)", () => {
		const match = src.match(/action:\s*Type\.Union\(\[(.+)\]\)/);
		expect(match).not.toBeNull();
		const actions = match![1];
		expect(actions).toContain('"start"');
		expect(actions).toContain('"status"');
		expect(actions).toContain('"check"');
		expect(actions).not.toContain('"stop"'); // LLM must not be able to stop monitoring
	});

	it("tool status action reports count of all monitors", () => {
		const statusBlock = src.slice(
			src.indexOf('case "status"'),
			src.indexOf('case "check"'),
		);
		expect(statusBlock).toContain("monitors.size");
		expect(statusBlock).toContain("activeMonitors: monitors.size");
		expect(statusBlock).toContain("buildDetailedStatusLines()");
	});

	it("tool check action can check all or specific monitor", () => {
		const checkBlock = src.slice(
			src.indexOf('case "check"'),
			src.indexOf('case "stop"'),
		);
		expect(checkBlock).toContain("mon.forceNotify = true");
		expect(checkBlock).toContain("monitors.values()");
		expect(checkBlock).toContain("resolvePR()");
		expect(checkBlock).toContain("monitors.get(key)");
	});

	it("tool stop action is forbidden for the agent (handled in default/fallback)", () => {
		// The stop action is NOT in the Type.Union, so it falls through to
		// the default case which handles it as unknown/invalid via exhaustiveness check
		const defaultBlock = src.slice(
			src.indexOf('default:'),
			src.indexOf("});\n\t});\n\t}", src.indexOf('default:')), 
		);
		// The default case includes exhaustiveness check via 'never' type
		expect(defaultBlock).toContain("never");
		// Stop action is NOT in the allowed actions (verified by earlier test)
		const actionMatch = src.match(/action:\s*Type\.Union\(\[(.+)\]\)/);
		expect(actionMatch![1]).not.toContain('"stop"');
	});

	it("start action returns already_running for duplicate monitor", () => {
		const startBlock = src.slice(
			src.indexOf('case "start"'),
			src.indexOf('case "status"'),
		);
		expect(startBlock).toContain("alreadyMonitoring");
	});
});

// ---------------------------------------------------------------------------
// Per-monitor state isolation simulation
// ---------------------------------------------------------------------------

describe("ActiveMonitor state isolation simulation", () => {
	interface SimMonitor {
		key: string;
		owner: string;
		repo: string;
		number: number;
		backoffSec: number;
		consecutiveNoChange: number;
		forceNotify: boolean;
		needsReminder: boolean;
		lastNudgeTime: number;
		controller: AbortController;
	}

	function createSimMonitor(owner: string, repo: string, number: number): SimMonitor {
		return {
			key: prKey(owner, repo, number),
			owner,
			repo,
			number,
			backoffSec: 0,
			consecutiveNoChange: 0,
			forceNotify: false,
			needsReminder: false,
			lastNudgeTime: 0,
			controller: new AbortController(),
		};
	}

	it("each monitor has independent backoff state", () => {
		const monitors: Map<string, SimMonitor> = new Map();
		monitors.set("v2nic/repo-a#1", createSimMonitor("v2nic", "repo-a", 1));
		monitors.set("v2nic/repo-b#2", createSimMonitor("v2nic", "repo-b", 2));

		// Simulate error on repo-a only
		const monA = monitors.get("v2nic/repo-a#1")!;
		monA.backoffSec = 60;

		const monB = monitors.get("v2nic/repo-b#2")!;
		expect(monB.backoffSec).toBe(0);
		expect(monA.backoffSec).toBe(60);
	});

	it("aborts independent monitors without affecting others", () => {
		const monitors: Map<string, SimMonitor> = new Map();
		monitors.set("v2nic/repo-a#1", createSimMonitor("v2nic", "repo-a", 1));
		monitors.set("v2nic/repo-b#2", createSimMonitor("v2nic", "repo-b", 2));

		// Abort repo-a
		monitors.get("v2nic/repo-a#1")!.controller.abort();
		monitors.delete("v2nic/repo-a#1");

		expect(monitors.size).toBe(1);
		expect(monitors.has("v2nic/repo-a#1")).toBe(false);
		expect(monitors.has("v2nic/repo-b#2")).toBe(true);
		expect(monitors.get("v2nic/repo-b#2")!.controller.signal.aborted).toBe(false);
	});

	it("forceNotify is per-monitor", () => {
		const monitors: Map<string, SimMonitor> = new Map();
		monitors.set("v2nic/repo-a#1", createSimMonitor("v2nic", "repo-a", 1));
		monitors.set("v2nic/repo-b#2", createSimMonitor("v2nic", "repo-b", 2));

		// Force check on repo-a only
		monitors.get("v2nic/repo-a#1")!.forceNotify = true;
		expect(monitors.get("v2nic/repo-a#1")!.forceNotify).toBe(true);
		expect(monitors.get("v2nic/repo-b#2")!.forceNotify).toBe(false);
	});

	it("can add a third monitor while two are running", () => {
		const monitors: Map<string, SimMonitor> = new Map();
		monitors.set("v2nic/repo-a#1", createSimMonitor("v2nic", "repo-a", 1));
		monitors.set("v2nic/repo-b#2", createSimMonitor("v2nic", "repo-b", 2));

		expect(monitors.size).toBe(2);

		monitors.set("other/repo-c#3", createSimMonitor("other", "repo-c", 3));
		expect(monitors.size).toBe(3);
		expect(monitors.has("v2nic/repo-a#1")).toBe(true);
		expect(monitors.has("v2nic/repo-b#2")).toBe(true);
		expect(monitors.has("other/repo-c#3")).toBe(true);
	});

	it("can remove a specific monitor while others continue", () => {
		const monitors: Map<string, SimMonitor> = new Map();
		monitors.set("v2nic/repo-a#1", createSimMonitor("v2nic", "repo-a", 1));
		monitors.set("v2nic/repo-b#2", createSimMonitor("v2nic", "repo-b", 2));
		monitors.set("other/repo-c#3", createSimMonitor("other", "repo-c", 3));

		// Stop repo-b
		monitors.get("v2nic/repo-b#2")!.controller.abort();
		monitors.delete("v2nic/repo-b#2");

		expect(monitors.size).toBe(2);
		expect(monitors.has("v2nic/repo-a#1")).toBe(true);
		expect(monitors.has("v2nic/repo-b#2")).toBe(false);
		expect(monitors.has("other/repo-c#3")).toBe(true);
	});

	it("can clear all monitors at once", () => {
		const monitors: Map<string, SimMonitor> = new Map();
		monitors.set("v2nic/repo-a#1", createSimMonitor("v2nic", "repo-a", 1));
		monitors.set("v2nic/repo-b#2", createSimMonitor("v2nic", "repo-b", 2));

		for (const mon of monitors.values()) {
			mon.controller.abort();
		}
		monitors.clear();

		expect(monitors.size).toBe(0);
	});

	it("duplicate PR key is prevented", () => {
		const monitors: Map<string, SimMonitor> = new Map();
		const key = prKey("v2nic", "repo-a", 1);

		// Add monitor
		monitors.set(key, createSimMonitor("v2nic", "repo-a", 1));
		expect(monitors.size).toBe(1);

		// Check for duplicate — same key
		expect(monitors.has(key)).toBe(true);

		// The second startMonitor call should detect the duplicate
		// and return "already running" rather than overwriting
	});
});

// ---------------------------------------------------------------------------
// Footer per-line display simulation
// ---------------------------------------------------------------------------

describe("Footer per-line display simulation", () => {
	interface SimStatus {
		hasConflicts: boolean;
		unresolvedThreads: number;
		generalComments: number;
		failingChecks: string[];
		pendingChecks: string[];
	}

	/** Simulates formatFooterStatus for a single monitor. */
	function formatFooterLine(key: string, status: SimStatus | null): string {
		const url = `https://github.com/${key.replace("#", "/pull/")}`;
		if (!status) return `📡 ${url}`;
		const emojis: string[] = [];
		if (status.hasConflicts) emojis.push("⚠️");
		if (status.unresolvedThreads > 0) emojis.push("💬");
		if (status.generalComments > 0) emojis.push("💭");
		if (status.failingChecks.length > 0) emojis.push("❌");
		if (status.pendingChecks.length > 0) emojis.push("⏳");
		return emojis.length > 0 ? `📡 ${url} ${emojis.join("")}` : `📡 ${url}`;
	}

	function getFooterLabel(monitors: { key: string; status: SimStatus | null }[]): string {
		if (monitors.length === 0) return "";
		return monitors.map(m => formatFooterLine(m.key, m.status)).join("\n");
	}

	it("shows one line per PR with its status", () => {
		const result = getFooterLabel([
			{ key: "v2nic/repo-a#1", status: { hasConflicts: true, unresolvedThreads: 0, generalComments: 0, failingChecks: [], pendingChecks: [] } },
			{ key: "v2nic/repo-b#2", status: { hasConflicts: false, unresolvedThreads: 0, generalComments: 0, failingChecks: [], pendingChecks: [] } },
		]);
		expect(result).toContain("v2nic/repo-a");
		expect(result).toContain("v2nic/repo-b");
		expect(result).toContain("⚠️");
	});

	it("each PR appears on its own line separated by newline", () => {
		const result = getFooterLabel([
			{ key: "v2nic/repo-a#1", status: { hasConflicts: true, unresolvedThreads: 0, generalComments: 0, failingChecks: [], pendingChecks: [] } },
			{ key: "v2nic/repo-b#2", status: { hasConflicts: false, unresolvedThreads: 0, generalComments: 0, failingChecks: [], pendingChecks: [] } },
		]);
		const lines = result.split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain("v2nic/repo-a");
		expect(lines[1]).toContain("v2nic/repo-b");
	});

	it("shows URL for single monitor with issues", () => {
		const result = getFooterLabel([{
			key: "v2nic/repo#1",
			status: {
				hasConflicts: false,
				unresolvedThreads: 2,
				generalComments: 0,
				failingChecks: ["ci/test"],
				pendingChecks: [],
			},
		}]);
		expect(result).toContain("v2nic/repo");
		expect(result).toContain("💬");
		expect(result).toContain("❌");
	});

	it("shows URL for single monitor with no issues", () => {
		const result = getFooterLabel([{
			key: "v2nic/repo#1",
			status: {
				hasConflicts: false,
				unresolvedThreads: 0,
				generalComments: 0,
				failingChecks: [],
				pendingChecks: [],
			},
		}]);
		expect(result).toContain("v2nic/repo");
		// Single PR with no issues — no emojis
		expect(result).not.toContain("with issues");
	});

	it("shows multiple PRs with mixed statuses", () => {
		const result = getFooterLabel([
			{ key: "v2nic/repo-a#1", status: { hasConflicts: true, unresolvedThreads: 0, generalComments: 0, failingChecks: [], pendingChecks: [] } },
			{ key: "v2nic/repo-b#2", status: { hasConflicts: false, unresolvedThreads: 3, generalComments: 0, failingChecks: ["ci/test"], pendingChecks: [] } },
			{ key: "v2nic/repo-c#3", status: { hasConflicts: false, unresolvedThreads: 1, generalComments: 2, failingChecks: [], pendingChecks: [] } },
		]);
		const lines = result.split("\n");
		expect(lines).toHaveLength(3);
		expect(lines[0]).toContain("⚠️");
		expect(lines[1]).toContain("💬");
		expect(lines[1]).toContain("❌");
		expect(lines[2]).toContain("💬");
		expect(lines[2]).toContain("💭");
	});

	it("does NOT show aggregate counts", () => {
		const result = getFooterLabel([
			{ key: "v2nic/repo-a#1", status: { hasConflicts: true, unresolvedThreads: 0, generalComments: 0, failingChecks: [], pendingChecks: [] } },
			{ key: "v2nic/repo-b#2", status: { hasConflicts: false, unresolvedThreads: 0, generalComments: 0, failingChecks: [], pendingChecks: [] } },
		]);
		expect(result).not.toContain("with issues");
		expect(result).not.toContain("PRs:");
	});

	it("shows pending status emoji (not considered actionable for issues count)", () => {
		const result = getFooterLabel([{
			key: "v2nic/repo#1",
			status: {
				hasConflicts: false,
				unresolvedThreads: 0,
				generalComments: 0,
				failingChecks: [],
				pendingChecks: ["ci/build"],
			},
		}]);
		expect(result).toContain("v2nic/repo");
		expect(result).toContain("⏳");
	});

	it("shows null status as pending (not yet polled)", () => {
		const result = getFooterLabel([{
			key: "v2nic/repo#1",
			status: null,
		}]);
		expect(result).toContain("v2nic/repo");
	});
});

// ---------------------------------------------------------------------------
// Description staleness nudge tests
// ---------------------------------------------------------------------------

describe("Description staleness nudge architecture", () => {
	it("ActiveMonitor includes knownCommitOid field", () => {
		expect(src).toContain("knownCommitOid: string | null");
	});

	it("createActiveMonitor initializes knownCommitOid to null", () => {
		expect(src).toContain("knownCommitOid: null");
	});

	it("pollLoop detects commit change and sends staleness nudge", () => {
		expect(src).toContain("knownCommitOid");
		// Check the staleness nudge logic block
		expect(src).toContain("curr.lastCommitOid");
		expect(src).toContain("mon.knownCommitOid");
	});

	it("sends staleness nudge only when knownCommitOid differs and is not null", () => {
		// The logic should check knownCommitOid !== null before nudging
		expect(src).toContain("mon.knownCommitOid === null");
	});

	it("uses descriptionStaleness preference with default message", () => {
		expect(src).toContain("descriptionStaleness");
		expect(src).toContain("getPreferenceWithDefault");
		expect(src).toContain("Review the PR description");
	});

	it("sets knownCommitOid on first poll without nudging", () => {
		// The first-poll case sets knownCommitOid without sending a nudge
		const stalenessBlock = src.slice(
			src.indexOf("Description staleness nudge"),
			src.indexOf("Description staleness nudge") + 800,
		);
		expect(stalenessBlock).toContain("mon.knownCommitOid === null");
		expect(stalenessBlock).toContain("mon.knownCommitOid = curr.lastCommitOid");
	});

	it("deduplicates staleness nudge by tracking commit OID", () => {
		// Only fires once per commit OID change
		expect(src).toContain("mon.knownCommitOid = curr.lastCommitOid");
	});

	it("includes commit URL and short OID in default staleness message", () => {
		// The default message should embed a commit URL so linkifyPRRefs can
		// turn it into a clickable hyperlink whose visible text is the short SHA.
		expect(src).toContain("commitShortOid");
		expect(src).toContain("commitUrl");
		expect(src).toContain("commit/${commitOid}");
		// The default message must reference the commitUrl so it gets linkified.
		expect(src).toMatch(/New commit \$\{commitUrl\} pushed to/);
	});

	it("derives commitShortOid from the first 7 characters of lastCommitOid", () => {
		expect(src).toContain("commitOid.slice(0, 7)");
	});

	it("passes commit template variables to getPreferenceWithDefault", () => {
		// Custom descriptionStaleness templates should be able to reference
		// {commitOid}, {commitShortOid}, {commitUrl}, {commitAuthor}, and
		// {commitCoauthors}.
		const stalenessBlock = src.slice(
			src.indexOf("Description staleness nudge"),
			src.indexOf("Description staleness nudge") + 3200,
		);
		expect(stalenessBlock).toContain("commitOid,");
		expect(stalenessBlock).toContain("commitShortOid,");
		expect(stalenessBlock).toContain("commitUrl,");
		expect(stalenessBlock).toContain("commitAuthor,");
		expect(stalenessBlock).toContain("commitCoauthors,");
		expect(stalenessBlock).toContain("commitMessageHeadline:");
	});

	it("includes the commit author in the default staleness message", () => {
		// The author is sourced from the analyzed snapshot and appended as a
		// "by <author>" clause that is omitted when the author is unknown.
		expect(src).toContain("curr.lastCommitAuthor");
		expect(src).toMatch(/by \$\{commitAuthor\}/);
		expect(src).toMatch(/pushed to \$\{prLabel\}\$\{headlineClause\}\$\{authorClause\}/);
	});

	it("includes the commit headline in the default staleness message", () => {
		// The headline is the first line of the commit message, shown in quotes.
		expect(src).toContain("curr.lastCommitMessageHeadline");
		expect(src).toMatch(/headlineClause/);
		expect(src).toMatch(/"\$\{commitHeadline\}"/);
	});

	it("includes co-authors in the default staleness message, on by default", () => {
		// Co-authors come from the analyzed snapshot and are appended as a
		// ", co-authored by ..." clause, omitted when there are no co-authors.
		expect(src).toContain("curr.lastCommitCoauthors");
		expect(src).toMatch(/co-authored by \$\{commitCoauthors\}/);
		expect(src).toMatch(/\$\{prLabel\}\$\{headlineClause\}\$\{authorClause\}\$\{coauthorClause\}/);
	});
});

// ---------------------------------------------------------------------------
// Simulated staleness nudge logic tests
// ---------------------------------------------------------------------------

describe("Description staleness nudge simulation", () => {
	interface SimMonitor {
		knownCommitOid: string | null;
	}

	function shouldNudgeStaleness(
		mon: SimMonitor,
		currentCommitOid: string,
	): boolean {
		// First poll: skip nudging (knownCommitOid starts as null)
		if (mon.knownCommitOid === null) {
			return false;
		}
		// Subsequent polls: nudge if commit changed
		return currentCommitOid !== mon.knownCommitOid;
	}

	it("does not nudge on first poll (knownCommitOid is null)", () => {
		const mon: SimMonitor = { knownCommitOid: null };
		expect(shouldNudgeStaleness(mon, "abc123")).toBe(false);
	});

	it("does not nudge when commit OID has not changed", () => {
		const mon: SimMonitor = { knownCommitOid: "abc123" };
		expect(shouldNudgeStaleness(mon, "abc123")).toBe(false);
	});

	it("nudges when commit OID changes", () => {
		const mon: SimMonitor = { knownCommitOid: "abc123" };
		expect(shouldNudgeStaleness(mon, "def456")).toBe(true);
	});

	it("does not nudge again for same commit after change", () => {
		const mon: SimMonitor = { knownCommitOid: "def456" };
		expect(shouldNudgeStaleness(mon, "def456")).toBe(false);
	});

	it("nudges for each distinct commit change", () => {
		const mon: SimMonitor = { knownCommitOid: "abc123" };
		expect(shouldNudgeStaleness(mon, "def456")).toBe(true);
		// After processing, knownCommitOid would be updated to "def456"
		const mon2: SimMonitor = { knownCommitOid: "def456" };
		expect(shouldNudgeStaleness(mon2, "ghi789")).toBe(true);
	});

	it("does not nudge when empty commit OID", () => {
		// If no commits are present (lastCommitOid is empty string)
		const mon: SimMonitor = { knownCommitOid: "" };
		expect(shouldNudgeStaleness(mon, "")).toBe(false);
	});

	it("nudges when transitioning from empty to non-empty", () => {
		const mon: SimMonitor = { knownCommitOid: "" };
		expect(shouldNudgeStaleness(mon, "abc123")).toBe(true);
	});
});
