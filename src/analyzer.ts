/**
 * PR analysis functions — pure logic, testable without Pi runtime.
 *
 * Mirrors the condition detection logic from gh-pr-review's internal/await package.
 *
 * All formatting functions accept an optional Preferences object that can
 * override the default prompt text for each notification situation.
 */

import type { Preferences } from "./preferences";
import { interpolateTemplate, type TemplateVars } from "./preferences";

// ---------------------------------------------------------------------------
// GitHub GraphQL response types
// ---------------------------------------------------------------------------

export interface ReactionNode {
	content: string;
}

export interface CommentNode {
	id: string;
	/** REST API numeric ID. Present on IssueComment (general PR comments). */
	databaseId?: number;
	/** REST API numeric ID (BigInt). Present on PullRequestReviewComment (thread comments). */
	fullDatabaseId?: string;
	body: string;
	author: { login: string };
	createdAt: string;
	reactions?: { nodes: ReactionNode[] };
	/** File path (only on PullRequestReviewComment, not IssueComment) */
	path?: string;
	/** Line number (only on PullRequestReviewComment, not IssueComment) */
	line?: number | null;
	/** Diff context around the comment (only on PullRequestReviewComment) */
	diffHunk?: string;
}

export interface ReviewThreadNode {
	id: string;
	isResolved: boolean;
	comments: { nodes: CommentNode[] };
}

export interface CheckRunNode {
	name: string;
	conclusion: string | null;
	status: string;
}

export interface CheckSuiteNode {
	id: string;
	conclusion: string | null;
	status: string;
	app: { name: string; slug: string };
	checkRuns: { nodes: CheckRunNode[] };
}

export interface StatusContextNode {
	state: string;
	context: string;
	description: string | null;
	targetUrl: string | null;
}

export interface CommitStatusNode {
	state: string;
	contexts: StatusContextNode[];
}

export interface CommitNode {
	commit: {
		oid: string;
		checkSuites: { nodes: CheckSuiteNode[] };
		status: CommitStatusNode | null;
	};
}

export interface PullRequestData {
	comments: { nodes: CommentNode[] };
	reviewThreads: { nodes: ReviewThreadNode[] };
	mergeable: string;
	mergeStateStatus: string;
	state: string;
	merged: boolean;
	commits: { nodes: CommitNode[] };
}

// ---------------------------------------------------------------------------
// PR status snapshot
// ---------------------------------------------------------------------------

export interface ThreadSummary {
	id: string;
	isResolved: boolean;
	lastCommentAuthor: string;
	lastCommentBody: string;
	/** Untruncated body of the last comment (for agent context) */
	fullBody?: string;
	/** File path the review thread is anchored to */
	path?: string;
	/** Line number the review thread is anchored to */
	line?: number | null;
	/** All comments in the thread (for agent context) */
	allComments?: CommentSummary[];
}

export interface CommentSummary {
	id: string;
	/** REST API numeric ID — the number you'd use in a GitHub REST API URL.
	 * For IssueComment (general PR comments), this comes from `databaseId` (Int).
	 * For PullRequestReviewComment (thread comments), this comes from `fullDatabaseId` (BigInt string).
	 * Both represent the same thing: the numeric ID used by the GitHub REST API v3/v4. */
	restApiId: string;
	author: string;
	body: string;
	/** Untruncated comment body (for agent context) */
	fullBody?: string;
	/** File path (only on review comments, not general PR comments) */
	path?: string;
	/** Line number (only on review comments, not general PR comments) */
	line?: number | null;
	/** Diff context around the comment (only on review comments) */
	diffHunk?: string;
}

export interface CheckSummary {
	name: string;
	conclusion: string | null;
}

export interface PRStatus {
	unresolvedThreads: number;
	generalComments: number;
	hasConflicts: boolean;
	failingChecks: string[];
	pendingChecks: string[];
	lastCommentTimestamp: string;
	lastCommentBySelf: boolean;
	/** OID of the latest commit, used for description-staleness detection. */
	lastCommitOid: string;
	// Detail for enriched notifications
	threadDetails: ThreadSummary[];
	commentDetails: CommentSummary[];
	checkDetails: CheckSummary[];
	// Commit statuses (old-style status API)
	failingStatuses?: string[];
	pendingStatuses?: string[];
	statusDetails?: CheckSummary[];
}

// ---------------------------------------------------------------------------
// Monitor config
// ---------------------------------------------------------------------------

export interface MonitorConfig {
	owner: string;
	repo: string;
	number: number;
	host: string;
	mode: "all" | "comments" | "conflicts" | "actions";
	intervalSec: number;
	debounceSec: number;
}

// ---------------------------------------------------------------------------
// Analysis functions
// ---------------------------------------------------------------------------

const FAILURE_CONCLUSIONS: Set<string> = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"]);
const PENDING_STATUSES: Set<string> = new Set(["IN_PROGRESS", "QUEUED", "WAITING", "STARTUP_FAILURE"]);
const FAILURE_COMMIT_STATES: Set<string> = new Set(["FAILURE", "ERROR"]);
const PENDING_COMMIT_STATES: Set<string> = new Set(["PENDING", "EXPECTED"]);

