/**
 * pi-ghpr-monitor — Pi extension for monitoring GitHub PRs
 *
 * Registers:
 *   /ghpr-monitor [!|start|on|off|status|owner/repo#number|check]  — user-facing command (no args = show status/usage)
 *   ghpr-monitor                                 — LLM-callable tool
 *
 * The tool polls one or more PRs for comments, conflicts, and CI status,
 * then injects notifications into the agent session so the LLM can take action.
 *
 * Starting a monitor with an explicit PR URL (/ghpr-monitor <URL>) is TUI-only:
 * it shows a notification confirming the monitor started but does NOT trigger an
 * agent turn. The /ghpr-monitor ! or /ghpr-monitor start subcommand injects a
 * steering prompt so the LLM will find the current PR and start monitoring it.
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
	type IssueData,
	type PRStatus,
	type IssueStatus,
	type MonitorConfig,
	snapshotPR,
	snapshotIssue,
	formatActionableItems,

	formatFooterStatus,
	formatAgentNotification,
	formatAgentStatusUpdate,
	linkifyPRRefs,
} from "./analyzer";
import {
	type Preferences,
	PreferencesSchema,
	DEFAULT_PREFERENCES,
	DEFAULT_RETRIGGER_COMMENTS,
	DEFAULT_DISABLE_MERGE_TOOL,
	validatePreferences,
	loadPreferences,
	savePreferences,
	getPreferencesPath,
	getEffectivePreferences,
	interpolateTemplate,
	getPreferenceWithDefault,
} from "./preferences";
import { setSessionId, enableDebug, disableDebug, isDebugEnabled, closeLogger, log, logPRSnapshot, logStatus, getLogPath } from "./logger";
import { isPRCreateCommand, parsePRUrlsFromOutput, createPRCreateNudge } from "./pr-create-hook";

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
        nodes { id databaseId body author { login } createdAt reactions(content: THUMBS_UP, first: 1) { nodes { content } } }
      }
      reviewThreads(last: $lastThreads) {
        nodes {
          id
          isResolved
          comments(last: $lastThreadComments) {
            nodes { id fullDatabaseId body author { login } createdAt path line diffHunk reactions(content: THUMBS_UP, first: 1) { nodes { content } } }
          }
        }
      }
      mergeable
      mergeStateStatus
      commits(last: 1) {
        nodes {
          commit {
            oid
            messageHeadline
            messageBody
            author {
              name
              user { login }
            }
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
// Issue GraphQL query
// ---------------------------------------------------------------------------

const AWAIT_ISSUE_QUERY = `query AwaitIssue(
  $owner: String!,
  $repo: String!,
  $number: Int!,
  $lastComments: Int!
) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      title
      state
      comments(last: $lastComments) {
        nodes { id databaseId body author { login } createdAt reactions(content: THUMBS_UP, first: 1) { nodes { content } } }
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

async function fetchIssueData(config: MonitorConfig, signal?: AbortSignal, mockBaseUrl?: string): Promise<IssueData> {
	const vars: Record<string, unknown> = {
		owner: config.owner,
		repo: config.repo,
		number: config.number,
		lastComments: 25,
	};
	const raw = await ghGraphQL(
		AWAIT_ISSUE_QUERY,
		vars,
		config.host !== "github.com" ? config.host : undefined,
		mockBaseUrl,
	);
	const outer = raw as { data?: { repository?: { issue?: IssueData } } };
	if (!outer.data?.repository?.issue) {
		throw new Error(`Issue ${config.owner}/${config.repo}#${config.number} not found or not accessible`);
	}
	return outer.data.repository.issue;
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// PR URL parser
// ---------------------------------------------------------------------------

const PR_URL_RE = /^https?:\/\/([^\/]+)\/([^\/]+)\/([^\/]+)\/pull\/([0-9]+)/i;

const ISSUE_URL_RE = /^https?:\/\/([^\/]+)\/([^\/]+)\/([^\/]+)\/issues\/([0-9]+)/i;

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

/** Parse an issue URL like https://github.com/owner/repo/issues/123 */
export function parseIssueUrl(input: string): ParsedPR | null {
	const m = input.trim().match(ISSUE_URL_RE);
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
	lastStatus: PRStatus | IssueStatus | null;
	lastStatusTimestamp: Date | null;
	lastSentUpdate: string | null;
	lastSentReminder: string | null;
	needsReminder: boolean;
	forceNotify: boolean;
	backoffSec: number;
	consecutiveNoChange: number;
	lastNudgeTime: number; // epoch ms
	pollWakeResolve: (() => void) | null;
	knownCommitOid: string | null;
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
		knownCommitOid: null,
	};
}

// ---------------------------------------------------------------------------
// Main extension
// ---------------------------------------------------------------------------

