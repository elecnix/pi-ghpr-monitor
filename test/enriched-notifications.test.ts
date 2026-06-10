/**
 * Unit tests for enriched notification formatting (agent-facing content).
 *
 * Tests the new formatAgentNotification and formatAgentStatusUpdate functions
 * that produce two-part messages: concise (for TUI) and detailed (for agent),
 * including full comment bodies, file paths, and line numbers.
 */

import { describe, it, expect } from "vitest";
import {
	snapshotPR,
	formatAgentNotification,
	formatAgentStatusUpdate,
	formatStatusUpdate,
	formatActionableItems,
	type PullRequestData,
	type PRStatus,
	type MonitorConfig,
	type CommitNode,
	type ReviewThreadNode,
	type CommentNode,
} from "../src/analyzer";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const config: MonitorConfig = {
	owner: "testowner",
	repo: "testrepo",
	number: 42,
	host: "github.com",
	mode: "all",
	intervalSec: 60,
	debounceSec: 30,
};

function makeMockPR(overrides: Partial<PullRequestData> = {}): PullRequestData {
	const defaults: PullRequestData = {
		comments: { nodes: [] },
		reviewThreads: { nodes: [] },
		mergeable: "MERGEABLE",
		mergeStateStatus: "CLEAN",
		state: "OPEN",
		merged: false,
		commits: { nodes: [] as CommitNode[] },
	};
	return { ...defaults, ...overrides };
}

function makeMockStatus(overrides: Partial<PRStatus> = {}): PRStatus {
	const defaults: PRStatus = {
		unresolvedThreads: 0,
		generalComments: 0,
		hasConflicts: false,
		failingChecks: [],
		pendingChecks: [],
		lastCommentTimestamp: "",
		lastCommentBySelf: false,
		lastCommitOid: "",
		threadDetails: [],
		commentDetails: [],
		checkDetails: [],
	};
	return { ...defaults, ...overrides };
}

// ---------------------------------------------------------------------------
// snapshotPR with enriched fields
// ---------------------------------------------------------------------------