export function countUnresolvedThreads(pr: PullRequestData): number {
	return pr.reviewThreads.nodes.filter((t: ReviewThreadNode) => {
		if (t.isResolved) return false;
		const last = t.comments.nodes[t.comments.nodes.length - 1];
		return !last || !isAcknowledged(last);
	}).length;
}

export function hasConflicts(pr: PullRequestData): boolean {
	return pr.mergeable === "CONFLICTING";
}

export function failingChecks(pr: PullRequestData): string[] {
	const failing: Set<string> = new Set();
	for (const commit of pr.commits.nodes) {
		for (const suite of commit.commit.checkSuites.nodes) {
			if (suite.conclusion && FAILURE_CONCLUSIONS.has(suite.conclusion)) {
				failing.add(suite.app.name || suite.app.slug || `suite-${suite.id}`);
			}
			for (const run of suite.checkRuns.nodes) {
				if (run.conclusion && FAILURE_CONCLUSIONS.has(run.conclusion)) {
					failing.add(run.name || suite.app.name || suite.app.slug || `suite-${suite.id}`);
				}
			}
		}
		// Also check commit statuses (old-style status API used by CircleCI, etc.)
		if (commit.commit.status) {
			for (const ctx of commit.commit.status.contexts) {
				if (FAILURE_COMMIT_STATES.has(ctx.state)) {
					failing.add(ctx.context);
				}
			}
		}
	}
	return [...failing];
}

export function pendingChecks(pr: PullRequestData): string[] {
	const pending: Set<string> = new Set();
	for (const commit of pr.commits.nodes) {
		for (const suite of commit.commit.checkSuites.nodes) {
			if (PENDING_STATUSES.has(suite.status)) {
				const name = suite.app.name || suite.app.slug || `suite-${suite.id}`;
				pending.add(name);
			}
		}
		// Also check commit statuses (old-style status API)
		if (commit.commit.status) {
			for (const ctx of commit.commit.status.contexts) {
				if (PENDING_COMMIT_STATES.has(ctx.state)) {
					pending.add(ctx.context);
				}
			}
		}
	}
	return [...pending];
}

export function failingStatuses(pr: PullRequestData): string[] {
	const failing: Set<string> = new Set();
	for (const commit of pr.commits.nodes) {
		if (commit.commit.status) {
			for (const ctx of commit.commit.status.contexts) {
				if (FAILURE_COMMIT_STATES.has(ctx.state)) {
					failing.add(ctx.context);
				}
			}
		}
	}
	return [...failing];
}

export function pendingStatuses(pr: PullRequestData): string[] {
	const pending: Set<string> = new Set();
	for (const commit of pr.commits.nodes) {
		if (commit.commit.status) {
			for (const ctx of commit.commit.status.contexts) {
				if (PENDING_COMMIT_STATES.has(ctx.state)) {
					pending.add(ctx.context);
				}
			}
		}
	}
	return [...pending];
}

export function getLatestCommentTimestamp(pr: PullRequestData): string {
	let latest = "";
	for (const c of pr.comments.nodes) {
		if (c.createdAt > latest) latest = c.createdAt;
	}
	for (const t of pr.reviewThreads.nodes) {
		for (const c of t.comments.nodes) {
			if (c.createdAt > latest) latest = c.createdAt;
		}
	}
	return latest;
}

const ACKNOWLEDGED_REACTIONS = new Set(["THUMBS_UP"]);

/** A comment is acknowledged if it has any THUMBS_UP reaction. */
function isAcknowledged(comment: CommentNode): boolean {
	return !!(comment.reactions?.nodes?.some((r: ReactionNode) => ACKNOWLEDGED_REACTIONS.has(r.content)));
}

/** Extract the REST API ID from a review thread comment (PullRequestReviewComment).
 *  Prefers `fullDatabaseId` (BigInt string) since that's the canonical field for this type,
 *  falls back to `databaseId` (Int) for older API versions or test mocks. */
function reviewCommentRestApiId(c: CommentNode): string {
	return c.fullDatabaseId ?? (c.databaseId != null ? String(c.databaseId) : "");
}

/** Extract the REST API ID from a general PR comment (IssueComment).
 *  Prefers `databaseId` (Int) since that's the canonical field for this type,
 *  falls back to `fullDatabaseId` (BigInt string) for robustness. */
function generalCommentRestApiId(c: CommentNode): string {
	return c.databaseId != null ? String(c.databaseId) : (c.fullDatabaseId ?? "");
}

