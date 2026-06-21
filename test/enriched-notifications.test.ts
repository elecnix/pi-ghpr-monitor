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
		lastCommitOid: "", lastCommitAuthor: "", lastCommitCoauthors: "",
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
									databaseId: 17,
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

		const status = snapshotPR(pr, []);
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
						databaseId: 22,
						body: "This is a long comment\nwith multiple lines\nand details",
						author: { login: "bot" },
						createdAt: "2024-01-01T00:00:00Z",
						reactions: { nodes: [] },
					} as CommentNode,
				],
			},
		});

		const status = snapshotPR(pr, []);
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
									databaseId: 18,
									body: "Original comment on the code",
									author: { login: "reviewer" },
									createdAt: "2024-01-01T00:00:00Z",
									reactions: { nodes: [] },
									path: "backend/package.json",
									line: 39,
								},
								{
									id: "RC_2",
									databaseId: 19,
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

		const status = snapshotPR(pr, []);
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
									databaseId: 20,
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

		const status = snapshotPR(pr, []);
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
									databaseId: 21,
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

		const status = snapshotPR(pr, []);
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
							restApiId: "1",
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
					restApiId: "1",
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
							restApiId: "31",
							author: "reviewer",
							body: "Please fix the typo",
							fullBody: "Please fix the typo on this line. The variable name should be `authToken` not `authTken`.",
							path: "src/auth/login.ts",
							line: 42,
						},
						{
							id: "RC_2",
							restApiId: "32",
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
		expect(result!.detailed).toContain("reviewer (src/auth/login.ts:42) (id: RC_1, restApiId: 31)");
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
		// Should NOT contain empty parentheses since there's no path
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
					restApiId: "2",
					author: "bot",
					body: "Deploy notification",
					fullBody: "Deploy notification: Production deployed at 2024-01-01T12:00:00Z",
					// No path or line — this is a general PR comment
				},
			],
		});

		const result = formatAgentNotification(status, config);
		expect(result).not.toBeNull();
		expect(result!.detailed).toContain('Comment C_1 by bot (restApiId: 2)');
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
							restApiId: "33",
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
					restApiId: "3",
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
							restApiId: "2",
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
		expect(result!.detailed).toContain("(id: 3203359833, restApiId: 2)");
		expect(result!.detailed).toContain("copilot-pull-request-reviewer");

		// The agent should no longer need to make this gh api call:
		// gh api repos/mobilityhouse/vgi-na-masscec/pulls/436/comments --jq '.[] | {id: .id, body: .body, path: .path, line: .line}'
		// because all of {id, body, path, line} are now included in the notification.
		expect(result!.detailed).toContain("backend/package.json:39");
		expect(result!.detailed).toContain("(id: 3203359833, restApiId: 2)");  // id and restApiId
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
					restApiId: "4",
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
					restApiId: "5",
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
						{ id: "RC_1", restApiId: "30", author: "a", body: "Code comment", fullBody: "Code comment with details", path: "src/app.ts", line: 10 },
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
		expect(result!.detailed).not.toContain("Thread PRRT_2 ()");
	});
});
// ---------------------------------------------------------------------------
// diffHunk tests
// ---------------------------------------------------------------------------

