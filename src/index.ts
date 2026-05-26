/**
 * pi-ghpr-monitor — Pi extension for monitoring GitHub PRs
 *
 * Registers:
 *   /ghpr-monitor [on|off|owner/repo#number|check]  — user-facing command (no args = ask agent)
 *   ghpr-monitor                                 — LLM-callable tool
 *
 * The tool polls one or more PRs for comments, conflicts, and CI status,
 * then injects notifications into the agent session so the LLM can take action.
 *
 * Multiple PRs can be monitored simultaneously — each runs its own
 * independent poll loop with its own state (backoff, status, reminders).
 */

import type { ExtensionAPI, ExtensionUIContext, MessageRenderer } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import * as path from "node:path";
import { Text, Box } from "@mariozechner/pi-tui";
import {
	type PullRequestData,
	type PRStatus,
	type MonitorConfig,
	snapshotPR,
	formatActionableItems,
	formatStatusUpdate,
	formatFooterStatus,
	formatAgentNotification,
	formatAgentStatusUpdate,
} from "./analyzer";
import { setSessionId, enableDebug, disableDebug, isDebugEnabled, closeLogger, log, logPRSnapshot, logStatus, getLogPath } from "./logger";

// ---------------------------------------------------------------------------
// GraphQL query (same as gh-pr-review's AWAIT_QUERY)
// ---------------------------------------------------------------------------

const AWAIT_QUERY = `query AwaitPR(
  $owner: String!,
  $repo: String!,
  $number: Int!,
  $lastComments: Int!,
  $lastThreads: Int!,
  $lastThreadComments: Int!,
  $lastCheckSuites: Int!,
  $lastCheckRuns: Int!
) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      state
      merged
      comments(last: $lastComments) {
        nodes { id body author { login } createdAt reactions(content: THUMBS_UP, first: 1) { nodes { content } } }
      }
      reviewThreads(last: $lastThreads) {
        nodes {
          id
          isResolved
          comments(last: $lastThreadComments) {
            nodes { id body author { login } createdAt path line reactions(content: THUMBS_UP, first: 1) { nodes { content } } }
          }
        }
      }
      mergeable
      mergeStateStatus
      commits(last: 1) {
        nodes {
          commit {
            checkSuites(last: $lastCheckSuites) {
              nodes {
                id
                conclusion
                status
                app { name slug }
                checkRuns(last: $lastCheckRuns) {
                  nodes {
                    name
                    conclusion
                    status
                  }
                }
              }
            }
            status {
              state
              contexts {
                state
                context
                description
                targetUrl
              }
            }
          }
        }
      }
    }
  }
}`;

// ---------------------------------------------------------------------------
// GitHub API helpers
// ---------------------------------------------------------------------------

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

async function ghGraphQL(
	query: string,
	variables: Record<string, unknown>,
	host?: string,
	mockBaseUrl?: string,
): Promise<unknown> {
	if (mockBaseUrl) {
		// In test mode, call the mock server directly via HTTP
		const resp = await fetch(`${mockBaseUrl}/graphql`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ query, variables }),
		});
		if (!resp.ok) throw new Error(`Mock server returned ${resp.status}`);
		return resp.json();
	}

	const payload = JSON.stringify({ query, variables });
	const args = ["api", "graphql", "--input", "-"];
	if (host && host !== "github.com") {
		args.push("--hostname", host);
	}
	const result = await runGh(args, payload);
	if (result.exitCode !== 0) {
		throw new Error(`gh api graphql failed: ${result.stderr}`);
	}
	return JSON.parse(result.stdout);
}

async function fetchPRData(config: MonitorConfig, signal?: AbortSignal, mockBaseUrl?: string): Promise<PullRequestData> {
	const vars: Record<string, unknown> = {
		owner: config.owner,
		repo: config.repo,
		number: config.number,
		lastComments: 25,
		lastThreads: 25,
		lastThreadComments: 25,
		lastCheckSuites: 10,
		lastCheckRuns: 10,
	};
	const raw = await ghGraphQL(
		AWAIT_QUERY,
		vars,
		config.host !== "github.com" ? config.host : undefined,
		mockBaseUrl,
	);
	const outer = raw as { data?: { repository?: { pullRequest?: PullRequestData } } };
	if (!outer.data?.repository?.pullRequest) {
		throw new Error(`PR ${config.owner}/${config.repo}#${config.number} not found or not accessible`);
	}
	return outer.data.repository.pullRequest;
}

// ---------------------------------------------------------------------------
// PR URL parser
// ---------------------------------------------------------------------------

const PR_URL_RE = /^https?:\/\/([^\/]+)\/([^\/]+)\/([^\/]+)\/pull\/([0-9]+)/i;

export interface ParsedPR {
	owner: string;
	repo: string;
	number: number;
	host: string;
}

export function parsePRUrl(input: string): ParsedPR | null {
	const m = input.trim().match(PR_URL_RE);
	if (!m) return null;
	const host = m[1] === "github.com" ? "github.com" : m[1];
	return { owner: m[2], repo: m[3], number: parseInt(m[4], 10), host };
}