describe("snapshotPR enriches ThreadSummary and CommentSummary", () => {
	it("populates fullBody, path, and line on review thread comments", () => {
		const pr: PullRequestData = makeMockPR({
			reviewThreads: {
				nodes: [
					{
						id: "PRRT_1",
						isResolved: false,
						comments: {
							nodes: [
								{
									id: "RC_1",
									body: "First line of comment\n\nSecond paragraph with details",
									author: { login: "reviewer" },
									createdAt: "2024-01-01T00:00:00Z",
									reactions: { nodes: [] },
									path: "src/auth/login.ts",
									line: 42,
								},
							],
						},
					},
				] as ReviewThreadNode[],
			},
		});

		const status = snapshotPR(pr);
		expect(status.unresolvedThreads).toBe(1);
		expect(status.threadDetails).toHaveLength(1);

		const thread = status.threadDetails[0];
		expect(thread.id).toBe("PRRT_1");
		// Truncated for TUI display
		expect(thread.lastCommentBody).toBe("First line of comment");
		// Full body for agent context
		expect(thread.fullBody).toBe("First line of comment\n\nSecond paragraph with details");
		// Path and line from the first comment
		expect(thread.path).toBe("src/auth/login.ts");
		expect(thread.line).toBe(42);
		// allComments includes all thread comments with full details
		expect(thread.allComments).toHaveLength(1);
		expect(thread.allComments![0].fullBody).toBe("First line of comment\n\nSecond paragraph with details");
		expect(thread.allComments![0].path).toBe("src/auth/login.ts");
		expect(thread.allComments![0].line).toBe(42);
	});

	it("populates fullBody on general comments", () => {
		const pr: PullRequestData = makeMockPR({
			comments: {
				nodes: [
					{
						id: "C_1",
						body: "This is a long comment\nwith multiple lines\nand details",
						author: { login: "bot" },
						createdAt: "2024-01-01T00:00:00Z",
						reactions: { nodes: [] },
					} as CommentNode,
				],
			},
		});

		const status = snapshotPR(pr);
		expect(status.generalComments).toBe(1);
		expect(status.commentDetails).toHaveLength(1);
		// Truncated for TUI
		expect(status.commentDetails[0].body).toBe("This is a long comment");
		// Full body for agent
		expect(status.commentDetails[0].fullBody).toBe("This is a long comment\nwith multiple lines\nand details");
	});

	it("uses first comment's path/line for the thread's path/line", () => {
		const pr: PullRequestData = makeMockPR({
			reviewThreads: {
				nodes: [
					{
						id: "PRRT_1",
						isResolved: false,
						comments: {
							nodes: [
								{
									id: "RC_1",
									body: "Original comment on the code",
									author: { login: "reviewer" },
									createdAt: "2024-01-01T00:00:00Z",
									reactions: { nodes: [] },
									path: "backend/package.json",
									line: 39,
								},
								{
									id: "RC_2",
									body: "Reply to the comment",
									author: { login: "dev" },
									createdAt: "2024-01-01T00:01:00Z",
									reactions: { nodes: [] },
									path: "backend/package.json",
									line: 39,
								},
							],
						},
					},
				] as ReviewThreadNode[],
			},
		});

		const status = snapshotPR(pr);
		const thread = status.threadDetails[0];
		expect(thread.path).toBe("backend/package.json");
		expect(thread.line).toBe(39);
		// allComments includes both comments
		expect(thread.allComments).toHaveLength(2);
		expect(thread.allComments![0].author).toBe("reviewer");
		expect(thread.allComments![1].author).toBe("dev");
		expect(thread.allComments![0].path).toBe("backend/package.json");
		expect(thread.allComments![0].line).toBe(39);
	});

	it("handles review comments without path/line (legacy or general comments)", () => {
		const pr: PullRequestData = makeMockPR({
			reviewThreads: {
				nodes: [
					{
						id: "PRRT_1",
						isResolved: false,
						comments: {
							nodes: [
								{
									id: "RC_1",
									body: "General review comment",
									author: { login: "reviewer" },
									createdAt: "2024-01-01T00:00:00Z",
									reactions: { nodes: [] },
								},
							],
						},
					},
				] as ReviewThreadNode[],
			},
		});

		const status = snapshotPR(pr);
		expect(status.threadDetails[0].path).toBeUndefined();
		expect(status.threadDetails[0].line).toBeUndefined();
	});

	it("truncates long single-line comment bodies for TUI display", () => {
		const longBody = "A".repeat(200);
		const pr: PullRequestData = makeMockPR({
			reviewThreads: {
				nodes: [
					{
						id: "PRRT_1",
						isResolved: false,
						comments: {
							nodes: [
								{
									id: "RC_1",
									body: longBody,
									author: { login: "reviewer" },
									createdAt: "2024-01-01T00:00:00Z",
									reactions: { nodes: [] },
									path: "src/main.ts",
									line: 1,
								},
							],
						},
					},
				] as ReviewThreadNode[],
			},
		});

		const status = snapshotPR(pr);
		const thread = status.threadDetails[0];
		// TUI body is truncated to 120 chars + ellipsis
		expect(thread.lastCommentBody).toContain("…");
		expect(thread.lastCommentBody.length).toBeLessThan(longBody.length);
		// Full body is preserved
		expect(thread.fullBody).toBe(longBody);
	});
});

// ---------------------------------------------------------------------------
// formatAgentNotification
// ---------------------------------------------------------------------------

