/**
 * Standalone GitHub Actions workflow-run monitoring helpers.
 *
 * Mirrors the watch-by-run-id feature shipped in gh-monitor#18: when a run_id
 * is supplied, the monitor polls GET /repos/{owner}/{repo}/actions/runs/{run_id}
 * until status == "completed", emitting one notification per genuinely-new
 * status transition and auto-stopping with the run's conclusion.
 *
 * This module is intentionally free of any Pi SDK / pi-tui dependency so it can
 * be unit-tested in isolation (index.ts cannot be imported directly under
 * vitest because of its pi-tui import). The poll *loop* itself lives in
 * index.ts (it needs the monitors Map and the notification machinery); only
 * the pure helpers and the REST fetcher live here.
 */

import type { RunStatus, MonitorConfig } from "./analyzer";

// ---------------------------------------------------------------------------
// Parsed run identity
// ---------------------------------------------------------------------------

export interface ParsedRun {
	owner: string;
	repo: string;
	runId: number;
	host: string;
}

const RUN_URL_RE = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/actions\/runs\/([0-9]+)/i;

/** Parse a GitHub Actions run URL like https://github.com/owner/repo/actions/runs/123 */
export function parseRunUrl(input: string): ParsedRun | null {
	const m = input.trim().match(RUN_URL_RE);
	if (!m) return null;
	const host = m[1] === "github.com" ? "github.com" : m[1];
	return { owner: m[2], repo: m[3], runId: parseInt(m[4], 10), host };
}

// ---------------------------------------------------------------------------
// Monitor key
// ---------------------------------------------------------------------------

/** Generate a unique key for a workflow-run monitor. */
export function runKey(config: MonitorConfig): string;
export function runKey(owner: string, repo: string, runId: number, host?: string): string;
export function runKey(a: string | MonitorConfig, b?: string, c?: number, d?: string): string {
	if (typeof a === "object") {
		const cfg = a as MonitorConfig;
		return cfg.host === "github.com"
			? `${cfg.owner}/${cfg.repo}@run/${cfg.runId}`
			: `${cfg.host}/${cfg.owner}/${cfg.repo}@run/${cfg.runId}`;
	}
	return (!d || d === "github.com")
		? `${a}/${b}@run/${c}`
		: `${d}/${a}/${b}@run/${c}`;
}

// ---------------------------------------------------------------------------
// REST fetch (GitHub Actions runs are REST-only, unlike PR/issue GraphQL)
// ---------------------------------------------------------------------------

/** Relevant subset of GET /repos/{owner}/{repo}/actions/runs/{run_id}. */
export interface RunData {
	id: number;
	name: string | null;
	display_title: string;
	event: string;
	status: string;
	conclusion: string | null;
	head_branch: string | null;
	head_sha: string;
	html_url: string;
	run_number: number;
}

interface GhResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

function runGh(args: string[], stdin?: string): Promise<GhResult> {
	return new Promise((resolve) => {
		const { spawn } = require("node:child_process") as typeof import("node:child_process");
		const proc = spawn("gh", args, { stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		proc.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
		proc.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
		if (stdin) {
			proc.stdin.write(stdin);
			proc.stdin.end();
		}
		proc.on("close", (code: number | null) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
	});
}

/**
 * Fetch a single workflow run snapshot via the REST API.
 *
 * When `mockBaseUrl` is set (test mode), the request goes directly to the mock
 * server over HTTP instead of shelling out to `gh api`.
 */
export async function fetchRunData(
	config: MonitorConfig,
	signal?: AbortSignal,
	mockBaseUrl?: string,
): Promise<RunData> {
	const runId = config.runId;
	if (!runId || runId <= 0) {
		throw new Error(`Invalid workflow run id: ${runId}`);
	}
	const apiPath = `repos/${config.owner}/${config.repo}/actions/runs/${runId}`;

	if (mockBaseUrl) {
		const resp = await fetch(`${mockBaseUrl}/${apiPath}`, { signal });
		if (!resp.ok) {
			throw new Error(`Workflow run ${runId} not found or not accessible (${resp.status})`);
		}
		return (await resp.json()) as RunData;
	}

	const args = ["api", apiPath];
	if (config.host && config.host !== "github.com") {
		args.push("--hostname", config.host);
	}
	const result = await runGh(args);
	if (result.exitCode !== 0) {
		throw new Error(`gh api ${apiPath} failed: ${result.stderr.trim() || result.stdout.trim()}`);
	}
	const data = JSON.parse(result.stdout) as RunData;
	if (!data || !data.id) {
		throw new Error(`Workflow run ${runId} not found or not accessible`);
	}
	return data;
}

// Re-export run snapshot types so callers can import everything from here
export type { RunStatus } from "./analyzer";