/**
 * Per-session logger for pi-ghpr-monitor
 *
 * Writes all monitor activity to /tmp/ghpr-monitor-<session-id>.log
 * One log file per PI session. Helps with debugging issues like
 * CI failures not being detected.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

let logStream: fs.WriteStream | null = null;
let logPath: string | null = null;

/**
 * Initialize the logger for a session.
 * Creates or appends to a log file in /tmp named after the session.
 */
export function initLogger(sessionId: string): void {
	if (logStream) {
		closeLogger();
	}
	// Sanitize session ID for use as filename
	const safeId = sessionId.replace(/[^a-zA-Z0-9._-]/g, "_");
	logPath = path.join(os.tmpdir(), `ghpr-monitor-${safeId}.log`);
	logStream = fs.createWriteStream(logPath, { flags: "a", encoding: "utf-8" });
	log(`=== ghpr-monitor session started: ${new Date().toISOString()} ===`);
	log(`Log file: ${logPath}`);
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
 * Log a message with a timestamp.
 *Messages are written to the log file and also to stderr for debugging.
 */
export function log(message: string): void {
	const timestamp = new Date().toISOString();
	const line = `[${timestamp}] ${message}`;
	if (logStream) {
		logStream.write(line + "\n");
	}
	// Also write to stderr for visibility during development
	process.stderr.write(`[ghpr-monitor] ${line}\n`);
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
				checkSuites: { nodes: Array<{ conclusion: string | null; status: string; app: { name: string; slug: string }; checkRuns: { nodes: Array<{ name: string; conclusion: string | null; status: string }> } }> };
				status: { state: string; contexts: Array<{ state: string; context: string }> } | null;
			};
		}>;
	};
}): void {
	log(`PR state: ${pr.state}, merged: ${pr.merged}, mergeable: ${pr.mergeable}`);
	log(`  comments: ${pr.comments.nodes.length}, unresolved threads: ${pr.reviewThreads.nodes.filter(t => !t.isResolved).length}`);

	for (const commit of pr.commits.nodes) {
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
}): void {
	log(`Status: threads=${status.unresolvedThreads}, comments=${status.generalComments}, conflicts=${status.hasConflicts}`);
	log(`  failingChecks: [${status.failingChecks.join(", ")}]`);
	log(`  pendingChecks: [${status.pendingChecks.join(", ")}]`);
	log(`  failingStatuses: [${(status.failingStatuses ?? []).join(", ")}]`);
	log(`  pendingStatuses: [${(status.pendingStatuses ?? []).join(", ")}]`);
}

/**
 * Get the current log file path, or null if not initialized.
 */
export function getLogPath(): string | null {
	return logPath;
}