describe("formatAgentNotification", () => {
	it("returns null when nothing is actionable", () => {
		const status = makeMockStatus();
		const result = formatAgentNotification(status, config);
		expect(result).toBeNull();
	});

	it("returns concise and detailed for review threads with path and line", () => {
		const status = makeMockStatus({
			unresolvedThreads: 1,
			threadDetails: [
				{
					id: "PRRT_kwDOO45Fys6AY8FC",
					isResolved: false,
					lastCommentAuthor: "copilot-pull-request-reviewer",
					lastCommentBody: "PR description says the frontend already has pnpm.onlyBuiltDependencies configured, but frontend/package.json curren…",
					fullBody: "PR description says the frontend already has `pnpm.onlyBuiltDependencies` configured, but `frontend/package.json` currently does not contain `onlyBuiltDependencies` (only `pnpm.overrides`). Please update the PR description (or add the equivalent config to the frontend if that was intended) so the documented root cause/fix matches the repo state.",
					path: "backend/package.json",
					line: 39,
					allComments: [
						{
							id: "3203359833",
							author: "copilot-pull-request-reviewer",
							body: "PR description says the frontend already has pnpm.onlyBuiltDependencies configured, but frontend/package.json curren…",
							fullBody: "PR description says the frontend already has `pnpm.onlyBuiltDependencies` configured, but `frontend/package.json` currently does not contain `onlyBuiltDependencies` (only `pnpm.overrides`). Please update the PR description (or add the equivalent config to the frontend if that was intended) so the documented root cause/fix matches the repo state.",
							path: "backend/package.json",
							line: 39,
						},
					],
				},
			],
		});

		const result = formatAgentNotification(status, config);
		expect(result).not.toBeNull();

		// Concise version (TUI) should contain the truncated summary
		expect(result!.concise).toContain("1 unresolved review thread(s)");
		expect(result!.concise).toContain("PRRT_kwDOO45Fys6AY8FC");
		// Concise should contain truncated body (with ellipsis) but NOT the full untruncated text
		expect(result!.concise).toContain("…");
		expect(result!.concise).not.toContain("Please update the PR description");

		// Detailed version (agent) should contain path, line, and full body
		expect(result!.detailed).toContain("backend/package.json:39");
		expect(result!.detailed).toContain("onlyBuiltDependencies");
		expect(result!.detailed).toContain("PR description says");
	});

	it("returns concise and detailed for general comments with full body", () => {
		const status = makeMockStatus({
			generalComments: 1,
			commentDetails: [
				{
					id: "IC_1",
					author: "sonarqubecloud",
					body: "Quality Gate Passed",
					fullBody: "Quality Gate Passed\n\nAll 5 conditions met:\n- Coverage: 80%\n- Duplications: 3%",
				},
			],
		});

		const result = formatAgentNotification(status, config);
		expect(result).not.toBeNull();

		// Concise shows truncated body
		expect(result!.concise).toContain("1 general comment(s)");
		expect(result!.concise).toContain("Quality Gate Passed");
		// Detailed shows full body
		expect(result!.detailed).toContain("All 5 conditions met");
		expect(result!.detailed).toContain("Coverage: 80%");
	});

	it("includes review thread details with conversation history", () => {
		const status = makeMockStatus({
			unresolvedThreads: 1,
			threadDetails: [
				{
					id: "PRRT_1",
					isResolved: false,
					lastCommentAuthor: "dev",
					lastCommentBody: "Fixed in commit abc123",
					fullBody: "Fixed in commit abc123",
					path: "src/auth/login.ts",
					line: 42,
					allComments: [
						{
							id: "RC_1",
							author: "reviewer",
							body: "Please fix the typo",
							fullBody: "Please fix the typo on this line. The variable name should be `authToken` not `authTken`.",
							path: "src/auth/login.ts",
							line: 42,
						},
						{
							id: "RC_2",
							author: "dev",
							body: "Fixed in commit abc123",
							fullBody: "Fixed in commit abc123. Also added a validation check.",
						},
					],
				},
			],
		});

		const result = formatAgentNotification(status, config);
		expect(result).not.toBeNull();

		// Detailed version shows both comments
		expect(result!.detailed).toContain("Thread PRRT_1 (src/auth/login.ts:42)");
		expect(result!.detailed).toContain("reviewer (src/auth/login.ts:42) (id: RC_1)");
		expect(result!.detailed).toContain("authToken");
		expect(result!.detailed).toContain("dev");
		expect(result!.detailed).toContain("Fixed in commit abc123. Also added a validation check.");
	});

	it("includes failing check details", () => {
		const status = makeMockStatus({
			failingChecks: ["ci/test"],
			checkDetails: [
				{ name: "ci/test", conclusion: "FAILURE" },
			],
		});

		const result = formatAgentNotification(status, config);
		expect(result).not.toBeNull();
		expect(result!.concise).toContain("Failing CI checks");
		expect(result!.detailed).toContain("ci/test (FAILURE)");
	});

	it("includes merge conflict information", () => {
		const status = makeMockStatus({
			hasConflicts: true,
		});

		const result = formatAgentNotification(status, config);
		expect(result).not.toBeNull();
		expect(result!.concise).toContain("Merge conflicts detected");
		expect(result!.detailed).toContain("Merge conflicts detected");
	});

	it("handles threads without path or line gracefully", () => {
		const status = makeMockStatus({
			unresolvedThreads: 1,
			threadDetails: [
				{
					id: "PRRT_1",
					isResolved: false,
					lastCommentAuthor: "reviewer",
					lastCommentBody: "General review note",
					fullBody: "General review note with more context",
					// No path or line
				},
			],
		});

		const result = formatAgentNotification(status, config);
		expect(result).not.toBeNull();

		// Should show thread ID without file location
		expect(result!.detailed).toContain("Thread PRRT_1:");
		expect(result!.detailed).toContain("General review note with more context");
		// Should NOT contain ":" after thread ID since there's no path
		expect(result!.detailed).not.toContain("Thread PRRT_1 ():");
	});

	it("handles thread with path but no line", () => {
		const status = makeMockStatus({
			unresolvedThreads: 1,
			threadDetails: [
				{
					id: "PRRT_1",
					isResolved: false,
					lastCommentAuthor: "reviewer",
					lastCommentBody: "File-level comment",
					fullBody: "File-level comment with details",
					path: "README.md",
					// line is undefined
				},
			],
		});

		const result = formatAgentNotification(status, config);
		expect(result).not.toBeNull();
		expect(result!.detailed).toContain("Thread PRRT_1 (README.md):");
	});

	it("handles null line number", () => {
		const status = makeMockStatus({
			unresolvedThreads: 1,
			threadDetails: [
				{
					id: "PRRT_1",
					isResolved: false,
					lastCommentAuthor: "reviewer",
					lastCommentBody: "Outdated comment",
					fullBody: "Outdated comment",
					path: "src/utils.ts",
					line: null,
				},
			],
		});

		const result = formatAgentNotification(status, config);
		expect(result).not.toBeNull();
		expect(result!.detailed).toContain("Thread PRRT_1 (src/utils.ts):");
	});

	it("concise matches formatActionableItems output", () => {
		const status = makeMockStatus({
			unresolvedThreads: 2,
			hasConflicts: true,
			failingChecks: ["ci/test"],
			threadDetails: [
				{ id: "PRRT_1", isResolved: false, lastCommentAuthor: "a", lastCommentBody: "Fix this" },
				{ id: "PRRT_2", isResolved: false, lastCommentAuthor: "b", lastCommentBody: "And this" },
			],
			checkDetails: [{ name: "ci/test", conclusion: "FAILURE" }],
		});

		const result = formatAgentNotification(status, config);
		expect(result).not.toBeNull();
		// concise should match what formatActionableItems produces
		const expectedConcise = formatActionableItems(status, config);
		expect(result!.concise).toBe(expectedConcise);
	});

	it("handles general comments without path (they're IssueComments)", () => {
		const status = makeMockStatus({
			generalComments: 1,
			commentDetails: [
				{
					id: "C_1",
					author: "bot",
					body: "Deploy notification",
					fullBody: "Deploy notification: Production deployed at 2024-01-01T12:00:00Z",
					// No path or line — this is a general PR comment
				},
			],
		});

		const result = formatAgentNotification(status, config);
		expect(result).not.toBeNull();
		expect(result!.detailed).toContain("Comment C_1 by bot:");
		expect(result!.detailed).toContain("Production deployed");
	});
});

