/**
 * pi-ghpr-monitor — Pi extension that monitors GitHub PRs.
 *
 * This is now a **thin adapter** around the `gh monitor` CLI
 * (https://github.com/elecnix/gh-monitor). Instead of re-implementing PR/issue/
 * run polling, snapshotting, change-diffing, and notification rendering in
 * TypeScript (the old analyzer.ts / run-monitor.ts / poll-loop trio, ~2000
 * lines), the adapter shells out to `gh monitor monitor <selector>`, which
 * streams one NDJSON event per genuinely-new change and auto-stops on
 * merge/close/run-completion. The adapter:
 *
 *   - parses user-supplied PR/issue/run selectors (keys.ts),
 *   - spawns `gh monitor` and relays each event into the Pi session
 *     (gh-monitor-bridge.ts),
 *   - renders events for pi-tui (Text/Markdown) and the agent (render.ts),
 *   - delegates notification templates to `gh monitor prefs` and keeps the
 *     Pi-only prefs (disableMergeTool, prCreateNudge, ciGreenMerge) in
 *     adapter-prefs.ts,
 *   - owns the Pi-harness integration the CLI can't do itself: the
 *     `/ghpr-monitor` command, the `ghpr-monitor` tool, the steering prompt,
 *     the custom message renderer, the footer status, turn-batching (queue
 *     events while the agent is working, flush on turn_end), the `gh pr create`
 *     hook, and the auto-merge nudge on CI-green.
 *
 * Registers:
 *   /ghpr-monitor [!|start|on|off|status|check|merge|owner/repo#number|<URL>] — user command
 *   ghpr-monitor — LLM-callable tool
 */

import type { ExtensionAPI, ExtensionUIContext, MessageRenderer } from "@mariozechner/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import type { Static } from "@sinclair/typebox";
import * as path from "node:path";
import { Text, Box } from "@mariozechner/pi-tui";

import {
	type MonitorConfig,
	type ResourceType,
	type ParsedSelector,
	type ParsedRun,
	parsePRUrl,
	parseIssueUrl,
	parsePRShorthand,
	parseRunUrl,
	prKey,
	runKey,
	monitorKey,
	resourceUrl,
} from "./keys";
import {
	type Notification,
	type MonitorState,
	emptyMonitorState,
	updateStateFromNotification,
	linkifyPRRefs,
	formatFooterStatus,
	formatMonitorStatusLine,
} from "./render";
import {
	type MonitorHandle,
	spawnMonitor,
	spawnOnce,
	prefsGet,
	prefsSet,
	prefsReset,
	prefsPath,
} from "./gh-monitor-bridge";
import {
	type AdapterPrefs,
	loadAdapterPrefs,
	saveAdapterPrefs,
	getAdapterPref,
	interpolatePref,
	adapterPrefsPath,
	DEFAULT_CI_GREEN_MERGE,
	DEFAULT_DISABLE_MERGE_TOOL,
} from "./adapter-prefs";
import { setSessionId, enableDebug, disableDebug, isDebugEnabled, closeLogger, log, getLogPath } from "./logger";
import { isPRCreateCommand, parsePRUrlsFromOutput, createPRCreateNudge } from "./pr-create-hook";

// ---------------------------------------------------------------------------
// Active monitor entry
// ---------------------------------------------------------------------------

export interface ActiveMonitor {
	config: MonitorConfig;
	handle: MonitorHandle | null;
	state: MonitorState;
	lastSentUpdate: string | null;
	lastNudgeTime: number;
	/** True once the ci-green auto-merge nudge has fired for this commit cycle. */
	autoMergeNotified: boolean;
	/** Set when the monitor exited (so late events are ignored). */
	exited: boolean;
}

function createActiveMonitor(config: MonitorConfig): ActiveMonitor {
	return {
		config,
		handle: null,
		state: emptyMonitorState(),
		lastSentUpdate: null,
		lastNudgeTime: 0,
		autoMergeNotified: false,
		exited: false,
	};
}

// ---------------------------------------------------------------------------
// Main extension
// ---------------------------------------------------------------------------