export default function ghprMonitorExtension(pi: ExtensionAPI) {
	const monitors: Map<string, ActiveMonitor> = new Map();
	/** Tracks PR keys that have already been nudged after gh pr create */
	const nudgedPRKeys: Set<string> = new Set();
	let agentTurnActive = false;
	let queuedUpdate: { concise: string; detailed: string; host: string; monitorKey: string } | null = null;
	let queuedForceChecks: Array<{ concise: string; detailed: string; host: string; monitorKey: string }> = [];
	let queuedPrCreateNudges: Array<{ message: string; host: string }> = [];
	// NOTE: Deduplication is per-monitor (mon.lastSentUpdate). No global lastSentUpdate
	// to prevent cross-monitor dedup suppression. See issue #25.
	let uiCtx: ExtensionUIContext | undefined;
	const MAX_BACKOFF_SEC = 300; // 5 minutes max rate-limit backoff
	const MAX_IDLE_SEC = 300; // 5 minutes max idle polling
	const NUDGE_COOLDOWN_MS = 3 * 60 * 1000; // 3 minutes between nudges for idle agent

	// In-memory preferences, loaded on startup and refreshed when the tool is called
	let currentPreferences: Preferences = loadPreferences();
	log(`Loaded preferences: ${JSON.stringify(currentPreferences)}`);

	// For testing: allows pointing at a mock server
	let mockBaseUrl: string | undefined = process.env.GHPR_MOCK_BASE_URL;

	// For testing: allows reducing the polling interval
	const MOCK_INTERVAL_SECS = process.env.GHPR_MONITOR_INTERVAL_SECS ? parseInt(process.env.GHPR_MONITOR_INTERVAL_SECS, 10) : undefined;

	const STEERING_PROMPT = `You have access to the ghpr-monitor tool. When the user asks you to watch or monitor a PR or issue, use ghpr-monitor with action "start" to begin monitoring. The tool has actions: start, status, check, merge, and preferences. Multiple PRs and issues can be monitored simultaneously. You must NOT stop monitoring on your own — only the user can stop via /ghpr-monitor off (stops all) or /ghpr-monitor off <PR> (stops specific). The user can also run /ghpr-monitor check to trigger an immediate poll (all PRs or a specific one). You will receive PR/issue status updates as notifications. The url parameter accepts GitHub PR URLs, issue URLs, or shorthand like "owner/repo#123". Use action='preferences' to view or customize the notification prompts. Calling with no value shows current preferences (with defaults); providing a value in JSON writes new preferences. Set a key to null to reset it to default. Use action='merge' to toggle auto-merge when CI passes (the monitor will notify you to merge the PR once CI is green).`;

	// Register a custom message renderer for "ghpr-monitor" messages.
	// This renders only the concise summary in the TUI, while the agent
	// receives the full content (including complete comment bodies, paths,
	// and line numbers) via the CustomMessage content field.
	//
	// PR references and URLs in the concise text are already linkified
	// with OSC 8 hyperlinks by sendPRNotification() before reaching here.
	// pi-tui's Text component uses wrapTextWithAnsi() which correctly
	// handles OSC 8 sequences: preserving them across line wraps and
	// excluding them from visible-width calculations.
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
	 * 1. pi.sendUserMessage(detailed) — creates a UserMessage that is the primary
	 *    delivery to the LLM agent. This ensures the coding agent can see and act
	 *    on the notification.
	 *
	 * 2. pi.sendMessage(customType: ghpr-monitor) — stores the CustomMessage in the
	 *    session for event sourcing and rendering via the registered message renderer.
	 *    When a UserMessage is also being sent (normal agent mode), display:false prevents
	 *    a duplicate visible message — the UserMessage already appears in the TUI.
	 *
	 * NOTE: CustomMessages with display:true are also converted to role: "user"
	 * messages in the LLM context by pi-agent-core's convertToLlm(). This means they
	 * CAN be seen by the agent. However, pi.sendUserMessage() is still the preferred
	 * delivery mechanism because it creates a proper UserMessage with content control.
	 * Error messages intentionally avoid pi.sendMessage() entirely and use uiCtx.notify()
	 * instead — transient TUI notifications that never enter the session or LLM context.
	 *
	 * IMPORTANT: Always use prLabel (owner/repo#number) in notification text, never
	 * the full PR URL (prUrl). linkifyPRRefs converts prLabel into a compact OSC 8
	 * hyperlink (display: owner/repo#number, href: full URL). Using prUrl causes
	 * triplicated URLs because linkifyPRRefs wraps the full URL in an OSC 8 hyperlink
	 * whose display text contains the same URL, and if the terminal doesn't support
	 * OSC 8, both the href and display text are shown as raw text.
	 */
	function sendPRNotification(concise: string, detailed: string, options?: { deliverAs?: "steer" | "followUp"; host?: string }) {
		const delivery = options?.deliverAs ?? "steer";
		const linkifyHost = options?.host ?? "github.com";
		// The detailed message is delivered via pi.sendUserMessage() and rendered
		// by pi-tui's Markdown component, which re-linkifies URLs embedded in raw
		// OSC 8 escapes (producing doubled/tripled output). Use markdown link
		// syntax — the Markdown component renders that into a single clean OSC 8
		// hyperlink (or a `display (url)` fallback when OSC 8 is unsupported).
		const markdownDetailed = linkifyPRRefs(detailed, linkifyHost, "markdown");
		// The concise message feeds the footer/CustomMessage Text renderer, which
		// handles raw OSC 8 escapes correctly via wrapTextWithAnsi().
		const linkifiedConcise = linkifyPRRefs(concise, linkifyHost, "osc8");

		// Deliver detailed content to the agent via UserMessage.
		// pi.sendUserMessage() creates a UserMessage that is injected into the
		// LLM conversation context, ensuring the coding agent can see and act on it.
		// This is the preferred way to deliver content to the agent.
		// pi.sendMessage() with customType also enters the LLM context via
		// CustomMessage -> convertToLlm(), so error messages must NOT use it —
		// they use uiCtx.notify() instead to stay TUI-only.
		//
		// The UserMessage (detailed) uses markdown link syntax because
		// UserMessageComponent renders via pi-tui's Markdown component. The
		// CustomMessage concise uses raw OSC 8 because its renderer uses pi-tui's
		// Text component. Both produce a single clean OSC 8 hyperlink in the TUI.
		if (delivery) {
			pi.sendUserMessage(markdownDetailed, { deliverAs: delivery });
		}

		// Emit a CustomMessage for the registered message renderer.
		// When a UserMessage is also being sent (delivery is set), display:false
		// avoids a duplicate visible message — the UserMessage already appears in
		// the TUI. When no UserMessage is sent (delivery is undefined/null),
		// display:true makes the CustomMessage the visible notification (rendered
		// by the Text component, hence raw OSC 8 in details.concise).
		pi.sendMessage({
			customType: "ghpr-monitor",
			content: markdownDetailed,
			display: !delivery,
			details: { concise: linkifiedConcise },
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
			sendPRNotification(update.concise, update.detailed, {deliverAs: "steer", host: update.host});
			// Only update lastSentUpdate for the monitor that originated the queued update
			const originatingMon = monitors.get(update.monitorKey);
			if (originatingMon) {
				originatingMon.lastSentUpdate = update.concise;
			}
			// Mark all monitors that their reminders are superseded
			for (const mon of monitors.values()) {
				mon.lastSentReminder = null;
			}
		}
		// Flush queued force-check results when turn ends
		if (queuedForceChecks.length > 0) {
			for (const fc of queuedForceChecks) {
				sendPRNotification(fc.concise, fc.detailed, {deliverAs: "steer", host: fc.host});
			}
			queuedForceChecks = [];
			for (const mon of monitors.values()) {
				mon.lastNudgeTime = Date.now();
			}
		}
		// Flush queued PR create nudges when turn ends
		if (queuedPrCreateNudges.length > 0) {
			for (const nudge of queuedPrCreateNudges) {
				sendPRNotification(nudge.message, nudge.message, {deliverAs: "steer", host: nudge.host});
			}
			queuedPrCreateNudges = [];
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

	// PR create hook: detect when the agent runs gh pr create and
	// inject a steer message nudging the LLM to start monitoring.
	pi.on("tool_result", async (event) => {
		// Only watch bash tool results
		if (event.toolName !== "bash") return;

		// Get the command string from the tool input
		const input = event.input as { command?: string } | undefined;
		const command = input?.command;
		if (!command || !isPRCreateCommand(command)) return;

		// Skip failed commands — a failed gh pr create may contain a PR URL
		// in its error message (e.g. "pull request already exists"), which
		// would trigger a false-positive nudge.
		if (event.isError) {
			log(`PR create hook: gh pr create failed, skipping nudge`);
			return;
		}

		// Parse PR URLs from the command output
		const content = Array.isArray(event.content)
			? event.content.map((c: { type: string; text: string }) => c.text).join("\n")
			: String(event.content ?? "");
		const prs = parsePRUrlsFromOutput(content);
		if (prs.length === 0) return;

		// For each newly created PR, send a steer message
		for (const pr of prs) {
			const key = prKey(pr.owner, pr.repo, pr.number, pr.host);

			// Skip if already monitoring or already nudged
			if (monitors.has(key)) {
				log(`PR create hook: ${key} is already being monitored, skipping nudge`);
				continue;
			}
			if (nudgedPRKeys.has(key)) {
				log(`PR create hook: ${key} was already nudged this session, skipping`);
				continue;
			}

			nudgedPRKeys.add(key);

			const nudgeTemplate = currentPreferences.prCreateNudge;
			const message = createPRCreateNudge(pr, nudgeTemplate);
			log(`PR create hook: queueing nudge for ${key}`);
			queuedPrCreateNudges.push({ message, host: pr.host });
		}
	});

	// -----------------------------------------------------------------------
	// Monitor management
	// -----------------------------------------------------------------------

	function startMonitor(config: MonitorConfig): { key: string; message: string; alreadyMonitoring?: boolean } {
		const isIssue = config.resourceType === "issue";
		const resourceUrl = isIssue
			? `https://${config.host}/${config.owner}/${config.repo}/issues/${config.number}`
			: `https://${config.host}/${config.owner}/${config.repo}/pull/${config.number}`;
		log(`Starting monitor: ${config.owner}/${config.repo}#${config.number} (interval: ${config.intervalSec}s, mode: ${config.mode}, type: ${config.resourceType})`);
		const key = prKey(config);

		if (monitors.has(key)) {
			const existing = monitors.get(key)!;
			return {
				key,
				message: `Already monitoring ${resourceUrl}. Use /ghpr-monitor off ${key} to stop.`,
				alreadyMonitoring: true,
			};
		}

		const mon = createActiveMonitor(config);
		monitors.set(key, mon);
		updateFooter();

		const loop = isIssue ? pollIssueLoop : pollLoop;
		const resourceLabel = isIssue ? "Issue" : "PR";
		loop(mon).catch((err) => {
			if (mon.controller.signal.aborted) return;
			const fatalErrMsg = `${resourceLabel} monitor error for ${key}: ${err instanceof Error ? err.message : String(err)}`;
			log(fatalErrMsg);
			uiCtx?.notify(fatalErrMsg, "error");
			monitors.delete(key);
			updateFooter();
		});

		return {
			key,
			message: `Started monitoring ${resourceUrl} (interval: ${config.intervalSec}s, mode: ${config.mode})`,
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
		const isIssue = config.resourceType === "issue";
		const resourceUrl = isIssue
			? `https://${config.host}/${config.owner}/${config.repo}/issues/${config.number}`
			: `https://${config.host}/${config.owner}/${config.repo}/pull/${config.number}`;
		monitors.delete(key);
		updateFooter();
		return `Stopped monitoring ${resourceUrl}`;
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
		return `Stopped monitoring ${keys.length} resource(s): ${keys.join(", ")}`;
	}

	function updateFooter() {
		if (!uiCtx) return;
		if (monitors.size === 0) {
			uiCtx.setStatus("ghpr-monitor", undefined);
			return;
		}

		if (monitors.size === 1) {
			const mon = monitors.values().next().value!;
			uiCtx.setStatus("ghpr-monitor", linkifyPRRefs(formatFooterStatus(mon.config, mon.lastStatus), mon.config.host));
			return;
		}

		// Multiple monitors: one line per PR with clickable links
		const lines: string[] = [];
		for (const mon of monitors.values()) {
			lines.push(linkifyPRRefs(formatFooterStatus(mon.config, mon.lastStatus), mon.config.host));
		}
		uiCtx.setStatus("ghpr-monitor", lines.join("\n"));
	}

	async function pollLoop(mon: ActiveMonitor): Promise<void> {
		const { config, controller } = mon;
		const signal = controller.signal;

		// Initial check
		const defaultInitialMsg = `📡 Monitoring ${config.owner}/${config.repo}#${config.number} (polling every ${config.intervalSec}s)`;
		const initialMsg = currentPreferences.firstPoll
			? interpolateTemplate(currentPreferences.firstPoll, {
				owner: config.owner, repo: config.repo, number: config.number, host: config.host,
				prLabel: `${config.owner}/${config.repo}#${config.number}`,
				prUrl: `https://${config.host}/${config.owner}/${config.repo}/pull/${config.number}`,
				intervalSec: config.intervalSec,
			})
			: defaultInitialMsg;
		const linkifiedInitialMsg = linkifyPRRefs(initialMsg, config.host);
		pi.sendMessage({
			customType: "ghpr-monitor",
			content: linkifiedInitialMsg,
			display: true,
			details: { concise: linkifiedInitialMsg, action: "start", owner: config.owner, repo: config.repo, number: config.number },
		});

		for (;;) {
			if (signal.aborted) return;

			try {
				const pr = await fetchPRData(config, signal, mockBaseUrl);
				log(`Fetched PR data for ${config.owner}/${config.repo}#${config.number}`);
				logPRSnapshot(pr);

				// Check if PR was merged or closed
				if (pr.state === "MERGED" || pr.state === "CLOSED") {
					// IMPORTANT: Use prLabel (owner/repo#number) in notification text, NOT prUrl.
				// linkifyPRRefs converts prLabel into a compact OSC 8 hyperlink.
				// Using prUrl causes triplicated URLs when linkifyPRRefs wraps the
				// full URL in a second hyperlink whose display text also contains the URL.
				const prLabel = `${config.owner}/${config.repo}#${config.number}`;
				const reason = pr.merged ? "merged" : "closed";
				const concise = `${pr.merged ? "🔀" : "❌"} PR ${prLabel} was ${reason}. Monitoring stopped.`;
				const detailed = `${pr.merged ? "🔀" : "❌"} PR ${prLabel} was ${reason}. Monitoring stopped.`;
					sendPRNotification(concise, detailed, {deliverAs: "steer", host: config.host});
					const key = prKey(config);
					monitors.delete(key);
					updateFooter();
					return;
				}

				const curr = snapshotPR(pr, currentPreferences.ignoredBots ?? []);
				const prevStatus = mon.lastStatus as PRStatus | null;
				const { concise: update, detailed: detUpdate } = formatAgentStatusUpdate(prevStatus, curr, config, currentPreferences);
				const hadChange = update.length > 0;
				let updateSentThisCycle = false;

				// When retriggerComments is false (the default), pass the previous status
				// snapshot to reminder/nudge formatters so they only report new items.
				const retrigger = currentPreferences.retriggerComments ?? DEFAULT_RETRIGGER_COMMENTS;
				const dedupPrev = !retrigger ? (prevStatus ?? undefined) : undefined;

				if (update) {
					if (agentTurnActive) {
						// Don't spam the LLM while it's working - queue for later
						queuedUpdate = { concise: update, detailed: detUpdate, host: config.host, monitorKey: prKey(config) };
					} else if (update !== mon.lastSentUpdate) {
						// Only send if something changed since last update
						sendPRNotification(update, detUpdate, {deliverAs: "steer", host: config.host});
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
					const reminder = formatActionableItems(curr, config, currentPreferences, dedupPrev);
					if (reminder && reminder !== mon.lastSentReminder) {
						const detReminder = formatAgentNotification(curr, config, currentPreferences, dedupPrev); sendPRNotification(reminder, detReminder?.detailed ?? reminder, {deliverAs: "steer", host: config.host});
						mon.lastSentReminder = reminder;
						mon.lastNudgeTime = Date.now();
					}
					mon.needsReminder = false;
				}

				// Force-check: always consume the flag so /ghpr-monitor check is never
				// a no-op. When the agent is active, queue the result for flush on turn_end.
				// Intentional: does NOT pass prevStatus — explicit user checks always
				// report the full current state regardless of the retriggerComments pref.
				if (mon.forceNotify) {
					// IMPORTANT: Use prLabel (owner/repo#number) in notification text, NOT prUrl.
					// See the merged/closed notification above for why.
					const prLabel = `${config.owner}/${config.repo}#${config.number}`;
					const items = formatActionableItems(curr, config, currentPreferences);
					const detItems = formatAgentNotification(curr, config, currentPreferences);
					const msg = items ?? `\u2705 No issues found on ${prLabel}`;
					const detMsg = detItems?.detailed ?? `\u2705 No issues found on ${prLabel}`;
					if (agentTurnActive) {
						queuedForceChecks.push({ concise: msg, detailed: detMsg, host: config.host, monitorKey: prKey(config) });
					} else {
						sendPRNotification(msg, detMsg, {deliverAs: "steer", host: config.host});
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
					const nudge = formatActionableItems(curr, config, currentPreferences, dedupPrev);
					const detNudge = formatAgentNotification(curr, config, currentPreferences, dedupPrev);
					if (nudge) {
						sendPRNotification(nudge, detNudge?.detailed ?? nudge, {deliverAs: "steer", host: config.host});
						mon.lastSentReminder = nudge;
						mon.lastNudgeTime = Date.now();
					}
				}

				// Description staleness nudge: detect new commits and remind agent to review the PR description
				if (curr.lastCommitOid) {
					if (mon.knownCommitOid === null) {
						// First poll: learn the current commit without nudging
						mon.knownCommitOid = curr.lastCommitOid;
					} else if (curr.lastCommitOid !== mon.knownCommitOid) {
						// New commit detected: nudge the agent to review the PR description
						const prLabel = `${config.owner}/${config.repo}#${config.number}`;
						const commitOid = curr.lastCommitOid;
						const commitShortOid = commitOid.slice(0, 7);
						const commitUrl = `https://${config.host}/${config.owner}/${config.repo}/commit/${commitOid}`;
						// Author of the new commit (GitHub login, falling back to the git
						// author name). May be empty if GitHub returns no author info.
						const commitAuthor = curr.lastCommitAuthor;
						// Co-authors parsed from the commit's Co-authored-by trailers,
						// joined with ", ". Empty when the commit has no co-authors.
						const commitCoauthors = curr.lastCommitCoauthors;
						// Include the commit headline in the default message; linkifyPRRefs
						// converts the commit URL into an OSC 8 hyperlink whose visible text
						// is the short 7-char SHA, so the rendered notification reads e.g.
						//   📝 New commit abc1234 ("Fix race condition") pushed to v2nic/repo#42 by alice.
						// where `abc1234` is a clickable link to the commit on GitHub. The
						// headline clause is omitted when the commit has no headline. The
						// ", co-authored by ..." clause is omitted when there are no co-authors.
						// A comma form (rather than parentheses) avoids nested parens when a
						// co-author's name itself contains "(...)".
						const commitHeadline = curr.lastCommitMessageHeadline;
						const headlineClause = commitHeadline ? ` ("${commitHeadline}")` : "";
						const authorClause = commitAuthor ? ` by ${commitAuthor}` : "";
						const coauthorClause = commitCoauthors ? `, co-authored by ${commitCoauthors}` : "";
						const defaultStalenessMsg = `\u{1F4DD} New commit ${commitUrl} pushed to ${prLabel}${headlineClause}${authorClause}${coauthorClause}. Review the PR description to ensure it still accurately reflects the latest changes.`;
						const stalenessMsg = getPreferenceWithDefault(
							"descriptionStaleness",
							currentPreferences,
							{
								owner: config.owner,
								repo: config.repo,
								number: config.number,
								host: config.host,
								prLabel,
								prUrl: `https://${config.host}/${config.owner}/${config.repo}/pull/${config.number}`,
								commitOid,
								commitShortOid,
								commitUrl,
								commitAuthor,
								commitCoauthors,
								commitMessageHeadline: commitHeadline,
							},
							defaultStalenessMsg,
						);
						if (agentTurnActive) {
							// Queue for flush on turn_end, matching the pattern used by status updates and force-checks
							queuedForceChecks.push({ concise: stalenessMsg, detailed: stalenessMsg, host: config.host, monitorKey: prKey(config) });
						} else {
							sendPRNotification(stalenessMsg, stalenessMsg, {deliverAs: "steer", host: config.host});
						}
						mon.knownCommitOid = curr.lastCommitOid;
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
				const pollErrMsg = isRateLimit
					? `Rate limited on ${config.owner}/${config.repo}#${config.number}, backing off ${mon.backoffSec}s`
					: `Poll error for ${config.owner}/${config.repo}#${config.number}: ${errMsg}${mon.backoffSec > config.intervalSec ? ` (retrying in ${mon.backoffSec}s)` : ""}`;
				log(pollErrMsg);
				uiCtx?.notify(pollErrMsg, "warning");
			}

			// Wait for interval (abortable), with backoff after any error
			const idleSec = mon.consecutiveNoChange > 3
				? Math.min(config.intervalSec * Math.pow(2, mon.consecutiveNoChange - 3), MAX_IDLE_SEC)
				: config.intervalSec;
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

	async function pollIssueLoop(mon: ActiveMonitor): Promise<void> {
		const { config, controller } = mon;
		const signal = controller.signal;
		const isIssue = config.resourceType === "issue";

		// Initial message
		const defaultInitialMsg = `📡 Monitoring ${config.owner}/${config.repo}#${config.number} (issue, polling every ${config.intervalSec}s)`;
		const initialMsg = currentPreferences.firstPoll
			? interpolateTemplate(currentPreferences.firstPoll, {
				owner: config.owner, repo: config.repo, number: config.number, host: config.host,
				prLabel: `${config.owner}/${config.repo}#${config.number}`,
				prUrl: `https://${config.host}/${config.owner}/${config.repo}/issues/${config.number}`,
				intervalSec: config.intervalSec,
			})
			: defaultInitialMsg;
		const linkifiedInitialMsg = linkifyPRRefs(initialMsg, config.host);
		pi.sendMessage({
			customType: "ghpr-monitor",
			content: linkifiedInitialMsg,
			display: true,
			details: { concise: linkifiedInitialMsg, action: "start", owner: config.owner, repo: config.repo, number: config.number },
		});

		for (;;) {
			if (signal.aborted) return;

			try {
				const issue = await fetchIssueData(config, signal, mockBaseUrl);
				log(`Fetched issue data for ${config.owner}/${config.repo}#${config.number}`);

				// Check if issue was closed
				if (issue.state === "CLOSED") {
					const prLabel = `${config.owner}/${config.repo}#${config.number}`;
					const concise = `❌ Issue ${prLabel} was closed. Monitoring stopped.`;
					const detailed = `❌ Issue ${prLabel} was closed. Monitoring stopped.`;
					sendPRNotification(concise, detailed, {deliverAs: "steer", host: config.host});
					const key = prKey(config);
					monitors.delete(key);
					updateFooter();
					return;
				}

				const curr = snapshotIssue(issue, currentPreferences.ignoredBots ?? []);
				const prevIssueStatus = mon.lastStatus as IssueStatus | null;

				// Compare comments
				const prevCommentIds = prevIssueStatus
					? new Set((prevIssueStatus.commentDetails ?? []).map(c => c.id))
					: null;
				const newComments = prevCommentIds
					? (curr.commentDetails ?? []).filter(c => !prevCommentIds.has(c.id))
					: (curr.commentDetails ?? []);

				const hadChange = newComments.length > 0;

				if (hadChange) {
					const prLabel = `${config.owner}/${config.repo}#${config.number}`;
					const lines: string[] = [];
					lines.push(`💭 ${newComments.length} new comment(s) on ${prLabel}:`);
					for (const c of newComments) {
						lines.push(`  - [${c.author}] ${c.body.slice(0, 120)} (id: ${c.id}, restApiId: ${c.restApiId})`);
					}
					lines.push("  React with 👍 on a comment to acknowledge it and stop notifications.");
					const update = lines.join("\n");

					if (agentTurnActive) {
						queuedUpdate = { concise: update, detailed: update, host: config.host, monitorKey: prKey(config) };
					} else if (update !== mon.lastSentUpdate) {
						sendPRNotification(update, update, {deliverAs: "steer", host: config.host});
						mon.lastSentUpdate = update;
						mon.lastSentReminder = null;
						mon.lastNudgeTime = Date.now();
					}
				}

				// Force-check
				if (mon.forceNotify) {
					const prLabel = `${config.owner}/${config.repo}#${config.number}`;
					const items = curr.generalComments > 0
						? [`💭 ${curr.generalComments} general comment(s) on ${prLabel}:`,
							...(curr.commentDetails ?? []).map(c => `  - [${c.author}] ${c.body.slice(0, 120)}`),
							"  React with 👍 on a comment to acknowledge it and stop notifications."].join("\n")
						: `✨ No issues found on ${prLabel} (issue)`;
					if (agentTurnActive) {
						queuedForceChecks.push({ concise: items, detailed: items, host: config.host, monitorKey: prKey(config) });
					} else {
						sendPRNotification(items, items, {deliverAs: "steer", host: config.host});
					}
					mon.lastSentReminder = items;
					mon.lastNudgeTime = Date.now();
					mon.forceNotify = false;
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
				const pollErrMsg = isRateLimit
					? `Rate limited on ${config.owner}/${config.repo}#${config.number}, backing off ${mon.backoffSec}s`
					: `Poll error for ${config.owner}/${config.repo}#${config.number}: ${errMsg}${mon.backoffSec > config.intervalSec ? ` (retrying in ${mon.backoffSec}s)` : ""}`;
				log(pollErrMsg);
				uiCtx?.notify(pollErrMsg, "warning");
			}

			// Wait for interval (abortable), with backoff after any error
			const idleSec = mon.consecutiveNoChange > 3
				? Math.min(config.intervalSec * Math.pow(2, mon.consecutiveNoChange - 3), MAX_IDLE_SEC)
				: config.intervalSec;
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

	// Build detailed status lines for display (shared by /ghpr-monitor status command
	// and ghpr-monitor tool action='status')
	function buildDetailedStatusLines(): string[] {
		if (monitors.size === 0) return [];
		const lines: string[] = [`Monitoring ${monitors.size} resource(s):`];
		for (const [key, mon] of monitors) {
			const ts = mon.lastStatusTimestamp ? mon.lastStatusTimestamp.toLocaleString() : "unknown";
			const isIssue = mon.config.resourceType === "issue";
			if (mon.lastStatus) {
				const s = mon.lastStatus;
				if (isIssue) {
					const issueStatus = s as IssueStatus;
					lines.push(`${key} (issue): ${issueStatus.generalComments} comments, state: ${issueStatus.state} (last checked: ${ts})`);
				} else {
					const prStatus = s as PRStatus;
					lines.push(`${key}: ${prStatus.unresolvedThreads} unresolved threads, ${prStatus.generalComments} comments, conflicts: ${prStatus.hasConflicts}, failing: ${prStatus.failingChecks.join(", ") || "none"} (last checked: ${ts})`);
				}
			} else {
				lines.push(`${key}: No status update received yet.`);
			}
		}
		return lines;
	}

	// Format the current monitor status for display
	function formatCurrentStatus(): string {
		if (monitors.size === 0) return "";
		const lines: string[] = [];
		for (const mon of monitors.values()) {
			const c = mon.config;
			const isIssue = c.resourceType === "issue";
			const resourceUrl = isIssue
				? `https://${c.host}/${c.owner}/${c.repo}/issues/${c.number}`
				: `https://${c.host}/${c.owner}/${c.repo}/pull/${c.number}`;
			const autoMergeTag = c.autoMerge && !isIssue ? " 🔀auto-merge" : "";
			const header = `Monitoring ${resourceUrl} (mode: ${c.mode}, interval: ${c.intervalSec}s${autoMergeTag})`;
			if (!mon.lastStatus) {
				lines.push(`${header}\n  No status update received yet.`);
			} else {
			const ts = mon.lastStatusTimestamp ? mon.lastStatusTimestamp.toLocaleString() : "unknown";
			if (isIssue) {
				const issueStatus = mon.lastStatus as IssueStatus;
				const commentCount = issueStatus?.generalComments ?? 0;
				if (commentCount > 0) {
					const details = (issueStatus.commentDetails ?? [])
						.map(c => `  - [${c.author}] ${c.body.slice(0, 120)}`)
						.join("\n");
					lines.push(`${header}\n  💭 ${commentCount} general comment(s):\n${details}\n  Last checked: ${ts}`);
				} else {
					lines.push(`${header}\n  ✨ No issues, all clear (last checked: ${ts})`);
				}
			} else {
				const prStatus = mon.lastStatus as PRStatus;
				const status = formatActionableItems(prStatus, c, currentPreferences);
				if (status) {
					lines.push(`${header}\n  ${status.replace(/\n/g, "\n  ")}\n  Last checked: ${ts}`);
				} else {
					lines.push(`${header}\n  ✨ No issues, all clear (last checked: ${ts})`);
				}
			}
			}
		}
		return lines.join("\n\n");
	}

	// -----------------------------------------------------------------------
	// Register the /ghpr-monitor command
	// -----------------------------------------------------------------------

	pi.registerCommand("ghpr-monitor", {
		description: "Monitor PRs: /ghpr-monitor ! | start — /ghpr-monitor [PR URL] — /ghpr-monitor status — /ghpr-monitor check [PR] — /ghpr-monitor off [PR] — leave blank to show status/usage",
		getArgumentCompletions: (prefix: string) => {
			const completions = ["!", "start", "on", "off", "stop", "check", "status", "https://github.com"];
			// Add currently monitored PRs as completions for off/check
			for (const key of monitors.keys()) {
				completions.push(key);
			}
			return completions.filter((c) => c.startsWith(prefix)).map((c) => ({ value: c, label: c }));
		},
		handler: async (args, ctx) => {
			uiCtx = ctx.ui;
			const raw = args.trim();

			// Parse: ! or start — auto-detect current branch's PR and start
			// Parse: ! or start — inject a prompt so the LLM sees the user wants
			// to monitor the current PR. The LLM will determine which PR and
			// invoke the ghpr-monitor tool itself. This triggers an agent turn.
			if (raw === "!" || raw.toLowerCase() === "start") {
				pi.sendUserMessage("Monitor the current pull request using ghpr-monitor.", { deliverAs: "steer" });
				return;
			}

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

			// Parse: status — show current PR status without triggering a turn
			// Uses pi.sendMessage with deliverAs: "nextTurn" so the status is
			// visible in the TUI and enters the LLM context, but does NOT
			// trigger a new agent turn — similar to !command behavior.
			if (raw.toLowerCase() === "status") {
				if (monitors.size === 0) {
					ctx.ui.notify("No PR monitors running.\n  Start one with: /ghpr-monitor ! (current branch) or /ghpr-monitor <PR URL>", "info");
					return;
				}
				const conciseStatus = formatCurrentStatus();
				const detailedStatus = buildDetailedStatusLines().join("\n");
				// Display in TUI via registered message renderer (display: true)
				// and inject into LLM context via deliverAs: "nextTurn"
				// — this does NOT trigger an agent turn
				pi.sendMessage({
					customType: "ghpr-monitor",
					content: detailedStatus,
					display: true,
					details: { concise: conciseStatus },
				}, {
					deliverAs: "nextTurn",
				});
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

			// Parse: merge [PR identifier] — toggle auto-merge when CI passes
			if (raw.toLowerCase() === "merge" || raw.toLowerCase().startsWith("merge ")) {
				const rest = raw.replace(/^merge\s*/i, "").trim();
				if (!rest) {
					// No argument: if exactly one PR monitored, toggle it; otherwise show status
					const prMonitors = [...monitors.entries()]
						.filter(([, mon]) => mon.config.resourceType !== "issue");
					if (prMonitors.length === 1) {
						const [key, mon] = prMonitors[0]!;
						mon.config.autoMerge = !mon.config.autoMerge;
						ctx.ui.notify(
							`Auto-merge ${mon.config.autoMerge ? "enabled" : "disabled"} for ${key}.${mon.config.autoMerge ? " The monitor will notify to merge when CI passes." : ""}`,
							"info",
						);
						return;
					}
					// Show which monitors have auto-merge enabled
					const autoMergeMonitors = [...monitors.entries()]
						.filter(([, mon]) => mon.config.autoMerge);
					if (autoMergeMonitors.length === 0) {
						ctx.ui.notify(
							"No monitors have auto-merge enabled.\n  Toggle with: /ghpr-monitor merge <PR>\n  When CI passes, the monitor will notify to merge.",
							"info",
						);
					} else {
						const lines = autoMergeMonitors.map(([key]) => `  ${key}: auto-merge ON`);
						ctx.ui.notify(`Auto-merge enabled on:\n${lines.join("\n")}`, "info");
					}
					return;
				}
				const targetKey = resolveMonitorKey(rest);
				if (targetKey && monitors.has(targetKey)) {
					const mon = monitors.get(targetKey)!;
					mon.config.autoMerge = !mon.config.autoMerge;
					const isIssue = mon.config.resourceType === "issue";
					if (isIssue) {
						ctx.ui.notify(`Auto-merge does not apply to issues. ${targetKey}`, "warning");
						mon.config.autoMerge = false;
					} else {
						ctx.ui.notify(
							`Auto-merge ${mon.config.autoMerge ? "enabled" : "disabled"} for ${targetKey}.${mon.config.autoMerge ? " The monitor will notify to merge when CI passes." : ""}`,
							"info",
						);
					}
				} else {
					ctx.ui.notify(`Unknown PR: ${rest}. Currently monitoring: ${[...monitors.keys()].join(", ") || "none"}`, "warning");
				}
				return;
			}

			if (raw.toLowerCase() === "on" || raw === "") {
				if (monitors.size > 0) {
					const statusText = formatCurrentStatus();
					ctx.ui.notify(statusText, "info");
					return;
				}
				// No monitors running — show usage hint via UI only (no agent turn)
				ctx.ui.notify(
					"No PR monitors running.\n  Start one with: /ghpr-monitor ! (current branch) or /ghpr-monitor <PR URL>",
					"info",
				);
				return;
			}

			// Try parsing as an issue URL first (since /issues/ is unambiguous)
			const issueParsed = parseIssueUrl(raw);
			if (issueParsed) {
				const urlMatch = raw.trim().match(ISSUE_URL_RE);
				const afterUrl = urlMatch ? raw.trim().slice(urlMatch[0].length).trim() : "";
				const steerMessage = afterUrl && !/^[\/?#]/.test(afterUrl) ? afterUrl : undefined;

				const config: MonitorConfig = {
					owner: issueParsed.owner,
					repo: issueParsed.repo,
					number: issueParsed.number,
					host: issueParsed.host,
					resourceType: "issue",
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
					pi.sendUserMessage(steerMessage, { deliverAs: "steer" });
				}
				return;
			}

			// Try parsing as a PR URL
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
					resourceType: "pr",
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
					pi.sendUserMessage(steerMessage, { deliverAs: "steer" });
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
					resourceType: "pr",
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
					resourceType: "pr",
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
					pi.sendUserMessage(steerMessage, { deliverAs: "steer" });
				}
				return;
			}

			ctx.ui.notify(
				"Usage:\n  /ghpr-monitor ! | start — monitor current branch's PR (injects prompt for LLM)\n  /ghpr-monitor <URL> — paste a GH PR or issue URL (TUI-only, no LLM turn)\n  /ghpr-monitor owner/repo#123\n  /ghpr-monitor owner/repo <pr-number> [message]\n  /ghpr-monitor check [PR/issue] — check now (all or specific)\n  /ghpr-monitor merge [PR] — toggle auto-merge when CI passes\n  /ghpr-monitor off [PR/issue] — stop monitoring (all or specific)",
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

		// Try parsing as PR URL, issue URL, or shorthand
		const parsed = parseIssueUrl(trimmed) || parsePRUrl(trimmed) || parsePRShorthand(trimmed);
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
		action: StringEnum(["start", "status", "check", "merge", "preferences"] as const, {
			description: "Action: start monitoring, check current status, trigger an immediate poll, toggle auto-merge on CI green, or view/update preferences",
		}),
		url: Type.Optional(Type.String({ description: "GitHub PR/issue URL (e.g. https://github.com/owner/repo/pull/123 or .../issues/123) or shorthand (e.g. owner/repo#123). Alternative to owner+repo+pr_number." })),
		owner: Type.Optional(Type.String({ description: "Repository owner (e.g. 'v2nic')" })),
		repo: Type.Optional(Type.String({ description: "Repository name (e.g. 'gh-pr-review')" })),
		pr_number: Type.Optional(Type.Number({ description: "Pull request number" })),
		mode: Type.Optional(
			StringEnum(["all", "comments", "conflicts", "actions"] as const, {
				description: "What to watch for (default: all)",
			}),
		),
		interval: Type.Optional(Type.Number({ description: "Polling interval in seconds (default: 60, minimum: 10)" })),
		value: Type.Optional(Type.String({ description: "For preferences action: JSON string with preference overrides. Omit to read current preferences." })),
	});

	pi.registerTool({
		name: "ghpr-monitor",
		label: "GH PR Monitor",
		description:
			"Monitor GitHub pull requests and issues for changes. Supports monitoring multiple PRs/issues simultaneously. Use action='start' with a 'url' (GitHub PR/issue URL) or with owner+repo+pr_number to begin monitoring. Use action='status' to list all currently monitored resources. Use action='check' to trigger an immediate poll. Use action='preferences' to view or update notification prompt preferences. The agent cannot stop monitoring — only the user can stop via /ghpr-monitor off.",
		promptSnippet: "Monitor GitHub PRs/issues for changes (comments, conflicts, CI failures)",
		promptGuidelines: [
			"When the user asks you to watch or monitor a PR or issue, use ghpr-monitor with action='start'.",
			"Multiple PRs and issues can be monitored at the same time — start a new monitor without stopping existing ones.",
			"Accept a GitHub PR URL, issue URL, shorthand like 'owner/repo#123', or separate owner/repo/pr_number.",
			"Use action='status' to see all currently monitored resources.",
			"Use action='check' to trigger an immediate poll.",
			"Use action='merge' to toggle auto-merge when CI passes (if not disabled by the disableMergeTool preference). When enabled, the monitor will notify you to merge the PR once CI turns green.",
			"Use action='preferences' to view current preferences or update them with a value parameter.",
			"The value parameter for preferences is a JSON string with keys: ignoredBots (array of strings), newComments, conflict, ciFailure, reminder, allClear, firstPoll, descriptionStaleness, prCreateNudge, ciGreenMerge, disableMergeTool (boolean, default false), retriggerComments (boolean, default false).",
			"Template variables available in preferences: {owner}, {repo}, {number}, {host}, {prLabel}, {prUrl}, plus situation-specific vars like {failingChecks}, {unresolvedThreads}, {generalComments}, {conflict}, {commitOid}, {commitShortOid}, {commitUrl}, {commitAuthor}, {commitCoauthors}, {commitMessageHeadline}.",
			"Do NOT stop monitoring on your own. Only the user can stop monitoring via /ghpr-monitor off.",
			"Monitoring runs until the user stops it via /ghpr-monitor off, or the PR/issue is merged/closed.",
			"You will receive PR/issue status updates as notifications.",
		],
		parameters: GhprMonitorParams,

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			uiCtx = _ctx.ui;

			// Helper: resolve PR/issue identity from url or explicit params
			function resolvePR(): { owner: string; repo: string; number: number; host: string; resourceType: "pr" | "issue" } | { error: string } {
				let resolvedOwner: string | undefined;
				let resolvedRepo: string | undefined;
				let resolvedNumber: number | undefined;
				let resolvedHost = "github.com";
				let resolvedType: "pr" | "issue" = "pr";

				if (params.url) {
					// Try issue URL first (unambiguous), then PR URL, then shorthand
					const issueParsed = parseIssueUrl(params.url);
					if (issueParsed) {
						resolvedOwner = issueParsed.owner;
						resolvedRepo = issueParsed.repo;
						resolvedNumber = issueParsed.number;
						resolvedHost = issueParsed.host;
						resolvedType = "issue";
					} else {
						const prParsed = parsePRUrl(params.url) || parsePRShorthand(params.url);
						if (!prParsed) {
							return { error: `Invalid PR/issue URL or shorthand: ${params.url}. Expected format: https://github.com/owner/repo/pull/123, https://github.com/owner/repo/issues/123, or owner/repo#123` };
						}
						resolvedOwner = prParsed.owner;
						resolvedRepo = prParsed.repo;
						resolvedNumber = prParsed.number;
						resolvedHost = prParsed.host;
					}
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
							"  ghpr-monitor(action='start', url='https://github.com/owner/repo/issues/123')",
					"  ghpr-monitor(action='start', url='owner/repo#123')",
							"  ghpr-monitor(action='start', owner='v2nic', repo='gh-pr-review', pr_number=42)",
							"  ghpr-monitor(action='check') — trigger an immediate poll",
							"  /ghpr-monitor off [PR] — stop monitoring (user only)",
							"  ghpr-monitor(action='status') — list all monitored PRs/issues",
						].join("\n"),
					};
				}

				return { owner: resolvedOwner, repo: resolvedRepo, number: resolvedNumber, host: resolvedHost, resourceType: resolvedType };
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
						resourceType: resolved.resourceType,
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

					const detailedStatus = buildDetailedStatusLines().join("\n");

					return {
						content: [{ type: "text", text: detailedStatus }],
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

				case "merge": {
					const mergeDisabled = currentPreferences.disableMergeTool ?? DEFAULT_DISABLE_MERGE_TOOL;
					if (mergeDisabled) {
						return {
							content: [{ type: "text", text: "The merge tool action is disabled for the agent. The user can toggle auto-merge via /ghpr-monitor merge." }],
							details: { action: "merge", status: "disabled" },
						};
					}

					if (monitors.size === 0) {
						return {
							content: [{ type: "text", text: "No monitors are currently active. Start one first with action='start'." }],
							details: { action: "merge", status: "idle" },
						};
					}

					const resolved = resolvePR();
					if ("error" in resolved) {
						return {
							content: [{ type: "text", text: resolved.error }],
							details: { action: "merge", status: "missing_params" },
						};
					}

					const key = prKey(resolved.owner, resolved.repo, resolved.number, resolved.host);
					const mon = monitors.get(key);
					if (!mon) {
						return {
							content: [{ type: "text", text: `Not monitoring ${key}. Currently monitoring: ${[...monitors.keys()].join(", ")}` }],
							details: { action: "merge", status: "not_found" },
						};
					}

					const isIssue = mon.config.resourceType === "issue";
					if (isIssue) {
						return {
							content: [{ type: "text", text: `Auto-merge does not apply to issues. ${key}` }],
							details: { action: "merge", status: "not_applicable", config: mon.config },
						};
					}

					mon.config.autoMerge = !mon.config.autoMerge;
					const msg = mon.config.autoMerge
						? `Auto-merge enabled for ${key}. The monitor will notify you to merge when CI passes.`
						: `Auto-merge disabled for ${key}.`;
					return {
						content: [{ type: "text", text: msg }],
						details: { action: "merge", status: "toggled", autoMerge: mon.config.autoMerge, config: mon.config },
					};
				}

				case "preferences": {
					if (params.value !== undefined && params.value !== "") {
						// Write preferences — merge with current to avoid dropping other keys
						const result = validatePreferences(params.value);
						if (!result.ok) {
							return {
								content: [{ type: "text", text: `Invalid preferences: ${result.errors.join("; ")}` }],
								details: { action: "preferences", status: "validation_error", errors: result.errors },
							};
						}
						const validated = result.preferences!;
						// Merge: validated keys override current; reset keys are removed
						const merged = { ...currentPreferences, ...validated };
						for (const key of result.resetKeys ?? []) {
							delete merged[key];
						}
						savePreferences(merged);
						currentPreferences = merged;
						log(`Preferences updated: ${JSON.stringify(merged)}`);

						// Show effective preferences (defaults merged with overrides)
						const effective = getEffectivePreferences(merged);
						const lines: string[] = [];
						for (const key of Object.keys(PreferencesSchema.properties) as (keyof Preferences)[]) {
							const isCustom = merged[key] !== undefined && merged[key] !== "";
							const defaultValue = DEFAULT_PREFERENCES[key];
							if (isCustom) {
								lines.push(`  ${key}: ${effective[key]} (custom)`);
							} else if (defaultValue !== undefined) {
								lines.push(`  ${key}: ${defaultValue} (default)`);
							} else {
								lines.push(`  ${key}: (computed)`);
							}
						}
						const prefsDisplay = lines.join("\n");
						return {
							content: [{ type: "text", text: `Preferences saved to ${getPreferencesPath()}:\n${JSON.stringify(merged, null, 2)}\n\nEffective values:\n${prefsDisplay}\n\nSet a key to null to reset it to default, e.g. {"conflict": null}` }],
							details: { action: "preferences", status: "saved", preferences: merged },
						};
					}

					// Read preferences — show all keys with their effective values
					const effective = getEffectivePreferences(currentPreferences);
					const lines: string[] = [];
					for (const key of Object.keys(PreferencesSchema.properties) as (keyof Preferences)[]) {
						const isCustom = currentPreferences[key] !== undefined && currentPreferences[key] !== "";
						const defaultValue = DEFAULT_PREFERENCES[key];
						if (isCustom) {
							lines.push(`  ${key}: ${effective[key]} (custom)`);
						} else if (defaultValue !== undefined) {
							lines.push(`  ${key}: ${defaultValue} (default)`);
						} else {
							lines.push(`  ${key}: (computed)`);
						}
					}
					const prefsDisplay = lines.join("\n");
					const availableKeys = Object.keys(PreferencesSchema.properties).join(", ");
					const hasCustomPrefs = Object.keys(currentPreferences).length > 0;
					const helpText = hasCustomPrefs
						? `Current preferences:\n${prefsDisplay}\n\nAvailable keys: ${availableKeys}\nTemplate variables: {owner}, {repo}, {number}, {host}, {prLabel}, {prUrl}, {unresolvedThreads}, {generalComments}, {failingChecks}, {conflict}, {commitOid}, {commitShortOid}, {commitUrl}, {commitAuthor}, {commitCoauthors}, {commitMessageHeadline}`
						: `No custom preferences set. Using defaults.\n\nAvailable keys: ${availableKeys}\nTemplate variables: {owner}, {repo}, {number}, {host}, {prLabel}, {prUrl}, {unresolvedThreads}, {generalComments}, {failingChecks}, {conflict}, {commitOid}, {commitShortOid}, {commitUrl}, {commitAuthor}, {commitCoauthors}, {commitMessageHeadline}\n\nSet preferences with: ghpr-monitor(action='preferences', value='{"conflict": "⚠️ Conflict on {prLabel}!"}')`;
					return {
						content: [{ type: "text", text: helpText }],
						details: { action: "preferences", status: "read", preferences: currentPreferences },
					};
				}
				case "stop": {
					// The stop action is intentionally excluded from the tool's StringEnum
					// so the LLM cannot invoke it. Only the user can stop monitoring via
					// /ghpr-monitor off. This case remains as a safety fallback.
					return {
						content: [{ type: "text", text: "Stopping monitors is not available to the agent. The user can stop monitoring via /ghpr-monitor off." }],
						details: { action: "stop", status: "forbidden" },
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