// ---------------------------------------------------------------------------
// formatAgentStatusUpdate
// ---------------------------------------------------------------------------

describe("formatAgentStatusUpdate", () => {
	it("returns concise matching formatStatusUpdate", () => {
		const prev = makeMockStatus({
			unresolvedThreads: 1,
			threadDetails: [{ id: "PRRT_1", isResolved: false, lastCommentAuthor: "a", lastCommentBody: "Fix" }],
			failingChecks: ["ci/test"],
			checkDetails: [{ name: "ci/test", conclusion: "FAILURE" }],
		});
		const curr = makeMockStatus({
			unresolvedThreads: 2,
			threadDetails: [
				{ id: "PRRT_1", isResolved: false, lastCommentAuthor: "a", lastCommentBody: "Fix" },
				{ id: "PRRT_2", isResolved: false, lastCommentAuthor: "b", lastCommentBody: "Also fix", fullBody: "Also fix this other thing", path: "src/main.ts", line: 10 },
			],
			failingChecks: ["ci/test"],
			checkDetails: [{ name: "ci/test", conclusion: "FAILURE" }],
		});

		const result = formatAgentStatusUpdate(prev, curr, config);
		expect(result.concise).toBe(formatStatusUpdate(prev, curr, config));
	});

	it("includes thread details for new threads in detailed output", () => {
		const prev = makeMockStatus({
			unresolvedThreads: 1,
			threadDetails: [{ id: "PRRT_1", isResolved: false, lastCommentAuthor: "a", lastCommentBody: "Old thread" }],
		});
		const curr = makeMockStatus({
			unresolvedThreads: 2,
			threadDetails: [
				{ id: "PRRT_1", isResolved: false, lastCommentAuthor: "a", lastCommentBody: "Old thread" },
				{
					id: "PRRT_2",
					isResolved: false,
					lastCommentAuthor: "reviewer",
					lastCommentBody: "New thread",
					fullBody: "New thread: please review this carefully\n\nIt affects the auth module",
					path: "src/auth/login.ts",
					line: 55,
					allComments: [
						{
							id: "RC_3",
							author: "reviewer",
							body: "New thread",
							fullBody: "New thread: please review this carefully\n\nIt affects the auth module",
							path: "src/auth/login.ts",
							line: 55,
						},
					],
				},
			],
		});

		const result = formatAgentStatusUpdate(prev, curr, config);
		// Detailed shows the file location
		expect(result.detailed).toContain("src/auth/login.ts:55");
		// Detailed shows the full body
		expect(result.detailed).toContain("auth module");
		// Detailed shows thread ID
		expect(result.detailed).toContain("Thread PRRT_2");
	});

	it("includes general comment details for new comments", () => {
		const prev = makeMockStatus({
			generalComments: 0,
			commentDetails: [],
		});
		const curr = makeMockStatus({
			generalComments: 1,
			commentDetails: [
				{
					id: "C_1",
					author: "ci-bot",
					body: "Quality Gate Passed",
					fullBody: "Quality Gate Passed\n\nAll conditions met:\n- Coverage: 85%\n- Duplications: 2%",
				},
			],
		});

		const result = formatAgentStatusUpdate(prev, curr, config);
		expect(result.detailed).toContain("Comment C_1 by ci-bot");
		expect(result.detailed).toContain("All conditions met");
		expect(result.detailed).toContain("Coverage: 85%");
	});

	it("returns empty concise and detailed when no changes", () => {
		const status = makeMockStatus();
		const result = formatAgentStatusUpdate(null, status, config);
		// No change from null to clean = empty
		expect(result.concise).toContain("all clear");
		// No additional details since there are no threads/comments
		expect(result.detailed).toContain("all clear");
	});

	it("does not repeat thread details when status is unchanged", () => {
		const status = makeMockStatus({
			unresolvedThreads: 1,
			threadDetails: [
				{
					id: "PRRT_1",
					isResolved: false,
					lastCommentAuthor: "a",
					lastCommentBody: "Fix",
					fullBody: "Fix this bug",
					path: "src/x.ts",
					line: 1,
				},
			],
		});

		// Same status twice — no change detected
		const result = formatAgentStatusUpdate(status, status, config);
		expect(result.concise).toBe("");
		// No detailed content since no new items
		expect(result.detailed).toBe("");
	});
});

