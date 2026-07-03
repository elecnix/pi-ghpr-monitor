/**
 * Tests for notification URL bugs (issue #45):
 * 1. Trailing ellipsis (...) gets included in PR ref linkification
 * 2. Full URLs in concise messages cause duplication when linkified
 */

import { describe, it, expect } from "vitest";
import {
	linkifyPRRefs,
	formatActionableItems,
	formatStatusUpdate,
	formatAgentNotification,
	formatAgentStatusUpdate,
	type PRStatus,
	type MonitorConfig,
} from "../src/analyzer";

const OSC_OPEN = "\x1b]8;;";
const OSC_SEP = "\x1b\\";
const OSC_CLOSE = "\x1b]8;;\x1b\\";

function linkify(url: string, display: string): string {
	return `${OSC_OPEN}${url}${OSC_SEP}${display}${OSC_CLOSE}`;
}

const config: MonitorConfig = {
	owner: "v2nic",
	repo: "pi-ghpr-monitor",
	number: 42,
	host: "github.com",
	mode: "all",
	intervalSec: 60,
	debounceSec: 30,
};

// ---------------------------------------------------------------------------
// Bug #45-1: Trailing ellipsis should NOT be part of PR ref link
// ---------------------------------------------------------------------------

describe("linkifyPRRefs: trailing ellipsis after PR ref", () => {
	it("does NOT include trailing ... in the linkified PR ref", () => {
		// Original bug: "📡 Monitoring owner/repo#462..." linked to
		// "https://github.com/owner/repo/pull/462..." (with dots in the URL)
		const input = "📡 Monitoring v2nic/pi-ghpr-monitor#42... (polling every 60s)";
		const result = linkifyPRRefs(input);
		// The ... should NOT be inside the link — it should be outside
		expect(result).toBe(
			`📡 Monitoring ${linkify("https://github.com/v2nic/pi-ghpr-monitor/pull/42", "v2nic/pi-ghpr-monitor#42")}... (polling every 60s)`,
		);
		// The URL should NOT contain dots
		expect(result).not.toContain("pull/42...");
	});

	it("does NOT include trailing ... after a full PR URL", () => {
		const input = "📡 Monitoring https://github.com/v2nic/pi-ghpr-monitor/pull/42... (polling every 60s)";
		const result = linkifyPRRefs(input);
		expect(result).toBe(
			`📡 Monitoring ${linkify("https://github.com/v2nic/pi-ghpr-monitor/pull/42", "v2nic/pi-ghpr-monitor#42")}... (polling every 60s)`,
		);
		expect(result).not.toContain("pull/42...");
	});

	it("does NOT include trailing ... after PR ref without space", () => {
		const input = "Status: owner/repo#123...";
		const result = linkifyPRRefs(input);
		expect(result).toBe(
			`Status: ${linkify("https://github.com/owner/repo/pull/123", "owner/repo#123")}...`,
		);
	});

	it("does NOT include punctuation after PR ref in link", () => {
		const input = "See v2nic/pi-ghpr-monitor#42!";
		const result = linkifyPRRefs(input);
		expect(result).toBe(
			`See ${linkify("https://github.com/v2nic/pi-ghpr-monitor/pull/42", "v2nic/pi-ghpr-monitor#42")}!`,
		);
	});

	it("correctly linkifies PR ref followed by parenthesis", () => {
		const input = "Monitoring v2nic/pi-ghpr-monitor#42 (polling every 60s)";
		const result = linkifyPRRefs(input);
		expect(result).toBe(
			`Monitoring ${linkify("https://github.com/v2nic/pi-ghpr-monitor/pull/42", "v2nic/pi-ghpr-monitor#42")} (polling every 60s)`,
		);
	});
});

// ---------------------------------------------------------------------------
// Bug #45-2: Concise messages should use PR labels, not full URLs
//    (to avoid URL duplication in TUI rendering)
// ---------------------------------------------------------------------------

