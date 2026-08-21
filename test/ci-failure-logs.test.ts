/**
 * Unit tests for CI failure log extraction (#93).
 *
 * Covers the pure helpers in src/analyzer.ts (snippet truncation, gh run list
 * parsing, notification formatting) and the structural wiring in src/index.ts
 * (per-monitor cache fields, defensive fetch helper, one-shot clearing).
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	extractLogSnippet,
	parseFailedRuns,
	formatAgentStatusUpdate,
	formatAgentNotification,
	FAILURE_LOG_MAX_LINES,
	type PRStatus,
	type MonitorConfig,
	type FailureLogInfo,
} from "../src/analyzer";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const config: MonitorConfig = {
	owner: "testowner",
	repo: "testrepo",
	number: 42,
	host: "github.com",
	mode: "all",
	intervalSec: 60,
	debounceSec: 30,
};

function makeMockStatus(overrides: Partial<PRStatus> = {}): PRStatus {
	const defaults: PRStatus = {
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
	return { ...defaults, ...overrides };
}

function makeFailureLogs(): FailureLogInfo[] {
	return [
		{
			jobName: "ci/test",
			runId: 1234567890,
			snippet: "FAIL src/auth.test.ts\n  ● login rejects bad token\n    Expected: 401\n    Received: 200",
		},
	];
}

// ---------------------------------------------------------------------------
// extractLogSnippet
// ---------------------------------------------------------------------------

describe("extractLogSnippet", () => {
	it("returns empty string for empty input", () => {
		expect(extractLogSnippet("")).toBe("");
	});

	it("keeps short logs unchanged", () => {
		const log = "line 1\nline 2\nline 3";
		expect(extractLogSnippet(log)).toBe(log);
	});

	it(`truncates to ${FAILURE_LOG_MAX_LINES} lines with an ellipsis marker`, () => {
		const log = Array.from({ length: 120 }, (_, i) => `error line ${i + 1}`).join("\n");
		const snippet = extractLogSnippet(log);
		const lines = snippet.split("\n");
		expect(lines).toHaveLength(FAILURE_LOG_MAX_LINES + 1); // kept lines + "…truncated"
		expect(lines[FAILURE_LOG_MAX_LINES]).toBe("…truncated");
		expect(snippet).toContain("error line 1\n");
		expect(snippet).toContain(`error line ${FAILURE_LOG_MAX_LINES}`);
		expect(snippet).not.toContain("error line 51");
	});

	it("respects a custom maxLines", () => {
		const log = Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join("\n");
		const snippet = extractLogSnippet(log, 3);
		expect(snippet).toBe("l1\nl2\nl3\n…truncated");
	});

	it("normalizes CRLF line endings before counting lines", () => {
		const log = Array.from({ length: 60 }, (_, i) => `w${i + 1}`).join("\r\n");
		const snippet = extractLogSnippet(log);
		expect(snippet.split("\n")).toHaveLength(FAILURE_LOG_MAX_LINES + 1);
		expect(snippet).not.toContain("\r");
	});
});

// ---------------------------------------------------------------------------
// parseFailedRuns
// ---------------------------------------------------------------------------

describe("parseFailedRuns", () => {
	it("extracts failed runs from gh run list JSON output", () => {
		const json = JSON.stringify([
			{ databaseId: 101, name: "ci/test", conclusion: "FAILURE" },
			{ databaseId: 102, name: "ci/build", conclusion: "SUCCESS" },
			{ databaseId: 103, name: "ci/lint", conclusion: null }, // still running
			{ databaseId: 104, name: "ci/e2e", conclusion: "TIMED_OUT" },
		]);
		expect(parseFailedRuns(json)).toEqual([
			{ runId: 101, name: "ci/test" },
			{ runId: 104, name: "ci/e2e" },
		]);
	});

	it("ignores CANCELLED runs (they usually have no failure logs)", () => {
		const json = JSON.stringify([{ databaseId: 201, name: "ci/deploy", conclusion: "CANCELLED" }]);
		expect(parseFailedRuns(json)).toEqual([]);
	});

	it("returns [] on invalid JSON", () => {
		expect(parseFailedRuns("not json at all")).toEqual([]);
	});

	it("returns [] on non-array JSON", () => {
		expect(parseFailedRuns(JSON.stringify({ message: "oops" }))).toEqual([]);
	});

	it("skips entries with missing or wrong-typed fields", () => {
		const json = JSON.stringify([
			{ name: "no-id", conclusion: "FAILURE" },
			{ databaseId: "301", name: "string-id", conclusion: "FAILURE" },
			{ databaseId: 302, conclusion: "FAILURE" }, // no name
			{ databaseId: 303, name: "ok-run", conclusion: "failure" }, // lowercase is fine
		]);
		expect(parseFailedRuns(json)).toEqual([{ runId: 303, name: "ok-run" }]);
	});
});

// ---------------------------------------------------------------------------
// Notification formatting with failure logs
// ---------------------------------------------------------------------------

describe("formatAgentStatusUpdate includes CI failure logs", () => {
	it("appends the failure-log block when failing checks are newly reported", () => {
		const prev = makeMockStatus();
		const curr = makeMockStatus({
			failingChecks: ["ci/test"],
			checkDetails: [{ name: "ci/test", conclusion: "FAILURE" }],
			failureLogs: makeFailureLogs(),
		});

		const result = formatAgentStatusUpdate(prev, curr, config);
		expect(result.concise).toContain("Failing CI checks on testowner/testrepo#42");
		expect(result.detailed).toContain("CI failure log details:");
		expect(result.detailed).toContain("Job ci/test (run 1234567890):");
		expect(result.detailed).toContain("login rejects bad token");
		// Snippet rendered inside a fenced code block
		expect(result.detailed).toContain("  ```");
	});

	it("does not append the block when there are no failure logs", () => {
		const prev = makeMockStatus();
		const curr = makeMockStatus({
			failingChecks: ["ci/test"],
			checkDetails: [{ name: "ci/test", conclusion: "FAILURE" }],
		});

		const result = formatAgentStatusUpdate(prev, curr, config);
		expect(result.concise).toContain("Failing CI checks");
		expect(result.detailed).not.toContain("CI failure log details:");
	});

	it("does not re-send stale logs when nothing changed (concise empty)", () => {
		const status = makeMockStatus({
			failingChecks: ["ci/test"],
			checkDetails: [{ name: "ci/test", conclusion: "FAILURE" }],
			failureLogs: makeFailureLogs(),
		});

		const result = formatAgentStatusUpdate(status, status, config);
		expect(result.concise).toBe("");
		expect(result.detailed).toBe("");
	});

	it("omits the run id when unknown", () => {
		const prev = makeMockStatus();
		const curr = makeMockStatus({
			failingChecks: ["ci/test"],
			checkDetails: [{ name: "ci/test", conclusion: "FAILURE" }],
			failureLogs: [{ jobName: "ci/test", snippet: "boom" }],
		});

		const result = formatAgentStatusUpdate(prev, curr, config);
		expect(result.detailed).toContain("Job ci/test:");
		expect(result.detailed).not.toContain("(run ");
	});
});

describe("formatAgentNotification includes CI failure logs", () => {
	it("appends the failure-log block to reminders listing failing checks", () => {
		const status = makeMockStatus({
			failingChecks: ["ci/test"],
			checkDetails: [{ name: "ci/test", conclusion: "FAILURE" }],
			failureLogs: makeFailureLogs(),
		});

		const result = formatAgentNotification(status, config);
		expect(result).not.toBeNull();
		expect(result!.detailed).toContain("CI failure log details:");
		expect(result!.detailed).toContain("Expected: 401");
		// detailed starts with concise
		expect(result!.detailed).toContain(result!.concise);
	});

	it("truncates very long snippets in the rendered block", () => {
		const longSnippet = extractLogSnippet(Array.from({ length: 80 }, (_, i) => `err ${i + 1}`).join("\n"));
		const status = makeMockStatus({
			failingChecks: ["ci/test"],
			checkDetails: [{ name: "ci/test", conclusion: "FAILURE" }],
			failureLogs: [{ jobName: "ci/test", runId: 1, snippet: longSnippet }],
		});

		const result = formatAgentNotification(status, config);
		expect(result).not.toBeNull();
		expect(result!.detailed).toContain("err 50");
		expect(result!.detailed).toContain("…truncated");
		// Lines beyond the cap must not appear as their own log line
		expect(result!.detailed).not.toMatch(/\n\s*err 51\n/);
	});
});

// ---------------------------------------------------------------------------
// Structural wiring in src/index.ts (white-box, mirrors code-structure.test.ts)
// ---------------------------------------------------------------------------

describe("index.ts wiring for failure-log extraction", () => {
	const src = fs.readFileSync(path.join(__dirname, "..", "src", "index.ts"), "utf-8");

	it("caches fetched logs per monitor", () => {
		expect(src).toContain("failureLogCache: FailureLogInfo[]");
		expect(src).toContain("failureLogsCommitOid: string | null");
	});

	it("fetches logs via gh run view --log-failed", () => {
		expect(src).toContain('"--log-failed"');
		expect(src).toContain('"run", "list"');
	});

	it("only fetches when failing checks newly appear and a commit OID is known", () => {
		expect(src).toContain("hasNewFailures && curr.lastCommitOid");
	});

	it("clears one-shot logs before storing status so reminders don't repeat them", () => {
		expect(src).toContain("curr.failureLogs = undefined;");
	});

	it("wraps extraction defensively so poll never fails on log errors", () => {
		const loopStart = src.indexOf("async function pollLoop");
		const loopEnd = src.indexOf("function buildDetailedStatusLines");
		const loop = src.slice(loopStart, loopEnd);
		expect(loop).toContain("catch (err)");
		expect(loop).toContain("Failure-log extraction error");
	});
});
