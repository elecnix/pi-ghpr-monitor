/**
 * PR analysis functions — pure logic, testable without Pi runtime.
 *
 * Mirrors the condition detection logic from gh-pr-review's internal/await package.
 */

// ---------------------------------------------------------------------------
// GitHub GraphQL response types
// ---------------------------------------------------------------------------

export interface CommentNode {
	id: string;
	body: string;
	author: { login: string };
	createdAt: string;
}

export interface ReviewThreadNode {
	id: string;
	isResolved: boolean;
	isOutdated: boolean;
	comments: { nodes: CommentNode[]; pageInfo: { hasNextPage: boolean; endCursor?: string } };
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

export interface CommitNode {
	commit: {
		checkSuites: { nodes: CheckSuiteNode[] };
	};
}

export interface PullRequestData {
	comments: { nodes: CommentNode[] };
	reviewThreads: { nodes: ReviewThreadNode[] };
	mergeable: string;
	mergeStateStatus: string;
	commits: { nodes: CommitNode[] };
}

// ---------------------------------------------------------------------------
// PR status snapshot
// ---------------------------------------------------------------------------

export interface PRStatus {
	unresolvedThreads: number;
	generalComments: number;
	hasConflicts: boolean;
	failingChecks: string[];
	pendingChecks: string[];
	lastCommentTimestamp: string;
	lastCommentBySelf: boolean;
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

export function countUnresolvedThreads(pr: PullRequestData): number {
	return pr.reviewThreads.nodes.filter((t: ReviewThreadNode) => !t.isResolved).length;
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

export function snapshotPR(pr: PullRequestData): PRStatus {
	return {
		unresolvedThreads: countUnresolvedThreads(pr),
		generalComments: pr.comments.nodes.length,
		hasConflicts: hasConflicts(pr),
		failingChecks: failingChecks(pr),
		pendingChecks: pendingChecks(pr),
		lastCommentTimestamp: getLatestCommentTimestamp(pr),
		lastCommentBySelf: false,
	};
}

export function formatStatusUpdate(prev: PRStatus | null, curr: PRStatus, config: MonitorConfig): string {
	const lines: string[] = [];
	const prLabel = `${config.owner}/${config.repo}#${config.number}`;

	if (curr.hasConflicts) {
		lines.push(`⚠️  Merge conflicts detected on ${prLabel}`);
	}

	if (curr.failingChecks.length > 0) {
		lines.push(`❌ Failing CI checks on ${prLabel}: ${curr.failingChecks.join(", ")}`);
	}

	if (curr.pendingChecks.length > 0) {
		if (!prev || prev.pendingChecks.length !== curr.pendingChecks.length) {
			lines.push(`⏳ CI checks still pending on ${prLabel}: ${curr.pendingChecks.join(", ")}`);
		}
	}

	if (curr.unresolvedThreads > 0) {
		const prevCount = prev?.unresolvedThreads ?? 0;
		if (curr.unresolvedThreads > prevCount) {
			lines.push(
				`💬 ${curr.unresolvedThreads - prevCount} new unresolved review thread(s) on ${prLabel} (${curr.unresolvedThreads} total)`,
			);
		} else if (!prev) {
			lines.push(`💬 ${curr.unresolvedThreads} unresolved review thread(s) on ${prLabel}`);
		}
	}

	if (curr.generalComments > 0) {
		const prevCount = prev?.generalComments ?? 0;
		if (curr.generalComments > prevCount) {
			lines.push(`📝 ${curr.generalComments - prevCount} new general comment(s) on ${prLabel}`);
		} else if (!prev) {
			lines.push(`📝 ${curr.generalComments} general comment(s) on ${prLabel}`);
		}
	}

	// All checks passed
	if (
		curr.pendingChecks.length === 0 &&
		curr.failingChecks.length === 0 &&
		prev &&
		(prev.pendingChecks.length > 0 || prev.failingChecks.length > 0)
	) {
		lines.push(`✅ All CI checks passed on ${prLabel}`);
	}

	// No issues at all
	if (
		!curr.hasConflicts &&
		curr.unresolvedThreads === 0 &&
		curr.generalComments === 0 &&
		curr.failingChecks.length === 0 &&
		curr.pendingChecks.length === 0
	) {
		lines.push(`✨ ${prLabel} — no issues, all clear`);
	}

	return lines.join("\n");
}