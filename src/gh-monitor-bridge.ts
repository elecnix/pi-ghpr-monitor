/**
 * The gh-monitor bridge: the adapter's thin wrapper around the `gh monitor` CLI.
 *
 * Instead of re-implementing PR/issue/run polling, snapshotting, and
 * change-diffing in TypeScript (the old analyzer.ts / run-monitor.ts /
 * pollLoop trio, ~2000 lines), the adapter shells out to `gh monitor`, which
 * streams one NDJSON `Notification` per genuinely-new change and auto-stops on
 * merge/close/run-completion. This module:
 *
 *   - builds the CLI arguments for a monitor target (`buildMonitorArgs`),
 *   - spawns the persistent monitor and relays each NDJSON line as a parsed
 *     `Notification` (`spawnMonitor`),
 *   - runs a one-shot `--once` fetch (`spawnOnce`),
 *   - delegates preference read/write/reset/path to `gh monitor prefs`
 *     (`prefsGet` / `prefsSet` / `prefsReset` / `prefsPath`).
 *
 * It is deliberately free of any Pi SDK / pi-tui dependency so it can be unit
 * tested in isolation (index.ts cannot be imported under vitest because of its
 * pi-tui import). The Notification type re-exported here is the single source
 * of truth that index.ts and render.ts consume.
 */

import { spawn, type ChildProcess } from "node:child_process";
import type { MonitorConfig } from "./keys";

// Re-export so callers import the Notification shape from one place.
export type { Notification } from "./render";

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/**
 * When set, this binary is invoked directly instead of `gh monitor ...`. Used
 * for tests and sandboxed runs. The binary receives the same subargs that `gh`
 * would forward to the `gh-monitor` extension (i.e. starting with the
 * subcommand, without the leading `monitor` extension name).
 */
export const GH_MONITOR_BIN_ENV = "GH_MONITOR_BIN";

function bin(): string {
	return process.env[GH_MONITOR_BIN_ENV] || "gh";
}

/** Subargs are the args after the `gh monitor` extension name. */
function fullArgs(subargs: string[]): string[] {
	return process.env[GH_MONITOR_BIN_ENV] ? subargs : ["monitor", ...subargs];
}

/** Spawn env: forward GH_HOST for enterprise hosts so gh-monitor resolves them. */
function spawnEnv(config: MonitorConfig): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	if (config.host && config.host !== "github.com") {
		env.GH_HOST = config.host;
	}
	return env;
}

// ---------------------------------------------------------------------------
// Monitor argument builder
// ---------------------------------------------------------------------------

/**
 * Build the `gh monitor monitor` subargs for a target.
 *
 * Returns the args after the `monitor` extension name, i.e. the first element
 * is the `monitor` subcommand. PRs use a positional selector; issues use
 * `--issue`; runs use `--run-id`.
 */
export function buildMonitorArgs(config: MonitorConfig, opts: { once?: boolean } = {}): string[] {
	const interval = Math.max(10, config.intervalSec || 60);
	const args = ["monitor", "-R", `${config.owner}/${config.repo}`, "--interval", String(interval)];

	if (config.resourceType === "run") {
		args.push("--run-id", String(config.runId ?? 0));
	} else if (config.resourceType === "issue") {
		args.push("--issue", String(config.number));
	} else {
		args.push(String(config.number));
	}

	if (opts.once) args.push("--once");
	return args;
}

// ---------------------------------------------------------------------------
// NDJSON parsing
// ---------------------------------------------------------------------------

import type { Notification } from "./render";