export default function ghprMonitorExtension(pi: ExtensionAPI) {
	const monitors: Map<string, ActiveMonitor> = new Map();
	const nudgedPRKeys: Set<string> = new Set();
	let agentTurnActive = false;
	let queuedUpdates: Array<{ concise: string; detailed: string; host: string; monitorKey: string }> = [];
	let queuedPrCreateNudges: Array<{ message: string; host: string }> = [];
	let uiCtx: ExtensionUIContext | undefined;

	// For testing: allow pointing the bridge at a mock binary / reducing interval.
	// (GH_MONITOR_BIN is read directly by the bridge; no env wiring needed here.)
	const MOCK_INTERVAL_SECS = process.env.GHPR_MONITOR_INTERVAL_SECS ? parseInt(process.env.GHPR_MONITOR_INTERVAL_SECS, 10) : undefined;

	// In-memory pi-specific prefs, loaded on startup.
	let currentAdapterPrefs: AdapterPrefs = loadAdapterPrefs();
	log(`Loaded adapter prefs: ${JSON.stringify(currentAdapterPrefs)}`);

	const STEERING_PROMPT = `You have access to the ghpr-monitor tool. When the user asks you to watch or monitor a PR, use ghpr-monitor with action "start" to begin monitoring. The tool has actions: start, status, check, merge, and preferences. Multiple PRs/runs can be monitored simultaneously. You must NOT stop monitoring on your own — only the user can stop via /ghpr-monitor off (stops all) or /ghpr-monitor off <PR> (stops specific). The user can also run /ghpr-monitor check to trigger an immediate poll (all PRs or a specific one). You will receive PR status updates as notifications. The url parameter accepts GitHub PR URLs or shorthand like "owner/repo#123". To watch a standalone GitHub Actions workflow run by id, pass run_id with owner+repo (no pr_number): the monitor polls the run until status becomes "completed", then auto-stops and notifies with the conclusion (success, failure, cancelled, etc.). Use action='preferences' to view or update notification prompt preferences. Calling with no value shows current preferences (with defaults); providing a value in JSON writes new preferences. Set a key to null to reset it to default. Use action='merge' to toggle auto-merge when CI passes (if not disabled by the disableMergeTool preference). When enabled, the monitor will notify you to merge the PR once CI turns green.`;

	// Custom message renderer for "ghpr-monitor" messages — shows only the
	// concise summary in the TUI; the agent receives the full content via the
	// UserMessage delivered by sendPRNotification().
	pi.registerMessageRenderer<{ concise: string }>("ghpr-monitor", (message, _options, theme) => {
		const concise = message.details?.concise ?? (typeof message.content === "string" ? message.content : "");
		const box = new Box(1, 0, (t: string) => theme.bg("customMessageBg", t));
		box.addChild(new Text(concise, 0, 0));
		return box;
	});

	// Inject the steering prompt so the LLM knows about the tool.
	pi.on("before_agent_start", async (event, _ctx) => {
		return { systemPrompt: event.systemPrompt + "\n\n" + STEERING_PROMPT };
	});

	// Store session ID for debug logging (activated on demand via /ghpr-monitor debug).
	pi.on("session_start", async (_event, ctx) => {
		const sessionFile = ctx.sessionManager.getSessionFile();
		const id = sessionFile ? path.basename(sessionFile, path.extname(sessionFile)) : `ephemeral-${Date.now()}`;
		setSessionId(id);
	});

	/**
	 * Deliver a notification to both the agent (UserMessage) and the TUI
	 * (CustomMessage). The detailed body is rendered as markdown for the
	 * UserMessage component; the concise summary uses raw OSC-8 for the Text
	 * component. See render.ts/linkifyPRRefs for the format split.
	 */
	function sendPRNotification(concise: string, detailed: string, options?: { deliverAs?: "steer" | "followUp" | "nextTurn"; host?: string; displayOnly?: boolean }) {
		const delivery = options?.deliverAs ?? "steer";
		const linkifyHost = options?.host ?? "github.com";
		const markdownDetailed = linkifyPRRefs(detailed, linkifyHost, "markdown");
		const linkifiedConcise = linkifyPRRefs(concise, linkifyHost, "osc8");

		if (!options?.displayOnly && delivery) {
			pi.sendUserMessage(markdownDetailed, { deliverAs: delivery });
		}

		pi.sendMessage({
			customType: "ghpr-monitor",
			content: markdownDetailed,
			display: !delivery || options?.displayOnly ? true : false,
			details: { concise: linkifiedConcise },
		});
	}

	// Track agent turn state to avoid spamming updates while the LLM is working.
	pi.on("turn_start", () => {
		agentTurnActive = true;
	});

	pi.on("turn_end", () => {
		agentTurnActive = false;
		if (queuedUpdates.length > 0) {
			for (const u of queuedUpdates) {
				sendPRNotification(u.concise, u.detailed, { deliverAs: "steer", host: u.host });
			}
			queuedUpdates = [];
		}
		if (queuedPrCreateNudges.length > 0) {
			for (const nudge of queuedPrCreateNudges) {
				sendPRNotification(nudge.message, nudge.message, { deliverAs: "steer", host: nudge.host });
			}
			queuedPrCreateNudges = [];
		}
		// Wake footers
		updateFooter();
	});

	pi.on("session_shutdown", async () => {
		log("Session shutdown event received");
		stopAllMonitors();
		closeLogger();
	});

	// PR create hook: detect `gh pr create` and nudge the LLM to monitor.
	pi.on("tool_result", async (event) => {
		if (event.toolName !== "bash") return;
		const input = event.input as { command?: string } | undefined;
		const command = input?.command;
		if (!command || !isPRCreateCommand(command)) return;
		if (event.isError) {
			log(`PR create hook: gh pr create failed, skipping nudge`);
			return;
		}
		const content = Array.isArray(event.content)
			? event.content.map((c) => ("text" in c ? c.text : "")).join("\n")
			: String(event.content ?? "");
		const prs = parsePRUrlsFromOutput(content);
		if (prs.length === 0) return;

		const nudgeTemplate = getAdapterPref("prCreateNudge", currentAdapterPrefs) as string | undefined;
		for (const pr of prs) {
			const key = prKey(pr.owner, pr.repo, pr.number, pr.host);
			if (monitors.has(key) || nudgedPRKeys.has(key)) continue;
			nudgedPRKeys.add(key);
			const message = createPRCreateNudge(pr, nudgeTemplate);
			log(`PR create hook: queueing nudge for ${key}`);
			queuedPrCreateNudges.push({ message, host: pr.host });
		}
	});

	// -----------------------------------------------------------------------
	// Monitor lifecycle
	// -----------------------------------------------------------------------

	function startMonitor(config: MonitorConfig): { key: string; message: string; alreadyMonitoring?: boolean } {
		const key = monitorKey(config);
		log(`Starting monitor: ${key} (interval: ${config.intervalSec}s, type: ${config.resourceType})`);

		if (monitors.has(key)) {
			return { key, message: `Already monitoring ${resourceUrl(config)}. Use /ghpr-monitor off ${key} to stop.`, alreadyMonitoring: true };
		}

		const mon = createActiveMonitor(config);
		monitors.set(key, mon);
		updateFooter();

		mon.handle = spawnMonitor(config, {
			onNotification: (n) => handleNotification(key, mon, n),
			onExit: (code, stderr) => handleExit(key, mon, code, stderr),
		});

		return { key, message: `Started monitoring ${resourceUrl(config)} (interval: ${config.intervalSec}s)` };
	}

	function handleNotification(key: string, mon: ActiveMonitor, n: Notification): void {
		if (mon.exited) return;
		updateStateFromNotification(mon.state, n);
		updateFooter();

		const config = mon.config;
		const host = config.host;
		const concise = n.message;
		const detailed = n.detail ? `${n.message}\n\n${n.detail}` : n.message;

		// first-poll is informational: TUI-only, no agent turn.
		if (n.type === "first-poll") {
			pi.sendMessage({
				customType: "ghpr-monitor",
				content: linkifyPRRefs(detailed, host, "markdown"),
				display: true,
				details: { concise: linkifyPRRefs(concise, host, "osc8") },
			});
			return;
		}

		// Auto-merge nudge on CI-green (PRs only, once per green cycle).
		if (n.type === "ci-all-green" && config.autoMerge && !mon.autoMergeNotified) {
			mon.autoMergeNotified = true;
			const vars = makePrefVars(config, n);
			const mergeMsg = interpolatePref(
				getAdapterPref("ciGreenMerge", currentAdapterPrefs) as string,
				vars,
			);
			deliver(concise, `${detailed}\n\n${mergeMsg}`, host, key);
			mon.lastSentUpdate = concise;
			mon.lastNudgeTime = Date.now();
			return;
		}

		// A failing-checks or new-commit event resets the auto-merge flag so a
		// later green can nudge again.
		if (n.type === "new-failing-checks" || n.type === "new-commit") {
			mon.autoMergeNotified = false;
		}

		deliver(concise, detailed, host, key);
		mon.lastSentUpdate = concise;
		mon.lastNudgeTime = Date.now();
	}

	/** Deliver now, or queue for turn_end if the agent is mid-turn. */
	function deliver(concise: string, detailed: string, host: string, monitorKey: string): void {
		if (agentTurnActive) {
			queuedUpdates.push({ concise, detailed, host, monitorKey });
			return;
		}
		sendPRNotification(concise, detailed, { deliverAs: "steer", host });
	}

	function handleExit(key: string, mon: ActiveMonitor, code: number | null, stderr: string): void {
		if (mon.exited) return;
		mon.exited = true;
		mon.handle = null;
		// gh-monitor auto-stops (exit 0) after emitting the terminal event
		// (merged/closed/run-completed/issue-closed), so a clean exit is
		// expected. A nonzero exit is a real error.
		if (code !== null && code !== 0) {
			const errMsg = `Monitor error for ${key}: gh monitor exited ${code}${stderr ? ` — ${stderr.trim()}` : ""}`;
			log(errMsg);
			uiCtx?.notify(errMsg, "error");
		} else {
			log(`Monitor ${key} exited cleanly`);
		}
		monitors.delete(key);
		updateFooter();
	}

	function stopMonitorByKey(key: string): string {
		log(`Stopping monitor: ${key}`);
		const mon = monitors.get(key);
		if (!mon) return `Not monitoring ${key}`;
		mon.exited = true;
		mon.handle?.abort();
		mon.handle = null;
		monitors.delete(key);
		updateFooter();
		return `Stopped monitoring ${resourceUrl(mon.config)}`;
	}

	function stopAllMonitors(): string {
		log("Stopping all monitors");
		if (monitors.size === 0) return "No monitors running";
		const keys = [...monitors.keys()];
		for (const [, mon] of monitors) {
			mon.exited = true;
			mon.handle?.abort();
			mon.handle = null;
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
			uiCtx.setStatus("ghpr-monitor", linkifyPRRefs(formatFooterStatus(mon.config, mon.state), mon.config.host));
			return;
		}
		const lines: string[] = [];
		for (const mon of monitors.values()) {
			lines.push(linkifyPRRefs(formatFooterStatus(mon.config, mon.state), mon.config.host));
		}
		uiCtx.setStatus("ghpr-monitor", lines.join("\n"));
	}

	/** Build the {token} vars for pi-specific pref templates (ciGreenMerge, …). */
	function makePrefVars(config: MonitorConfig, n: Notification) {
		const prLabel =
			config.resourceType === "run"
				? `${config.owner}/${config.repo} run #${config.runId}`
				: `${config.owner}/${config.repo}#${config.number}`;
		return {
			owner: config.owner,
			repo: config.repo,
			number: config.number,
			host: config.host,
			prLabel,
			prUrl: resourceUrl(config),
			commitOid: "",
			commitShortOid: n.commit_short_oid ?? "",
			commitUrl: n.commit_url ?? "",
			commitAuthor: n.commit_author ?? "",
			commitCoauthors: "",
			commitMessageHeadline: "",
		};
	}

	// -----------------------------------------------------------------------
	// Force-check: a one-shot `gh monitor --once` for a target.
	// -----------------------------------------------------------------------

	async function forceCheck(config: MonitorConfig): Promise<void> {
		const key = monitorKey(config);
		try {
			const events = await spawnOnce(config);
			// If not currently monitored, still surface the one-shot result.
			const mon = monitors.get(key);
			for (const n of events) {
				if (mon && !mon.exited) updateStateFromNotification(mon.state, n);
				const concise = n.message;
				const detailed = n.detail ? `${n.message}\n\n${n.detail}` : n.message;
				if (agentTurnActive) {
					queuedUpdates.push({ concise, detailed, host: config.host, monitorKey: key });
				} else {
					sendPRNotification(concise, detailed, { deliverAs: "steer", host: config.host });
				}
			}
			if (mon) mon.lastNudgeTime = Date.now();
			updateFooter();
		} catch (err) {
			const msg = `Check failed for ${key}: ${err instanceof Error ? err.message : String(err)}`;
			log(msg);
			uiCtx?.notify(msg, "warning");
		}
	}

	// -----------------------------------------------------------------------
	// Status display
	// -----------------------------------------------------------------------

	function buildDetailedStatusLines(): string[] {
		if (monitors.size === 0) return [];
		const lines: string[] = [`Monitoring ${monitors.size} resource(s):`];
		for (const [key, mon] of monitors) {
			lines.push(`${key}: ${formatMonitorStatusLine(mon.config, mon.state)}`);
		}
		return lines;
	}

	function formatCurrentStatus(): string {
		if (monitors.size === 0) return "";
		const lines: string[] = [];
		for (const mon of monitors.values()) {
			lines.push(formatMonitorStatusLine(mon.config, mon.state));
		}
		return lines.join("\n\n");
	}

	// -----------------------------------------------------------------------
	// /ghpr-monitor command
	// -----------------------------------------------------------------------

	pi.registerCommand("ghpr-monitor", {
		description: "Monitor PRs: /ghpr-monitor ! | start — /ghpr-monitor [PR URL] — /ghpr-monitor status — /ghpr-monitor check [PR] — /ghpr-monitor off [PR] — leave blank to show status/usage",
		getArgumentCompletions: (prefix: string) => {
			const completions = ["!", "start", "on", "off", "stop", "check", "status", "merge", "preferences", "debug", "https://github.com"];
			for (const key of monitors.keys()) completions.push(key);
			return completions.filter((c) => c.startsWith(prefix)).map((c) => ({ value: c, label: c }));
		},
		handler: async (args, ctx) => {
			uiCtx = ctx.ui;
			const raw = args.trim();

			if (raw === "!" || raw.toLowerCase() === "start") {
				pi.sendUserMessage("Monitor the current pull request using ghpr-monitor.", { deliverAs: "steer" });
				return;
			}

			if (raw.toLowerCase() === "debug") {
				if (isDebugEnabled()) { disableDebug(); ctx.ui.notify("Debug logging disabled.", "info"); }
				else { enableDebug(); ctx.ui.notify(`Debug logging enabled. Log: ${getLogPath()}`, "info"); }
				return;
			}

			if (raw.toLowerCase().startsWith("off") || raw.toLowerCase().startsWith("stop")) {
				const rest = raw.replace(/^(off|stop)\s*/i, "").trim();
				if (!rest) { ctx.ui.notify(stopAllMonitors(), "info"); return; }
				const targetKey = resolveMonitorKey(rest);
				if (targetKey) ctx.ui.notify(stopMonitorByKey(targetKey), "info");
				else ctx.ui.notify(`Unknown PR: ${rest}. Currently monitoring: ${[...monitors.keys()].join(", ") || "none"}`, "warning");
				return;
			}

			if (raw.toLowerCase() === "status") {
				if (monitors.size === 0) {
					ctx.ui.notify("No PR monitors running.\n  Start one with: /ghpr-monitor ! (current branch) or /ghpr-monitor <PR URL>", "info");
					return;
				}
				const conciseStatus = formatCurrentStatus();
				const detailedStatus = buildDetailedStatusLines().join("\n");
				pi.sendMessage({ customType: "ghpr-monitor", content: detailedStatus, display: true, details: { concise: conciseStatus } }, { deliverAs: "nextTurn" });
				return;
			}

			if (raw.toLowerCase() === "check" || raw.toLowerCase().startsWith("check ")) {
				const rest = raw.replace(/^check\s*/i, "").trim();
				if (monitors.size === 0) { ctx.ui.notify("No monitors running. Start one first with /ghpr-monitor <PR URL>", "warning"); return; }
				if (!rest) {
					for (const mon of monitors.values()) void forceCheck(mon.config);
					ctx.ui.notify(`Checking all ${monitors.size} monitor(s)...`, "info");
				} else {
					const targetKey = resolveMonitorKey(rest);
					const mon = targetKey ? monitors.get(targetKey) : undefined;
					if (mon) { void forceCheck(mon.config); ctx.ui.notify(`Checking ${targetKey} now...`, "info"); }
					else ctx.ui.notify(`Unknown PR: ${rest}. Currently monitoring: ${[...monitors.keys()].join(", ")}`, "warning");
				}
				return;
			}

			if (raw.toLowerCase() === "merge" || raw.toLowerCase().startsWith("merge ")) {
				const rest = raw.replace(/^merge\s*/i, "").trim();
				const target = rest ? resolveMonitorKey(rest) : monitors.size === 1 ? [...monitors.keys()][0] : null;
				if (rest && !target) { ctx.ui.notify(`Unknown PR: ${rest}. Currently monitoring: ${[...monitors.keys()].join(", ") || "none"}`, "warning"); return; }
				if (!rest && monitors.size !== 1) {
					const auto = [...monitors.entries()].filter(([, m]) => m.config.autoMerge);
					if (auto.length === 0) ctx.ui.notify("No monitors have auto-merge enabled.\n  Toggle with: /ghpr-monitor merge <PR>", "info");
					else ctx.ui.notify(`Auto-merge enabled on:\n${auto.map(([k]) => `  ${k}: auto-merge ON`).join("\n")}`, "info");
					return;
				}
				const mon = target ? monitors.get(target) : undefined;
				if (!mon) { ctx.ui.notify(`Not monitoring ${target}.`, "warning"); return; }
				mon.config.autoMerge = !mon.config.autoMerge;
				ctx.ui.notify(`Auto-merge ${mon.config.autoMerge ? "enabled" : "disabled"} for ${target}.${mon.config.autoMerge ? " The monitor will notify to merge when CI passes." : ""}`, "info");
				return;
			}

			if (raw.toLowerCase() === "on" || raw === "") {
				if (monitors.size > 0) { ctx.ui.notify(formatCurrentStatus(), "info"); return; }
				ctx.ui.notify("No PR monitors running.\n  Start one with: /ghpr-monitor ! (current branch) or /ghpr-monitor <PR URL>", "info");
				return;
			}

			// Issue URL
			const issueParsed = parseIssueUrl(raw);
			if (issueParsed) {
				const urlMatch = raw.trim().match(/^https?:\/\/[^/]+\/[^/]+\/[^/]+\/issues\/[0-9]+/i);
				const afterUrl = urlMatch ? raw.trim().slice(urlMatch[0].length).trim() : "";
				const steerMessage = afterUrl && !/^[\/?#]/.test(afterUrl) ? afterUrl : undefined;
				const result = startMonitor(makeConfig(issueParsed, "issue"));
				ctx.ui.notify(result.message, result.alreadyMonitoring ? "warning" : "info");
				if (steerMessage) pi.sendUserMessage(steerMessage, { deliverAs: "steer" });
				return;
			}

			// Run URL
			const runParsed = parseRunUrl(raw);
			if (runParsed) {
				const result = startMonitor(makeRunConfig(runParsed));
				ctx.ui.notify(result.message, result.alreadyMonitoring ? "warning" : "info");
				return;
			}

			// PR URL
			const parsed = parsePRUrl(raw);
			if (parsed) {
				const urlMatch = raw.trim().match(/^https?:\/\/[^/]+\/[^/]+\/[^/]+\/pull\/[0-9]+/i);
				const afterUrl = urlMatch ? raw.trim().slice(urlMatch[0].length).trim() : "";
				const steerMessage = afterUrl && !/^[\/?#]/.test(afterUrl) ? afterUrl : undefined;
				const result = startMonitor(makeConfig(parsed, "pr"));
				ctx.ui.notify(result.message, result.alreadyMonitoring ? "warning" : "info");
				if (steerMessage) pi.sendUserMessage(steerMessage, { deliverAs: "steer" });
				return;
			}

			// Shorthand owner/repo#123
			const shorthand = parsePRShorthand(raw);
			if (shorthand) {
				const result = startMonitor(makeConfig(shorthand, "pr"));
				ctx.ui.notify(result.message, result.alreadyMonitoring ? "warning" : "info");
				return;
			}

			// owner/repo <number> [message]
			const parts = raw.split(/\s+/);
			if (parts.length >= 2 && parts[0].includes("/")) {
				const [ownerRepo, numStr] = [parts[0], parts[1]];
				const [owner, repo] = ownerRepo.split("/");
				const number = parseInt(numStr, 10);
				if (!owner || !repo || isNaN(number)) { ctx.ui.notify("Invalid format. Use: /ghpr-monitor owner/repo#123 or owner/repo <pr-number> [message]", "error"); return; }
				const steerMessage = parts.length > 2 ? parts.slice(2).join(" ") : undefined;
				const result = startMonitor(makeConfig({ owner, repo, number, host: "github.com" }, "pr"));
				ctx.ui.notify(result.message, result.alreadyMonitoring ? "warning" : "info");
				if (steerMessage) pi.sendUserMessage(steerMessage, { deliverAs: "steer" });
				return;
			}

			ctx.ui.notify(
				"Usage:\n  /ghpr-monitor ! | start — monitor current branch's PR (injects prompt for LLM)\n  /ghpr-monitor <PR URL> — paste a GH PR URL (TUI-only, no LLM turn)\n  /ghpr-monitor owner/repo#123\n  /ghpr-monitor owner/repo <pr-number> [message]\n  /ghpr-monitor <Actions run URL> — watch a single workflow run until it completes\n  /ghpr-monitor check [PR] — check now (all or specific)\n  /ghpr-monitor merge [PR] — toggle auto-merge when CI passes\n  /ghpr-monitor off [PR] — stop monitoring (all or specific)",
				"info",
			);
		},
	});

	function makeConfig(p: ParsedSelector, resourceType: ResourceType): MonitorConfig {
		return {
			owner: p.owner,
			repo: p.repo,
			number: p.number,
			host: p.host,
			resourceType,
			mode: "all",
			intervalSec: MOCK_INTERVAL_SECS ? Math.max(1, MOCK_INTERVAL_SECS) : 60,
		};
	}

	function makeRunConfig(p: ParsedRun): MonitorConfig {
		return {
			owner: p.owner,
			repo: p.repo,
			number: 0,
			host: p.host,
			resourceType: "run",
			mode: "all",
			intervalSec: MOCK_INTERVAL_SECS ? Math.max(1, MOCK_INTERVAL_SECS) : 60,
			runId: p.runId,
		};
	}

	function resolveMonitorKey(input: string): string | null {
		const trimmed = input.trim();
		if (monitors.has(trimmed)) return trimmed;
		const parsed = parseIssueUrl(trimmed) || parsePRUrl(trimmed) || parsePRShorthand(trimmed);
		if (parsed) {
			const key = prKey(parsed.owner, parsed.repo, parsed.number, parsed.host);
			if (monitors.has(key)) return key;
		}
		const runParsed = parseRunUrl(trimmed);
		if (runParsed) {
			const key = runKey(runParsed.owner, runParsed.repo, runParsed.runId, runParsed.host);
			if (monitors.has(key)) return key;
		}
		for (const key of monitors.keys()) {
			if (key.endsWith(`#${trimmed}`) || key.endsWith(`@run/${trimmed}`) || key === trimmed) return key;
		}
		return null;
	}

	// -----------------------------------------------------------------------
	// ghpr-monitor tool (LLM-callable)
	// -----------------------------------------------------------------------

	const GhprMonitorParams = Type.Object({
		action: Type.Union([Type.Literal("start"), Type.Literal("status"), Type.Literal("check"), Type.Literal("merge"), Type.Literal("preferences")]),
		url: Type.Optional(Type.String({ description: "GitHub PR URL (e.g. https://github.com/owner/repo/pull/123), issue URL, Actions run URL, or shorthand (e.g. owner/repo#123)." })),
		owner: Type.Optional(Type.String({ description: "Repository owner (e.g. 'elecnix')" })),
		repo: Type.Optional(Type.String({ description: "Repository name" })),
		pr_number: Type.Optional(Type.Number({ description: "Pull request or issue number" })),
		run_id: Type.Optional(Type.Number({ description: "GitHub Actions workflow run id to monitor (watches a single run until it completes). Mutually exclusive with pr_number/url; requires owner+repo." })),
		mode: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("comments"), Type.Literal("conflicts"), Type.Literal("actions")])),
		interval: Type.Optional(Type.Number({ description: "Polling interval in seconds (default: 60, minimum: 10)" })),
		value: Type.Optional(Type.String({ description: "For preferences action: JSON string with preference overrides. Omit to read current preferences." })),
	}) as any;

	pi.registerTool({
		name: "ghpr-monitor",
		label: "GH PR Monitor",
		description:
			"Monitor GitHub pull requests for comments, conflicts, and CI status changes, or watch a standalone GitHub Actions workflow run by run_id. Supports monitoring multiple PRs/runs simultaneously. Use action='start' with a 'url' (GitHub PR URL) or with owner+repo+pr_number to begin monitoring a PR. Use action='start' with run_id plus owner+repo to watch a single workflow run until it completes — the monitor polls the run and auto-stops when status becomes 'completed', emitting a notification with the conclusion. Use action='status' to list all currently monitored PRs/runs. Use action='check' to trigger an immediate poll. Use action='preferences' to view or update notification prompt preferences. The agent cannot stop monitoring — only the user can stop via /ghpr-monitor off.",
		promptSnippet: "Monitor GitHub PRs for changes (comments, conflicts, CI failures)",
		promptGuidelines: [
			"When the user asks you to watch or monitor a PR, use ghpr-monitor with action='start'.",
			"Multiple PRs can be monitored at the same time — start a new monitor without stopping existing ones.",
			"Accept a GitHub PR URL, shorthand like 'owner/repo#123', or separate owner/repo/pr_number.",
			"To watch a standalone GitHub Actions workflow run, pass run_id with owner+repo (no pr_number). The monitor polls the run until status == 'completed', then auto-stops and notifies with the conclusion (success, failure, cancelled, etc.).",
			"Use action='status' to see all currently monitored PRs/runs.",
			"Use action='check' to trigger an immediate poll.",
			"Use action='merge' to toggle auto-merge when CI passes (if not disabled by the disableMergeTool preference). When enabled, the monitor will notify you to merge the PR once CI turns green.",
			"Use action='preferences' to view current preferences or update them with a value parameter.",
			"The value parameter for preferences is a JSON string. gh-monitor-owned keys: templates (map of event-kind → template string|null), ignoredBots (array of strings), retriggerComments (boolean). Pi-specific keys: disableMergeTool (boolean), prCreateNudge (string), ciGreenMerge (string). Set any key to null to reset it to default.",
			"Event kinds for templates: new-unresolved-threads, new-general-comments, conflict, new-failing-checks, ci-all-green, review-approved, review-changes-requested, review-dismissed, new-commit, merged, closed, first-poll, all-clear, issue-closed, issue-reopened, issue-new-comment, issue-mention, run-queued, run-in-progress, run-completed.",
			"Template variables: {owner}, {repo}, {number}, {host}, {prLabel}, {prUrl}, {unresolvedThreads}, {generalComments}, {failingChecks}, {conflict}, {commitOid}, {commitShortOid}, {commitUrl}, {commitAuthor}, {commitCoauthors}, {commitMessageHeadline}, {runId}, {runName}, {runNumber}, {runEvent}, {runStatus}, {runConclusion}, {runBranch}, {runUrl}.",
			"Do NOT stop monitoring on your own. Only the user can stop monitoring via /ghpr-monitor off.",
			"Monitoring runs until the user stops it via /ghpr-monitor off, or the PR is merged/closed (run until completed).",
			"You will receive PR status updates as notifications.",
		],
		parameters: GhprMonitorParams,

		async execute(_toolCallId, params: Static<typeof GhprMonitorParams>, _signal, _onUpdate, _ctx) {
			uiCtx = _ctx.ui;

			function resolvePR(): { owner: string; repo: string; number: number; host: string; resourceType: ResourceType } | { error: string } {
				let resolvedOwner: string | undefined;
				let resolvedRepo: string | undefined;
				let resolvedNumber: number | undefined;
				let resolvedHost = "github.com";
				let resolvedType: ResourceType = "pr";

				if (params.url) {
					const issueParsed = parseIssueUrl(params.url);
					if (issueParsed) {
						resolvedOwner = issueParsed.owner; resolvedRepo = issueParsed.repo; resolvedNumber = issueParsed.number; resolvedHost = issueParsed.host; resolvedType = "issue";
					} else {
						const parsed = parsePRUrl(params.url) || parsePRShorthand(params.url);
						if (!parsed) return { error: `Invalid PR/issue URL or shorthand: ${params.url}. Expected format: https://github.com/owner/repo/pull/123, https://github.com/owner/repo/issues/123, or owner/repo#123` };
						resolvedOwner = parsed.owner; resolvedRepo = parsed.repo; resolvedNumber = parsed.number; resolvedHost = parsed.host;
					}
				} else {
					resolvedOwner = params.owner; resolvedRepo = params.repo; resolvedNumber = params.pr_number;
				}

				if (!resolvedOwner || !resolvedRepo || !resolvedNumber) {
					return { error: ["Missing required parameters.", "", "Usage:", "  ghpr-monitor(action='start', url='https://github.com/owner/repo/pull/123')", "  ghpr-monitor(action='start', url='owner/repo#123')", "  ghpr-monitor(action='start', owner='o', repo='r', pr_number=42)", "  ghpr-monitor(action='check') — trigger an immediate poll", "  /ghpr-monitor off [PR] — stop monitoring (user only)", "  ghpr-monitor(action='status') — list all monitored PRs/issues"].join("\n") };
				}
				return { owner: resolvedOwner, repo: resolvedRepo, number: resolvedNumber, host: resolvedHost, resourceType: resolvedType };
			}

			switch (params.action) {
				case "start": {
					if (params.run_id) {
						if (!params.owner || !params.repo) {
							return { content: [{ type: "text", text: "run_id requires owner and repo. Example: ghpr-monitor(action='start', owner='owner', repo='repo', run_id=30433642)" }], details: { action: "start", status: "missing_params", target: "run" } };
						}
						const config: MonitorConfig = { owner: params.owner, repo: params.repo, number: 0, host: "github.com", resourceType: "run", mode: params.mode || "all", intervalSec: Math.max(10, params.interval || 60), runId: params.run_id };
						const result = startMonitor(config);
						return { content: [{ type: "text", text: result.message }], details: { action: "start", status: result.alreadyMonitoring ? "already_running" : "started", config, activeMonitors: monitors.size } };
					}
					const resolved = resolvePR();
					if ("error" in resolved) return { content: [{ type: "text", text: resolved.error }], details: { action: "start", status: "missing_params" } };
					const config: MonitorConfig = { owner: resolved.owner, repo: resolved.repo, number: resolved.number, host: resolved.host, resourceType: resolved.resourceType, mode: params.mode || "all", intervalSec: Math.max(10, params.interval || 60) };
					const result = startMonitor(config);
					return { content: [{ type: "text", text: result.message }], details: { action: "start", status: result.alreadyMonitoring ? "already_running" : "started", config, activeMonitors: monitors.size } };
				}

				case "status": {
					if (monitors.size === 0) return { content: [{ type: "text", text: "No PR monitors are currently active." }], details: { action: "status", status: "idle", activeMonitors: 0 } };
					const detailedStatus = buildDetailedStatusLines().join("\n");
					return { content: [{ type: "text", text: detailedStatus }], details: { action: "status", status: "running", activeMonitors: monitors.size, monitors: [...monitors.entries()].map(([key, mon]) => ({ key, config: mon.config, state: mon.state })) } };
				}

				case "check": {
					if (monitors.size === 0) return { content: [{ type: "text", text: "No monitors are currently active. Start one first with action='start'." }], details: { action: "check", status: "idle" } };
					if (params.run_id) {
						if (!params.owner || !params.repo) return { content: [{ type: "text", text: "run_id requires owner and repo." }], details: { action: "check", status: "missing_params", target: "run" } };
						const key = runKey(params.owner, params.repo, params.run_id);
						const mon = monitors.get(key);
						if (!mon) return { content: [{ type: "text", text: `Not monitoring ${key}. Currently monitoring: ${[...monitors.keys()].join(", ")}` }], details: { action: "check", status: "not_found", target: "run" } };
						void forceCheck(mon.config);
						return { content: [{ type: "text", text: `Checking ${key} now...` }], details: { action: "check", status: "triggered", config: mon.config } };
					}
					if (params.url || params.owner) {
						const resolved = resolvePR();
						if ("error" in resolved) return { content: [{ type: "text", text: resolved.error }], details: { action: "check", status: "missing_params" } };
						const key = prKey(resolved.owner, resolved.repo, resolved.number, resolved.host);
						const mon = monitors.get(key);
						if (!mon) return { content: [{ type: "text", text: `Not monitoring ${key}. Currently monitoring: ${[...monitors.keys()].join(", ")}` }], details: { action: "check", status: "not_found" } };
						void forceCheck(mon.config);
						return { content: [{ type: "text", text: `Checking ${key} now...` }], details: { action: "check", status: "triggered", config: mon.config } };
					}
					for (const mon of monitors.values()) void forceCheck(mon.config);
					return { content: [{ type: "text", text: `Checking all ${monitors.size} monitor(s)...` }], details: { action: "check", status: "triggered_all", activeMonitors: monitors.size } };
				}

				case "merge": {
					const mergeDisabled = (getAdapterPref("disableMergeTool", currentAdapterPrefs) as boolean) ?? DEFAULT_DISABLE_MERGE_TOOL;
					if (mergeDisabled) return { content: [{ type: "text", text: "The merge tool action is disabled for the agent. The user can toggle auto-merge via /ghpr-monitor merge." }], details: { action: "merge", status: "disabled" } };
					if (monitors.size === 0) return { content: [{ type: "text", text: "No monitors are currently active. Start one first with action='start'." }], details: { action: "merge", status: "idle" } };
					const resolved = resolvePR();
					if ("error" in resolved) return { content: [{ type: "text", text: resolved.error }], details: { action: "merge", status: "missing_params" } };
					const key = prKey(resolved.owner, resolved.repo, resolved.number, resolved.host);
					const mon = monitors.get(key);
					if (!mon) return { content: [{ type: "text", text: `Not monitoring ${key}. Currently monitoring: ${[...monitors.keys()].join(", ")}` }], details: { action: "merge", status: "not_found" } };
					mon.config.autoMerge = !mon.config.autoMerge;
					const msg = mon.config.autoMerge ? `Auto-merge enabled for ${key}. The monitor will notify you to merge when CI passes.` : `Auto-merge disabled for ${key}.`;
					return { content: [{ type: "text", text: msg }], details: { action: "merge", status: "toggled", autoMerge: mon.config.autoMerge, config: mon.config } };
				}

				case "preferences": {
					return await handlePreferencesAction(params.value);
				}

				default: {
					const _exhaustiveCheck: never = params.action as never;
					return { content: [{ type: "text", text: `Unknown action: ${_exhaustiveCheck}` }], details: { action: _exhaustiveCheck, status: "unknown" } };
				}
			}
		},
	});

	// -----------------------------------------------------------------------
	// Preferences action: delegate templates to `gh monitor prefs`, keep
	// pi-specific keys in adapter-prefs.
	// -----------------------------------------------------------------------

	async function handlePreferencesAction(value: string | undefined) {
		const ghKeys = ["templates", "ignoredBots", "retriggerComments"];
		const piKeys = ["disableMergeTool", "prCreateNudge", "ciGreenMerge"];

		if (value !== undefined && value !== "") {
			let parsed: Record<string, unknown>;
			try {
				parsed = JSON.parse(value);
			} catch (e) {
				return { content: [{ type: "text", text: `Invalid preferences JSON: ${e instanceof Error ? e.message : String(e)}` }], details: { action: "preferences", status: "validation_error" } };
			}

			// Split into gh-monitor-owned and pi-specific keys.
			const ghSubset: Record<string, unknown> = {};
			const piSubset: AdapterPrefs = {};
			const unknown: string[] = [];
			for (const [k, v] of Object.entries(parsed)) {
				if (ghKeys.includes(k)) ghSubset[k] = v;
				else if (piKeys.includes(k)) (piSubset as Record<string, unknown>)[k] = v;
				else unknown.push(k);
			}
			if (unknown.length > 0) {
				return { content: [{ type: "text", text: `Unknown preference keys: ${unknown.join(", ")}. Valid keys: ${[...ghKeys, ...piKeys].join(", ")}` }], details: { action: "preferences", status: "validation_error", unknown } };
			}

			// Apply gh-monitor keys (if any) via the CLI.
			let ghPrefs;
			if (Object.keys(ghSubset).length > 0) {
				try {
					ghPrefs = await prefsSet(JSON.stringify(ghSubset));
				} catch (e) {
					return { content: [{ type: "text", text: `gh monitor prefs set failed: ${e instanceof Error ? e.message : String(e)}` }], details: { action: "preferences", status: "gh_error" } };
				}
			}

			// Apply pi-specific keys (if any) locally.
			if (Object.keys(piSubset).length > 0) {
				currentAdapterPrefs = saveAdapterPrefs(piSubset);
			}

			const display = await buildPrefsDisplay(ghPrefs);
			return {
				content: [{ type: "text", text: `Preferences saved.\ngh-monitor file: ${await prefsPath().catch(() => "(unknown)")}\npi-adapter file: ${adapterPrefsPath()}\n\n${display}` }],
				details: { action: "preferences", status: "saved", ghPrefs, adapterPrefs: currentAdapterPrefs },
			};
		}

		// Read mode.
		const display = await buildPrefsDisplay();
		return {
			content: [{ type: "text", text: display }],
			details: { action: "preferences", status: "read", adapterPrefs: currentAdapterPrefs },
		};
	}

	async function buildPrefsDisplay(ghPrefs?: unknown): Promise<string> {
		let gh: { templates?: Record<string, string>; ignoredBots?: string[]; retriggerComments?: boolean } = {};
		if (ghPrefs) {
			gh = ghPrefs as typeof gh;
		} else {
			try { gh = await prefsGet(); } catch (e) { gh = { templates: {}, ignoredBots: [], retriggerComments: false, _error: `${e instanceof Error ? e.message : String(e)}` } as unknown as typeof gh; }
		}
		const lines: string[] = [];
		lines.push("Notification templates (gh-monitor):");
		if ((gh as unknown as { _error?: string })._error) {
			lines.push(`  (could not read gh-monitor prefs: ${(gh as unknown as { _error?: string })._error})`);
		} else {
			lines.push(`  ignoredBots: ${JSON.stringify(gh.ignoredBots ?? [])}`);
			lines.push(`  retriggerComments: ${JSON.stringify(gh.retriggerComments ?? false)}`);
			lines.push(`  templates: ${JSON.stringify(gh.templates ?? {}, null, 2)}`);
		}
		lines.push("");
		lines.push("Pi-specific (adapter):");
		lines.push(`  disableMergeTool: ${JSON.stringify(getAdapterPref("disableMergeTool", currentAdapterPrefs))} (default: ${DEFAULT_DISABLE_MERGE_TOOL})`);
		lines.push(`  prCreateNudge: ${JSON.stringify(getAdapterPref("prCreateNudge", currentAdapterPrefs))}`);
		lines.push(`  ciGreenMerge: ${JSON.stringify(getAdapterPref("ciGreenMerge", currentAdapterPrefs))}`);
		lines.push("");
		lines.push(`Set with: ghpr-monitor(action='preferences', value='{"templates":{"conflict":"..."}, "disableMergeTool":true}')`);
		lines.push(`Keys: templates, ignoredBots, retriggerComments (gh-monitor); disableMergeTool, prCreateNudge, ciGreenMerge (pi). Set a key to null to reset.`);
		return lines.join("\n");
	}
}