describe("formatActionableItems and formatStatusUpdate use PR labels not URLs", () => {
	const cleanStatus: PRStatus = {
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
		lastCommitOid: "",
		lastCommitAuthor: "",
		lastCommitCoauthors: "",
		lastCommitMessageHeadline: "",
		failingStatuses: [],
		pendingStatuses: [],
		statusDetails: [],
	};

	it("formatStatusUpdate 'all clear' uses prLabel not URL", () => {
		const result = formatStatusUpdate(null, cleanStatus, config);
		expect(result).toContain("v2nic/pi-ghpr-monitor#42");
		expect(result).not.toContain("https://github.com");
	});

	it("formatStatusUpdate conflict uses prLabel not URL", () => {
		const conflictStatus = { ...cleanStatus, hasConflicts: true };
		const result = formatStatusUpdate(null, conflictStatus, config);
		expect(result).toContain("v2nic/pi-ghpr-monitor#42");
		expect(result).not.toContain("https://github.com");
	});

	it("formatActionableItems returns null for clean status (no URL)", () => {
		const result = formatActionableItems(cleanStatus, config);
		expect(result).toBeNull();
	});

	it("formatActionableItems conflict uses prLabel not URL", () => {
		const conflictStatus = { ...cleanStatus, hasConflicts: true };
		const result = formatActionableItems(conflictStatus, config);
		expect(result).toContain("v2nic/pi-ghpr-monitor#42");
		expect(result).not.toContain("https://github.com");
	});

	it("formatAgentNotification concise matches formatActionableItems (prLabel, not URL)", () => {
		const conflictStatus = { ...cleanStatus, hasConflicts: true };
		const result = formatAgentNotification(conflictStatus, config);
		expect(result).not.toBeNull();
		expect(result!.concise).toContain("v2nic/pi-ghpr-monitor#42");
		expect(result!.concise).not.toContain("https://github.com");
		// Detailed should also use prLabel, not URL
		expect(result!.detailed).toContain("v2nic/pi-ghpr-monitor#42");
		expect(result!.detailed).not.toContain("https://github.com");
	});

	it("formatAgentStatusUpdate concise uses prLabel not URL", () => {
		const result = formatAgentStatusUpdate(null, cleanStatus, config);
		expect(result.concise).toContain("v2nic/pi-ghpr-monitor#42");
		expect(result.concise).not.toContain("https://github.com");
		expect(result.detailed).toContain("v2nic/pi-ghpr-monitor#42");
		expect(result.detailed).not.toContain("https://github.com");
	});
});

// ---------------------------------------------------------------------------
// Linkification of messages that contain PR labels
// ---------------------------------------------------------------------------

describe("linkifyPRRefs on notification messages", () => {
	it("correctly linkifies the 'all clear' notification", () => {
		const input = "✨ v2nic/pi-ghpr-monitor#42 — open, all clear";
		const result = linkifyPRRefs(input);
		expect(result).toBe(
			`✨ ${linkify("https://github.com/v2nic/pi-ghpr-monitor/pull/42", "v2nic/pi-ghpr-monitor#42")} — open, all clear`,
		);
	});

	it("correctly linkifies the 'conflict detected' notification", () => {
		const input = "⚠️  Merge conflicts detected on v2nic/pi-ghpr-monitor#42";
		const result = linkifyPRRefs(input);
		expect(result).toBe(
			`⚠️  Merge conflicts detected on ${linkify("https://github.com/v2nic/pi-ghpr-monitor/pull/42", "v2nic/pi-ghpr-monitor#42")}`,
		);
	});

	it("linkifies a single PR ref into a single link", () => {
		// The "Open" message uses PR labels (not full URLs),
		// so linkification should produce exactly one OSC 8 link
		const input = "✅ Open, nothing to address on v2nic/pi-ghpr-monitor#42";
		const result = linkifyPRRefs(input);
		const linkified = linkify("https://github.com/v2nic/pi-ghpr-monitor/pull/42", "v2nic/pi-ghpr-monitor#42");
		expect(result).toBe(`✅ Open, nothing to address on ${linkified}`);
	});
});