/** Parse one NDJSON line into a Notification, or null if blank/invalid. */
export function parseNotification(line: string): Notification | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	try {
		return JSON.parse(trimmed) as Notification;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Spawning
// ---------------------------------------------------------------------------

export interface MonitorHandlers {
	onNotification: (n: Notification) => void;
	/** Called once when the process exits (clean auto-stop, error, or abort). */
	onExit: (code: number | null, stderr: string) => void;
}

export interface MonitorHandle {
	/** Abort the monitor: kills the child process. */
	abort: () => void;
	/** The underlying child process (for advanced uses). */
	child: ChildProcess;
}

/**
 * Spawn `gh monitor monitor <selector>` and relay each NDJSON line as a
 * Notification. The process runs until gh-monitor auto-stops (PR merged/closed,
 * run completed) or `abort()` kills it.
 */
export function spawnMonitor(config: MonitorConfig, handlers: MonitorHandlers): MonitorHandle {
	const args = fullArgs(buildMonitorArgs(config));
	const child = spawn(bin(), args, {
		stdio: ["ignore", "pipe", "pipe"],
		env: spawnEnv(config),
	});

	let stderr = "";
	let aborted = false;

	child.stdout?.setEncoding("utf-8");
	child.stdout?.on("data", (chunk: string) => {
		// Buffer-split on newlines so partial lines across chunks are handled.
		let line: string | null = null;
		const lines = chunk.split("\n");
		for (let i = 0; i < lines.length; i++) {
			if (i === lines.length - 1) {
				// Last segment may be partial; save for next chunk.
				line = lines[i];
				continue;
			}
			const n = parseNotification(lines[i]!);
			if (n) handlers.onNotification(n);
		}
		// Re-emit a trailing partial line only when the stream ends (below).
		// Track the dangling partial for the final 'end' flush.
		if (line !== null && line !== "") (child as any).__partial = ((child as any).__partial || "") + line;
	});

	child.stderr?.on("data", (d: Buffer) => {
		stderr += d.toString();
	});

	child.on("close", (code) => {
		// Flush any trailing partial line.
		const partial: string = (child as any).__partial || "";
		if (partial) {
			const n = parseNotification(partial);
			if (n) handlers.onNotification(n);
		}
		handlers.onExit(aborted ? null : code, stderr);
	});

	return {
		child,
		abort: () => {
			aborted = true;
			if (!child.killed) {
				try {
					child.kill("SIGTERM");
				} catch {
					/* ignore */
				}
			}
		},
	};
}

/**
 * Run `gh monitor monitor <selector> --once`, collecting every Notification
 * emitted before the process exits. Rejects on a nonzero exit code.
 */
export async function spawnOnce(config: MonitorConfig): Promise<Notification[]> {
	const args = fullArgs(buildMonitorArgs(config, { once: true }));
	return new Promise((resolve, reject) => {
		const child = spawn(bin(), args, {
			stdio: ["ignore", "pipe", "pipe"],
			env: spawnEnv(config),
		});
		const events: Notification[] = [];
		let stderr = "";
		let partial = "";

		child.stdout?.setEncoding("utf-8");
		child.stdout?.on("data", (chunk: string) => {
			const lines = chunk.split("\n");
			for (let i = 0; i < lines.length; i++) {
				if (i === lines.length - 1) {
					partial += lines[i];
					continue;
				}
				const n = parseNotification(lines[i]!);
				if (n) events.push(n);
			}
		});
		child.stderr?.on("data", (d: Buffer) => {
			stderr += d.toString();
		});
		child.on("close", (code) => {
			if (partial) {
				const n = parseNotification(partial);
				if (n) events.push(n);
			}
			if (code !== 0) {
				reject(new Error(`gh monitor --once exited ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
				return;
			}
			resolve(events);
		});
	});
}

// ---------------------------------------------------------------------------
// Preferences delegation (`gh monitor prefs …`)
// ---------------------------------------------------------------------------

/** The effective preferences shape returned by `gh monitor prefs get`. */
export interface GhMonitorPrefs {
	templates: Record<string, string>;
	ignoredBots: string[];
	retriggerComments: boolean;
}

function prefsArgs(subcommand: string[], configDir?: string): string[] {
	const sub = ["prefs", ...subcommand];
	if (configDir) sub.push("--config-dir", configDir);
	return sub;
}

function runPrefs(subargs: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(bin(), fullArgs(subargs), {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout?.setEncoding("utf-8");
		child.stdout?.on("data", (d: string) => (stdout += d));
		child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
		child.on("close", (code) => {
			if (code !== 0) {
				reject(new Error(`gh monitor prefs exited ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
				return;
			}
			resolve(stdout);
		});
	});
}

/** Read effective preferences via `gh monitor prefs get`. */
export async function prefsGet(configDir?: string): Promise<GhMonitorPrefs> {
	const out = await runPrefs(prefsArgs(["get"], configDir));
	return JSON.parse(out) as GhMonitorPrefs;
}

/**
 * Merge preference overrides via `gh monitor prefs set <json>` and return the
 * resulting effective preferences.
 */
export async function prefsSet(json: string, configDir?: string): Promise<GhMonitorPrefs> {
	const out = await runPrefs(prefsArgs(["set", json], configDir));
	return JSON.parse(out) as GhMonitorPrefs;
}

/** Reset preferences to defaults via `gh monitor prefs reset`. */
export async function prefsReset(configDir?: string): Promise<GhMonitorPrefs> {
	const out = await runPrefs(prefsArgs(["reset"], configDir));
	return JSON.parse(out) as GhMonitorPrefs;
}

/** Print the preferences file path via `gh monitor prefs path`. */
export async function prefsPath(configDir?: string): Promise<string> {
	const out = await runPrefs(prefsArgs(["path"], configDir));
	return out.trim();
}