export function snapshotPR(pr: PullRequestData): PRStatus {
	const threads = pr.reviewThreads.nodes
		.filter((t: ReviewThreadNode) => !t.isResolved)
		.filter((t: ReviewThreadNode) => {
			const last = t.comments.nodes[t.comments.nodes.length - 1];
			return !last || !isAcknowledged(last);
		})
		.map((t: ReviewThreadNode) => {
			const comments = t.comments.nodes;
			const last = comments[comments.length - 1];
			// The first comment in a review thread typically has the path/line anchor
			const first = comments[0];
			return {
				id: t.id,
				isResolved: t.isResolved,
				lastCommentAuthor: last?.author?.login ?? "",
				lastCommentBody: firstLine(last?.body, 120),
				fullBody: last?.body ?? "",
				path: first?.path,
				line: first?.line,
				allComments: comments.map((c: CommentNode) => ({
					id: c.id,
					restApiId: reviewCommentRestApiId(c),
					author: c.author?.login ?? "",
					body: firstLine(c.body, 120),
					fullBody: c.body,
					path: c.path,
					line: c.line,
					diffHunk: c.diffHunk,
				})),
			};
		});

	const comments = pr.comments.nodes
		.filter((c: CommentNode) => !isAcknowledged(c))
		.map((c: CommentNode) => ({
			id: c.id,
			restApiId: generalCommentRestApiId(c),
			author: c.author?.login ?? "",
			body: firstLine(c.body, 120),
			fullBody: c.body,
		}));

	const checks: CheckSummary[] = [];
	const statusChecks: CheckSummary[] = [];
	for (const commit of pr.commits.nodes) {
		for (const suite of commit.commit.checkSuites.nodes) {
			if (suite.conclusion && FAILURE_CONCLUSIONS.has(suite.conclusion)) {
				const name = suite.app.name || suite.app.slug || `suite-${suite.id}`;
				checks.push({ name, conclusion: suite.conclusion });
			}
			for (const run of suite.checkRuns.nodes) {
				if (run.conclusion && FAILURE_CONCLUSIONS.has(run.conclusion)) {
					checks.push({ name: run.name, conclusion: run.conclusion });
				}
			}
		}
		// Commit statuses (old-style status API)
		if (commit.commit.status) {
			for (const ctx of commit.commit.status.contexts) {
				if (FAILURE_COMMIT_STATES.has(ctx.state)) {
					statusChecks.push({ name: ctx.context, conclusion: ctx.state });
				}
			}
		}
	}

	const lastCommitOid = pr.commits.nodes.length > 0
		? pr.commits.nodes[0].commit.oid
		: "";

	return {
		unresolvedThreads: countUnresolvedThreads(pr),
		generalComments: pr.comments.nodes.filter((c: CommentNode) => !isAcknowledged(c)).length,
		hasConflicts: hasConflicts(pr),
		failingChecks: failingChecks(pr),
		pendingChecks: pendingChecks(pr),
		lastCommentTimestamp: getLatestCommentTimestamp(pr),
		lastCommentBySelf: false,
		lastCommitOid,
		threadDetails: threads,
		commentDetails: comments,
		checkDetails: checks,
		failingStatuses: failingStatuses(pr),
		pendingStatuses: pendingStatuses(pr),
		statusDetails: statusChecks,
	};
}

/** Build template variables from a MonitorConfig. */
function makeTemplateVars(config: MonitorConfig, extra?: Partial<TemplateVars>): TemplateVars {
	return {
		owner: config.owner,
		repo: config.repo,
		number: config.number,
		host: config.host,
		prLabel: `${config.owner}/${config.repo}#${config.number}`,
		prUrl: `https://${config.host}/${config.owner}/${config.repo}/pull/${config.number}`,
		...extra,
	};
}