describe("snapshotPR maps diffHunk from GraphQL to CommentSummary", () => {
	it("maps diffHunk from review thread comments to CommentSummary.diffHunk", () => {
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
									fullDatabaseId: "201",
									body: "Please fix the typo",
									author: { login: "reviewer" },
									createdAt: "2024-01-01T00:00:00Z",
									reactions: { nodes: [] },
									path: "src/auth/login.ts",
									line: 42,
									diffHunk: "@@ -40,7 +40,7 @@\n export function login() {\n-  const token = getOldToken();\n+  const token = getToken();\n   return token;\n }",
								},
							],
						},
					},
				] as ReviewThreadNode[],
			},
		});

		const status = snapshotPR(pr, []);
		expect(status.threadDetails).toHaveLength(1);
		const thread = status.threadDetails[0];
		expect(thread.allComments).toHaveLength(1);
		expect(thread.allComments![0].diffHunk).toBe("@@ -40,7 +40,7 @@\n export function login() {\n-  const token = getOldToken();\n+  const token = getToken();\n   return token;\n }");
	});

	it("maps diffHunk as undefined when not present", () => {
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
									fullDatabaseId: "202",
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

		const status = snapshotPR(pr, []);
		const thread = status.threadDetails[0];
		expect(thread.allComments![0].diffHunk).toBeUndefined();
	});

	it("does not add diffHunk to general comments (IssueComments)", () => {
		const pr: PullRequestData = makeMockPR({
			comments: {
				nodes: [
					{
						id: "C_1",
						databaseId: 301,
						body: "General comment",
						author: { login: "bot" },
						createdAt: "2024-01-01T00:00:00Z",
						reactions: { nodes: [] },
					} as CommentNode,
				],
			},
		});

		const status = snapshotPR(pr, []);
		expect(status.commentDetails).toHaveLength(1);
		expect((status.commentDetails[0] as any).diffHunk).toBeUndefined();
	});
});

describe("formatThreadDetailBlock includes diffHunk as code block", () => {
	it("highlights the anchored line in diffHunk", () => {
		const status = makeMockStatus({
			unresolvedThreads: 1,
			threadDetails: [
				{
					id: "PRRT_1",
						isResolved: false,
					lastCommentAuthor: "reviewer",
					lastCommentBody: "Fix the typo",
					fullBody: "Please fix the typo: authTken should be authToken",
					path: "src/auth/login.ts",
					line: 42,
					allComments: [
						{
							id: "RC_1",
							restApiId: "401",
							author: "reviewer",
							body: "Fix the typo",
							fullBody: "Please fix the typo: authTken should be authToken",
							path: "src/auth/login.ts",
							line: 42,
							diffHunk: "@@ -40,7 +40,7 @@\n export function login() {\n-  const token = getOldToken();\n+  const token = getToken();\n   return token;\n }",
						},
					],
				},
			],
		});

		const result = formatAgentNotification(status, config);
		expect(result).not.toBeNull();

		expect(result!.detailed).toContain("  ```diff");
		expect(result!.detailed).toContain("  @@ -40,7 +40,7 @@");
		// Line 42 is the anchored line - highlighted with >>>
		expect(result!.detailed).toContain(">>> 42 |    return token;");
		// Context lines show line numbers
		expect(result!.detailed).toContain("   40 |  export function login() {");
		expect(result!.detailed).toContain("   41 | +  const token = getToken();");
		expect(result!.detailed).toContain("  ```");
	});

	it("omits diff code block when diffHunk is absent/undefined", () => {
		const status = makeMockStatus({
			unresolvedThreads: 1,
			threadDetails: [
				{
					id: "PRRT_1",
						isResolved: false,
					lastCommentAuthor: "reviewer",
					lastCommentBody: "General review note",
					fullBody: "General review note with context",
					path: "src/app.ts",
					line: 10,
					allComments: [
						{
							id: "RC_1",
							restApiId: "402",
							author: "reviewer",
							body: "General review note",
							fullBody: "General review note with context",
							path: "src/app.ts",
							line: 10,
							// No diffHunk
						},
					],
				},
			],
		});

		const result = formatAgentNotification(status, config);
		expect(result).not.toBeNull();
		expect(result!.detailed).not.toContain("```diff");
	});

	it("handles CRLF line endings in diffHunk", () => {
		const crlfDiff = "@@ -1,3 +1,3 @@" + "\r\n" + " context line" + "\r\n" + "-old line" + "\r\n" + "+new line";
		const status = makeMockStatus({
			unresolvedThreads: 1,
			threadDetails: [
				{
					id: "PRRT_1",
						isResolved: false,
					lastCommentAuthor: "reviewer",
					lastCommentBody: "Fix this",
					fullBody: "Fix this",
					path: "src/file.ts",
					line: 2, // +new line maps to line 2 in new file
					allComments: [
						{
							id: "RC_1",
							restApiId: "403",
							author: "reviewer",
							body: "Fix this",
							fullBody: "Fix this",
							path: "src/file.ts",
							line: 2,
							diffHunk: crlfDiff,
						},
					],
				},
			],
		});

		const result = formatAgentNotification(status, config);
		expect(result).not.toBeNull();

		// CRLF should be stripped; anchored line (2) should be highlighted
		expect(result!.detailed).toContain(">>> 2 | +new line");
		expect(result!.detailed).toContain("   1 |  context line");
		expect(result!.detailed).not.toContain("\r");
	});

	it("focuses long diffHunk around the anchored line with context window", () => {
		const longDiff = "@@ -1,25 +1,25 @@\n" + Array.from({ length: 25 }, (_, i) => ` line ${i + 1}`).join("\n");
		const status = makeMockStatus({
			unresolvedThreads: 1,
			threadDetails: [
				{
					id: "PRRT_1",
						isResolved: false,
					lastCommentAuthor: "reviewer",
					lastCommentBody: "Fix this",
					fullBody: "Fix this",
					path: "src/file.ts",
					line: 10,
					allComments: [
						{
							id: "RC_1",
							restApiId: "404",
							author: "reviewer",
							body: "Fix this",
							fullBody: "Fix this",
							path: "src/file.ts",
							line: 10,
							diffHunk: longDiff,
						},
					],
				},
			],
		});

		const result = formatAgentNotification(status, config);
		expect(result).not.toBeNull();

		// Should show the anchored line (10) highlighted with >>>
		expect(result!.detailed).toContain(">>> 10 |  line 10");
		// Should show context lines around the anchored line
		expect(result!.detailed).toContain("   7 |  line 7");
		expect(result!.detailed).toContain("   8 |  line 8");
		expect(result!.detailed).toContain("   9 |  line 9");
		expect(result!.detailed).toContain("   11 |  line 11");
		expect(result!.detailed).toContain("   12 |  line 12");
		expect(result!.detailed).toContain("   13 |  line 13");
		// Should NOT show lines far from the anchored line
		expect(result!.detailed).not.toContain(" 1 |  line 1");
		expect(result!.detailed).not.toContain(" 25 |  line 25");
		// Should NOT contain truncated marker (we show a focused window instead)
		expect(result!.detailed).not.toContain("…truncated");
	});
});

