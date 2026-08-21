/**
 * Post-merge deployment status monitoring (#85).
 *
 * When a monitor with `trackDeployments` enabled receives the `merged` event,
 * `gh monitor` auto-stops (the PR is done) — but the deployment triggered by
 * the merge is still running. The adapter then keeps polling the GitHub
 * Deployments REST API for deployments on the merged head SHA and notifies on
 * status transitions (pending → in_progress → success/failure/error/inactive),
 * auto-stopping when every tracked deployment reaches a terminal state.
 *
 * Pure helpers (terminal-state logic, snapshotting, transition formatting,
 * REST payload parsing) are unit-testable in isolation; the gh orchestration
 * (fetchMergedHeadOid / fetchDeploymentsForSha) is best-effort and defensive:
 * repos that don't use GitHub Deployments simply return an empty list.
 */

import type { MonitorConfig } from "./keys";

// ---------------------------------------------------------------------------
// Snapshot + terminal-state logic
// ---------------------------------------------------------------------------

export interface DeploymentSnapshot {
	id: string;
	environment: string;
	/** Latest known status state (uppercased), e.g. PENDING / IN_PROGRESS / SUCCESS. */
	state: string;
}

/**
 * Deployment status states that end tracking (#85: success, failure, inactive
 * — plus error). Anything else (PENDING, QUEUED, IN_PROGRESS, WAITING, ...)
 * keeps the adapter polling.
 */
export const TERMINAL_DEPLOYMENT_STATES: Set<string> = new Set([
	"SUCCESS",
	"FAILURE",
	"ERROR",
	"INACTIVE",
]);

export function isTerminalDeploymentState(state: string): boolean {
	return TERMINAL_DEPLOYMENT_STATES.has(state.toUpperCase());
}

/** True when every tracked deployment reached a terminal state. Requires at
 *  least one deployment — an empty list means "nothing seen yet", handled by
 *  the adapter's grace period instead. */
export function allDeploymentsTerminal(snapshots: DeploymentSnapshot[]): boolean {
	return snapshots.length > 0 && snapshots.every((s) => isTerminalDeploymentState(s.state));
}

// ---------------------------------------------------------------------------
// REST payload parsing (defensive)
// ---------------------------------------------------------------------------

interface GhApiDeployment {
	id?: unknown;
	environment?: unknown;
}

interface GhApiDeploymentStatus {
	state?: unknown;
}

/**
 * Parse the JSON array returned by `gh api repos/O/R/deployments?sha=<sha>`.
 * Defensive: returns [] on invalid JSON or unexpected shapes rather than
 * throwing. Entries are reduced to {id, environment} pairs.
 */
export function parseDeploymentsList(json: string): { id: string; environment: string }[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const out: { id: string; environment: string }[] = [];
	for (const entry of parsed as GhApiDeployment[]) {
		if (!entry || typeof entry !== "object") continue;
		const id = entry.id;
		if (typeof id !== "number" && typeof id !== "string") continue;
		out.push({
			id: String(id),
			environment: typeof entry.environment === "string" ? entry.environment : "unknown",
		});
	}
	return out;
}

/**
 * Parse the JSON array returned by
 * `gh api repos/O/R/deployments/<id>/statuses?per_page=1` and return the
 * latest status state (uppercased), or null when absent/invalid.
 */
export function parseLatestStatusState(json: string): string | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return null;
	}
	if (!Array.isArray(parsed) || parsed.length === 0) return null;
	const first = parsed[0] as GhApiDeploymentStatus | null;
	if (!first || typeof first !== "object" || typeof first.state !== "string") return null;
	return first.state.toUpperCase();
}

// ---------------------------------------------------------------------------
// Notification formatting
// ---------------------------------------------------------------------------

const STATE_EMOJI: Record<string, string> = {
	SUCCESS: "✅",
	FAILURE: "❌",
	ERROR: "❌",
	INACTIVE: "🛑",
};

function describeState(state: string): string {
	const emoji = STATE_EMOJI[state.toUpperCase()] ?? "🚀";
	return `${emoji} ${state.toLowerCase()}`;
}

/**
 * Format deployment status transitions between two snapshots.
 *
 * Emits one line per change:
 *   - first sighting (prev === null): current state of each deployment
 *   - newly appeared deployment: announced as new
 *   - state change: old → new with an emoji reflecting the new state
 *
 * Returns "" when nothing changed since the previous poll.
 */
export function formatDeploymentUpdate(
	prev: DeploymentSnapshot[] | null,
	curr: DeploymentSnapshot[],
	prLabel: string,
): string {
	const lines: string[] = [];
	const prevById = new Map((prev ?? []).map((s) => [s.id, s]));

	for (const snap of curr) {
		if (!prev) {
			lines.push(`🚀 Deployment to ${snap.environment} on ${prLabel} is ${describeState(snap.state)}`);
			continue;
		}
		const before = prevById.get(snap.id);
		if (!before) {
			lines.push(`🚀 New deployment to ${snap.environment} on ${prLabel}: ${describeState(snap.state)}`);
		} else if (before.state !== snap.state) {
			lines.push(
				`🚀 Deployment to ${snap.environment} on ${prLabel}: ${before.state.toLowerCase()} → ${describeState(snap.state)}`,
			);
		}
	}
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// gh orchestration
// ---------------------------------------------------------------------------

/** Max number of deployments tracked per merged SHA (first-deployment-only-ish heuristic). */
export const MAX_DEPLOYMENTS_TRACKED = 5;

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
 * The NDJSON events only carry short OIDs (and only on some events), so the
 * deploy tracker uses this to know which SHA's deployments to watch.
 * Returns null on any failure or for non-PR monitors.
 */
export async function fetchMergedHeadOid(config: MonitorConfig): Promise<string | null> {
	if (config.resourceType !== "pr") return null;
	const repo = `${config.owner}/${config.repo}`;
	const result = await runGh(["pr", "view", String(config.number), "-R", repo, "--json", "headRefOid", "--jq", ".headRefOid"]);
	if (result.exitCode !== 0 || !result.stdout.trim()) {
		return null;
	}
	return result.stdout.trim();
}

/**
 * Fetch deployment snapshots for an explicit commit SHA via the Deployments
 * REST API. Throws only when the deployments list itself cannot be fetched
 * (so the caller can count consecutive errors); per-deployment status fetch
 * failures degrade to a PENDING-looking snapshot instead.
 */
export async function fetchDeploymentsForSha(repo: string, sha: string): Promise<DeploymentSnapshot[]> {
	const listResult = await runGh(["api", `repos/${repo}/deployments?sha=${sha}&per_page=${MAX_DEPLOYMENTS_TRACKED}`]);
	if (listResult.exitCode !== 0) {
		throw new Error(`gh api deployments failed${listResult.stderr ? `: ${listResult.stderr.trim()}` : ""}`);
	}
	const deployments = parseDeploymentsList(listResult.stdout).slice(0, MAX_DEPLOYMENTS_TRACKED);

	const snapshots: DeploymentSnapshot[] = [];
	for (const d of deployments) {
		const statusResult = await runGh(["api", `repos/${repo}/deployments/${d.id}/statuses?per_page=1`]);
		const state = statusResult.exitCode === 0 ? parseLatestStatusState(statusResult.stdout) : null;
		snapshots.push({ id: d.id, environment: d.environment, state: state ?? "PENDING" });
	}
	return snapshots;
}