export function formatStatusUpdate(prev: PRStatus | null, curr: PRStatus, config: MonitorConfig, prefs?: Preferences): string {
	const lines: string[] = [];
	const prLabel = `${config.owner}/${config.repo}#${config.number}`;

	if (curr.hasConflicts && (!prev || !prev.hasConflicts)) {
		const defaultMsg = `⚠️  Merge conflicts detected on ${prLabel}`;
		const msg = prefs?.conflict
			? interpolateTemplate(prefs.conflict, makeTemplateVars(config))
			: defaultMsg;
		lines.push(msg);
	}

	// Report failing checks only when they first appear or when the set changes
	const prevFailing = prev?.failingChecks ?? [];
	const newFailing = curr.failingChecks.filter(c => !prevFailing.includes(c));
	if (curr.failingChecks.length > 0 && (!prev || newFailing.length > 0)) {
		const details = formatCheckDetails([...(curr.checkDetails ?? []), ...(curr.statusDetails ?? [])]);
		const defaultMsg = details
			? `❌ Failing CI checks on ${prLabel}:${details}`
			: `❌ Failing CI checks on ${prLabel}: ${curr.failingChecks.join(", ")}`;
		const msg = prefs?.ciFailure
			? interpolateTemplate(prefs.ciFailure, makeTemplateVars(config, { failingChecks: curr.failingChecks.join(", ") }))
			: defaultMsg;
		lines.push(msg);
	}

	// Track whether a newComments preference line was already emitted to avoid
	// double-emission when both threads and comments are present.
	let newCommentsPrefEmitted = false;

	if (curr.unresolvedThreads > 0) {
		const prevCount = prev?.unresolvedThreads ?? 0;
		const threadLines = formatThreadDetails(curr.threadDetails ?? [], prev?.threadDetails);
		const defaultThreadPrefix = curr.unresolvedThreads > prevCount
			? `💬 ${curr.unresolvedThreads - prevCount} new unresolved review thread(s) on ${prLabel} (${curr.unresolvedThreads} total):`
			: !prev
				? `💬 ${curr.unresolvedThreads} unresolved review thread(s) on ${prLabel}:`
				: null;
		if (defaultThreadPrefix) {
			if (prefs?.newComments && !newCommentsPrefEmitted) {
				// Provide both thread and comment variables so the template can reference either
				lines.push(interpolateTemplate(prefs.newComments, makeTemplateVars(config, {
					unresolvedThreads: curr.unresolvedThreads,
					generalComments: curr.generalComments,
				})));
				newCommentsPrefEmitted = true;
			} else if (!prefs?.newComments) {
				lines.push(defaultThreadPrefix);
			}
		}
		if (threadLines) {
			lines.push(threadLines);
			lines.push("  After replying, resolve each thread: gh api graphql -f query='mutation{resolveReviewThread(input:{threadId:\"<id>\"}){thread{isResolved}}}'");
			lines.push("  React with 👍 on non-actionable comments to acknowledge and stop notifications.");
		}
	}

	if (curr.generalComments > 0) {
		const prevCount = prev?.generalComments ?? 0;
		const commentLines = formatCommentDetails(curr.commentDetails ?? [], prev?.commentDetails);
		const defaultCommentPrefix = curr.generalComments > prevCount
			? `💭 ${curr.generalComments - prevCount} new general comment(s) on ${prLabel}:`
			: !prev
				? `💭 ${curr.generalComments} general comment(s) on ${prLabel}:`
				: null;
		if (defaultCommentPrefix) {
			// If newComments preference was already emitted for threads, skip the comment line;
			// otherwise emit the preference line now (with both variables available).
			if (prefs?.newComments && !newCommentsPrefEmitted) {
				lines.push(interpolateTemplate(prefs.newComments, makeTemplateVars(config, {
					unresolvedThreads: curr.unresolvedThreads,
					generalComments: curr.generalComments,
				})));
				newCommentsPrefEmitted = true;
			} else if (!prefs?.newComments) {
				lines.push(defaultCommentPrefix);
			}
		}
		if (commentLines) {
			lines.push(commentLines);
			lines.push("  React with 👍 on a comment to acknowledge it and stop notifications.");
		}
	}

	// All checks passed (including commit statuses)
	if (
		curr.pendingChecks.length === 0 &&
		curr.failingChecks.length === 0 &&
		(curr.pendingStatuses ?? []).length === 0 &&
		prev &&
		(prev.pendingChecks.length > 0 || prev.failingChecks.length > 0 || (prev.pendingStatuses ?? []).length > 0)
	) {
		lines.push(`✅ All CI checks passed on ${prLabel}`);
	}

	// No issues at all — only when first seen or transitioning from issues
	if (
		!curr.hasConflicts &&
		curr.unresolvedThreads === 0 &&
		curr.generalComments === 0 &&
		curr.failingChecks.length === 0 &&
		curr.pendingChecks.length === 0 &&
		(curr.pendingStatuses ?? []).length === 0 &&
		(!prev || prev.hasConflicts || prev.unresolvedThreads > 0 || prev.generalComments > 0 || prev.failingChecks.length > 0 || prev.pendingChecks.length > 0 || (prev.pendingStatuses ?? []).length > 0)
	) {
		const defaultMsg = `✨ ${prLabel} — no issues, all clear`;
		const msg = prefs?.allClear
			? interpolateTemplate(prefs.allClear, makeTemplateVars(config))
			: defaultMsg;
		lines.push(msg);
	}

	return lines.join("\n");
}

/** Keep only the first line of a multiline string, then truncate to maxLen. */
function firstLine(text: string | undefined | null, maxLen: number): string {
	if (!text) return "";
	const first = text.split("\n")[0];
	return first.length > maxLen ? first.slice(0, maxLen) + "…" : first;
}

function formatCheckDetails(checks: CheckSummary[]): string {
	if (checks.length === 0) return "";
	return checks.map(c => `\n  - ${c.name} (${c.conclusion})`).join("");
}

function formatThreadDetails(threads: ThreadSummary[], prev?: ThreadSummary[]): string | null {
	if (threads.length === 0) return null;
	const prevIds = new Set((prev ?? []).map(t => t.id));
	return threads
		.filter(t => !prevIds.has(t.id) || !prev) // show new threads only (or all if no prev)
		.map(t => `  - [${t.lastCommentAuthor}] ${firstLine(t.lastCommentBody, 120)} (id: ${t.id})`)
		.join("\n");
}