/** Parse shorthand formats like "owner/repo#123" */
export function parsePRShorthand(input: string): ParsedPR | null {
	// Try "owner/repo#number" (e.g. "mobilityhouse/vgi-na-masscec#373")
	const hashM = input.trim().match(/^([^\s#/]+)\/([^#]+)#([0-9]+)$/);
	if (hashM) {
		return { owner: hashM[1], repo: hashM[2], number: parseInt(hashM[3], 10), host: "github.com" };
	}
	return null;
}

// ---------------------------------------------------------------------------
// PR key helper
// ---------------------------------------------------------------------------

/** Generate a unique key for a PR monitor. */
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

// ---------------------------------------------------------------------------
// Active monitor entry
// ---------------------------------------------------------------------------

export interface ActiveMonitor {
	config: MonitorConfig;
	controller: AbortController;
	lastStatus: PRStatus | null;
	lastStatusTimestamp: Date | null;
	lastSentUpdate: string | null;
	lastSentReminder: string | null;
	needsReminder: boolean;
	forceNotify: boolean;
	backoffSec: number;
	consecutiveNoChange: number;
	lastNudgeTime: number; // epoch ms
	pollWakeResolve: (() => void) | null;
}

function createActiveMonitor(config: MonitorConfig): ActiveMonitor {
	return {
		config,
		controller: new AbortController(),
		lastStatus: null,
		lastStatusTimestamp: null,
		lastSentUpdate: null,
		lastSentReminder: null,
		needsReminder: false,
		forceNotify: false,
		backoffSec: 0,
		consecutiveNoChange: 0,
		lastNudgeTime: 0,
		pollWakeResolve: null,
	};
}

// ---------------------------------------------------------------------------
// Main extension
// ---------------------------------------------------------------------------

export default function ghprMonitorExtension(pi: ExtensionAPI) {
	const monitors: Map<string, ActiveMonitor> = new Map();
	let agentTurnActive = false;
	let queuedUpdate: string | null = null;
	let queuedForceCheck: string | null = null;
	let queuedForceCheckDetailed: string | null = null;
	let lastSentUpdate: string | null = null;
	let uiCtx: ExtensionUIContext | undefined;
	const MAX_BACKOFF_SEC = 300; // 5 minutes max rate-limit backoff
	const MAX_IDLE_SEC = 3600; // 1 hour max idle polling
	const NUDGE_COOLDOWN_MS = 3 * 60 * 1000; // 3 minutes between nudges for idle agent

	// For testing: allows pointing at a mock server
	let mockBaseUrl: string | undefined = process.env.GHPR_MOCK_BASE_URL;
	const NO_AGENT = !!process.env.PI_GHPR_NO_AGENT;

	// For testing: allows reducing the polling interval
	const MOCK_INTERVAL_SECS = process.env.GHPR_MONITOR_INTERVAL_SECS ? parseInt(process.env.GHPR_MONITOR_INTERVAL_SECS, 10) : undefined;

	const STEERING_PROMPT = `You have access to the ghpr-monitor tool. When the user asks you to watch or monitor a PR, use ghpr-monitor with action "start" to begin monitoring. The tool has actions: start, status, check, and stop. Multiple PRs can be monitored simultaneously. Monitoring continues until the user stops it with /ghpr-monitor off (stops all) or /ghpr-monitor off <PR> (stops specific). The user can also run /ghpr-monitor check to trigger an immediate poll (all PRs or a specific one). You will receive PR status updates as notifications. The url parameter accepts GitHub PR URLs or shorthand like "owner/repo#123".`;

	// Register a custom message renderer for "ghpr-monitor" messages.
	// This renders only the concise summary in the TUI, while the agent
	// receives the full content (including complete comment bodies, paths,
	// and line numbers) via the CustomMessage content field.
	pi.registerMessageRenderer<{ concise: string }>("ghpr-monitor", (message, _options, theme) => {
		const concise = message.details?.concise ?? (typeof message.content === "string" ? message.content : "");
		const box = new Box(1, 0, (t: string) => theme.bg("customMessageBg", t));
		box.addChild(new Text(concise, 0, 0));
		return box;
	});

	// Inject steering prompt so the LLM knows about the tool
	pi.on("before_agent_start", async (event, _ctx) => {
		return {
			systemPrompt: event.systemPrompt + "\n\n" + STEERING_PROMPT,
		};
	});

	// Store session ID for debug logging (activated on demand via /ghpr-monitor debug)
	pi.on("session_start", async (_event, ctx) => {
		const sessionFile = ctx.sessionManager.getSessionFile();
		const id = sessionFile ? path.basename(sessionFile, path.extname(sessionFile)) : `ephemeral-${Date.now()}`;
		setSessionId(id);
	});

	/**
	 * Send a PR status notification with enriched content.
	 *
	 * Uses TWO delivery mechanisms to ensure both the agent and the TUI receive it:
	 * 1. pi.sendUserMessage(detailed) — delivers the full content to the LLM agent.
	 *    CustomMessage (pi.sendMessage) only renders in the TUI; the agent never sees it.
	 *    This was the root cause of the regression where notifications appeared in the
	 *    TUI but the agent did not react.
	 * 2. pi.sendMessage(customType: ghpr-monitor) — renders the concise summary in
	 *    the TUI via the registered message renderer.
	 */
	function sendPRNotification(concise: string, detailed: string, options?: { deliverAs?: "steer" | "followUp" }) {
		const delivery = NO_AGENT ? undefined : (options?.deliverAs ?? "steer");
		// Deliver detailed content to the agent via user message.
		// pi.sendUserMessage() creates a UserMessage that is injected into the
		// LLM conversation context, ensuring the coding agent can see and act on it.
		// This is the ONLY reliable way to deliver content to the agent;
		// pi.sendMessage() with customType only renders in the TUI.
		if (delivery) {
			pi.sendUserMessage(detailed, { deliverAs: delivery });
		}

		// Render the concise summary in the TUI via the custom message renderer.
		// The renderer extracts message.details.concise and shows the short version.
		pi.sendMessage({
			customType: "ghpr-monitor",
			content: detailed,
			display: true,
			details: { concise },
		});
	}

	// Track agent turn state to avoid spamming updates while LLM is working
	pi.on("turn_start", () => {
		agentTurnActive = true;
		for (const mon of monitors.values()) {
			mon.needsReminder = false;
		}
	});

	pi.on("turn_end", () => {
		agentTurnActive = false;
		// Flush queued update when turn ends (if any)
		if (queuedUpdate !== null) {
			const update = queuedUpdate;
			queuedUpdate = null;
			sendPRNotification(update, update, {deliverAs: "steer"});
			lastSentUpdate = update;
			// Mark all monitors that their reminders are superseded
			for (const mon of monitors.values()) {
				mon.lastSentReminder = null;
			}
		}
		// Flush queued force-check result when turn ends
		if (queuedForceCheck !== null) {
			const concMsg = queuedForceCheck;
			const detMsg = queuedForceCheckDetailed;
			queuedForceCheck = null;
			queuedForceCheckDetailed = null;
			sendPRNotification(concMsg, detMsg ?? concMsg, {deliverAs: "steer"});
			for (const mon of monitors.values()) {
				mon.lastNudgeTime = Date.now();
			}
		}
		// Schedule a reminder on next poll for each monitor with actionable items
		for (const mon of monitors.values()) {
			if (mon.lastStatus) {
				mon.needsReminder = true;
			}
		}
		// Wake all poll loops early so footers update
		for (const mon of monitors.values()) {
			if (mon.pollWakeResolve) {
				mon.pollWakeResolve();
				mon.pollWakeResolve = null;
			}
		}
	});

	// Clean up on session shutdown
	pi.on("session_shutdown", async () => {
		log("Session shutdown event received");
		stopAllMonitors();
		closeLogger();
	});

	// -----------------------------------------------------------------------
	// Monitor management
	// -----------------------------------------------------------------------

	function startMonitor(config: MonitorConfig): { key: string; message: string; alreadyMonitoring?: boolean } {
		log(`Starting monitor: ${config.owner}/${config.repo}#${config.number} (interval: ${config.intervalSec}s, mode: ${config.mode})`);
		const key = prKey(config);

		if (monitors.has(key)) {
			const existing = monitors.get(key)!;
			return {
				key,
				message: `Already monitoring https://${config.host}/${config.owner}/${config.repo}/pull/${config.number}. Use /ghpr-monitor off ${key} to stop.`,
				alreadyMonitoring: true,
			};
		}

		const mon = createActiveMonitor(config);
		monitors.set(key, mon);
		updateFooter();

		pollLoop(mon).catch((err) => {
			if (mon.controller.signal.aborted) return;
			pi.sendMessage({
				customType: "ghpr-monitor-error",
				content: `PR monitor error for ${key}: ${err instanceof Error ? err.message : String(err)}`,
				display: true,
			});
			monitors.delete(key);
			updateFooter();
		});

		return {
			key,
			message: `Started monitoring https://${config.host}/${config.owner}/${config.repo}/pull/${config.number} (interval: ${config.intervalSec}s, mode: ${config.mode})`,
		};
	}

	function stopMonitorByKey(key: string): string {
		log(`Stopping monitor: ${key}`);
		const mon = monitors.get(key);
		if (!mon) {
			return `Not monitoring ${key}`;
		}
		mon.controller.abort();
		mon.pollWakeResolve = null;
		const config = mon.config;
		monitors.delete(key);
		updateFooter();
		return `Stopped monitoring https://${config.host}/${config.owner}/${config.repo}/pull/${config.number}`;
	}

	function stopAllMonitors(): string {
		log("Stopping all monitors");
		if (monitors.size === 0) {
			return "No monitors running";
		}
		const keys = [...monitors.keys()];
		for (const [key, mon] of monitors) {
			mon.controller.abort();
			mon.pollWakeResolve = null;
		}
		monitors.clear();
		updateFooter();
		return `Stopped monitoring ${keys.length} PR(s): ${keys.join(", ")}`;
	}

	function updateFooter() {
		if (!uiCtx) return;
		if (monitors.size === 0) {
			uiCtx.setStatus("ghpr-monitor", undefined);
			return;
		}

		if (monitors.size === 1) {
			const mon = monitors.values().next().value!;
			uiCtx.setStatus("ghpr-monitor", formatFooterStatus(mon.config, mon.lastStatus));
			return;
		}

		// Multiple monitors: aggregate summary
		let issuesCount = 0;
		let clearCount = 0;
		for (const mon of monitors.values()) {
			if (mon.lastStatus && (
				mon.lastStatus.hasConflicts ||
				mon.lastStatus.unresolvedThreads > 0 ||
				mon.lastStatus.generalComments > 0 ||
				mon.lastStatus.failingChecks.length > 0
			)) {
				issuesCount++;
			} else {
				clearCount++;
			}
		}

		const parts: string[] = [];
		if (issuesCount > 0) parts.push(`${issuesCount} with issues`);
		if (clearCount > 0) parts.push(`${clearCount} clear`);
		uiCtx.setStatus("ghpr-monitor", `📡 ${monitors.size} PRs: ${parts.join(", ")}`);
	}

	async function pollLoop(mon: ActiveMonitor): Promise<void> {
		const { config, controller } = mon;
		const signal = controller.signal;

		// Initial check
		const initialMsg = `📡 Monitoring ${config.owner}/${config.repo}#${config.number}... (polling every ${config.intervalSec}s)`;
		pi.sendMessage({
			customType: "ghpr-monitor",
			content: initialMsg,
			display: true,
			details: { action: "start", owner: config.owner, repo: config.repo, number: config.number },
		});

		for (;;) {
			if (signal.aborted) return;

			try {
				const pr = await fetchPRData(config, signal, mockBaseUrl);
				log(`Fetched PR data for ${config.owner}/${config.repo}#${config.number}`);
				logPRSnapshot(pr);

				// Check if PR was merged or closed
				if (pr.state === "MERGED" || pr.state === "CLOSED") {
					const prUrl = `https://${config.host}/${config.owner}/${config.repo}/pull/${config.number}`;
					const reason = pr.merged ? "merged" : "closed";
					const msg = `${pr.merged ? "🔀" : "❌"} PR ${prUrl} was ${reason}. Monitoring stopped.`;
					sendPRNotification(msg, msg, {deliverAs: "steer"});
					const key = prKey(config);
					monitors.delete(key);
					updateFooter();
					return;
				}

				const curr = snapshotPR(pr);
				const update = formatStatusUpdate(mon.lastStatus, curr, config);
				const hadChange = update.length > 0;
				let updateSentThisCycle = false;

				if (update) {
					if (agentTurnActive) {
						// Don't spam the LLM while it's working - queue for later
						queuedUpdate = update;
					} else if (update !== lastSentUpdate) {
						// Only send if something changed since last update
						const { concise: concUpdate, detailed: detUpdate } = formatAgentStatusUpdate(mon.lastStatus, curr, config); sendPRNotification(concUpdate, detUpdate, {deliverAs: "steer"});
						lastSentUpdate = update;
						mon.lastSentUpdate = update;
						mon.lastSentReminder = null; // real update supersedes any prior reminder
						mon.lastNudgeTime = Date.now();
						updateSentThisCycle = true;
					}
				}

				// If agent just went idle and actionable items remain, send a reminder
				// — but skip if a status update was already sent this cycle to avoid
				//   duplicate content (e.g. first-poll overlap when lastStatus is null)
				if (!updateSentThisCycle && mon.needsReminder && !agentTurnActive) {
					const reminder = formatActionableItems(curr, config);
					if (reminder && reminder !== mon.lastSentReminder) {
						const detReminder = formatAgentNotification(curr, config); sendPRNotification(reminder, detReminder?.detailed ?? reminder, {deliverAs: "steer"});
						mon.lastSentReminder = reminder;
						mon.lastNudgeTime = Date.now();
					}
					mon.needsReminder = false;
				}

				// Force-check
				if (mon.forceNotify && !agentTurnActive) {
					const prUrl = `https://${config.host}/${config.owner}/${config.repo}/pull/${config.number}`;
					const items = formatActionableItems(curr, config);
					const detItems = formatAgentNotification(curr, config);
					const msg = items ?? `\u2705 No issues found on ${prUrl}`;
					const detMsg = detItems?.detailed ?? `\u2705 No issues found on ${prUrl}`;
					if (agentTurnActive) {
						queuedForceCheck = msg;
						queuedForceCheckDetailed = detMsg;
					} else {
						sendPRNotification(msg, detMsg, {deliverAs: "steer"});
					}
					mon.lastSentReminder = items;
					mon.lastNudgeTime = Date.now();
					mon.forceNotify = false;
				}

				// Periodic nudge
				if (
					!agentTurnActive &&
					!mon.needsReminder &&
					mon.lastNudgeTime > 0 &&
					Date.now() - mon.lastNudgeTime >= NUDGE_COOLDOWN_MS
				) {
					const nudge = formatActionableItems(curr, config);
					const detNudge = formatAgentNotification(curr, config);
					if (nudge) {
						sendPRNotification(nudge, detNudge?.detailed ?? nudge, {deliverAs: "steer"});
						mon.lastSentReminder = nudge;
						mon.lastNudgeTime = Date.now();
					}
				}

				mon.lastStatus = curr;
				mon.lastStatusTimestamp = new Date();
				mon.backoffSec = 0;
				updateFooter();
				if (hadChange) {
					mon.consecutiveNoChange = 0;
				} else {
					mon.consecutiveNoChange++;
				}
			} catch (err) {
				if (signal.aborted) return;
				const errMsg = err instanceof Error ? err.message : String(err);
				const isRateLimit = /rate limit/i.test(errMsg);
				mon.backoffSec = mon.backoffSec === 0
					? config.intervalSec
					: Math.min(mon.backoffSec * 2, MAX_BACKOFF_SEC);
				pi.sendMessage({
					customType: "ghpr-monitor-error",
					content: isRateLimit
						? `Rate limited on ${config.owner}/${config.repo}#${config.number}, backing off ${mon.backoffSec}s`
						: `Poll error for ${config.owner}/${config.repo}#${config.number}: ${errMsg}${mon.backoffSec > config.intervalSec ? ` (retrying in ${mon.backoffSec}s)` : ""}`,
					display: true,
				});
			}

			// Wait for interval (abortable), with backoff after any error
			const baseSec = mon.backoffSec > 0 ? mon.backoffSec : config.intervalSec;
			const idleSec = mon.consecutiveNoChange > 3
				? Math.min(config.intervalSec * Math.pow(2, mon.consecutiveNoChange - 3), MAX_IDLE_SEC)
				: baseSec;
			const waitSec = agentTurnActive ? Math.max(idleSec, 300) : idleSec;
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

	// Format the current monitor status for display
	function formatCurrentStatus(): string {
		if (monitors.size === 0) return "";
		const lines: string[] = [];
		for (const mon of monitors.values()) {
			const c = mon.config;
			const header = `Monitoring https://${c.host}/${c.owner}/${c.repo}/pull/${c.number} (mode: ${c.mode}, interval: ${c.intervalSec}s)`;
			if (!mon.lastStatus) {
				lines.push(`${header}\n  No status update received yet.`);
			} else {
				const ts = mon.lastStatusTimestamp ? mon.lastStatusTimestamp.toLocaleString() : "unknown";
				const status = formatActionableItems(mon.lastStatus, c);
				if (status) {
					lines.push(`${header}\n  ${status.replace(/\n/g, "\n  ")}\n  Last checked: ${ts}`);
				} else {
					lines.push(`${header}\n  ✨ No issues, all clear (last checked: ${ts})`);
				}
			}
		}
		return lines.join("\n\n");
	}

	// -----------------------------------------------------------------------
	// Register the /ghpr-monitor command
	// -----------------------------------------------------------------------

	pi.registerCommand("ghpr-monitor", {
		description: "Monitor PRs: /ghpr-monitor [PR URL] [message] — /ghpr-monitor check [PR] — /ghpr-monitor off [PR] — leave blank to let the agent figure it out",
		getArgumentCompletions: (prefix: string) => {
			const completions = ["on", "off", "stop", "check", "https://github.com"];
			// Add currently monitored PRs as completions for off/check
			for (const key of monitors.keys()) {
				completions.push(key);
			}
			return completions.filter((c) => c.startsWith(prefix)).map((c) => ({ value: c, label: c }));
		},
		handler: async (args, ctx) => {
			uiCtx = ctx.ui;
			const raw = args.trim();

			// Parse: off [PR identifier]
			if (raw.toLowerCase().startsWith("off") || raw.toLowerCase().startsWith("stop")) {
				const rest = raw.replace(/^(off|stop)\s*/i, "").trim();
				if (!rest) {
					const msg = stopAllMonitors();
					ctx.ui.notify(msg, "info");
					return;
				}
				// Try to identify a specific PR
				const targetKey = resolveMonitorKey(rest);
				if (targetKey) {
					const msg = stopMonitorByKey(targetKey);
					ctx.ui.notify(msg, "info");
				} else {
					ctx.ui.notify(`Unknown PR: ${rest}. Currently monitoring: ${[...monitors.keys()].join(", ") || "none"}`, "warning");
				}
				return;
			}

			// Parse: check [PR identifier]
			if (raw.toLowerCase() === "check" || raw.toLowerCase().startsWith("check ")) {
				const rest = raw.replace(/^check\s*/i, "").trim();
				if (monitors.size === 0) {
					ctx.ui.notify("No monitors running. Start one first with /ghpr-monitor <PR URL>", "warning");
					return;
				}
				if (!rest) {
					// Check all monitors
					for (const mon of monitors.values()) {
						mon.backoffSec = 0;
						mon.consecutiveNoChange = 0;
						mon.forceNotify = true;
						if (mon.pollWakeResolve) {
							mon.pollWakeResolve();
							mon.pollWakeResolve = null;
						}
					}
					ctx.ui.notify(`Checking all ${monitors.size} monitor(s)...`, "info");
				} else {
					const targetKey = resolveMonitorKey(rest);
					if (targetKey && monitors.has(targetKey)) {
						const mon = monitors.get(targetKey)!;
						mon.backoffSec = 0;
						mon.consecutiveNoChange = 0;
						mon.forceNotify = true;
						if (mon.pollWakeResolve) {
							mon.pollWakeResolve();
							mon.pollWakeResolve = null;
						}
						ctx.ui.notify(`Checking ${targetKey} now...`, "info");
					} else {
						ctx.ui.notify(`Unknown PR: ${rest}. Currently monitoring: ${[...monitors.keys()].join(", ")}`, "warning");
					}
				}
				return;
			}

			if (raw.toLowerCase() === "on" || raw === "") {
				if (monitors.size > 0) {
					const statusText = formatCurrentStatus();
					ctx.ui.notify(statusText, "info");
					return;
				}
				pi.sendUserMessage(
					"The user wants to start PR monitoring but didn't provide a PR URL. Please invoke the ghpr-monitor tool with action='start' and the appropriate parameters (url, or owner+repo+pr_number) based on the PR you have been working on.",
					{ deliverAs: "steer" },
				);
				return;
			}

			// Try parsing as a PR URL first
			const parsed = parsePRUrl(raw);
			if (parsed) {
				const urlMatch = raw.trim().match(PR_URL_RE);
				const afterUrl = urlMatch ? raw.trim().slice(urlMatch[0].length).trim() : "";
				const steerMessage = afterUrl && !/^[\/?#]/.test(afterUrl) ? afterUrl : undefined;

				const config: MonitorConfig = {
					owner: parsed.owner,
					repo: parsed.repo,
					number: parsed.number,
					host: parsed.host,
					mode: "all",
					intervalSec: MOCK_INTERVAL_SECS ? Math.max(1, MOCK_INTERVAL_SECS) : 60,
					debounceSec: 30,
				};
				const result = startMonitor(config);
				if (result.alreadyMonitoring) {
					ctx.ui.notify(result.message, "warning");
				} else {
					ctx.ui.notify(result.message, "success");
				}
				if (steerMessage) {
					pi.sendUserMessage(steerMessage, NO_AGENT ? {} : { deliverAs: "steer" });
				}
				return;
			}

			// Try parsing as "owner/repo#number"
			const shorthand = parsePRShorthand(raw);
			if (shorthand) {
				const config: MonitorConfig = {
					owner: shorthand.owner,
					repo: shorthand.repo,
					number: shorthand.number,
					host: shorthand.host,
					mode: "all",
					intervalSec: MOCK_INTERVAL_SECS ? Math.max(1, MOCK_INTERVAL_SECS) : 60,
					debounceSec: 30,
				};
				const result = startMonitor(config);
				if (result.alreadyMonitoring) {
					ctx.ui.notify(result.message, "warning");
				} else {
					ctx.ui.notify(result.message, "success");
				}
				return;
			}

			// Try parsing as "owner/repo number [message]"
			const parts = raw.split(/\s+/);
			if (parts.length >= 2 && parts[0].includes("/")) {
				const [ownerRepo, numStr] = [parts[0], parts[1]];
				const [owner, repo] = ownerRepo.split("/");
				const number = parseInt(numStr, 10);
				if (!owner || !repo || isNaN(number)) {
					ctx.ui.notify("Invalid format. Use: /ghpr-monitor owner/repo#123 or owner/repo <pr-number> [message]", "error");
					return;
				}
				const steerMessage = parts.length > 2 ? parts.slice(2).join(" ") : undefined;
				const config: MonitorConfig = {
					owner,
					repo,
					number,
					host: "github.com",
					mode: "all",
					intervalSec: MOCK_INTERVAL_SECS ? Math.max(1, MOCK_INTERVAL_SECS) : 60,
					debounceSec: 30,
				};
				const result = startMonitor(config);
				if (result.alreadyMonitoring) {
					ctx.ui.notify(result.message, "warning");
				} else {
					ctx.ui.notify(result.message, "success");
				}
				if (steerMessage) {
					pi.sendUserMessage(steerMessage, NO_AGENT ? {} : { deliverAs: "steer" });
				}
				return;
			}

			ctx.ui.notify(
				"Usage:\n  /ghpr-monitor <PR URL> [message] — paste a GH PR URL\n  /ghpr-monitor owner/repo#123\n  /ghpr-monitor owner/repo <pr-number> [message]\n  /ghpr-monitor check [PR] — check now (all or specific)\n  /ghpr-monitor off [PR] — stop monitoring (all or specific)",
				"info",
			);
		},
	});

	// -----------------------------------------------------------------------
	// Helper: resolve a user-supplied string to an existing monitor key
	// -----------------------------------------------------------------------

	function resolveMonitorKey(input: string): string | null {
		const trimmed = input.trim();

		// Direct key match (e.g. "owner/repo#123")
		if (monitors.has(trimmed)) return trimmed;

		// Try parsing as PR URL
		const parsed = parsePRUrl(trimmed) || parsePRShorthand(trimmed);
		if (parsed) {
			const key = prKey(parsed.owner, parsed.repo, parsed.number, parsed.host);
			if (monitors.has(key)) return key;
		}

		// Try partial match (e.g. just the number)
		for (const key of monitors.keys()) {
			if (key.endsWith(`#${trimmed}`) || key === trimmed) return key;
		}

		return null;
	}

	// -----------------------------------------------------------------------
	// Register the ghpr-monitor tool (LLM-callable)
	// -----------------------------------------------------------------------

	const GhprMonitorParams = Type.Object({
		action: StringEnum(["start", "status", "check", "stop"] as const, {
			description: "Action: start monitoring, check current status, trigger an immediate poll, or stop monitoring a specific PR",
		}),
		url: Type.Optional(Type.String({ description: "GitHub PR URL (e.g. https://github.com/owner/repo/pull/123) or shorthand (e.g. owner/repo#123). Alternative to owner+repo+pr_number." })),
		owner: Type.Optional(Type.String({ description: "Repository owner (e.g. 'v2nic')" })),
		repo: Type.Optional(Type.String({ description: "Repository name (e.g. 'gh-pr-review')" })),
		pr_number: Type.Optional(Type.Number({ description: "Pull request number" })),
		mode: Type.Optional(
			StringEnum(["all", "comments", "conflicts", "actions"] as const, {
				description: "What to watch for (default: all)",
			}),
		),
		interval: Type.Optional(Type.Number({ description: "Polling interval in seconds (default: 60, minimum: 10)" })),
	});

	pi.registerTool({
		name: "ghpr-monitor",
		label: "GH PR Monitor",
		description:
			"Monitor GitHub pull requests for comments, conflicts, and CI status changes. Supports monitoring multiple PRs simultaneously. Use action='start' with a 'url' (GitHub PR URL) or with owner+repo+pr_number to begin monitoring. Use action='status' to list all currently monitored PRs. Use action='check' to trigger an immediate poll. Use action='stop' with url or owner+repo+pr_number to stop monitoring a specific PR. Use /ghpr-monitor off to stop all monitors.",
		promptSnippet: "Monitor GitHub PRs for changes (comments, conflicts, CI failures)",
		promptGuidelines: [
			"When the user asks you to watch or monitor a PR, use ghpr-monitor with action='start'.",
			"Multiple PRs can be monitored at the same time — start a new monitor without stopping existing ones.",
			"Accept a GitHub PR URL, shorthand like 'owner/repo#123', or separate owner/repo/pr_number.",
			"Use action='status' to see all currently monitored PRs.",
			"Use action='stop' with url/owner/repo/pr_number to stop a specific PR monitor.",
			"Monitoring runs until stopped via action='stop', /ghpr-monitor off, or the PR is merged/closed.",
			"The user can run /ghpr-monitor check to trigger an immediate poll.",
			"You will receive PR status updates as notifications.",
		],
		parameters: GhprMonitorParams,

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			uiCtx = _ctx.ui;

			// Helper: resolve PR identity from url or explicit params
			function resolvePR(): { owner: string; repo: string; number: number; host: string } | { error: string } {
				let resolvedOwner: string | undefined;
				let resolvedRepo: string | undefined;
				let resolvedNumber: number | undefined;
				let resolvedHost = "github.com";

				if (params.url) {
					const parsed = parsePRUrl(params.url) || parsePRShorthand(params.url);
					if (!parsed) {
						return { error: `Invalid PR URL or shorthand: ${params.url}. Expected format: https://github.com/owner/repo/pull/123 or owner/repo#123` };
					}
					resolvedOwner = parsed.owner;
					resolvedRepo = parsed.repo;
					resolvedNumber = parsed.number;
					resolvedHost = parsed.host;
				} else {
					resolvedOwner = params.owner;
					resolvedRepo = params.repo;
					resolvedNumber = params.pr_number;
				}

				if (!resolvedOwner || !resolvedRepo || !resolvedNumber) {
					return {
						error: [
							"Missing required parameters.",
							"",
							"Usage:",
							"  ghpr-monitor(action='start', url='https://github.com/owner/repo/pull/123')",
							"  ghpr-monitor(action='start', url='owner/repo#123')",
							"  ghpr-monitor(action='start', owner='v2nic', repo='gh-pr-review', pr_number=42)",
							"  ghpr-monitor(action='stop', url='owner/repo#123')",
							"  ghpr-monitor(action='status') — list all monitored PRs",
						].join("\n"),
					};
				}

				return { owner: resolvedOwner, repo: resolvedRepo, number: resolvedNumber, host: resolvedHost };
			}

			switch (params.action) {
				case "start": {
					const resolved = resolvePR();
					if ("error" in resolved) {
						return {
							content: [{ type: "text", text: resolved.error }],
							details: { action: "start", status: "missing_params" },
						};
					}

					const config: MonitorConfig = {
						owner: resolved.owner,
						repo: resolved.repo,
						number: resolved.number,
						host: resolved.host,
						mode: params.mode || "all",
						intervalSec: MOCK_INTERVAL_SECS ? Math.max(1, MOCK_INTERVAL_SECS) : Math.max(10, params.interval || 60),
						debounceSec: 30,
					};

					const result = startMonitor(config);
					return {
						content: [{ type: "text", text: result.message }],
						details: {
							action: "start",
							status: result.alreadyMonitoring ? "already_running" : "started",
							config,
							activeMonitors: monitors.size,
						},
					};
				}

				case "status": {
					if (monitors.size === 0) {
						return {
							content: [{ type: "text", text: "No PR monitors are currently active." }],
							details: { action: "status", status: "idle", activeMonitors: 0 },
						};
					}

					const lines: string[] = [`Monitoring ${monitors.size} PR(s):`];
					for (const [key, mon] of monitors) {
						const c = mon.config;
						const ts = mon.lastStatusTimestamp ? mon.lastStatusTimestamp.toLocaleString() : "unknown";
						if (mon.lastStatus) {
							const statusLine = `${key}: ${mon.lastStatus.unresolvedThreads} unresolved threads, ${mon.lastStatus.generalComments} comments, conflicts: ${mon.lastStatus.hasConflicts}, failing: ${mon.lastStatus.failingChecks.join(", ") || "none"} (last checked: ${ts})`;
							lines.push(statusLine);
						} else {
							lines.push(`${key}: No status update received yet.`);
						}
					}

					return {
						content: [{ type: "text", text: lines.join("\n") }],
						details: {
							action: "status",
							status: "running",
							activeMonitors: monitors.size,
							monitors: [...monitors.entries()].map(([key, mon]) => ({
								key,
								config: mon.config,
								lastStatus: mon.lastStatus,
								lastStatusTimestamp: mon.lastStatusTimestamp,
							})),
						},
					};
				}

				case "check": {
					if (monitors.size === 0) {
						return {
							content: [{ type: "text", text: "No monitors are currently active. Start one first with action='start'." }],
							details: { action: "check", status: "idle" },
						};
					}

					// If a specific PR is specified, only check that one
					if (params.url || params.owner) {
						const resolved = resolvePR();
						if ("error" in resolved) {
							return {
								content: [{ type: "text", text: resolved.error }],
								details: { action: "check", status: "missing_params" },
							};
						}
						const key = prKey(resolved.owner, resolved.repo, resolved.number, resolved.host);
						const mon = monitors.get(key);
						if (!mon) {
							return {
								content: [{ type: "text", text: `Not monitoring ${key}. Currently monitoring: ${[...monitors.keys()].join(", ")}` }],
								details: { action: "check", status: "not_found" },
							};
						}
						mon.backoffSec = 0;
						mon.consecutiveNoChange = 0;
						mon.forceNotify = true;
						if (mon.pollWakeResolve) {
							mon.pollWakeResolve();
							mon.pollWakeResolve = null;
						}
						return {
							content: [{ type: "text", text: `Checking ${key} now...` }],
							details: { action: "check", status: "triggered", config: mon.config },
						};
					}

					// Check all monitors
					for (const mon of monitors.values()) {
						mon.backoffSec = 0;
						mon.consecutiveNoChange = 0;
						mon.forceNotify = true;
						if (mon.pollWakeResolve) {
							mon.pollWakeResolve();
							mon.pollWakeResolve = null;
						}
					}
					return {
						content: [{ type: "text", text: `Checking all ${monitors.size} monitor(s)...` }],
						details: { action: "check", status: "triggered_all", activeMonitors: monitors.size },
					};
				}

				case "stop": {
					const resolved = resolvePR();
					if ("error" in resolved) {
						return {
							content: [{ type: "text", text: resolved.error }],
							details: { action: "stop", status: "missing_params" },
						};
					}
					const key = prKey(resolved.owner, resolved.repo, resolved.number, resolved.host);
					if (!monitors.has(key)) {
						const currentlyMonitoring = [...monitors.keys()];
						return {
							content: [{ type: "text", text: `Not monitoring ${key}. Currently monitoring: ${currentlyMonitoring.join(", ") || "none"}` }],
							details: { action: "stop", status: "not_found", currentlyMonitoring },
						};
					}
					const msg = stopMonitorByKey(key);
					return {
						content: [{ type: "text", text: msg }],
						details: { action: "stop", status: "stopped", key, remainingMonitors: monitors.size },
					};
				}

				default:
					return {
						content: [{ type: "text", text: `Unknown action: ${params.action}` }],
						details: { action: params.action, status: "unknown" },
					};
			}
		},
	});
}