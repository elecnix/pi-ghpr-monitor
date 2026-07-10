/**
 * Pi-TUI rendering helpers for the gh-monitor adapter.
 *
 * `linkifyPRRefs` is ported verbatim from the old analyzer.ts: it wraps PR/issue
 * refs, commit URLs, and full PR URLs in OSC-8 (terminal) or markdown (LLM)
 * hyperlinks, protecting already-linkified spans from double-wrapping. This is
 * pure presentation logic and stays in the adapter — `gh monitor` does not know
 * about pi-tui's Markdown-vs-Text rendering distinction.
 *
 * `MonitorState` is a small per-monitor summary the adapter maintains from the
 * gh-monitor event stream (each Notification carries the current
 * unresolved-thread / general-comment counts, and events toggle conflict /
 * failing-check / run-status flags). It drives the footer and `/ghpr-monitor
 * status` display without re-fetching.
 */

import type { MonitorConfig } from "./keys";

// ---------------------------------------------------------------------------
// Hyperlink rendering (ported from analyzer.ts)
// ---------------------------------------------------------------------------

/**
 * Wrap PR refs, commit URLs, and full PR URLs in hyperlinks.
 *
 * @param text       Plain text containing owner/repo#number refs and/or URLs.
 * @param defaultHost Host used to build URLs for bare owner/repo#number refs.
 * @param format     "osc8" for terminal Text rendering, "markdown" for the
 *                   UserMessage Markdown renderer.
 */
export function linkifyPRRefs(
	text: string,
	defaultHost: string = "github.com",
	format: "osc8" | "markdown" = "osc8",
): string {
	const link = (url: string, display: string): string =>
		format === "markdown"
			? `[${display}](${url})`
			: `\x1b]8;;${url}\x1b\\${display}\x1b]8;;\x1b\\`;

	const protectedSpans: string[] = [];
	const oscPattern = /\x1b\]8;;[^\x1b]*\x1b\\[^\x1b]*\x1b\]8;;\x1b\\/g;
	const markdownLinkPattern = /\[[^\]]*\]\([^)]*\)/g;

	function protectLinks(): void {
		const pattern = format === "markdown" ? markdownLinkPattern : oscPattern;
		text = text.replace(pattern, (match) => {
			const placeholder = `\x00LINK${protectedSpans.length}\x00`;
			protectedSpans.push(match);
			return placeholder;
		});
	}

	protectLinks();

	const urlPattern = /https?:\/\/([^\/\s]+)\/([^\/\s]+)\/([^\/\s]+)\/pull\/([0-9]+)\b/g;
	text = text.replace(urlPattern, (_match, host: string, owner: string, repo: string, number: string) => {
		const url = `https://${host}/${owner}/${repo}/pull/${number}`;
		const label = `${owner}/${repo}#${number}`;
		return link(url, label);
	});

	protectLinks();

	const commitUrlPattern = /https?:\/\/([^\/\s]+)\/([^\/\s]+)\/([^\/\s]+)\/commit\/([0-9a-f]{7,40})\b/gi;
	text = text.replace(commitUrlPattern, (_match, host: string, owner: string, repo: string, sha: string) => {
		const url = `https://${host}/${owner}/${repo}/commit/${sha}`;
		const shortSha = sha.slice(0, 7);
		return link(url, shortSha);
	});

	protectLinks();

	const refPattern = /([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)#([0-9]+)\b/g;
	text = text.replace(refPattern, (_match, owner: string, repo: string, number: string) => {
		const url = `https://${defaultHost}/${owner}/${repo}/pull/${number}`;
		return link(url, `${owner}/${repo}#${number}`);
	});

	for (let i = protectedSpans.length - 1; i >= 0; i--) {
		text = text.replace(`\x00LINK${i}\x00`, protectedSpans[i]!);
	}

	return text;
}

// ---------------------------------------------------------------------------
// Per-monitor state derived from the gh-monitor event stream
// ---------------------------------------------------------------------------

/**
 * A compact summary of a monitor's current state, maintained from the
 * Notification stream. Counts come from every PR/issue event; flags toggle on
 * the relevant event kinds.
 */
export interface MonitorState {
	unresolvedThreads: number;
	generalComments: number;
	failingChecks: string[];
	hasConflict: boolean;
	/** Workflow-run status (queued/in_progress/completed) for run monitors. */
	runStatus?: string;
	runConclusion?: string;
	/** The last event kind seen, e.g. "new-unresolved-threads" or "first-poll". */
	lastEventType?: string;
	lastMessage?: string;
	lastChecked: Date | null;
}

export function emptyMonitorState(): MonitorState {
	return {
		unresolvedThreads: 0,
		generalComments: 0,
		failingChecks: [],
		hasConflict: false,
		lastChecked: null,
	};
}