function formatCommentDetails(comments: CommentSummary[], prev?: CommentSummary[]): string | null {
	if (comments.length === 0) return null;
	const prevIds = new Set((prev ?? []).map(c => c.id));
	return comments
		.filter(c => !prevIds.has(c.id) || !prev) // show new comments only (or all if no prev)
		.map(c => `  - [${c.author}] ${firstLine(c.body, 120)} (id: ${c.id}, restApiId: ${c.restApiId})`)
		.join("\n");
}

/**
 * Format a reminder listing all actionable items in the current PR status.
 *
 * Unlike formatStatusUpdate (which only reports changes), this always lists
 * every actionable item. Returns null when nothing needs the agent's attention.
 *
 * Used to nudge the agent after it goes idle with unresolved items.
 *
 * If prefs.reminder is set, it replaces the entire concise summary.
 * When prefs.newComments is set, it is emitted once with both
 * {unresolvedThreads} and {generalComments} available, covering both
 * threads and comments in a single line.
 */
export function formatActionableItems(status: PRStatus, config: MonitorConfig, prefs?: Preferences): string | null {
	const prLabel = `${config.owner}/${config.repo}#${config.number}`;

	// If the reminder preference is set, use it as the entire concise message
	if (prefs?.reminder) {
		const reminder = interpolateTemplate(prefs.reminder, makeTemplateVars(config, {
			unresolvedThreads: status.unresolvedThreads,
			generalComments: status.generalComments,
			failingChecks: status.failingChecks.join(", "),
			conflict: status.hasConflicts,
		}));
		return reminder;
	}

	const lines: string[] = [];

	if (status.hasConflicts) {
		const defaultMsg = `⚠️  Merge conflicts detected on ${prLabel}`;
		const msg = prefs?.conflict
			? interpolateTemplate(prefs.conflict, makeTemplateVars(config))
			: defaultMsg;
		lines.push(msg);
	}

	if (status.failingChecks.length > 0) {
		const details = formatCheckDetails([...(status.checkDetails ?? []), ...(status.statusDetails ?? [])]);
		const defaultMsg = details
			? `❌ Failing CI checks on ${prLabel}:${details}`
			: `❌ Failing CI checks on ${prLabel}: ${status.failingChecks.join(", ")}`;
		const msg = prefs?.ciFailure
			? interpolateTemplate(prefs.ciFailure, makeTemplateVars(config, { failingChecks: status.failingChecks.join(", ") }))
			: defaultMsg;
		lines.push(msg);
	}

	// newComments preference: emit once with both variables, covering threads + comments
	let newCommentsPrefEmitted = false;

	if (status.unresolvedThreads > 0) {
		if (prefs?.newComments && !newCommentsPrefEmitted) {
			lines.push(interpolateTemplate(prefs.newComments, makeTemplateVars(config, {
				unresolvedThreads: status.unresolvedThreads,
				generalComments: status.generalComments,
			})));
			newCommentsPrefEmitted = true;
		} else if (!prefs?.newComments) {
			lines.push(`💬 ${status.unresolvedThreads} unresolved review thread(s) on ${prLabel}:`);
		}
		const threadLines = formatThreadDetails(status.threadDetails ?? []);
		if (threadLines) {
			lines.push(threadLines);
			lines.push("  After replying, resolve each thread: gh api graphql -f query='mutation{resolveReviewThread(input:{threadId:\"<id>\"}){thread{isResolved}}}'");
			lines.push("  React with 👍 on non-actionable comments to acknowledge and stop notifications.");
		}
	}

	if (status.generalComments > 0) {
		if (prefs?.newComments && !newCommentsPrefEmitted) {
			lines.push(interpolateTemplate(prefs.newComments, makeTemplateVars(config, {
				unresolvedThreads: status.unresolvedThreads,
				generalComments: status.generalComments,
			})));
			newCommentsPrefEmitted = true;
		} else if (!prefs?.newComments) {
			lines.push(`💭 ${status.generalComments} general comment(s) on ${prLabel}:`);
		}
		const commentLines = formatCommentDetails(status.commentDetails ?? []);
		if (commentLines) {
			lines.push(commentLines);
			lines.push("  React with 👍 on a comment to acknowledge it and stop notifications.");
		}
	}

	return lines.length > 0 ? lines.join("\n") : null;
}

