/**
 * Identity parsing and monitor keys for the pi-ghpr-monitor adapter.
 *
 * These are the only pieces of the old TypeScript monitoring engine that the
 * adapter still needs: turning a user-supplied PR/issue/run selector into an
 * owner/repo/number (or run id) and a stable map key. The actual fetching,
 * snapshotting, and change-diffing live in `gh monitor` now; this module just
 * builds the CLI arguments and tracks which monitors are active.
 */

/** What kind of GitHub resource a monitor watches. */
export type ResourceType = "pr" | "issue" | "run";

/**
 * A monitor's resolved target and polling options.
 *
 * `mode` is accepted for backwards compatibility with the old tool schema but
 * is not forwarded to `gh monitor` (which always surfaces every event kind);
 * `gh monitor --ignored-bots` and the preferences file control filtering.
 */
export interface MonitorConfig {
	owner: string;
	repo: string;
	/** PR or issue number. 0 for workflow-run monitors. */
	number: number;
	host: string;
	resourceType: ResourceType;
	mode: "all" | "comments" | "conflicts" | "actions";
	intervalSec: number;
	/** Workflow-run id for `resourceType: "run"`. */
	runId?: number;
	/** When true, the adapter nudges the agent to merge once CI is green. */
	autoMerge?: boolean;
}

export interface ParsedSelector {
	owner: string;
	repo: string;
	number: number;
	host: string;
}

// ---------------------------------------------------------------------------
// URL / shorthand parsers
// ---------------------------------------------------------------------------

const PR_URL_RE = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/([0-9]+)/i;
const ISSUE_URL_RE = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/issues\/([0-9]+)/i;

/** Parse a GitHub PR URL like https://github.com/owner/repo/pull/123 */
export function parsePRUrl(input: string): ParsedSelector | null {
	const m = input.trim().match(PR_URL_RE);
	if (!m) return null;
	const host = m[1] === "github.com" ? "github.com" : m[1];
	return { owner: m[2], repo: m[3], number: parseInt(m[4], 10), host };
}

/** Parse a GitHub issue URL like https://github.com/owner/repo/issues/123 */
export function parseIssueUrl(input: string): ParsedSelector | null {
	const m = input.trim().match(ISSUE_URL_RE);
	if (!m) return null;
	const host = m[1] === "github.com" ? "github.com" : m[1];
	return { owner: m[2], repo: m[3], number: parseInt(m[4], 10), host };
}

/** Parse shorthand formats like "owner/repo#123" */
export function parsePRShorthand(input: string): ParsedSelector | null {
	const hashM = input.trim().match(/^([^\s#/]+)\/([^#]+)#([0-9]+)$/);
	if (!hashM) return null;
	return { owner: hashM[1], repo: hashM[2], number: parseInt(hashM[3], 10), host: "github.com" };
}

// ---------------------------------------------------------------------------
// Workflow-run URL parser
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
// Monitor keys
// ---------------------------------------------------------------------------

/** Generate a unique key for a PR/issue monitor. */
export function prKey(config: MonitorConfig): string;
export function prKey(owner: string, repo: string, number: number, host?: string): string;
export function prKey(a: string | MonitorConfig, b?: string, c?: number, d?: string): string {
	if (typeof a === "object") {
		const cfg = a as MonitorConfig;
		return cfg.host === "github.com"
			? `${cfg.owner}/${cfg.repo}#${cfg.number}`
			: `${cfg.host}/${cfg.owner}/${cfg.repo}#${cfg.number}`;
	}
	return (!d || d === "github.com")
		? `${a}/${b}#${c}`
		: `${d}/${a}/${b}#${c}`;
}

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

/** Generate the monitor key for any config (PR/issue/run). */
export function monitorKey(config: MonitorConfig): string {
	return config.resourceType === "run" ? runKey(config) : prKey(config);
}

/** The GitHub web URL for a config's resource. */
export function resourceUrl(config: MonitorConfig): string {
	if (config.resourceType === "run") {
		return `https://${config.host}/${config.owner}/${config.repo}/actions/runs/${config.runId}`;
	}
	if (config.resourceType === "issue") {
		return `https://${config.host}/${config.owner}/${config.repo}/issues/${config.number}`;
	}
	return `https://${config.host}/${config.owner}/${config.repo}/pull/${config.number}`;
}