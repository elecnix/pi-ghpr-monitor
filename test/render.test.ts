/**
 * Unit tests for render.ts — state folding from the event stream and the
 * footer/status display derived from it.
 */
import { describe, it, expect } from "vitest";
import {
	emptyMonitorState,
	updateStateFromNotification,
	formatFooterStatus,
	formatMonitorStatusLine,
	type Notification,
} from "../src/render";
import type { MonitorConfig } from "../src/keys";

function cfg(over: Partial<MonitorConfig> = {}): MonitorConfig {
	return {
		owner: "octo",
		repo: "demo",
		number: 42,
		host: "github.com",
		resourceType: "pr",
		mode: "all",
		intervalSec: 60,
		...over,
	};
}

function n(over: Partial<Notification> = {}): Notification {
	return { type: "new-unresolved-threads", message: "m", pr_label: "octo/demo#42", ...over };
}

describe("updateStateFromNotification", () => {
	it("carries the current thread/comment counts", () => {
		const s = emptyMonitorState();
		updateStateFromNotification(s, n({ unresolved_threads: 3, general_comments: 1 }));
		expect(s.unresolvedThreads).toBe(3);
		expect(s.generalComments).toBe(1);
		expect(s.lastChecked).not.toBeNull();
	});

	it("sets failing checks on new-failing-checks and clears on ci-all-green", () => {
		const s = emptyMonitorState();
		updateStateFromNotification(s, n({ type: "new-failing-checks", failing_checks: ["CI"] }));
		expect(s.failingChecks).toEqual(["CI"]);
		updateStateFromNotification(s, n({ type: "ci-all-green" }));
		expect(s.failingChecks).toEqual([]);
	});

	it("sets conflict flag (sticky)", () => {
		const s = emptyMonitorState();
		updateStateFromNotification(s, n({ type: "conflict" }));
		expect(s.hasConflict).toBe(true);
	});

	it("tracks run status transitions", () => {
		const s = emptyMonitorState();
		updateStateFromNotification(s, n({ type: "run-queued" }));
		expect(s.runStatus).toBe("queued");
		updateStateFromNotification(s, n({ type: "run-in-progress" }));
		expect(s.runStatus).toBe("in_progress");
		updateStateFromNotification(s, n({ type: "run-completed", conclusion: "success" }));
		expect(s.runStatus).toBe("completed");
		expect(s.runConclusion).toBe("success");
	});
});

describe("formatFooterStatus", () => {
	it("shows the URL with no emojis when clean", () => {
		expect(formatFooterStatus(cfg(), emptyMonitorState())).toBe("📡 https://github.com/octo/demo/pull/42");
	});
	it("shows emojis for each issue type", () => {
		const s = emptyMonitorState();
		s.hasConflict = true;
		s.unresolvedThreads = 2;
		s.generalComments = 1;
		s.failingChecks = ["CI"];
		expect(formatFooterStatus(cfg(), s)).toBe("📡 https://github.com/octo/demo/pull/42 ⚠️💬💭❌");
	});
	it("uses the run URL + status for run monitors", () => {
		const s = emptyMonitorState();
		s.runStatus = "in_progress";
		expect(formatFooterStatus(cfg({ resourceType: "run", number: 0, runId: 9 }), s)).toBe(
			"📡 https://github.com/octo/demo/actions/runs/9 in_progress",
		);
	});
	it("uses the issue URL for issue monitors", () => {
		expect(formatFooterStatus(cfg({ resourceType: "issue" }), null)).toBe(
			"📡 https://github.com/octo/demo/issues/42",
		);
	});
});

describe("formatMonitorStatusLine", () => {
	it("reports all-clear when nothing actionable", () => {
		const line = formatMonitorStatusLine(cfg(), emptyMonitorState());
		expect(line).toContain("Monitoring https://github.com/octo/demo/pull/42");
		expect(line).toContain("all clear");
	});
	it("lists actionable items", () => {
		const s = emptyMonitorState();
		s.unresolvedThreads = 2;
		s.failingChecks = ["CI"];
		const line = formatMonitorStatusLine(cfg(), s);
		expect(line).toContain("2 unresolved thread(s)");
		expect(line).toContain("Failing CI: CI");
	});
	it("includes the auto-merge tag for PR monitors", () => {
		const line = formatMonitorStatusLine(cfg({ autoMerge: true }), emptyMonitorState());
		expect(line).toContain("🔀auto-merge");
	});
});