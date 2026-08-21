/**
 * CI failure log extraction (#93).
 *
 * When `gh monitor` emits a `new-failing-checks` event, the adapter enriches
 * the notification with failed-job names and a truncated failure-log snippet
 * so the agent can diagnose without an extra turn.
 *
 * Pure helpers (extractLogSnippet / parseFailedRuns / formatFailureLogBlock)
 * are unit-testable in isolation; fetchFailureLogs orchestrates the gh calls
 * and is best-effort: any failure (gh missing, rate limit, no logs) results
 * in fewer or zero entries — never an exception.
 */

import type { MonitorConfig } from "./keys";

// ---------------------------------------------------------------------------
// Snippet extraction
// ---------------------------------------------------------------------------

/** Maximum number of log lines kept in a failure-log snippet. */
export const FAILURE_LOG_MAX_LINES = 50;

/** Conclusions for which we attempt to fetch logs (CANCELLED runs usually have none). */
const LOGGABLE_FAILURE_CONCLUSIONS: Set<string> = new Set(["FAILURE", "ERROR", "TIMED_OUT", "ACTION_REQUIRED"]);

/** A truncated failure-log snippet for one failed CI job/run (#93). */
export interface FailureLogInfo {
	jobName: string;
	/** GitHub Actions run ID (from `gh run list --json databaseId`). */
	runId?: number;
	/** First N lines of the failure log (`gh run view <id> --log-failed`). */
	snippet: string;
}

/**
 * Extract a truncated snippet from a raw failure log.
 *
 * Keeps the first `maxLines` lines (default 50) and appends an ellipsis
 * marker when content was dropped. Normalizes CRLF line endings.
 */
export function extractLogSnippet(log: string, maxLines: number = FAILURE_LOG_MAX_LINES): string {
	if (!log) return "";
	const lines = log.replace(/\r\n/g, "\n").split("\n");
	if (lines.length <= maxLines) return lines.join("\n");
	return lines.slice(0, maxLines).join("\n") + "\n…truncated";
}

// ---------------------------------------------------------------------------
// gh run list parsing
// ---------------------------------------------------------------------------

/** A single entry of `gh run list --json databaseId,name,conclusion` output. */
interface GhRunListEntry {
	databaseId?: unknown;
	name?: unknown;
	conclusion?: unknown;
}

/**
 * Parse the JSON output of `gh run list --json databaseId,name,conclusion`
 * and return the failed runs. Defensive: returns [] on invalid JSON or
 * unexpected shapes rather than throwing.
 */
export function parseFailedRuns(ghRunListJson: string): { runId: number; name: string }[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(ghRunListJson);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const failed: { runId: number; name: string }[] = [];
	for (const entry of parsed as GhRunListEntry[]) {
		if (!entry || typeof entry !== "object") continue;
		if (typeof entry.databaseId !== "number" || typeof entry.name !== "string") continue;
		const conclusion = String(entry.conclusion ?? "").toUpperCase();
		if (!LOGGABLE_FAILURE_CONCLUSIONS.has(conclusion)) continue;
		failed.push({ runId: entry.databaseId, name: entry.name });
	}
	return failed;
}

// ---------------------------------------------------------------------------
// Notification formatting
// ---------------------------------------------------------------------------

/**
 * Format a failure-log detail block for the agent notification.
 * Rendered as fenced code blocks so markdown rendering keeps the log intact.
 */
export function formatFailureLogBlock(logs: FailureLogInfo[]): string {
	const lines: string[] = ["", "CI failure log details:"];
	for (const f of logs) {
		lines.push(`Job ${f.jobName}${f.runId != null ? ` (run ${f.runId})` : ""}:`);
		lines.push("  ```");
		for (const l of f.snippet.split("\n")) {
			lines.push(`  ${l}`);
		}
		lines.push("  ```");
	}
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// gh orchestration
// ---------------------------------------------------------------------------

/** Max number of failed runs to fetch logs for in a single event. */
export const MAX_FAILURE_LOG_RUNS = 3;

interface GhResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

function runGh(args: string[]): Promise<GhResult> {
	return new Promise((resolve) => {
		const { spawn } = require("node:child_process") as typeof import("node:child_process");
		const proc = spawn("gh", args, { stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		proc.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
		proc.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
		proc.on("error", () => resolve({ stdout: "", stderr: "gh spawn failed", exitCode: 1 }));
		proc.on("close", (code: number | null) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
	});
}

/**
 * Resolve the PR's head commit OID via `gh pr view --json headRefOid`.
 * The NDJSON events only carry short OIDs (and only on new-commit events),
 * so callers use this to key the failure-log cache and to list runs.
 * Returns null on any failure or for workflow-run monitors.
 */
export async function headCommitOid(config: MonitorConfig): Promise<string | null> {
	if (config.resourceType === "run") return null; // workflow-run monitors have no PR head commit
	const repo = `${config.owner}/${config.repo}`;
	const prResult = await runGh(["pr", "view", String(config.number), "-R", repo, "--json", "headRefOid", "--jq", ".headRefOid"]);
	if (prResult.exitCode !== 0 || !prResult.stdout.trim()) {
		return null;
	}
	return prResult.stdout.trim();
}

/**
 * Fetch failure-log snippets for a PR's head-commit failed workflow runs.
 * Best-effort: any failure results in fewer or zero entries — never an
 * exception.
 */
export async function fetchFailureLogs(config: MonitorConfig): Promise<FailureLogInfo[]> {
	const oid = await headCommitOid(config);
	if (!oid) return [];
	return fetchFailureLogsForCommit(`${config.owner}/${config.repo}`, oid);
}

/**
 * Fetch failure-log snippets for an explicit commit SHA. Exported so callers
 * that already know the head OID (e.g. from a cached `gh pr view`) can skip
 * the lookup.
 */
export async function fetchFailureLogsForCommit(repo: string, oid: string): Promise<FailureLogInfo[]> {
	const listResult = await runGh([
		"run", "list",
		"-R", repo,
		"--commit", oid,
		"--json", "databaseId,name,conclusion",
		"--limit", "20",
	]);
	if (listResult.exitCode !== 0) {
		return [];
	}
	const failedRuns = parseFailedRuns(listResult.stdout).slice(0, MAX_FAILURE_LOG_RUNS);
	const logs: FailureLogInfo[] = [];
	for (const run of failedRuns) {
		const view = await runGh(["run", "view", String(run.runId), "-R", repo, "--log-failed"]);
		if (view.exitCode !== 0 || !view.stdout.trim()) {
			continue;
		}
		logs.push({ jobName: run.name, runId: run.runId, snippet: extractLogSnippet(view.stdout) });
	}
	return logs;
}
