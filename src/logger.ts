/**
 * Per-session logger for pi-ghpr-monitor
 *
 * Writes monitor activity to /tmp/ghpr-monitor-<session-id>.log when
 * debug mode is enabled via /ghpr-monitor debug.
 * One log file per PI session. Helps with debugging issues like
 * CI failures not being detected.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

let logStream: fs.WriteStream | null = null;
let logPath: string | null = null;

/** Stored session ID, captured on session_start for use when debug is activated. */
let sessionId: string | null = null;

/**
 * Store the session ID for later use when debug mode is activated.
 * Called on session_start, but does NOT start logging.
 */
export function setSessionId(id: string): void {
	sessionId = id;
}

/**
 * Activate debug logging.
 * Creates or appends to a log file in /tmp named after the session.
 * Returns the log file path.
 */
export function enableDebug(): string {
	if (logStream) {
		// Already logging — just return the path
		return logPath!;
	}
	const id = sessionId ?? `adhoc-${Date.now()}`;
	// Sanitize session ID for use as filename
	const safeId = id.replace(/[^a-zA-Z0-9._-]/g, "_");
	logPath = path.join(os.tmpdir(), `ghpr-monitor-${safeId}.log`);
	logStream = fs.createWriteStream(logPath, { flags: "a", encoding: "utf-8" });
	log(`=== ghpr-monitor debug logging started: ${new Date().toISOString()} ===`);
	log(`Log file: ${logPath}`);
	return logPath;
}

/**
 * Deactivate debug logging.
 * Returns the (now former) log file path, or null if logging wasn't active.
 */
export function disableDebug(): string | null {
	const formerPath = logPath;
	if (logStream) {
		log(`=== ghpr-monitor debug logging stopped: ${new Date().toISOString()} ===`);
		logStream.end();
		logStream = null;
	}
	logPath = null;
	return formerPath;
}

/**
 * Close the log stream. Called on session shutdown.
 */
export function closeLogger(): void {
	if (logStream) {
		log(`=== ghpr-monitor session ended: ${new Date().toISOString()} ===`);
		logStream.end();
		logStream = null;
	}
	logPath = null;
}

/**
 * Whether debug logging is currently active.
 */
export function isDebugEnabled(): boolean {
	return logStream !== null;
}

/**
 * Log a message with a timestamp.
 * No-op when debug logging is not enabled.
 * Only writes to the log file — never to the TUI.
 */
export function log(message: string): void {
	if (!logStream) return;
	const timestamp = new Date().toISOString();
	const line = `[${timestamp}] ${message}`;
	logStream.write(line + "\n");
}

/**
 * Log a PR data snapshot (abbreviated).
 */
export function logPRSnapshot(pr: {
	state: string;
	merged: boolean;
	mergeable: string;
	comments: { nodes: unknown[] };
	reviewThreads: { nodes: Array<{ isResolved: boolean }> };
	commits: {
		nodes: Array<{
			commit: {
				oid: string;
				checkSuites: { nodes: Array<{ conclusion: string | null; status: string; app: { name: string; slug: string }; checkRuns: { nodes: Array<{ name: string; conclusion: string | null; status: string }> } }> };
				status: { state: string; contexts: Array<{ state: string; context: string }> } | null;
			};
		}>;
	};
}): void {
	log(`PR state: ${pr.state}, merged: ${pr.merged}, mergeable: ${pr.mergeable}`);
	log(`  comments: ${pr.comments.nodes.length}, unresolved threads: ${pr.reviewThreads.nodes.filter(t => !t.isResolved).length}`);

	for (const commit of pr.commits.nodes) {
		log(`  commit: ${commit.commit.oid}`);
		log(`  checkSuites: ${commit.commit.checkSuites.nodes.length}`);
		for (const suite of commit.commit.checkSuites.nodes) {
			const runs = suite.checkRuns.nodes.map(r => `${r.name}=${r.conclusion ?? r.status}`).join(", ");
			log(`    ${suite.app.name} (${suite.conclusion ?? suite.status}): [${runs}]`);
		}
		if (commit.commit.status) {
			log(`  commit status: ${commit.commit.status.state}`);
			for (const ctx of commit.commit.status.contexts) {
				log(`    ${ctx.context}: ${ctx.state}`);
			}
		} else {
			log(`  commit status: null (no status API data)`);
		}
	}
}

/**
 * Log the computed PR status snapshot.
 */
export function logStatus(status: {
	unresolvedThreads: number;
	generalComments: number;
	hasConflicts: boolean;
	failingChecks: string[];
	pendingChecks: string[];
	failingStatuses?: string[];
	pendingStatuses?: string[];
	lastCommitOid?: string;
}): void {
	log(`Status: threads=${status.unresolvedThreads}, comments=${status.generalComments}, conflicts=${status.hasConflicts}`);
	log(`  failingChecks: [${status.failingChecks.join(", ")}]`);
	log(`  pendingChecks: [${status.pendingChecks.join(", ")}]`);
	log(`  failingStatuses: [${(status.failingStatuses ?? []).join(", ")}]`);
	log(`  pendingStatuses: [${(status.pendingStatuses ?? []).join(", ")}]`);
	if (status.lastCommitOid !== undefined) {
		log(`  lastCommitOid: ${status.lastCommitOid}`);
	}
}

/**
 * Get the current log file path, or null if debug logging is not active.
 */
export function getLogPath(): string | null {
	return logPath;
}