/**
 * Linear monitor manager — the poll/diff/deliver machinery for Linear tickets.
 *
 * Mirrors the PR poll loop in index.ts (abortable interval, backoff on error,
 * throttle-during-turn with flush on turn end, forced checks) but is kept in
 * its own module and talks to the pi runtime through an injected
 * {@link LinearMonitorHost}. That keeps the existing (well-tested) PR path
 * untouched and makes the Linear logic unit-testable without the pi runtime or
 * the network.
 */

import {
	type LinearRef,
	type LinearIssueStatus,
	type LinearNotification,
	fetchLinearIssue,
	snapshotLinearIssue,
	formatLinearUpdate,
	formatLinearActionable,
	formatLinearFooter,
} from "./linear";

// ---------------------------------------------------------------------------
// Host interface — implemented by the pi extension (index.ts)
// ---------------------------------------------------------------------------

export interface LinearMonitorHost {
	/** Deliver a notification to the agent + TUI. */
	sendNotification(concise: string, detailed: string): void;
	/** Show a transient TUI-only message (never enters the LLM context). */
	notify(msg: string, level: "info" | "warning" | "error"): void;
	/** Set (or clear, with undefined) the footer status line. */
	setFooter(text: string | undefined): void;
	/** True while the agent is mid-turn — updates are queued, not delivered. */
	isAgentTurnActive(): boolean;
	/** Comment authors to filter out (shared with the PR monitor's preference). */
	getIgnoredBots(): string[];
	/** The Linear personal API key, or null when unconfigured. */
	getApiKey(): string | null;
	/** Injected fetch (tests) — defaults to global fetch inside the client. */
	fetchImpl?: typeof fetch;
	/** Endpoint override (tests / mock server). */
	endpoint?: string;
}

// ---------------------------------------------------------------------------
// Per-monitor state
// ---------------------------------------------------------------------------

export interface LinearMonitor {
	ref: LinearRef;
	controller: AbortController;
	intervalSec: number;
	lastStatus: LinearIssueStatus | null;
	lastStatusTimestamp: Date | null;
	lastSentUpdate: string | null;
	forceNotify: boolean;
	backoffSec: number;
	consecutiveNoChange: number;
	pollWakeResolve: (() => void) | null;
}

const MAX_BACKOFF_SEC = 300;
const MAX_IDLE_SEC = 300;

export interface AddOptions {
	intervalSec?: number;
	/** When false, register the monitor but don't launch the poll loop (tests). */
	autoStart?: boolean;
}

export interface AddResult {
	key: string;
	message?: string;
	alreadyMonitoring?: boolean;
	error?: string;
}

export class LinearMonitorManager {
	private monitors = new Map<string, LinearMonitor>();
	/** Updates deferred while the agent is working, flushed on turn end. */
	private queued: Array<{ key: string; concise: string; detailed: string }> = [];

	constructor(private host: LinearMonitorHost) {}

	// -- lifecycle ---------------------------------------------------------

	add(ref: LinearRef, opts: AddOptions = {}): AddResult {
		const key = ref.key;
		if (this.monitors.has(key)) {
			return { key, alreadyMonitoring: true, message: `Already monitoring ${key}.` };
		}
		if (!this.host.getApiKey()) {
			return {
				key,
				error:
					"No Linear API key found. Set a personal API key (Linear → Settings → Security & Access → " +
					"Personal API keys) in the LINEAR_API_KEY environment variable.",
			};
		}

		const mon: LinearMonitor = {
			ref,
			controller: new AbortController(),
			intervalSec: Math.max(10, opts.intervalSec ?? 60),
			lastStatus: null,
			lastStatusTimestamp: null,
			lastSentUpdate: null,
			forceNotify: false,
			backoffSec: 0,
			consecutiveNoChange: 0,
			pollWakeResolve: null,
		};
		this.monitors.set(key, mon);
		this.updateFooter();

		if (opts.autoStart !== false) {
			this.pollLoop(mon).catch((err) => {
				if (mon.controller.signal.aborted) return;
				this.host.notify(`Linear monitor error for ${key}: ${err instanceof Error ? err.message : String(err)}`, "error");
				this.monitors.delete(key);
				this.updateFooter();
			});
		}

		return { key, message: `Started monitoring ${key} (every ${mon.intervalSec}s).` };
	}

	stop(key: string): string {
		const mon = this.monitors.get(key);
		if (!mon) return `Not monitoring ${key}`;
		mon.controller.abort();
		mon.pollWakeResolve = null;
		this.monitors.delete(key);
		this.updateFooter();
		return `Stopped monitoring ${key}`;
	}

	stopAll(): string {
		if (this.monitors.size === 0) return "No Linear monitors running";
		const keys = [...this.monitors.keys()];
		for (const mon of this.monitors.values()) {
			mon.controller.abort();
			mon.pollWakeResolve = null;
		}
		this.monitors.clear();
		this.updateFooter();
		return `Stopped monitoring ${keys.length} issue(s): ${keys.join(", ")}`;
	}

	list(): string[] {
		return [...this.monitors.keys()];
	}

	get(key: string): LinearMonitor | undefined {
		return this.monitors.get(key);
	}

	size(): number {
		return this.monitors.size;
	}