/**
 * Replace PR references (owner/repo#number), full PR URLs, and commit
 * URLs with clickable hyperlinks so they are clickable in the terminal.
 *
 * Three patterns are linkified:
 * 1. `https://host/owner/repo/pull/number` → clickable link (display: owner/repo#number)
 * 2. `https://host/owner/repo/commit/<sha>` → clickable link
 *    (display: short 7-char SHA, so the link reads as e.g. `abc1234`)
 * 3. `owner/repo#number` → clickable link using defaultHost
 *
 * Two output formats are supported, because pi renders the two notification
 * delivery paths with DIFFERENT components:
 *
 * - `"osc8"` (default): emits raw OSC 8 escape sequences
 *   `\x1b]8;;URL\x1b\\ display \x1b]8;;\x1b\\`. Used for the footer status
 *   line and the CustomMessage renderer, which both use pi-tui's Text /
 *   wrapTextWithAnsi path that handles OSC 8 correctly.
 *
 * - `"markdown"`: emits markdown links `[display](URL)`. Used for the
 *   UserMessage path (pi.sendUserMessage → UserMessageComponent → pi-tui
 *   Markdown component). The Markdown component MANGLES pre-baked OSC 8
 *   escapes — its autolink detection finds the href URL inside the OSC 8
 *   sequence and re-linkifies it, producing doubled/tripled output. Feeding
 *   it markdown link syntax instead makes it emit a single clean OSC 8
 *   hyperlink (or a `display (url)` fallback when OSC 8 is unsupported).
 *
 * This function is idempotent for the `"osc8"` format: running it on
 * already-linkified text produces the same result, because existing OSC 8
 * sequences are extracted before regex matching and reinserted unchanged.
 *
 * @param text - The text containing PR references and/or URLs
 * @param defaultHost - The host to use for owner/repo#number shorthands.
 *                      Defaults to "github.com". For GitHub Enterprise,
 *                      pass the enterprise hostname (e.g. "github.corp.com").
 * @param format - Output format: "osc8" (default) or "markdown".
 */
export function linkifyPRRefs(text: string, defaultHost: string = "github.com", format: "osc8" | "markdown" = "osc8"): string {
	// Helper that emits a link in the requested format.
	const link = (url: string, display: string): string =>
		format === "markdown"
			? `[${display}](${url})`
			: `\x1b]8;;${url}\x1b\\${display}\x1b]8;;\x1b\\`;

	// Extract existing OSC 8 sequences to avoid double-linkification.
	// Replace them with unique NUL-delimited placeholders, run the regex
	// replacements on the clean text, then restore the originals.
	// After each pass that creates new links, we re-extract them into
	// placeholders so subsequent passes can't match inside them. This applies
	// to both OSC 8 sequences (osc8 format) and markdown links (markdown
	// format) — e.g. the third pass must not match the `owner/repo#number`
	// label inside a `[owner/repo#number](url)` markdown link from pass one.
	const protectedSpans: string[] = [];
	// Match complete OSC 8 hyperlinks: \x1b]8;;URL\x1b\\DISPLAY\x1b]8;;\x1b\\
	const oscPattern = /\x1b\]8;;[^\x1b]*\x1b\\[^\x1b]*\x1b\]8;;\x1b\\/g;
	// Match markdown links: [display](url)
	const markdownLinkPattern = /\[[^\]]*\]\([^)]*\)/g;

	function protectLinks(): void {
		const pattern = format === "markdown" ? markdownLinkPattern : oscPattern;
		text = text.replace(pattern, (match) => {
			const placeholder = `\x00LINK${protectedSpans.length}\x00`;
			protectedSpans.push(match);
			return placeholder;
		});
	}

	// Extract any pre-existing links of the active format
	protectLinks();

	// First pass: wrap existing full PR URLs in hyperlinks.
	// Matches https://github.com/owner/repo/pull/123 (or any host)
	// Uses owner/repo#number as the display text (not the full URL) to avoid
	// triplicating the URL in terminals that don't support OSC 8 hyperlinks.
	// Word boundary (\b) after the number prevents trailing punctuation
	// (e.g. "...", ".", ",") from being captured as part of the URL.
	const urlPattern = /https?:\/\/([^\/\s]+)\/([^\/\s]+)\/([^\/\s]+)\/pull\/([0-9]+)\b/g;
	text = text.replace(urlPattern, (_match, host: string, owner: string, repo: string, number: string) => {
		const url = `https://${host}/${owner}/${repo}/pull/${number}`;
		const label = `${owner}/${repo}#${number}`;
		return link(url, label);
	});

	// Re-extract newly created links so the next pass can't
	// match the owner/repo#number display text inside them.
	protectLinks();

	// Second pass: wrap commit URLs in hyperlinks with the short
	// 7-character SHA as the visible display text. This produces compact
	// notifications like "📝 New commit abc1234 pushed to ..." where the
	// short SHA is a clickable hyperlink to the full commit on GitHub.
	// Matches https://host/owner/repo/commit/<sha> with at least 7 hex chars.
	const commitUrlPattern = /https?:\/\/([^\/\s]+)\/([^\/\s]+)\/([^\/\s]+)\/commit\/([0-9a-f]{7,40})\b/gi;
	text = text.replace(commitUrlPattern, (_match, host: string, owner: string, repo: string, sha: string) => {
		const url = `https://${host}/${owner}/${repo}/commit/${sha}`;
		const shortSha = sha.slice(0, 7);
		return link(url, shortSha);
	});

	// Re-extract newly created links again.
	protectLinks();

	// Third pass: replace owner/repo#number patterns with hyperlinks.
	// These link to defaultHost (default: github.com).
	// Word boundary (\b) after the number prevents trailing punctuation
	// (e.g. "...", ".", ",") from being captured as part of the reference.
	const refPattern = /([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)#([0-9]+)\b/g;
	text = text.replace(refPattern, (_match, owner: string, repo: string, number: string) => {
		const url = `https://${defaultHost}/${owner}/${repo}/pull/${number}`;
		return link(url, `${owner}/${repo}#${number}`);
	});

	// Restore protected link spans from placeholders
	for (let i = protectedSpans.length - 1; i >= 0; i--) {
		text = text.replace(`\x00LINK${i}\x00`, protectedSpans[i]!);
	}

	return text;
}