// ---------------------------------------------------------------------------
// Reproducing the original session case
// ---------------------------------------------------------------------------

describe("real-world session: copilot review comment", () => {
	it("formatAgentNotification produces enriched output matching the gh api call", () => {
		// This reproduces the exact scenario from the issue:
		// The agent had to call: gh api repos/mobilityhouse/vgi-na-masscec/pulls/436/comments
		// to get full body, path, and line after seeing only a truncated one-liner.

		const status: PRStatus = makeMockStatus({
			unresolvedThreads: 1,
			threadDetails: [
				{
					id: "PRRT_kwDOO45Fys6AY8FC",
					isResolved: false,
					lastCommentAuthor: "copilot-pull-request-reviewer",
					lastCommentBody: "PR description says the frontend already has pnpm.onlyBuiltDependencies configured, but frontend/package.json curren…",
					fullBody: "PR description says the frontend already has `pnpm.onlyBuiltDependencies` configured, but `frontend/package.json` currently does not contain `onlyBuiltDependencies` (only `pnpm.overrides`). Please update the PR description (or add the equivalent config to the frontend if that was intended) so the documented root cause/fix matches the repo state.",
					path: "backend/package.json",
					line: 39,
					allComments: [
						{
							id: "3203359833",
							author: "copilot-pull-request-reviewer",
							body: "PR description says the frontend already has pnpm.onlyBuiltDependencies configured, but frontend/package.json curren…",
							fullBody: "PR description says the frontend already has `pnpm.onlyBuiltDependencies` configured, but `frontend/package.json` currently does not contain `onlyBuiltDependencies` (only `pnpm.overrides`). Please update the PR description (or add the equivalent config to the frontend if that was intended) so the documented root cause/fix matches the repo state.",
							path: "backend/package.json",
							line: 39,
						},
					],
				},
			],
		});

		const result = formatAgentNotification(status, {
			...config,
			owner: "mobilityhouse",
			repo: "vgi-na-masscec",
			number: 436,
		});

		expect(result).not.toBeNull();

		// Concise: TUI shows just the one-liner (matches original output)
		expect(result!.concise).toContain("1 unresolved review thread(s) on mobilityhouse/vgi-na-masscec#436");
		expect(result!.concise).toContain("PRRT_kwDOO45Fys6AY8FC");

		// Detailed: agent gets full body, path, and line
		expect(result!.detailed).toContain("backend/package.json:39");
		expect(result!.detailed).toContain("onlyBuiltDependencies");
		expect(result!.detailed).toContain("frontend/package.json");
		expect(result!.detailed).toContain("Please update the PR description");
		expect(result!.detailed).toContain("(id: 3203359833)");
		expect(result!.detailed).toContain("copilot-pull-request-reviewer");

		// The agent should no longer need to make this gh api call:
		// gh api repos/mobilityhouse/vgi-na-masscec/pulls/436/comments --jq '.[] | {id: .id, body: .body, path: .path, line: .line}'
		// because all of {id, body, path, line} are now included in the notification.
		expect(result!.detailed).toContain("backend/package.json:39");
		expect(result!.detailed).toContain("(id: 3203359833)");  // id
		expect(result!.detailed).toContain("onlyBuiltDependencies");  // part of full body
	});
});