	/** Trigger an immediate poll for one issue (or all) and report current items. */
	check(key?: string): boolean {
		const targets = key ? [this.monitors.get(key)].filter(Boolean) as LinearMonitor[] : [...this.monitors.values()];
		if (targets.length === 0) return false;
		for (const mon of targets) {
			mon.forceNotify = true;
			mon.backoffSec = 0;
			mon.consecutiveNoChange = 0;
			if (mon.pollWakeResolve) {
				mon.pollWakeResolve();
				mon.pollWakeResolve = null;
			}
		}
		return true;
	}

	// -- delivery / throttle ----------------------------------------------

	/** Flush any updates queued while the agent was working. */
	flushQueued(): void {
		if (this.queued.length === 0) return;
		const pending = this.queued;
		this.queued = [];
		for (const q of pending) {
			this.host.sendNotification(q.concise, q.detailed);
			const mon = this.monitors.get(q.key);
			if (mon) mon.lastSentUpdate = q.concise;
		}
	}

	private deliver(mon: LinearMonitor, note: LinearNotification): void {
		if (this.host.isAgentTurnActive()) {
			this.queued.push({ key: mon.ref.key, concise: note.concise, detailed: note.detailed });
			return;
		}
		if (note.concise === mon.lastSentUpdate) return; // dedup
		this.host.sendNotification(note.concise, note.detailed);
		mon.lastSentUpdate = note.concise;
	}

	// -- polling -----------------------------------------------------------

	/** Perform a single poll cycle for one monitor. Public for testing + forced checks. */
	async pollOnce(key: string): Promise<void> {
		const mon = this.monitors.get(key);
		if (!mon) return;
		await this.runPoll(mon);
	}

	private async runPoll(mon: LinearMonitor): Promise<void> {
		const key = mon.ref.key;
		try {
			const issue = await fetchLinearIssue(mon.ref, {
				apiKey: this.host.getApiKey()!,
				fetchImpl: this.host.fetchImpl,
				endpoint: this.host.endpoint,
				signal: mon.controller.signal,
			});
			const curr = snapshotLinearIssue(issue, this.host.getIgnoredBots());
			const update = formatLinearUpdate(mon.lastStatus, curr);

			if (update) {
				this.deliver(mon, update);
				mon.consecutiveNoChange = 0;
			} else {
				mon.consecutiveNoChange++;
			}

			// Forced check (/linear-monitor check): always report current items,
			// regardless of whether anything changed since the last poll.
			if (mon.forceNotify) {
				const actionable = formatLinearActionable(curr);
				const note = actionable ?? {
					concise: `✅ No open comments on ${key} (state: ${curr.stateName})`,
					detailed: `✅ No open comments on ${key} (state: ${curr.stateName})`,
				};
				if (this.host.isAgentTurnActive()) {
					this.queued.push({ key, concise: note.concise, detailed: note.detailed });
				} else {
					this.host.sendNotification(note.concise, note.detailed);
					mon.lastSentUpdate = note.concise;
				}
				mon.forceNotify = false;
			}

			mon.lastStatus = curr;
			mon.lastStatusTimestamp = new Date();
			mon.backoffSec = 0;
			this.updateFooter();
		} catch (err) {
			if (mon.controller.signal.aborted) return;
			const msg = err instanceof Error ? err.message : String(err);
			const isRateLimit = /rate limit/i.test(msg);
			mon.backoffSec = mon.backoffSec === 0 ? mon.intervalSec : Math.min(mon.backoffSec * 2, MAX_BACKOFF_SEC);
			this.host.notify(
				isRateLimit
					? `Rate limited on ${key}, backing off ${mon.backoffSec}s`
					: `Poll error for ${key}: ${msg} (retrying in ${mon.backoffSec}s)`,
				"warning",
			);
		}
	}

	private async pollLoop(mon: LinearMonitor): Promise<void> {
		const signal = mon.controller.signal;
		this.host.notify(`📋 Monitoring Linear issue ${mon.ref.key} (every ${mon.intervalSec}s)`, "info");

		for (;;) {
			if (signal.aborted) return;
			await this.runPoll(mon);
			if (signal.aborted) return;

			const idleSec =
				mon.consecutiveNoChange > 3
					? Math.min(mon.intervalSec * Math.pow(2, mon.consecutiveNoChange - 3), MAX_IDLE_SEC)
					: mon.intervalSec;
			const waitSec = mon.backoffSec > 0 ? mon.backoffSec : idleSec;

			await new Promise<void>((resolve) => {
				mon.pollWakeResolve = resolve;
				const timer = setTimeout(() => {
					mon.pollWakeResolve = null;
					resolve();
				}, waitSec * 1000);
				signal.addEventListener(
					"abort",
					() => {
						clearTimeout(timer);
						mon.pollWakeResolve = null;
						resolve();
					},
					{ once: true },
				);
			});
			if (signal.aborted) return;
		}
	}

	private updateFooter(): void {
		if (this.monitors.size === 0) {
			this.host.setFooter(undefined);
			return;
		}
		if (this.monitors.size === 1) {
			const mon = this.monitors.values().next().value!;
			this.host.setFooter(formatLinearFooter(mon.lastStatus, mon.ref));
			return;
		}
		this.host.setFooter(`📋 ${this.monitors.size} Linear issues`);
	}
}