/**
 * Fold a gh-monitor Notification into the per-monitor state.
 *
 * PR/issue events always carry the current unresolved-thread and
 * general-comment counts. `new-failing-checks` replaces the failing list;
 * `ci-all-green` clears it. `conflict` sets the flag (gh-monitor emits no
 * conflict-cleared event, so the flag is sticky). Run events set runStatus /
 * runConclusion.
 */
export function updateStateFromNotification(state: MonitorState, n: Notification): void {
	state.lastEventType = n.type;
	state.lastMessage = n.message;
	state.lastChecked = new Date();

	// Counts are present on PR (and issue) notifications.
	if (typeof n.unresolved_threads === "number") state.unresolvedThreads = n.unresolved_threads;
	if (typeof n.general_comments === "number") state.generalComments = n.general_comments;

	switch (n.type) {
		case "new-failing-checks":
			state.failingChecks = n.failing_checks && n.failing_checks.length > 0 ? [...n.failing_checks] : state.failingChecks;
			break;
		case "ci-all-green":
			state.failingChecks = [];
			break;
		case "conflict":
			state.hasConflict = true;
			break;
		case "run-queued":
		case "run-in-progress":
			state.runStatus = n.type === "run-queued" ? "queued" : "in_progress";
			break;
		case "run-completed":
			state.runStatus = "completed";
			state.runConclusion = n.conclusion || "";
			break;
		default:
			break;
	}
}

// ---------------------------------------------------------------------------
// Footer + status display
// ---------------------------------------------------------------------------

/** A minimal Notification shape — only the fields the state/footer need. */
export interface Notification {
	type: string;
	pr_label?: string;
	message: string;
	unresolved_threads?: number;
	general_comments?: number;
	failing_checks?: string[];
	commit_short_oid?: string;
	commit_author?: string;
	review_author?: string;
	detail?: string;
	pr_url?: string;
	commit_url?: string;
	run_id?: number;
	conclusion?: string;
	timestamp?: string;
}

/**
 * Format a footer status line for the TUI status bar.
 * Shows the resource URL with emoji indicators for each issue type.
 */
export function formatFooterStatus(config: MonitorConfig, state: MonitorState | null): string {
	const url =
		config.resourceType === "run"
			? `https://${config.host}/${config.owner}/${config.repo}/actions/runs/${config.runId}`
			: config.resourceType === "issue"
				? `https://${config.host}/${config.owner}/${config.repo}/issues/${config.number}`
				: `https://${config.host}/${config.owner}/${config.repo}/pull/${config.number}`;

	if (config.resourceType === "run") {
		if (!state || !state.runStatus) return `📡 ${url}`;
		const conclusion = state.runConclusion ? ` ${state.runConclusion}` : "";
		return `📡 ${url} ${state.runStatus}${conclusion}`;
	}

	if (!state) return `📡 ${url}`;
	const emojis: string[] = [];
	if (state.hasConflict) emojis.push("⚠️");
	if (state.unresolvedThreads > 0) emojis.push("💬");
	if (state.generalComments > 0) emojis.push("💭");
	if (state.failingChecks.length > 0) emojis.push("❌");
	return emojis.length > 0 ? `📡 ${url} ${emojis.join("")}` : `📡 ${url}`;
}

/**
 * Build the detailed human-readable status block for a single monitor (used by
 * `/ghpr-monitor status` and the `status` tool action).
 */
export function formatMonitorStatusLine(config: MonitorConfig, state: MonitorState | null): string {
	const url =
		config.resourceType === "run"
			? `https://${config.host}/${config.owner}/${config.repo}/actions/runs/${config.runId}`
			: config.resourceType === "issue"
				? `https://${config.host}/${config.owner}/${config.repo}/issues/${config.number}`
				: `https://${config.host}/${config.owner}/${config.repo}/pull/${config.number}`;
	const autoMergeTag = config.autoMerge && config.resourceType === "pr" ? " 🔀auto-merge" : "";
	const header = `Monitoring ${url} (interval: ${config.intervalSec}s${autoMergeTag})`;
	const ts = state?.lastChecked ? state.lastChecked.toLocaleString() : "unknown";

	if (!state) return `${header}\n  No status update received yet.`;

	if (config.resourceType === "run") {
		const conclusion = state.runConclusion ? `, conclusion: ${state.runConclusion}` : "";
		return `${header}\n  Workflow run status: ${state.runStatus ?? "—"}${conclusion}\n  Last checked: ${ts}`;
	}

	const parts: string[] = [];
	if (state.hasConflict) parts.push("⚠️ Merge conflicts");
	if (state.failingChecks.length > 0) parts.push(`❌ Failing CI: ${state.failingChecks.join(", ")}`);
	if (state.unresolvedThreads > 0) parts.push(`💬 ${state.unresolvedThreads} unresolved thread(s)`);
	if (state.generalComments > 0) parts.push(`💭 ${state.generalComments} general comment(s)`);
	if (parts.length === 0) {
		return `${header}\n  ✨ Open, all clear (last checked: ${ts})`;
	}
	return `${header}\n  ${parts.join("\n  ")}\n  Last checked: ${ts}`;
}