// ---------------------------------------------------------------------------
// TUI concise output is always a subset of agent detailed output
// ---------------------------------------------------------------------------

describe("consise is always a proper prefix/subset of detailed", () => {
	it("for threads with full body", () => {
		const status = makeMockStatus({
			unresolvedThreads: 1,
			threadDetails: [
				{
					id: "PRRT_1",
					isResolved: false,
					lastCommentAuthor: "reviewer",
					lastCommentBody: "Short",
					fullBody: "Short detailed body with explanation",
					path: "src/file.ts",
					line: 10,
				},
			],
		});

		const result = formatAgentNotification(status, config);
		expect(result).not.toBeNull();
		// The detailed output should start with the concise output
		expect(result!.detailed).toContain(result!.concise);
	});

	it("for general comments with full body", () => {
		const status = makeMockStatus({
			generalComments: 1,
			commentDetails: [
				{
					id: "C_1",
					author: "bot",
					body: "Deploy done",
					fullBody: "Deploy notification: build #42 deployed to production at 2024-01-01",
				},
			],
		});

		const result = formatAgentNotification(status, config);
		expect(result).not.toBeNull();
		expect(result!.detailed).toContain(result!.concise);
	});
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("edge cases for enriched notifications", () => {
	it("handles empty allComments array gracefully", () => {
		const status = makeMockStatus({
			unresolvedThreads: 1,
			threadDetails: [
				{
					id: "PRRT_1",
					isResolved: false,
					lastCommentAuthor: "reviewer",
					lastCommentBody: "Fix this",
					fullBody: "Fix this issue",
					path: "src/file.ts",
					line: 5,
					allComments: [],
				},
			],
		});

		const result = formatAgentNotification(status, config);
		expect(result).not.toBeNull();
		// Should fall back to last comment info
		expect(result!.detailed).toContain("reviewer");
		expect(result!.detailed).toContain("Fix this issue");
	});

	it("handles undefined fullBody (falls back to body)", () => {
		const status = makeMockStatus({
			generalComments: 1,
			commentDetails: [
				{
					id: "C_1",
					author: "bot",
					body: "Short notice",
					// fullBody intentionally undefined
				},
			],
		});

		const result = formatAgentNotification(status, config);
		expect(result).not.toBeNull();
		expect(result!.detailed).toContain("Short notice");
	});

	it("handles mixed thread with and without path/line", () => {
		const status = makeMockStatus({
			unresolvedThreads: 2,
			threadDetails: [
				{
					id: "PRRT_1",
					isResolved: false,
					lastCommentAuthor: "a",
					lastCommentBody: "Code comment",
					fullBody: "Code comment with details",
					path: "src/app.ts",
					line: 10,
					allComments: [
						{ id: "RC_1", author: "a", body: "Code comment", fullBody: "Code comment with details", path: "src/app.ts", line: 10 },
					],
				},
				{
					id: "PRRT_2",
					isResolved: false,
					lastCommentAuthor: "b",
					lastCommentBody: "General comment",
					fullBody: "General comment without file location",
					// No path or line
				},
			],
		});

		const result = formatAgentNotification(status, config);
		expect(result).not.toBeNull();
		// Thread with path should show file location
		expect(result!.detailed).toContain("Thread PRRT_1 (src/app.ts:10)");
		// Thread without path should show just thread ID
		expect(result!.detailed).toContain("Thread PRRT_2:");
		expect(result!.detailed).not.toContain("Thread PRRT_2 ():");
	});
});