/**
 * Unit tests for CI failure log extraction (#93).
 *
 * Covers the pure helpers in src/failure-logs.ts (snippet truncation, gh run
 * list parsing, notification formatting) and the structural wiring in
 * src/index.ts (new-failing-checks interception, per-commit cache fields,
 * defensive delivery).
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	extractLogSnippet,
	parseFailedRuns,
	formatFailureLogBlock,
	fetchFailureLogsForCommit,
	FAILURE_LOG_MAX_LINES,
	type FailureLogInfo,
} from "../src/failure-logs";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

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
		expect(extractLogSnippet(log, 3)).toBe("l1\nl2\nl3\n…truncated");
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
// formatFailureLogBlock
// ---------------------------------------------------------------------------

describe("formatFailureLogBlock", () => {
	it("renders job names, run ids, and fenced snippets", () => {
		const block = formatFailureLogBlock(makeFailureLogs());
		expect(block).toContain("CI failure log details:");
		expect(block).toContain("Job ci/test (run 1234567890):");
		expect(block).toContain("  ```");
		expect(block).toContain("login rejects bad token");
	});

	it("omits the run id when unknown", () => {
		const block = formatFailureLogBlock([{ jobName: "ci/test", snippet: "boom" }]);
		expect(block).toContain("Job ci/test:");
		expect(block).not.toContain("(run ");
	});

	it("truncates very long snippets (as produced by extractLogSnippet)", () => {
		const longSnippet = extractLogSnippet(Array.from({ length: 80 }, (_, i) => `err ${i + 1}`).join("\n"));
		const block = formatFailureLogBlock([{ jobName: "ci/test", runId: 1, snippet: longSnippet }]);
		expect(block).toContain("err 50");
		expect(block).toContain("…truncated");
		// Lines beyond the cap must not appear as their own log line
		expect(block).not.toMatch(/\n\s*err 51\n/);
	});
});

// ---------------------------------------------------------------------------
// fetchFailureLogsForCommit (defensive degradation, no gh in test env)
// ---------------------------------------------------------------------------

describe("fetchFailureLogsForCommit", () => {
	it("resolves to [] when gh is unavailable or fails — never throws", async () => {
		// The test environment has no `gh` binary stubbed to succeed for these
		// subcommands; whatever happens, the promise must resolve (not reject).
		const logs = await fetchFailureLogsForCommit("owner/repo", "abc123def456789");
		expect(Array.isArray(logs)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Structural wiring in src/index.ts (white-box — index.ts cannot be imported
// under vitest because of its pi SDK imports, mirroring source-validity.test.ts)
// ---------------------------------------------------------------------------

describe("index.ts wiring for failure-log extraction", () => {
	const src = fs.readFileSync(path.join(__dirname, "..", "src", "index.ts"), "utf-8");

	it("intercepts new-failing-checks events for enrichment", () => {
		expect(src).toContain('n.type === "new-failing-checks"');
		expect(src).toContain("deliverFailingChecksWithLogs");
	});

	it("caches fetched logs per head-commit OID on the monitor", () => {
		expect(src).toContain("failureLogsOid: string | null");
		expect(src).toContain("failureLogs: FailureLogInfo[]");
		expect(src).toContain("failureLogsFetching: boolean");
		expect(src).toContain("mon.failureLogsOid !== oid");
	});

	it("fetches logs via gh run view --log-failed (through failure-logs)", () => {
		expect(src).toContain("fetchFailureLogsForCommit");
		expect(src).toContain("formatFailureLogBlock");
		const failureLogsSrc = fs.readFileSync(path.join(__dirname, "..", "src", "failure-logs.ts"), "utf-8");
		expect(failureLogsSrc).toContain('"--log-failed"');
		expect(failureLogsSrc).toContain('"run", "list"');
		expect(failureLogsSrc).toContain('"--commit", oid');
	});

	it("resolves the head commit via gh pr view --json headRefOid", () => {
		const failureLogsSrc = fs.readFileSync(path.join(__dirname, "..", "src", "failure-logs.ts"), "utf-8");
		expect(failureLogsSrc).toContain('"headRefOid"');
	});

	it("dedupes concurrent fetches and wraps delivery defensively", () => {
		expect(src).toContain("failureLogsFetching");
		const fnStart = src.indexOf("async function deliverFailingChecksWithLogs");
		const fnEnd = src.indexOf("}", src.indexOf("mon.lastNudgeTime = Date.now();", fnStart));
		const fn = src.slice(fnStart, fnEnd);
		expect(fn).toContain("catch (err)");
		expect(fn).toContain("Failure-log extraction error");
	});
});