/**
 * Format a footer status line for the TUI status bar.
 * Shows the PR URL with emoji indicators for each issue type.
 * No emojis when no actionable items.
 */
export function formatFooterStatus(config: MonitorConfig, status: PRStatus | null): string {
	const url = `https://${config.host}/${config.owner}/${config.repo}/pull/${config.number}`;
	if (!status) return `📡 ${url}`;
	const emojis: string[] = [];
	if (status.hasConflicts) emojis.push("⚠️");
	if (status.unresolvedThreads > 0) emojis.push("💬");
	if (status.generalComments > 0) emojis.push("💭");
	if (status.failingChecks.length > 0) emojis.push("❌");
	if (status.pendingChecks.length > 0) emojis.push("⏳");
	return emojis.length > 0 ? `📡 ${url} ${emojis.join("")}` : `📡 ${url}`;
}

// ---------------------------------------------------------------------------
// Agent-enriched notification formatting
//
// These functions produce a two-part message:
//   1. A concise summary (displayed in TUI via message renderer)
//   2. A detailed section with full comment bodies, paths, and line numbers
//      (included in agent content so the LLM doesn't need extra API calls)
// ---------------------------------------------------------------------------

/**
 * Parse a unified diff hunk header like `@@ -40,7 +40,7 @@` and return
 * the starting line number for the new (right-side) file.
 * Returns null if the header cannot be parsed.
 */
function parseDiffHunkHeader(hunk: string): { oldStart: number; newStart: number } | null {
	// Match @@ -oldStart[,oldCount] +newStart[,newCount] @@
	const match = hunk.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
	if (!match) return null;
	return { oldStart: parseInt(match[1], 10), newStart: parseInt(match[2], 10) };
}

/**
 * Given a diff hunk and a target line number (1-based, in the new file),
 * extract a focused window around that line and highlight it.
 *
 * If the target line is found within the hunk, returns a subset of lines
 * centered on the target with CONTEXT_LINES of surrounding context,
 * and marks the target line with a `>>>` prefix.
 *
 * If the target line is not found (or line is null/undefined), falls back
 * to showing the entire hunk with a MAX_DIFF_LINES truncation limit.
 */
const CONTEXT_LINES = 3;
const MAX_DIFF_LINES = 20;

function formatDiffExcerpt(diffHunk: string, targetLine: number | null | undefined): string {
	const diffLines = diffHunk.split(/\r?\n/);

	// Find the hunk header line
	const headerIdx = diffLines.findIndex(l => l.startsWith("@@"));
	if (headerIdx < 0) {
		// No hunk header found; fall back to simple truncation
		return formatDiffLinesTruncated(diffLines);
	}

	const header = parseDiffHunkHeader(diffLines[headerIdx]!);
	if (!header) {
		return formatDiffLinesTruncated(diffLines);
	}

	// If we have a target line number, try to find and highlight it
	if (targetLine != null) {
		// Map diff lines to new-file line numbers
		// Lines after the header: ' ' = context (new-file line advances),
		// '-' = removed (skipped — no new-file line), '+' = added (new-file line advances)
		let newLine = header.newStart;
		let targetIdx = -1;
		const lineMap: { idx: number; newLine: number }[] = [];

		for (let i = headerIdx + 1; i < diffLines.length; i++) {
			const line = diffLines[i]!;
			const ch = line[0];

			if (ch === "\\" && line.startsWith("\\ ")) {
				// "No newline at end of file" marker — skip
				continue;
			}

			if (ch === "-") {
				// Removed line: not present in the new file, so skip it
				continue;
			}

			// '+' or ' ' or anything else: new side advances
			lineMap.push({ idx: i, newLine });

			if (newLine === targetLine) {
				targetIdx = lineMap.length - 1;
			}

			newLine++;
		}

		if (targetIdx >= 0) {
			// Found the target line — extract window around it
			const start = Math.max(0, targetIdx - CONTEXT_LINES);
			const end = Math.min(lineMap.length - 1, targetIdx + CONTEXT_LINES);
			const result: string[] = [];

			// Always include the hunk header
			result.push(`  ${diffLines[headerIdx]!}`);

			for (let j = start; j <= end; j++) {
				const { idx, newLine: ln } = lineMap[j]!;
				const prefix = j === targetIdx ? ">>>" : "   ";
				result.push(`${prefix} ${ln} | ${diffLines[idx]!}`);
			}

			return result.join("\n");
		}
	}

	// Fallback: no target line or target not found — show truncated hunk
	return formatDiffLinesTruncated(diffLines);
}

/**
 * Fallback formatter: show diff lines with simple truncation at MAX_DIFF_LINES.
 */