describe("formatAgentNotification includes diff context in detailed output", () => {
	it("highlights anchored line in diff context for review thread comments", () => {
		const status = makeMockStatus({
			unresolvedThreads: 1,
			threadDetails: [
				{
					id: "PRRT_1",
						isResolved: false,
					lastCommentAuthor: "reviewer",
					lastCommentBody: "Typo in variable name",
					fullBody: "Please fix the typo: authTken should be authToken",
					path: "src/auth/login.ts",
					line: 42,
					allComments: [
						{
							id: "PRRC_123",
							restApiId: "405",
							author: "reviewer",
							body: "Typo in variable name",
							fullBody: "Please fix the typo: authTken should be authToken",
							path: "src/auth/login.ts",
							line: 42,
							diffHunk: "@@ -40,7 +40,7 @@\n export function login() {\n-  const token = getOldToken();\n+  const token = getToken();\n   return token;\n }",
						},
					],
				},
			],
		});

		const result = formatAgentNotification(status, config);
		expect(result).not.toBeNull();

		expect(result!.detailed).toContain("  ```diff");
		// Line 42 is the anchored line - highlighted with >>>
		expect(result!.detailed).toContain(">>> 42 |    return token;");
		// Context lines show line numbers
		expect(result!.detailed).toContain("   40 |  export function login() {");
		expect(result!.detailed).toContain("   41 | +  const token = getToken();");
		expect(result!.detailed).toContain("  ```");
	});

	it("does not include diff context for general comments", () => {
		const status = makeMockStatus({
			generalComments: 1,
			commentDetails: [
				{
					id: "C_1",
					restApiId: "501",
					author: "bot",
					body: "Deploy done",
					fullBody: "Deploy notification: Production deployed",
					// General comments don't have diffHunk
				},
			],
		});

		const result = formatAgentNotification(status, config);
		expect(result).not.toBeNull();
		expect(result!.detailed).toContain("Comment C_1 by bot (restApiId: 501)");
		expect(result!.detailed).not.toContain("```diff");
	});
});

