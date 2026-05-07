/**
 * pi-ghpr-monitor — Pi extension for monitoring GitHub PRs
 *
 * Registers:
 *   /ghpr-monitor [on|off|owner/repo#number|check]  — user-facing command (no args = ask agent)
 *   ghpr-monitor                                 — LLM-callable tool
 *
 * The tool polls a PR for comments, conflicts, and CI status, then
 * injects notifications into the agent session so the LLM can take action.
 */

import type { ExtensionAPI, ExtensionUIContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import * as path from "node:path";
import {
	type PullRequestData,
	type PRStatus,
	type MonitorConfig,
	snapshotPR,
	formatActionableItems,
	formatStatusUpdate,
	formatFooterStatus,
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
            nodes { id body author { login } createdAt reactions(content: THUMBS_UP, first: 1) { nodes { content } } }
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
		lastThreadComments: 1,
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

interface ParsedPR {
	owner: string;
	repo: string;
	number: number;
	host: string;
}

function parsePRUrl(input: string): ParsedPR | null {
	const m = input.trim().match(PR_URL_RE);
	if (!m) return null;
	const host = m[1] === "github.com" ? "github.com" : m[1];
	return { owner: m[2], repo: m[3], number: parseInt(m[4], 10), host };
}

/** Parse shorthand formats like "owner/repo#123" */
function parsePRShorthand(input: string): ParsedPR | null {
	// Try "owner/repo#number" (e.g. "mobilityhouse/vgi-na-masscec#373")
	const hashM = input.trim().match(/^([^\s#/]+)\/([^#]+)#([0-9]+)$/);
	if (hashM) {
		return { owner: hashM[1], repo: hashM[2], number: parseInt(hashM[3], 10), host: "github.com" };
	}
	return null;
}

// ---------------------------------------------------------------------------
// Monitor state management
// ---------------------------------------------------------------------------

type MonitorState =
	| { status: "idle" }
	| { status: "running"; config: MonitorConfig; controller: AbortController }
	| { status: "stopped" };

// ---------------------------------------------------------------------------
// Main extension
// ---------------------------------------------------------------------------

export default function ghprMonitorExtension(pi: ExtensionAPI) {
	let monitorState: MonitorState = { status: "idle" };
	let lastStatus: PRStatus | null = null;
	let lastStatusTimestamp: Date | null = null;
	let agentTurnActive = false;
	let queuedUpdate: string | null = null;
	let queuedForceCheck: string | null = null;
	let lastSentUpdate: string | null = null;
	let lastSentReminder: string | null = null;
	let needsReminder = false;
	let forceNotify = false;
	let backoffSec = 0;
	let consecutiveNoChange = 0;
	let lastNudgeTime = 0; // epoch ms of last nudge sent (update or reminder)
	const NUDGE_COOLDOWN_MS = 3 * 60 * 1000; // 3 minutes between nudges for idle agent
	let uiCtx: ExtensionUIContext | undefined;
	let pollWakeResolve: (() => void) | null = null;
	const MAX_BACKOFF_SEC = 300; // 5 minutes max rate-limit backoff
	const MAX_IDLE_SEC = 3600; // 1 hour max idle polling

	// For testing: allows pointing at a mock server
	let mockBaseUrl: string | undefined;

	const STEERING_PROMPT = `You have access to the ghpr-monitor tool. When the user asks you to watch or monitor a PR, use ghpr-monitor with action "start" to begin monitoring. The tool has actions: start and status. Monitoring continues until the user stops it with /ghpr-monitor off. The user can also run /ghpr-monitor check to trigger an immediate poll. You will receive PR status updates as notifications. The url parameter accepts GitHub PR URLs or shorthand like "owner/repo#123".`;

	// Inject steering prompt when monitor is idle (so the LLM knows about the tool)
	pi.on("before_agent_start", async (event, _ctx) => {
		// Always inject steering prompt so the LLM knows the tool exists
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

	// Track agent turn state to avoid spamming updates while LLM is working
	pi.on("turn_start", () => {
		agentTurnActive = true;
		needsReminder = false;
	});

	pi.on("turn_end", () => {
		agentTurnActive = false;
		// Flush queued update when turn ends (if any)
		if (queuedUpdate !== null) {
			const update = queuedUpdate;
			queuedUpdate = null;
		pi.sendUserMessage(update, {deliverAs: "steer"});
			lastSentUpdate = update;
			lastSentReminder = null; // real update supersedes any prior reminder
			lastNudgeTime = Date.now();
		}
		// Flush queued force-check result when turn ends
		if (queuedForceCheck !== null) {
			const msg = queuedForceCheck;
			queuedForceCheck = null;
			pi.sendUserMessage(msg, {deliverAs: "steer"});
			lastNudgeTime = Date.now();
		}
		// Schedule a reminder on next poll if actionable items remain
		if (monitorState.status === "running" && lastStatus) {
			needsReminder = true;
		}
		// Wake the poll loop early so the footer updates with latest state
		if (pollWakeResolve) {
			pollWakeResolve();
			pollWakeResolve = null;
		}
	});

	// Clean up on session shutdown
	pi.on("session_shutdown", async () => {
		log("Session shutdown event received");
		stopMonitor();
		closeLogger();
	});

	function startMonitor(config: MonitorConfig): string {
		log(`Starting monitor: ${config.owner}/${config.repo}#${config.number} (interval: ${config.intervalSec}s, mode: ${config.mode})`);
		stopMonitor();

		const controller = new AbortController();
		monitorState = { status: "running", config, controller };
		lastStatus = null;
		lastStatusTimestamp = null;
		lastSentUpdate = null;
		lastSentReminder = null;
		lastNudgeTime = 0;
		updateFooter();

		pollLoop(config, controller.signal).catch((err) => {
			if (controller.signal.aborted) return;
			pi.sendMessage({
				customType: "ghpr-monitor-error",
				content: `PR monitor error: ${err instanceof Error ? err.message : String(err)}`,
				display: true,
			});
			monitorState = { status: "idle" };
			lastStatus = null;
			lastStatusTimestamp = null;
			lastSentUpdate = null;
			lastSentReminder = null;
			lastNudgeTime = 0;
			needsReminder = false;
			forceNotify = false;
			queuedForceCheck = null;
			consecutiveNoChange = 0;
			updateFooter();
		});

		return `Started monitoring https://${config.host}/${config.owner}/${config.repo}/pull/${config.number} (interval: ${config.intervalSec}s, mode: ${config.mode})`;
	}

	function updateFooter() {
		if (!uiCtx) return;
		if (monitorState.status === "running") {
			uiCtx.setStatus("ghpr-monitor", formatFooterStatus(monitorState.config, lastStatus));
		} else {
			uiCtx.setStatus("ghpr-monitor", undefined);
		}
	}

	function stopMonitor(): string {
		log("Stopping monitor");
		if (monitorState.status === "running") {
			monitorState.controller.abort();
			pollWakeResolve = null;
			const config = monitorState.config;
			monitorState = { status: "idle" };
			lastStatus = null;
			lastStatusTimestamp = null;
			lastSentUpdate = null;
			lastSentReminder = null;
			lastNudgeTime = 0;
			needsReminder = false;
			forceNotify = false;
			queuedForceCheck = null;
			consecutiveNoChange = 0;
			updateFooter();
			return `Stopped monitoring https://${config.host}/${config.owner}/${config.repo}/pull/${config.number}`;
		}
		monitorState = { status: "idle" };
		lastStatus = null;
		lastStatusTimestamp = null;
		lastSentUpdate = null;
		lastSentReminder = null;
		lastNudgeTime = 0;
		needsReminder = false;
		forceNotify = false;
		queuedForceCheck = null;
		consecutiveNoChange = 0;
		updateFooter();
		return "No monitor running";
	}

	async function pollLoop(config: MonitorConfig, signal: AbortSignal): Promise<void> {
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
					pi.sendUserMessage(msg, {deliverAs: "steer"});
					stopMonitor();
					return;
				}

				const curr = snapshotPR(pr);
				logStatus(curr);
				const update = formatStatusUpdate(lastStatus, curr, config);
				const hadChange = update.length > 0;

				if (update) {
					if (agentTurnActive) {
						// Don't spam the LLM while it's working - queue for later
						queuedUpdate = update;
					} else if (update !== lastSentUpdate) {
						// Only send if something changed since last update
						pi.sendUserMessage(update, {deliverAs: "steer"});
						lastSentUpdate = update;
						lastSentReminder = null; // real update supersedes any prior reminder
						lastNudgeTime = Date.now();
					}
				}

				// If agent just went idle and actionable items remain, send a reminder
				// Only send if the reminder content differs from the last one sent
				// to avoid spamming the agent with identical reminders during active work
				if (needsReminder && !agentTurnActive) {
					const reminder = formatActionableItems(curr, config);
					if (reminder && reminder !== lastSentReminder) {
						pi.sendUserMessage(reminder, {deliverAs: "steer"});
						lastSentReminder = reminder;
						lastNudgeTime = Date.now();
					}
					needsReminder = false;
				}

				// Force-check: always send current state (triggered by /ghpr-monitor check or tool check action)
				// Unlike automatic updates, force-checks are user-initiated and should always be delivered.
				// When the agent turn is active, queue the result to be flushed on turn_end.
				if (forceNotify) {
					const prUrl = `https://${config.host}/${config.owner}/${config.repo}/pull/${config.number}`;
					const items = formatActionableItems(curr, config);
					const msg = items ?? `\u2705 No issues found on ${prUrl}`;
					if (agentTurnActive) {
						queuedForceCheck = msg;
						log("Force-check queued (agent active)");
					} else {
						log(`Force-check result: ${items ? 'issues found' : 'no issues'} for ${prUrl}`);
						pi.sendUserMessage(msg, {deliverAs: "steer"});
						lastSentReminder = items;
						lastNudgeTime = Date.now();
					}
					forceNotify = false;
				}

				// Periodic nudge: if the agent has been idle for a while with
				// unresolved actionable items and nothing else triggered a notification,
				// send a nudge to keep the agent from forgetting about them.
				if (
					!agentTurnActive &&
					!needsReminder &&
					lastNudgeTime > 0 &&
					Date.now() - lastNudgeTime >= NUDGE_COOLDOWN_MS
				) {
					const nudge = formatActionableItems(curr, config);
					if (nudge) {
						pi.sendUserMessage(nudge, {deliverAs: "steer"});
						lastSentReminder = nudge;
						lastNudgeTime = Date.now();
					}
				}

				lastStatus = curr;
				lastStatusTimestamp = new Date();
				backoffSec = 0;
				updateFooter();
				if (hadChange) {
					consecutiveNoChange = 0;
				} else {
					consecutiveNoChange++;
				}
			} catch (err) {
				if (signal.aborted) return;
				const errMsg = err instanceof Error ? err.message : String(err);
				log(`Poll error: ${errMsg}`);
				const isRateLimit = /rate limit/i.test(errMsg);
				// Exponential backoff for ALL errors (rate limits, connection failures, etc.)
				backoffSec = backoffSec === 0
					? config.intervalSec
					: Math.min(backoffSec * 2, MAX_BACKOFF_SEC);
				pi.sendMessage({
					customType: "ghpr-monitor-error",
					content: isRateLimit
						? `Rate limited, backing off ${backoffSec}s`
						: `Poll error for ${config.owner}/${config.repo}#${config.number}: ${errMsg}${backoffSec > config.intervalSec ? ` (retrying in ${backoffSec}s)` : ""}`,
					display: true,
				});
			}

			// Wait for interval (abortable), with backoff after any error
			// Slow polling during active turns — no need to poll frequently while the LLM works
			const baseSec = backoffSec > 0 ? backoffSec : config.intervalSec;
			// After 3 consecutive no-change polls, double interval each time up to 1 hour
			const idleSec = consecutiveNoChange > 3
				? Math.min(config.intervalSec * Math.pow(2, consecutiveNoChange - 3), MAX_IDLE_SEC)
				: baseSec;
			const waitSec = agentTurnActive ? Math.max(idleSec, 300) : idleSec;
			await new Promise<void>((resolve) => {
				pollWakeResolve = resolve;
				const timer = setTimeout(() => {
					pollWakeResolve = null;
					resolve();
				}, waitSec * 1000);
				signal.addEventListener(
					"abort",
					() => {
						clearTimeout(timer);
						pollWakeResolve = null;
						resolve();
					},
					{ once: true },
				);
			});

			if (signal.aborted) return;
		}
	}

	// Format the current monitor status for display alongside usage
	function formatCurrentStatus(): string {
		if (monitorState.status !== "running") return "";
		const c = monitorState.config;
		const header = `Monitoring https://${c.host}/${c.owner}/${c.repo}/pull/${c.number} (mode: ${c.mode}, interval: ${c.intervalSec}s)`;
		if (!lastStatus) {
			return `${header}\nNo status update received yet.`;
		}
		const ts = lastStatusTimestamp ? lastStatusTimestamp.toLocaleString() : "unknown";
		const status = formatActionableItems(lastStatus, c);
		if (status) {
			return `${header}\n${status}\nLast checked: ${ts}`;
		}
		return `${header}\n✨ No issues, all clear (last checked: ${ts})`;
	}

	// -----------------------------------------------------------------------
	// Register the /ghpr-monitor command
	// -----------------------------------------------------------------------

	pi.registerCommand("ghpr-monitor", {
		description: "Monitor a PR: /ghpr-monitor [PR URL] [message] — leave blank to let the agent figure it out, /ghpr-monitor check — check now, /ghpr-monitor debug — toggle debug logging, /ghpr-monitor off — stop",
		getArgumentCompletions: (prefix: string) => {
			const completions = ["on", "off", "stop", "check", "debug", "https://github.com"];
			return completions.filter((c) => c.startsWith(prefix)).map((c) => ({ value: c, label: c }));
		},
		handler: async (args, ctx) => {
			uiCtx = ctx.ui;
			const raw = args.trim();
			const lower = raw.toLowerCase();

			if (lower === "off" || lower === "stop") {
				const msg = stopMonitor();
				ctx.ui.notify(msg, "info");
				return;
			}

			if (lower === "debug" || lower === "debug on") {
				const logFilePath = enableDebug();
				ctx.ui.notify(`Debug logging enabled: ${logFilePath}`, "info");
				return;
			}

			if (lower === "debug off") {
				const formerPath = disableDebug();
				if (formerPath) {
					ctx.ui.notify(`Debug logging disabled. Log saved: ${formerPath}`, "info");
			} else {
					ctx.ui.notify("Debug logging was not active.", "info");
				}
				return;
			}

			if (lower === "check") {
				if (monitorState.status !== "running") {
					ctx.ui.notify("No monitor running. Start one first with /ghpr-monitor <PR URL>", "warning");
					return;
				}
				// Reset backoff so the next poll happens at the base interval
				backoffSec = 0;
				consecutiveNoChange = 0;
				forceNotify = true;
				log("Force check triggered via /ghpr-monitor command");
				// Wake the poll loop immediately
				if (pollWakeResolve) {
					pollWakeResolve();
					pollWakeResolve = null;
				}
				const c = monitorState.config;
				ctx.ui.notify(`Checking ${c.owner}/${c.repo}#${c.number} now...`, "info");
				return;
			}

			if (lower === "on" || raw === "") {
				if (monitorState.status === "running") {
					// Already monitoring — just show current status
					const statusText = formatCurrentStatus();
					ctx.ui.notify(statusText, "info");
					return;
				}
				// No args and no monitor running — ask the agent to invoke the tool
				// so it can figure out the PR from conversation context
				pi.sendUserMessage(
					"The user wants to start PR monitoring but didn't provide a PR URL. Please invoke the ghpr-monitor tool with action='start' and the appropriate parameters (url, or owner+repo+pr_number) based on the PR you have been working on.",
					{deliverAs: "steer"},
				);
				return;
			}

			// Try parsing as a PR URL first
			const parsed = parsePRUrl(raw);
			if (parsed) {
				const urlMatch = raw.trim().match(PR_URL_RE);
				const afterUrl = urlMatch ? raw.trim().slice(urlMatch[0].length).trim() : "";
				// Only treat trailing text as a steer message if it's NOT a URL
				// continuation (path segments, query params, fragments).
				// e.g. "/changes", "/files", "?expand=1", "#discussion_r1"
				// are part of the GitHub URL, not user messages.
				const steerMessage = afterUrl && !/^[\/?#]/.test(afterUrl) ? afterUrl : undefined;

				const config: MonitorConfig = {
					owner: parsed.owner,
					repo: parsed.repo,
					number: parsed.number,
					host: parsed.host,
					mode: "all",
					intervalSec: 60,
					debounceSec: 30,
				};
				const msg = startMonitor(config);
				ctx.ui.notify(msg, "success");
				if (steerMessage) {
					pi.sendUserMessage(steerMessage, {deliverAs: "steer"});
				}
				return;
			}

			// Try parsing as "owner/repo#number" (e.g. "mobilityhouse/vgi-na-masscec#373")
			const shorthand = parsePRShorthand(raw);
			if (shorthand) {
				const config: MonitorConfig = {
					owner: shorthand.owner,
					repo: shorthand.repo,
					number: shorthand.number,
					host: shorthand.host,
					mode: "all",
					intervalSec: 60,
					debounceSec: 30,
				};
				const msg = startMonitor(config);
				ctx.ui.notify(msg, "success");
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
					intervalSec: 60,
					debounceSec: 30,
				};
				const msg = startMonitor(config);
				ctx.ui.notify(msg, "success");
				if (steerMessage) {
					pi.sendUserMessage(steerMessage, {deliverAs: "steer"});
				}
				return;
			}

			ctx.ui.notify(
				"Usage:\n  /ghpr-monitor <PR URL> [message] — paste a GH PR URL\n  /ghpr-monitor owner/repo#123\n  /ghpr-monitor owner/repo <pr-number> [message]\n  /ghpr-monitor check — check now\n  /ghpr-monitor debug — enable debug logging\n  /ghpr-monitor debug off — disable debug logging\n  /ghpr-monitor off — stop monitoring",
				"info",
			);
		},
	});

	// -----------------------------------------------------------------------
	// Register the ghpr-monitor tool (LLM-callable)
	// -----------------------------------------------------------------------

	const GhprMonitorParams = Type.Object({
		action: StringEnum(["start", "status", "check"] as const, {
			description: "Action: start monitoring, check current status, or trigger an immediate poll",
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
			"Monitor a GitHub pull request for comments, conflicts, and CI status changes. Use action='start' with a 'url' (GitHub PR URL) or with owner+repo+pr_number to begin monitoring. Use action='status' to check current monitoring state. Use action='check' to trigger an immediate poll. Monitoring continues until the user stops it with /ghpr-monitor off. Updates are injected as notifications so you can address issues.",
		promptSnippet: "Monitor a GitHub PR for changes (comments, conflicts, CI failures)",
		promptGuidelines: [
			"When the user asks you to watch or monitor a PR, use ghpr-monitor with action='start'.",
			"Accept a GitHub PR URL, shorthand like 'owner/repo#123', or separate owner/repo/pr_number.",
			"Monitoring runs until the user stops it with /ghpr-monitor off.",
			"The user can run /ghpr-monitor check to trigger an immediate poll.",
			"You will receive PR status updates as notifications.",
		],
		parameters: GhprMonitorParams,

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			uiCtx = _ctx.ui;
			switch (params.action) {
				case "start": {
					if (monitorState.status === "running") {
						const c = monitorState.config;
						return {
							content: [
								{
									type: "text",
									text: `Already monitoring https://${c.host}/${c.owner}/${c.repo}/pull/${c.number}. Use /ghpr-monitor off to stop.`,
								},
							],
							details: { action: "start", status: "already_running", config: monitorState.config },
						};
					}

					// Resolve owner/repo/number from url or explicit params
					let resolvedOwner: string | undefined;
					let resolvedRepo: string | undefined;
					let resolvedNumber: number | undefined;
					let resolvedHost = "github.com";

					if (params.url) {
						const parsed = parsePRUrl(params.url) || parsePRShorthand(params.url);
						if (!parsed) {
							return {
								content: [{ type: "text", text: `Invalid PR URL or shorthand: ${params.url}. Expected format: https://github.com/owner/repo/pull/123 or owner/repo#123` }],
								details: { action: "start", status: "invalid_url" },
							};
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
							content: [
								{
									type: "text",
									text: [
										"Missing required parameters for action='start'.",
										"",
										"Usage:",
										"  ghpr-monitor(action='start', url='https://github.com/owner/repo/pull/123')",
										"  ghpr-monitor(action='start', url='owner/repo#123')",
										"  ghpr-monitor(action='start', owner='v2nic', repo='gh-pr-review', pr_number=42)",
										"",
										"Parameters:",
										"  url        GitHub PR URL or shorthand (e.g. 'owner/repo#123'), alternative to owner+repo+pr_number",
										"  owner      Repository owner",
										"  repo       Repository name",
										"  pr_number  Pull request number",
										"  mode       Watch mode: all, comments, conflicts, actions (default: all)",
										"  interval   Polling interval in seconds (default: 60, min: 10)",
										"",

										"Other action:",
										"  ghpr-monitor(action='status') — check current state",
									].join("\n"),
								},
							],
							details: { action: "start", status: "missing_params" },
						};
					}

					const config: MonitorConfig = {
						owner: resolvedOwner,
						repo: resolvedRepo,
						number: resolvedNumber,
						host: resolvedHost,
						mode: params.mode || "all",
						intervalSec: Math.max(10, params.interval || 60),
						debounceSec: 30,
					};

					const msg = startMonitor(config);
					return {
						content: [{ type: "text", text: msg }],
						details: { action: "start", status: "started", config },
					};
				}

				case "status": {
					if (monitorState.status === "idle") {
						return {
							content: [{ type: "text", text: "No PR monitor is currently active." }],
							details: { action: "status", status: "idle" },
						};
					}
					if (monitorState.status === "running") {
						const c = monitorState.config;
						const ts = lastStatusTimestamp ? lastStatusTimestamp.toLocaleString() : "unknown";
						const statusLine = lastStatus
							? `\nLast update: ${lastStatus.unresolvedThreads} unresolved threads, ${lastStatus.generalComments} comments, conflicts: ${lastStatus.hasConflicts}, failing: ${lastStatus.failingChecks.join(", ") || "none"}\nLast checked: ${ts}`
							: "\nNo status update received yet.";
						return {
							content: [
								{
									type: "text",
									text: `Monitoring ${c.owner}/${c.repo}#${c.number} (mode: ${c.mode}, interval: ${c.intervalSec}s)${statusLine}`,
								},
							],
							details: { action: "status", status: "running", config: c, lastStatus, lastStatusTimestamp },
						};
					}
					return {
						content: [{ type: "text", text: `Monitor state: ${monitorState.status}` }],
						details: { action: "status", status: monitorState.status },
					};
				}

				case "check": {
					if (monitorState.status !== "running") {
						return {
							content: [{ type: "text", text: "No monitor is currently active. Start one first with action='start'." }],
							details: { action: "check", status: "idle" },
						};
					}
					// Reset backoff and wake the poll loop
					backoffSec = 0;
					consecutiveNoChange = 0;
					forceNotify = true;
					log("Force check triggered via ghpr-monitor tool");
					if (pollWakeResolve) {
						pollWakeResolve();
						pollWakeResolve = null;
					}
					const c = monitorState.config;
					return {
						content: [{ type: "text", text: `Checking ${c.owner}/${c.repo}#${c.number} now...` }],
						details: { action: "check", status: "triggered", config: c },
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