function formatDiffLinesTruncated(diffLines: string[]): string {
	const truncated = diffLines.length > MAX_DIFF_LINES;
	const showLines = truncated ? diffLines.slice(0, MAX_DIFF_LINES) : diffLines;
	const result: string[] = [];
	for (const diffLine of showLines) {
		result.push(`  ${diffLine}`);
	}
	if (truncated) {
		result.push("  …truncated");
	}
	return result.join("\n");
}

/**
 * Format a thread detail block for the agent, including full comment bodies,
 * file path, line number, and all comments in the conversation.
 */
function formatThreadDetailBlock(thread: ThreadSummary): string {
	const lines: string[] = [];
	const location = thread.path
		? `${thread.path}${thread.line != null ? `:${thread.line}` : ""}`
		: undefined;

	const header = location
		? `Thread ${thread.id} (${location})`
		: `Thread ${thread.id}`;
	lines.push(header + ":");

	if (thread.allComments && thread.allComments.length > 0) {
		for (const c of thread.allComments) {
			const cmtLocation = c.path
				? ` (${c.path}${c.line != null ? `:${c.line}` : ""})`
				: "";
			lines.push(`  ${c.author}${cmtLocation} (id: ${c.id}, restApiId: ${c.restApiId}): ${c.fullBody ?? c.body}`);
			if (c.diffHunk) {
				lines.push("  ```diff");
				lines.push(formatDiffExcerpt(c.diffHunk, c.line ?? thread.line));
				lines.push("  ```");
			}
		}
	} else {
		// Fallback: only last comment available
		lines.push(`  ${thread.lastCommentAuthor}: ${thread.fullBody ?? thread.lastCommentBody}`);
	}

	return lines.join("\n");
}

/**
 * Format a comment detail block for the agent, including full comment body.
 */
function formatCommentDetailBlock(comment: CommentSummary): string {
	return `Comment ${comment.id} by ${comment.author} (restApiId: ${comment.restApiId}):\n  ${comment.fullBody ?? comment.body}`;
}

/**
 * Format an enriched notification for the agent, including full comment bodies,
 * file paths, and line numbers so the LLM can act without additional API calls.
 *
 * Returns an object with:
 *   - concise: the short TUI-friendly summary (same as formatActionableItems)
 *   - detailed: the full agent-facing content including structured details
 */
export function formatAgentNotification(status: PRStatus, config: MonitorConfig, prefs?: Preferences): { concise: string; detailed: string } | null {
	const concise = formatActionableItems(status, config, prefs);
	if (concise === null) return null;

	const detailLines: string[] = [];

	// Thread detail blocks
	const threadsWithDetails = (status.threadDetails ?? []).filter(t => !t.isResolved);
	if (threadsWithDetails.length > 0) {
		detailLines.push("");
		detailLines.push("Review thread details:");
		for (const thread of threadsWithDetails) {
			detailLines.push(formatThreadDetailBlock(thread));
		}
	}

	// General comment detail blocks
	const commentsWithDetails = status.commentDetails ?? [];
	if (commentsWithDetails.length > 0) {
		detailLines.push("");
		detailLines.push("General comment details:");
		for (const c of commentsWithDetails) {
			detailLines.push(formatCommentDetailBlock(c));
		}
	}

	const detailed = detailLines.length > 0
		? `${concise}\n${detailLines.join("\n")}`
		: concise;

	return { concise, detailed };
}

/**
 * Format an enriched status update for the agent. Like formatStatusUpdate
 * but appends detailed thread/comment information.
 *
 * Returns an object with:
 *   - concise: the short TUI-friendly summary (same as formatStatusUpdate)
 *   - detailed: the full agent-facing content including structured details
 */
export function formatAgentStatusUpdate(prev: PRStatus | null, curr: PRStatus, config: MonitorConfig, prefs?: Preferences): { concise: string; detailed: string } {
	const concise = formatStatusUpdate(prev, curr, config, prefs);

	// Only add detail blocks for new/changed items
	const detailLines: string[] = [];

	// Thread detail blocks for new threads
	const prevThreadIds = new Set((prev?.threadDetails ?? []).map(t => t.id));
	const newThreads = (curr.threadDetails ?? []).filter(t => !prevThreadIds.has(t.id) || !prev);
	if (newThreads.length > 0) {
		detailLines.push("");
		detailLines.push("Review thread details:");
		for (const thread of newThreads) {
			detailLines.push(formatThreadDetailBlock(thread));
		}
	}

	// General comment detail blocks for new comments
	const prevCommentIds = new Set((prev?.commentDetails ?? []).map(c => c.id));
	const newComments = (curr.commentDetails ?? []).filter(c => !prevCommentIds.has(c.id) || !prev);
	if (newComments.length > 0) {
		detailLines.push("");
		detailLines.push("General comment details:");
		for (const c of newComments) {
			detailLines.push(formatCommentDetailBlock(c));
		}
	}

	const detailed = detailLines.length > 0
		? `${concise}\n${detailLines.join("\n")}`
		: concise;

	return { concise, detailed };
}