describe("formatAgentStatusUpdate includes diff context for new threads", () => {
	it("highlights anchored line in diffHunk for new threads", () => {
		const prev = makeMockStatus({
			unresolvedThreads: 0,
			threadDetails: [],
		});
		const curr = makeMockStatus({
			unresolvedThreads: 1,
			threadDetails: [
				{
					id: "PRRT_new",
						isResolved: false,
					lastCommentAuthor: "reviewer",
					lastCommentBody: "New thread",
					fullBody: "Please review this change",
					path: "src/index.ts",
					line: 9, // +added line maps to line 9 in new file
					allComments: [
						{
							id: "RC_new",
							restApiId: "406",
							author: "reviewer",
							body: "New thread",
							fullBody: "Please review this change",
							path: "src/index.ts",
							line: 9, // +added line maps to line 9 in new file
							diffHunk: "@@ -8,3 +8,3 @@\n context line\n-removed line\n+added line",
						},
					],
				},
			],
		});

		const result = formatAgentStatusUpdate(prev, curr, config);
		expect(result.detailed).toContain("  ```diff");
		// Line 9 is the anchored line (+added line)
		expect(result.detailed).toContain(">>> 9 | +added line");
		// Context line (line 8)
		expect(result.detailed).toContain("   8 |  context line");
	});
});

