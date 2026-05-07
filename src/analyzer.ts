/**
 * PR analysis functions — pure logic, testable without Pi runtime.
 *
 * Mirrors the condition detection logic from gh-pr-review's internal/await package.
 */

// ---------------------------------------------------------------------------
// GitHub GraphQL response types
// ---------------------------------------------------------------------------

export interface ReactionNode {
	content: string;
}

export interface CommentNode {
	id: string;
	body: string;
	author: { login: string };
	createdAt: string;
	reactions?: { nodes: ReactionNode[] };
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
}

export interface CommentSummary {
	id: string;
	author: string;
	body: string;
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
			return {
				id: t.id,
				isResolved: t.isResolved,
				lastCommentAuthor: last?.author?.login ?? "",
				lastCommentBody: firstLine(last?.body, 120),
			};
		});

	const comments = pr.comments.nodes
		.filter((c: CommentNode) => !isAcknowledged(c))
		.map((c: CommentNode) => ({
			id: c.id,
			author: c.author?.login ?? "",
			body: firstLine(c.body, 120),
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

	return {
		unresolvedThreads: countUnresolvedThreads(pr),
		generalComments: pr.comments.nodes.filter((c: CommentNode) => !isAcknowledged(c)).length,
		hasConflicts: hasConflicts(pr),
		failingChecks: failingChecks(pr),
		pendingChecks: pendingChecks(pr),
		lastCommentTimestamp: getLatestCommentTimestamp(pr),
		lastCommentBySelf: false,
		threadDetails: threads,
		commentDetails: comments,
		checkDetails: checks,
		failingStatuses: failingStatuses(pr),
		pendingStatuses: pendingStatuses(pr),
		statusDetails: statusChecks,
	};
}

export function formatStatusUpdate(prev: PRStatus | null, curr: PRStatus, config: MonitorConfig): string {
	const lines: string[] = [];
	const prLabel = `${config.owner}/${config.repo}#${config.number}`;

	if (curr.hasConflicts && (!prev || !prev.hasConflicts)) {
		lines.push(`⚠️  Merge conflicts detected on ${prLabel}`);
	}

	// Report failing checks only when they first appear or when the set changes
	const prevFailing = prev?.failingChecks ?? [];
	const newFailing = curr.failingChecks.filter(c => !prevFailing.includes(c));
	if (curr.failingChecks.length > 0 && (!prev || newFailing.length > 0)) {
		const details = formatCheckDetails([...(curr.checkDetails ?? []), ...(curr.statusDetails ?? [])]);
		if (details) {
			lines.push(`❌ Failing CI checks on ${prLabel}:${details}`);
		} else {
			lines.push(`❌ Failing CI checks on ${prLabel}: ${curr.failingChecks.join(", ")}`);
		}
	}


	if (curr.unresolvedThreads > 0) {
		const prevCount = prev?.unresolvedThreads ?? 0;
		const threadLines = formatThreadDetails(curr.threadDetails ?? [], prev?.threadDetails);
		if (curr.unresolvedThreads > prevCount) {
			lines.push(`💬 ${curr.unresolvedThreads - prevCount} new unresolved review thread(s) on ${prLabel} (${curr.unresolvedThreads} total):`);
		} else if (!prev) {
			lines.push(`💬 ${curr.unresolvedThreads} unresolved review thread(s) on ${prLabel}:`);
		}
		if (threadLines) {
			lines.push(threadLines);
			lines.push("  After replying, resolve each thread: gh api graphql -f query='mutation{resolveReviewThread(input:{threadId:\"<id>\"}){thread{isResolved}}}'");
			lines.push("  For non-actionable comments, add 👍 to stop notifications.");
		}
	}

	if (curr.generalComments > 0) {
		const prevCount = prev?.generalComments ?? 0;
		const commentLines = formatCommentDetails(curr.commentDetails ?? [], prev?.commentDetails);
		if (curr.generalComments > prevCount) {
			lines.push(`💭 ${curr.generalComments - prevCount} new general comment(s) on ${prLabel}:`);
		} else if (!prev) {
			lines.push(`💭 ${curr.generalComments} general comment(s) on ${prLabel}:`);
		}
		if (commentLines) {
			lines.push(commentLines);
			lines.push("  Add a 👍 reaction to a comment to acknowledge it and stop notifications.");
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
		lines.push(`✨ ${prLabel} — no issues, all clear`);
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
		.map(c => `  - [${c.author}] ${firstLine(c.body, 120)} (id: ${c.id})`)
		.join("\n");
}

/**
 * Format a reminder listing all actionable items in the current PR status.
 *
 * Unlike formatStatusUpdate (which only reports changes), this always lists
 * every actionable item. Returns null when nothing needs the agent's attention.
 *
 * Used to nudge the agent after it goes idle with unresolved items.
 */
export function formatActionableItems(status: PRStatus, config: MonitorConfig): string | null {
	const lines: string[] = [];
	const prLabel = `${config.owner}/${config.repo}#${config.number}`;

	if (status.hasConflicts) {
		lines.push(`⚠️  Merge conflicts detected on ${prLabel}`);
	}

	if (status.failingChecks.length > 0) {
		const details = formatCheckDetails([...(status.checkDetails ?? []), ...(status.statusDetails ?? [])]);
		if (details) {
			lines.push(`❌ Failing CI checks on ${prLabel}:${details}`);
		} else {
			lines.push(`❌ Failing CI checks on ${prLabel}: ${status.failingChecks.join(", ")}`);
		}
	}

	if (status.unresolvedThreads > 0) {
		lines.push(`💬 ${status.unresolvedThreads} unresolved review thread(s) on ${prLabel}:`);
		const threadLines = formatThreadDetails(status.threadDetails ?? []);
		if (threadLines) {
			lines.push(threadLines);
			lines.push("  After replying, resolve each thread: gh api graphql -f query='mutation{resolveReviewThread(input:{threadId:\"<id>\"}){thread{isResolved}}}'");
			lines.push("  For non-actionable comments, add 👍 to stop notifications.");
		}
	}

	if (status.generalComments > 0) {
		lines.push(`💭 ${status.generalComments} general comment(s) on ${prLabel}:`);
		const commentLines = formatCommentDetails(status.commentDetails ?? []);
		if (commentLines) {
			lines.push(commentLines);
			lines.push("  Add a 👍 reaction to a comment to acknowledge it and stop notifications.");
		}
	}

	return lines.length > 0 ? lines.join("\n") : null;
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
