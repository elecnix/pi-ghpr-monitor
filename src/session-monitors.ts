/**
 * Session persistence for monitors, so a resumed Pi session re-arms them.
 *
 * The adapter keeps its monitors in memory and kills each `gh monitor` child
 * on `session_shutdown`. To bring them back when Pi resumes the session (after
 * a restart, a `/reload`, or a hard kill that skipped `session_shutdown`), it
 * appends a custom entry to the session whenever a monitor starts or changes
 * (`watch`), and another when the monitor ends for a reason other than the Pi
 * process ending (`unwatch`). Custom entries are written to the session file
 * but never sent to the LLM.
 *
 * On `session_start`, `restorableMonitors` replays the current branch's
 * entries in order. The last entry per monitor key decides: `watch` re-arms
 * with that config, `unwatch` leaves it stopped.
 *
 * Each monitor runs `gh monitor --instance <name>` with a name derived from
 * the session id and monitor key. `gh monitor` stores the last snapshot it
 * delivered under that name, so a re-armed monitor diffs against what the
 * session already saw: it emits only what changed while Pi was down.
 *
 * Free of Pi SDK / pi-tui imports so it can be unit tested in isolation.
 */

import type { MonitorConfig } from "./keys";
import type { DeploymentSnapshot } from "./deployments";

/** customType of the session entries this extension writes. */
export const MONITOR_ENTRY_TYPE = "ghpr-monitor-session";

/** Post-merge deployment tracking state, recorded so it can resume too. */
export interface PersistedDeployState {
	/** Merged head commit SHA whose deployments are watched. */
	sha: string;
	/** Last deployment snapshots delivered, or null before the first poll. */
	snapshots: DeploymentSnapshot[] | null;
}

/** Why a monitor ended. Every reason means "do not re-arm". */
export type UnwatchReason = "stopped" | "finished" | "error";

export type MonitorEntryData =
	| { op: "watch"; key: string; config: MonitorConfig; deploy?: PersistedDeployState }
	| { op: "unwatch"; key: string; reason: UnwatchReason };

/** The fields of a Pi session entry this module reads. */
export interface SessionEntryLike {
	type: string;
	customType?: string;
	data?: unknown;
}

export interface RestorableMonitor {
	key: string;
	config: MonitorConfig;
	deploy?: PersistedDeployState;
}

function isConfig(v: unknown): v is MonitorConfig {
	if (!v || typeof v !== "object") return false;
	const c = v as Record<string, unknown>;
	return (
		typeof c.owner === "string" &&
		typeof c.repo === "string" &&
		typeof c.number === "number" &&
		typeof c.host === "string" &&
		(c.resourceType === "pr" || c.resourceType === "issue" || c.resourceType === "run") &&
		typeof c.intervalSec === "number"
	);
}

function isDeployState(v: unknown): v is PersistedDeployState {
	if (!v || typeof v !== "object") return false;
	const d = v as Record<string, unknown>;
	return typeof d.sha === "string" && d.sha !== "" && (d.snapshots === null || Array.isArray(d.snapshots));
}

/**
 * Replay the monitor entries of a session branch, oldest first, and return
 * the monitors whose last entry is a `watch`. Malformed entries are skipped.
 */
export function restorableMonitors(entries: readonly SessionEntryLike[]): RestorableMonitor[] {
	const live = new Map<string, RestorableMonitor>();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== MONITOR_ENTRY_TYPE) continue;
		const data = entry.data as Record<string, unknown> | undefined;
		if (!data || typeof data.key !== "string" || data.key === "") continue;
		if (data.op === "unwatch") {
			live.delete(data.key);
			continue;
		}
		if (data.op !== "watch" || !isConfig(data.config)) continue;
		// Delete first so a re-watched key moves to the end (start order).
		live.delete(data.key);
		const restored: RestorableMonitor = { key: data.key, config: data.config };
		if (isDeployState(data.deploy)) restored.deploy = data.deploy;
		live.set(data.key, restored);
	}
	return [...live.values()];
}

/**
 * The `gh monitor --instance` name for a monitor in a session. Stable across
 * restarts of the same session, distinct across sessions so two sessions
 * watching one PR never share a stored snapshot. Restricted to filename-safe
 * characters because `gh monitor` stores one cursor file per name.
 */
export function instanceName(sessionId: string, key: string): string {
	const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "_");
	return `pi-ghpr-${safe(sessionId)}-${safe(key)}`;
}