describe("formatDiffExcerpt edge cases", () => {
	it("falls back to truncation when line is null", () => {
		const status = makeMockStatus({
			unresolvedThreads: 1,
			threadDetails: [
				{
					id: "PRRT_1",
					isResolved: false,
					lastCommentAuthor: "reviewer",
					lastCommentBody: "Note",
					fullBody: "Note",
					path: "src/app.ts",
					// line is null (file-level comment)
					allComments: [
						{
							id: "RC_1",
							restApiId: "500",
							author: "reviewer",
							body: "Note",
							fullBody: "Note",
							path: "src/app.ts",
							// No line number
							diffHunk: "@@ -1,5 +1,5 @@\n line1\n line2\n line3\n line4\n line5",
						},
					],
				},
			],
		});

		const result = formatAgentNotification(status, config);
		expect(result).not.toBeNull();
		// Without a target line, should fall back to showing the full hunk with truncation
		expect(result!.detailed).toContain("  ```diff");
		expect(result!.detailed).toContain("  @@");
		// Should NOT contain >>> anchored line markers (no line to anchor to)
		expect(result!.detailed).not.toContain(">>>");
	});

	it("falls back to truncation when line number is not found in diff hunk", () => {
		const status = makeMockStatus({
			unresolvedThreads: 1,
			threadDetails: [
				{
					id: "PRRT_1",
					isResolved: false,
					lastCommentAuthor: "reviewer",
					lastCommentBody: "Note",
					fullBody: "Note",
					path: "src/app.ts",
					line: 999, // Line number not in the hunk
					allComments: [
						{
							id: "RC_1",
							restApiId: "501",
							author: "reviewer",
							body: "Note",
							fullBody: "Note",
							path: "src/app.ts",
							line: 999,
							diffHunk: "@@ -1,3 +1,3 @@\n line1\n line2\n line3",
						},
					],
				},
			],
		});

		const result = formatAgentNotification(status, config);
		expect(result).not.toBeNull();
		// Line 999 not found — should fall back to truncated display
		expect(result!.detailed).toContain("  ```diff");
		expect(result!.detailed).not.toContain(">>>");
	});

	it("highlights anchored line on a large added-file diff like copilot reviews", () => {
		// Simulates the real-world case: copilot review comment on line 21
		// of a 146-line added file, diff starts @@ -0,0 +1,146 @@
		const lines = [
			"/**",
			" * Structured session digest",
			" */",
			"import type { AnalysisNodeRow } from '../../types.js';",
			"",
			"export interface DigestSegment {",
			"  index: number;",
			"  text: string;",
			"}",
			"",
			"export interface SessionDigest {",
			"  summary: string;",
			"  segments: DigestSegment[];",
			"}",
			"",
			"function buildDigestSegment(entries: AnalysisNodeRow[]): DigestSegment {",
			"  const text = entries.map(e => e.content).join('\\n');",
			"  return { index: entries[0].index, text };",
			"}",
			"",
			"// ... more lines ...",
			"export function compileDigest(rows: AnalysisNodeRow[]): SessionDigest {",
			"  const segments: DigestSegment[] = [];",
			"  let current: AnalysisNodeRow[] = [];",
			"  // 60+ more lines...",
			"  return { summary: '', segments };",
			"}",
		];
		const diffHunk = "@@ -0,0 +1,146 @@\n" + lines.map((l, i) => `+${l}`).join("\n");

		const status = makeMockStatus({
			unresolvedThreads: 1,
			threadDetails: [
				{
					id: "PRRT_kwDOSoDSZ86IsWUG",
					isResolved: false,
					lastCommentAuthor: "copilot-pull-request-reviewer",
					lastCommentBody: "Role naming is inconsistent",
					fullBody: "Role naming is inconsistent across the new analyzers",
					path: "src/analyze/analyzers/session-overview/digest.ts",
					line: 21, // Line 21 in the diff
					allComments: [
						{
							id: "PRRC_kwDOSoDSZ87KQVtL",
							restApiId: "3393280843",
							author: "copilot-pull-request-reviewer",
							body: "Role naming is inconsistent",
							fullBody: "Role naming is inconsistent across the new analyzers",
							path: "src/analyze/analyzers/session-overview/digest.ts",
							line: 21,
							diffHunk,
						},
					],
				},
			],
		});

		const result = formatAgentNotification(status, config);
		expect(result).not.toBeNull();

		// Should highlight line 21 (the anchored line) with >>>
		expect(result!.detailed).toContain(">>> 21 | +// ... more lines ...");
		// Should show context lines around line 21
		expect(result!.detailed).toContain("   18 | +  return { index: entries[0].index, text };");
		expect(result!.detailed).toContain("   19 | +}");
		expect(result!.detailed).toContain("   22 | +export function compileDigest");
		// Should NOT show lines far from line 21
		expect(result!.detailed).not.toContain("   1 | +/**");
	});

	it("uses comment-level line when available, falls back to thread-level line", () => {
		const status = makeMockStatus({
			unresolvedThreads: 1,
			threadDetails: [
				{
					id: "PRRT_1",
					isResolved: false,
					lastCommentAuthor: "reviewer",
					lastCommentBody: "Fix this",
					fullBody: "Fix this",
					path: "src/app.ts",
					line: 5, // Thread-level line (used as fallback)
					allComments: [
						{
							id: "RC_1",
							restApiId: "502",
							author: "reviewer",
							body: "Fix this",
							fullBody: "Fix this",
							path: "src/app.ts",
							line: 5,
							diffHunk: "@@ -3,5 +3,5 @@\n line3\n line4\n line5\n line6\n line7",
						},
					],
				},
			],
		});

		const result = formatAgentNotification(status, config);
		expect(result).not.toBeNull();
		// Line 5 should be anchored
		expect(result!.detailed).toContain(">>> 5 |  line5");
	});

	it("falls back to thread-level line when comment-level line is missing", () => {
		const status = makeMockStatus({
			unresolvedThreads: 1,
			threadDetails: [
				{
					id: "PRRT_1",
					isResolved: false,
					lastCommentAuthor: "reviewer",
					lastCommentBody: "Fix this",
					fullBody: "Fix this",
					path: "src/app.ts",
					line: 5, // Thread-level line
					allComments: [
						{
							id: "RC_1",
							restApiId: "503",
							author: "reviewer",
							body: "Fix this",
							fullBody: "Fix this",
							path: "src/app.ts",
							// No line on the comment — uses thread.line
							diffHunk: "@@ -3,5 +3,5 @@\n line3\n line4\n line5\n line6\n line7",
						},
					],
				},
			],
		});

		const result = formatAgentNotification(status, config);
		expect(result).not.toBeNull();
		// Thread-level line (5) should be used as fallback
		expect(result!.detailed).toContain(">>> 5 |  line5");
	});
});
