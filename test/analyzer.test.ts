/**
 * Unit tests for pi-ghpr-monitor
 *
 * Tests the PR analysis functions and message formatting
 * without needing a running Pi instance.
 */

import { describe, it, expect } from "vitest";
import {
	countUnresolvedThreads,
	hasConflicts,
	failingChecks,
	pendingChecks,
	failingStatuses,
	pendingStatuses,
	formatStatusUpdate,
	formatActionableItems,
	formatFooterStatus,
	snapshotPR,
	snapshotIssue,
	parseCoauthors,
	linkifyPRRefs,
	formatAgentNotification,
	getReviewDecision,
} from "../src/analyzer";
import type { PullRequestData, PRStatus, IssueData, IssueStatus, MonitorConfig, CommitNode, ReactionNode, ReviewNode, ThreadSummary, CommentSummary } from "../src/analyzer";

function makeMockPR(overrides: Partial<PullRequestData> = {}): PullRequestData {
	const defaults: PullRequestData = {
		comments: { nodes: [] },
		reviewThreads: { nodes: [] },
		reviews: { nodes: [] },
		mergeable: "MERGEABLE",
		mergeStateStatus: "CLEAN",
		state: "OPEN",
		merged: false,
		commits: {
			nodes: [] as CommitNode[],
		},
	};
	return { ...defaults, ...overrides };
}

describe("countUnresolvedThreads", () => {
	it("returns 0 when no threads", () => {
		const pr = makeMockPR();
		expect(countUnresolvedThreads(pr)).toBe(0);
	});

	it("counts unresolved threads only", () => {
		const pr = makeMockPR({
			reviewThreads: {
				nodes: [
					{ id: "1", isResolved: false, comments: { nodes: [] } },
					{ id: "2", isResolved: true, comments: { nodes: [] } },
					{ id: "3", isResolved: false, comments: { nodes: [] } },
				],
			},
		});
		expect(countUnresolvedThreads(pr)).toBe(2);
	});
});

describe("hasConflicts", () => {
	it("returns false for mergeable PR", () => {
		const pr = makeMockPR({ mergeable: "MERGEABLE" });
		expect(hasConflicts(pr)).toBe(false);
	});

	it("returns true for conflicting PR", () => {
		const pr = makeMockPR({ mergeable: "CONFLICTING" });
		expect(hasConflicts(pr)).toBe(true);
	});
});

describe("failingChecks", () => {
	it("returns empty for no check suites", () => {
		const pr = makeMockPR();
		expect(failingChecks(pr)).toEqual([]);
	});

	it("detects failing check suites", () => {
		const pr = makeMockPR({
			commits: {
				nodes: [
					{
						commit: {
							oid: "test-oid",
							status: null,
							checkSuites: {
								nodes: [
									{
										id: "1",
										conclusion: "FAILURE",
										status: "COMPLETED",
										app: { name: "ci/test", slug: "ci-test" },
										checkRuns: { nodes: [{ name: "ci/test", conclusion: "FAILURE", status: "COMPLETED" }] },
									},
									{
										id: "2",
										conclusion: "SUCCESS",
										status: "COMPLETED",
										app: { name: "ci/build", slug: "ci-build" },
										checkRuns: { nodes: [{ name: "ci/build", conclusion: "SUCCESS", status: "COMPLETED" }] },
									},
								],
							},
						},
					},
				],
			},
		});
		expect(failingChecks(pr)).toContain("ci/test");
		expect(failingChecks(pr).length).toBe(1);
	});
});

describe("pendingChecks", () => {
	it("returns empty for no pending checks", () => {
		const pr = makeMockPR();
		expect(pendingChecks(pr)).toEqual([]);
	});

	it("detects in-progress checks", () => {
		const pr = makeMockPR({
			commits: {
				nodes: [
					{
						commit: {
							oid: "test-oid",
							status: null,
							checkSuites: {
								nodes: [
									{
										id: "1",
										conclusion: null,
										status: "IN_PROGRESS",
										app: { name: "ci/test", slug: "ci-test" },
										checkRuns: { nodes: [] },
									},
								],
							},
						},
					},
				],
			},
		});
		expect(pendingChecks(pr)).toContain("ci/test");
	});
});

describe("failingStatuses", () => {
	it("returns empty for no commit statuses", () => {
		const pr = makeMockPR();
		expect(failingStatuses(pr)).toEqual([]);
	});

	it("detects failing commit statuses", () => {
		const pr = makeMockPR({
			commits: {
				nodes: [
					{
						commit: {
							oid: "test-oid",
							checkSuites: { nodes: [] },
							status: {
								state: "FAILURE",
								contexts: [
									{ state: "FAILURE", context: "ci/circleci: Build", description: "Your tests failed on CircleCI", targetUrl: "https://circleci.com/gh/org/repo/123" },
									{ state: "SUCCESS", context: "ci/circleci: lint", description: "Your tests passed on CircleCI!", targetUrl: null },
								],
							},
						},
					},
				],
			},
		});
		expect(failingStatuses(pr)).toContain("ci/circleci: Build");
		expect(failingStatuses(pr).length).toBe(1);
	});

	it("detects error commit statuses", () => {
		const pr = makeMockPR({
			commits: {
				nodes: [
					{
						commit: {
							oid: "test-oid",
							checkSuites: { nodes: [] },
							status: {
								state: "FAILURE",
								contexts: [
									{ state: "ERROR", context: "ci/circleci: deploy", description: "Deploy failed", targetUrl: null },
								],
							},
						},
					},
				],
			},
		});
		expect(failingStatuses(pr)).toContain("ci/circleci: deploy");
	});

	it("returns empty when status is null", () => {
		const pr = makeMockPR({
			commits: {
				nodes: [
					{
						commit: {
							oid: "test-oid",
							checkSuites: { nodes: [] },
							status: null,
						},
					},
				],
			},
		});
		expect(failingStatuses(pr)).toEqual([]);
	});
});

describe("pendingStatuses", () => {
	it("returns empty for no commit statuses", () => {
		const pr = makeMockPR();
		expect(pendingStatuses(pr)).toEqual([]);
	});

	it("detects pending commit statuses", () => {
		const pr = makeMockPR({
			commits: {
				nodes: [
					{
						commit: {
							oid: "test-oid",
							checkSuites: { nodes: [] },
							status: {
								state: "PENDING",
								contexts: [
									{ state: "PENDING", context: "ci/circleci: Build", description: "Pending", targetUrl: null },
								],
							},
						},
					},
				],
			},
		});
		expect(pendingStatuses(pr)).toContain("ci/circleci: Build");
	});

	it("detects expected commit statuses", () => {
		const pr = makeMockPR({
			commits: {
				nodes: [
					{
						commit: {
							oid: "test-oid",
							checkSuites: { nodes: [] },
							status: {
								state: "EXPECTED",
								contexts: [
									{ state: "EXPECTED", context: "ci/travis-ci", description: "Expected", targetUrl: null },
								],
							},
						},
					},
				],
			},
		});
		expect(pendingStatuses(pr)).toContain("ci/travis-ci");
	});
});

describe("failingChecks includes commit statuses", () => {
	it("detects failures from both check suites and commit statuses", () => {
		const pr = makeMockPR({
			commits: {
				nodes: [
					{
						commit: {
							oid: "test-oid",
							checkSuites: {
								nodes: [
									{
										id: "1",
										conclusion: "FAILURE",
										status: "COMPLETED",
										app: { name: "GitHub Actions", slug: "github-actions" },
										checkRuns: { nodes: [{ name: "test", conclusion: "FAILURE", status: "COMPLETED" }] },
									},
								],
							},
							status: {
								state: "FAILURE",
								contexts: [
									{ state: "FAILURE", context: "ci/circleci: Build", description: "Your tests failed on CircleCI", targetUrl: "https://circleci.com/gh/org/repo/123" },
								],
							},
						},
					},
				],
			},
		});
		// Should include: check suite name (GitHub Actions), check run name (test), and commit status (ci/circleci: Build)
		expect(failingChecks(pr)).toContain("GitHub Actions");
		expect(failingChecks(pr)).toContain("ci/circleci: Build");
		expect(failingChecks(pr).length).toBe(3);
	});

	it("detects failures from commit statuses alone (no check suites)", () => {
		const pr = makeMockPR({
			commits: {
				nodes: [
					{
						commit: {
							oid: "test-oid",
							checkSuites: { nodes: [] },
							status: {
								state: "FAILURE",
								contexts: [
									{ state: "FAILURE", context: "ci/circleci: Build", description: "Your tests failed on CircleCI", targetUrl: null },
								],
							},
						},
					},
				],
			},
		});
		expect(failingChecks(pr)).toContain("ci/circleci: Build");
		expect(failingChecks(pr).length).toBe(1);
	});
});

describe("pendingChecks includes commit statuses", () => {
	it("detects pending from both check suites and commit statuses", () => {
		const pr = makeMockPR({
			commits: {
				nodes: [
					{
						commit: {
							oid: "test-oid",
							checkSuites: {
								nodes: [
									{
										id: "1",
										conclusion: null,
										status: "IN_PROGRESS",
										app: { name: "GitHub Actions", slug: "github-actions" },
										checkRuns: { nodes: [] },
									},
								],
							},
							status: {
								state: "PENDING",
								contexts: [
									{ state: "PENDING", context: "ci/circleci: Build", description: "Pending", targetUrl: null },
								],
							},
						},
					},
				],
			},
		});
		expect(pendingChecks(pr)).toContain("GitHub Actions");
		expect(pendingChecks(pr)).toContain("ci/circleci: Build");
	});
});

describe("formatStatusUpdate", () => {
	const config: MonitorConfig = {
		owner: "v2nic",
		repo: "gh-pr-review",
		number: 42,
		host: "github.com",
		mode: "all",
		intervalSec: 60,
		debounceSec: 30,
	};

	it("returns clean status when no issues", () => {
		const curr: PRStatus = {
			unresolvedThreads: 0,
			generalComments: 0,
			hasConflicts: false,
			failingChecks: [],
			pendingChecks: [],
			lastCommentTimestamp: "",
			lastCommentBySelf: false,
			lastCommitOid: "", lastCommitAuthor: "", lastCommitCoauthors: "",
		lastCommitMessageHeadline: "",
		};
		const update = formatStatusUpdate(null, curr, config);
		expect(update).toContain("all clear");
	});

	it("detects merge conflicts", () => {
		const curr: PRStatus = {
			unresolvedThreads: 0,
			generalComments: 0,
			hasConflicts: true,
			failingChecks: [],
			pendingChecks: [],
			lastCommentTimestamp: "",
			lastCommentBySelf: false,
			lastCommitOid: "", lastCommitAuthor: "", lastCommitCoauthors: "",
		lastCommitMessageHeadline: "",
		};
		const update = formatStatusUpdate(null, curr, config);
		expect(update).toContain("conflict");
	});

	it("detects failing CI checks", () => {
		const curr: PRStatus = {
			unresolvedThreads: 0,
			generalComments: 0,
			hasConflicts: false,
			failingChecks: ["ci/test"],
			pendingChecks: [],
			lastCommentTimestamp: "",
			lastCommentBySelf: false,
			lastCommitOid: "", lastCommitAuthor: "", lastCommitCoauthors: "",
		lastCommitMessageHeadline: "",
		};
		const update = formatStatusUpdate(null, curr, config);
		expect(update).toContain("Failing");
		expect(update).toContain("ci/test");
	});

	it("detects new unresolved threads", () => {
		const prev: PRStatus = {
			unresolvedThreads: 1,
			generalComments: 0,
			hasConflicts: false,
			failingChecks: [],
			pendingChecks: [],
			lastCommentTimestamp: "",
			lastCommentBySelf: false,
			lastCommitOid: "", lastCommitAuthor: "", lastCommitCoauthors: "",
		lastCommitMessageHeadline: "",
		};
		const curr: PRStatus = {
			...prev,
			unresolvedThreads: 3,
		};
		const update = formatStatusUpdate(prev, curr, config);
		expect(update).toContain("2 new");
	});

	it("detects all checks now passing", () => {
		const prev: PRStatus = {
			unresolvedThreads: 0,
			generalComments: 0,
			hasConflicts: false,
			failingChecks: ["ci/test"],
			pendingChecks: ["ci/build"],
			lastCommentTimestamp: "",
			lastCommentBySelf: false,
			lastCommitOid: "", lastCommitAuthor: "", lastCommitCoauthors: "",
		lastCommitMessageHeadline: "",
		};
		const curr: PRStatus = {
			unresolvedThreads: 0,
			generalComments: 0,
			hasConflicts: false,
			failingChecks: [],
			pendingChecks: [],
			lastCommentTimestamp: "",
			lastCommentBySelf: false,
			lastCommitOid: "", lastCommitAuthor: "", lastCommitCoauthors: "",
		lastCommitMessageHeadline: "",
		};
		const update = formatStatusUpdate(prev, curr, config);
		expect(update).toContain("passed");
	});

	it("shows clean status when no issues at all", () => {
		const curr: PRStatus = {
			unresolvedThreads: 0,
			generalComments: 0,
			hasConflicts: false,
			failingChecks: [],
			pendingChecks: [],
			lastCommentTimestamp: "",
			lastCommentBySelf: false,
			lastCommitOid: "", lastCommitAuthor: "", lastCommitCoauthors: "",
		lastCommitMessageHeadline: "",
		};
		const update = formatStatusUpdate(null, curr, config);
		expect(update).toContain("all clear");
	});

	it("reports initial unresolved threads", () => {
		const curr: PRStatus = {
			unresolvedThreads: 2,
			generalComments: 0,
			hasConflicts: false,
			failingChecks: [],
			pendingChecks: [],
			lastCommentTimestamp: "",
			lastCommentBySelf: false,
			lastCommitOid: "", lastCommitAuthor: "", lastCommitCoauthors: "",
		lastCommitMessageHeadline: "",
		};
		const update = formatStatusUpdate(null, curr, config);
		// When prev is null, format uses "N new" format since prev count defaults to 0
		expect(update).toContain("new unresolved review thread");
	});

	it("does not report pending checks (not actionable)", () => {
		const curr: PRStatus = {
			unresolvedThreads: 0,
			generalComments: 0,
			hasConflicts: false,
			failingChecks: [],
			pendingChecks: ["ci/test", "ci/lint"],
			lastCommentTimestamp: "",
			lastCommentBySelf: false,
			lastCommitOid: "", lastCommitAuthor: "", lastCommitCoauthors: "",
		lastCommitMessageHeadline: "",
		};
		const update = formatStatusUpdate(null, curr, config);
		expect(update).not.toContain("pending");
	});

	// -- auto-merge (ciGreenMerge) tests --

	const autoMergeConfig: MonitorConfig = {
		owner: "v2nic",
		repo: "gh-pr-review",
		number: 42,
		host: "github.com",
		mode: "all",
		intervalSec: 60,
		debounceSec: 30,
		autoMerge: true,
	};

	it("emits ciGreenMerge template when CI transitions to green and autoMerge is true", () => {
		const prev: PRStatus = {
			unresolvedThreads: 0,
			generalComments: 0,
			hasConflicts: false,
			failingChecks: ["ci/test"],
			pendingChecks: ["ci/build"],
			lastCommentTimestamp: "",
			lastCommentBySelf: false,
			lastCommitOid: "", lastCommitAuthor: "", lastCommitCoauthors: "",
			lastCommitMessageHeadline: "",
		};
		const curr: PRStatus = {
			unresolvedThreads: 0,
			generalComments: 0,
			hasConflicts: false,
			failingChecks: [],
			pendingChecks: [],
			lastCommentTimestamp: "",
			lastCommentBySelf: false,
			lastCommitOid: "", lastCommitAuthor: "", lastCommitCoauthors: "",
			lastCommitMessageHeadline: "",
		};
		const update = formatStatusUpdate(prev, curr, autoMergeConfig, { ciGreenMerge: "Please merge {prLabel}" });
		expect(update).toContain("Please merge");
		expect(update).not.toContain("passed");
	});

	it("does NOT emit merge message when autoMerge is false (default)", () => {
		const prev: PRStatus = {
			unresolvedThreads: 0,
			generalComments: 0,
			hasConflicts: false,
			failingChecks: ["ci/test"],
			pendingChecks: ["ci/build"],
			lastCommentTimestamp: "",
			lastCommentBySelf: false,
			lastCommitOid: "", lastCommitAuthor: "", lastCommitCoauthors: "",
			lastCommitMessageHeadline: "",
		};
		const curr: PRStatus = {
			unresolvedThreads: 0,
			generalComments: 0,
			hasConflicts: false,
			failingChecks: [],
			pendingChecks: [],
			lastCommentTimestamp: "",
			lastCommentBySelf: false,
			lastCommitOid: "", lastCommitAuthor: "", lastCommitCoauthors: "",
			lastCommitMessageHeadline: "",
		};
		const update = formatStatusUpdate(prev, curr, config, { ciGreenMerge: "Please merge {prLabel}" });
		expect(update).toContain("passed");
		expect(update).not.toContain("Please merge");
	});

	it("does NOT emit merge message when CI was already green (no transition)", () => {
		const prev: PRStatus = {
			unresolvedThreads: 0,
			generalComments: 0,
			hasConflicts: false,
			failingChecks: [],
			pendingChecks: [],
			lastCommentTimestamp: "",
			lastCommentBySelf: false,
			lastCommitOid: "", lastCommitAuthor: "", lastCommitCoauthors: "",
			lastCommitMessageHeadline: "",
		};
		const curr: PRStatus = { ...prev };
		const update = formatStatusUpdate(prev, curr, autoMergeConfig, { ciGreenMerge: "Please merge {prLabel}" });
		expect(update).toBe("");
	});

	it("does NOT emit merge message on first poll (prev=null) even with autoMerge", () => {
		const curr: PRStatus = {
			unresolvedThreads: 0,
			generalComments: 0,
			hasConflicts: false,
			failingChecks: [],
			pendingChecks: [],
			lastCommentTimestamp: "",
			lastCommentBySelf: false,
			lastCommitOid: "", lastCommitAuthor: "", lastCommitCoauthors: "",
			lastCommitMessageHeadline: "",
		};
		const update = formatStatusUpdate(null, curr, autoMergeConfig, { ciGreenMerge: "Please merge {prLabel}" });
		expect(update).not.toContain("Please merge");
	});

	it("emits merge message when CI transitions to green with autoMerge and also has threads", () => {
		const prev: PRStatus = {
			unresolvedThreads: 0,
			generalComments: 0,
			hasConflicts: false,
			failingChecks: ["ci/test"],
			pendingChecks: [],
			lastCommentTimestamp: "",
			lastCommentBySelf: false,
			lastCommitOid: "", lastCommitAuthor: "", lastCommitCoauthors: "",
			lastCommitMessageHeadline: "",
		};
		const curr: PRStatus = {
			unresolvedThreads: 1,
			generalComments: 0,
			hasConflicts: false,
			failingChecks: [],
			pendingChecks: [],
			lastCommentTimestamp: "",
			lastCommentBySelf: false,
			lastCommitOid: "", lastCommitAuthor: "", lastCommitCoauthors: "",
			lastCommitMessageHeadline: "",
		};
		const update = formatStatusUpdate(prev, curr, autoMergeConfig, { ciGreenMerge: "Please merge {prLabel}" });
		expect(update).toContain("Please merge");
		expect(update).not.toContain("all clear"); // merge message supersedes all-clear
	});
});
describe("formatActionableItems", () => {
	const config: MonitorConfig = {
		owner: "owner",
		repo: "repo",
		number: 42,
		host: "github.com",
		mode: "all",
		intervalSec: 60,
		debounceSec: 30,
	};

	it("returns null when nothing is actionable", () => {
		const status: PRStatus = {
			unresolvedThreads: 0,
			generalComments: 0,
			hasConflicts: false,
			failingChecks: [],
			pendingChecks: [],
			lastCommentTimestamp: "",
			lastCommentBySelf: false,
			lastCommitOid: "", lastCommitAuthor: "", lastCommitCoauthors: "",
		lastCommitMessageHeadline: "",
		};
		expect(formatActionableItems(status, config)).toBeNull();
	});

	it("returns conflicts when present", () => {
		const status: PRStatus = {
			unresolvedThreads: 0,
			generalComments: 0,
			hasConflicts: true,
			failingChecks: [],
			pendingChecks: [],
			lastCommentTimestamp: "",
			lastCommentBySelf: false,
			lastCommitOid: "", lastCommitAuthor: "", lastCommitCoauthors: "",
		lastCommitMessageHeadline: "",
		};
		const result = formatActionableItems(status, config);
		expect(result).toContain("Merge conflicts detected");
	});

	it("returns failing CI when present", () => {
		const status: PRStatus = {
			unresolvedThreads: 0,
			generalComments: 0,
			hasConflicts: false,
			failingChecks: ["ci/test", "ci/lint"],
			pendingChecks: [],
			lastCommentTimestamp: "",
			lastCommentBySelf: false,
			lastCommitOid: "", lastCommitAuthor: "", lastCommitCoauthors: "",
		lastCommitMessageHeadline: "",
		};
		const result = formatActionableItems(status, config);
		expect(result).toContain("Failing CI checks");
		expect(result).toContain("ci/test");
		expect(result).toContain("ci/lint");
	});

	it("returns unresolved threads when present", () => {
		const status: PRStatus = {
			unresolvedThreads: 3,
			generalComments: 0,
			hasConflicts: false,
			failingChecks: [],
			pendingChecks: [],
			lastCommentTimestamp: "",
			lastCommentBySelf: false,
			lastCommitOid: "", lastCommitAuthor: "", lastCommitCoauthors: "",
		lastCommitMessageHeadline: "",
		};
		const result = formatActionableItems(status, config);
		expect(result).toContain("3 unresolved review thread(s)");
	});

	it("returns general comments when present", () => {
		const status: PRStatus = {
			unresolvedThreads: 0,
			generalComments: 2,
			hasConflicts: false,
			failingChecks: [],
			pendingChecks: [],
			lastCommentTimestamp: "",
			lastCommentBySelf: false,
			lastCommitOid: "", lastCommitAuthor: "", lastCommitCoauthors: "",
		lastCommitMessageHeadline: "",
		};
		const result = formatActionableItems(status, config);
		expect(result).toContain("2 general comment(s)");
	});

	it("does not include pending CI (not actionable)", () => {
		const status: PRStatus = {
			unresolvedThreads: 0,
			generalComments: 0,
			hasConflicts: false,
			failingChecks: [],
			pendingChecks: ["ci/build"],
			lastCommentTimestamp: "",
			lastCommentBySelf: false,
			lastCommitOid: "", lastCommitAuthor: "", lastCommitCoauthors: "",
		lastCommitMessageHeadline: "",
		};
		expect(formatActionableItems(status, config)).toBeNull();
	});

	it("does not include all-clear message", () => {
		const status: PRStatus = {
			unresolvedThreads: 0,
			generalComments: 0,
			hasConflicts: false,
			failingChecks: [],
			pendingChecks: [],
			lastCommentTimestamp: "",
			lastCommentBySelf: false,
			lastCommitOid: "", lastCommitAuthor: "", lastCommitCoauthors: "",
		lastCommitMessageHeadline: "",
		};
		expect(formatActionableItems(status, config)).toBeNull();
	});

	it("returns multiple actionable items combined", () => {
		const status: PRStatus = {
			unresolvedThreads: 2,
			generalComments: 1,
			hasConflicts: true,
			failingChecks: ["ci/test"],
			pendingChecks: ["ci/build"],
			lastCommentTimestamp: "",
			lastCommentBySelf: false,
			lastCommitOid: "", lastCommitAuthor: "", lastCommitCoauthors: "",
		lastCommitMessageHeadline: "",
		};
		const result = formatActionableItems(status, config);
		expect(result).toContain("Merge conflicts detected");
		expect(result).toContain("Failing CI checks");
		expect(result).toContain("2 unresolved review thread(s)");
		expect(result).toContain("1 general comment(s)");
		expect(result).not.toContain("pending");
	});
});

describe("formatStatusUpdate with detail", () => {
	const config: MonitorConfig = {
		owner: "owner",
		repo: "repo",
		number: 42,
		host: "github.com",
		mode: "all",
		intervalSec: 60,
		debounceSec: 30,
	};

	it("includes thread details in notifications", () => {
		const curr: PRStatus = {
			unresolvedThreads: 2,
			generalComments: 0,
			hasConflicts: false,
			failingChecks: [],
			pendingChecks: [],
			lastCommentTimestamp: "",
			lastCommentBySelf: false,
			lastCommitOid: "", lastCommitAuthor: "", lastCommitCoauthors: "",
		lastCommitMessageHeadline: "",
			threadDetails: [
				{ id: "PRRT_1", isResolved: false, lastCommentAuthor: "reviewer", lastCommentBody: "Please fix this typo" },
				{ id: "PRRT_2", isResolved: false, lastCommentAuthor: "bot", lastCommentBody: "Build failed" },
			],
			commentDetails: [],
			checkDetails: [],
		};
		const result = formatStatusUpdate(null, curr, config);
		expect(result).toContain("PRRT_1");
		expect(result).toContain("reviewer");
		expect(result).toContain("Please fix this typo");
		expect(result).toContain("PRRT_2");
	});

	it("includes comment details in notifications", () => {
		const curr: PRStatus = {
			unresolvedThreads: 0,
			generalComments: 1,
			hasConflicts: false,
			failingChecks: [],
			pendingChecks: [],
			lastCommentTimestamp: "",
			lastCommentBySelf: false,
			lastCommitOid: "", lastCommitAuthor: "", lastCommitCoauthors: "",
		lastCommitMessageHeadline: "",
			threadDetails: [],
			commentDetails: [
				{ id: "C_1", restApiId: "301", author: "teammate", body: "Can you add tests?" },
			],
			checkDetails: [],
		};
		const result = formatStatusUpdate(null, curr, config);
		expect(result).toContain("C_1");
		expect(result).toContain("teammate");
		expect(result).toContain("Can you add tests?");
	});

	it("includes check details for failing CI", () => {
		const curr: PRStatus = {
			unresolvedThreads: 0,
			generalComments: 0,
			hasConflicts: false,
			failingChecks: ["ci/test"],
			pendingChecks: [],
			lastCommentTimestamp: "",
			lastCommentBySelf: false,
			lastCommitOid: "", lastCommitAuthor: "", lastCommitCoauthors: "",
		lastCommitMessageHeadline: "",
			threadDetails: [],
			commentDetails: [],
			checkDetails: [
				{ name: "ci/test", conclusion: "FAILURE" },
			],
		};
		const result = formatStatusUpdate(null, curr, config);
		expect(result).toContain("ci/test");
		expect(result).toContain("FAILURE");
	});

	it("truncates long comment bodies", () => {
		const longBody = "A".repeat(200);
		const curr: PRStatus = {
			unresolvedThreads: 0,
			generalComments: 1,
			hasConflicts: false,
			failingChecks: [],
			pendingChecks: [],
			lastCommentTimestamp: "",
			lastCommentBySelf: false,
			lastCommitOid: "", lastCommitAuthor: "", lastCommitCoauthors: "",
		lastCommitMessageHeadline: "",
			threadDetails: [],
			commentDetails: [
				{ id: "C_1", restApiId: "302", author: "user", body: longBody },
			],
			checkDetails: [],
		};
		const result = formatStatusUpdate(null, curr, config);
		expect(result).toContain("…");
		expect(result).not.toContain(longBody);
	});

	it("keeps only the first line of multiline comment bodies", () => {
		const multilineBody = "## Copilot review feedback — all addressed ✅\n\nAll 5 review comments have been fixed in the force-pushed commit:\n1. Some detail";
		const curr: PRStatus = {
			unresolvedThreads: 0,
			generalComments: 1,
			hasConflicts: false,
			failingChecks: [],
			pendingChecks: [],
			lastCommentTimestamp: "",
			lastCommentBySelf: false,
			lastCommitOid: "", lastCommitAuthor: "", lastCommitCoauthors: "",
		lastCommitMessageHeadline: "",
			threadDetails: [],
			commentDetails: [
				{ id: "C_1", restApiId: "303", author: "v2nic", body: multilineBody },
			],
			checkDetails: [],
		};
		const result = formatStatusUpdate(null, curr, config);
		expect(result).toContain("## Copilot review feedback — all addressed ✅");
		expect(result).not.toContain("All 5 review comments");
		expect(result).not.toContain("\n\n");
	});
});

describe("acknowledged comments (THUMBS_UP reactions)", () => {
	const config: MonitorConfig = {
		owner: "owner",
		repo: "repo",
		number: 42,
		host: "github.com",
		mode: "all",
		intervalSec: 60,
		debounceSec: 30,
	};

	it("filters out comments with THUMBS_UP reaction from general count and details", () => {
		const pr: PullRequestData = {
			comments: {
				nodes: [
					{ id: "c-1", databaseId: 401, body: "Please fix this", author: { login: "reviewer" }, createdAt: "2024-01-01T00:00:00Z", reactions: { nodes: [] } },
					{ id: "c-2", databaseId: 402, body: "Quality Gate Passed", author: { login: "sonarqubecloud" }, createdAt: "2024-01-01T00:01:00Z", reactions: { nodes: [{ content: "THUMBS_UP" }] } },
				],
			},
			reviewThreads: { nodes: [] },
			mergeable: "MERGEABLE",
			mergeStateStatus: "CLEAN",
			state: "OPEN",
			merged: false,
			reviews: { nodes: [] },
			commits: { nodes: [{ commit: { oid: "test-oid", status: null, checkSuites: { nodes: [] } } }] },
		};
		const status = snapshotPR(pr, []);
		// c-2 is acknowledged, so only c-1 counts
		expect(status.generalComments).toBe(1);
		expect(status.commentDetails).toHaveLength(1);
		expect(status.commentDetails![0].id).toBe("c-1");
	});

	it("filters out review threads whose last comment has THUMBS_UP", () => {
		const pr: PullRequestData = {
			comments: { nodes: [] },
			reviewThreads: {
				nodes: [
					{
						id: "t-1",
						isResolved: false,
						comments: {
							nodes: [
								{ id: "tc-1", fullDatabaseId: "601", body: "Fix this", author: { login: "reviewer" }, createdAt: "2024-01-01T00:00:00Z", reactions: { nodes: [] } },
							],
						},
					},
					{
						id: "t-2",
						isResolved: false,
						comments: {
							nodes: [
								{ id: "tc-2", fullDatabaseId: "602", body: "Looks good now", author: { login: "dev" }, createdAt: "2024-01-01T00:01:00Z", reactions: { nodes: [{ content: "THUMBS_UP" }] } },
							],
						},
					},
				],
			},
			mergeable: "MERGEABLE",
			mergeStateStatus: "CLEAN",
			state: "OPEN",
			merged: false,
			reviews: { nodes: [] },
			commits: { nodes: [{ commit: { oid: "test-oid", status: null, checkSuites: { nodes: [] } } }] },
		};
		const status = snapshotPR(pr, []);
		// t-2 is filtered because its last comment has THUMBS_UP
		expect(status.unresolvedThreads).toBe(1);
		expect(status.threadDetails).toHaveLength(1);
		expect(status.threadDetails![0].id).toBe("t-1");
	});

	it("does not filter comments without reactions", () => {
		const pr: PullRequestData = {
			comments: {
				nodes: [
					{ id: "c-1", databaseId: 701, body: "Please fix", author: { login: "reviewer" }, createdAt: "2024-01-01T00:00:00Z", reactions: { nodes: [] } },
				],
			},
			reviewThreads: { nodes: [] },
			mergeable: "MERGEABLE",
			mergeStateStatus: "CLEAN",
			state: "OPEN",
			merged: false,
			reviews: { nodes: [] },
			commits: { nodes: [{ commit: { oid: "test-oid", status: null, checkSuites: { nodes: [] } } }] },
		};
		const status = snapshotPR(pr, []);
		expect(status.generalComments).toBe(1);
		expect(status.commentDetails![0].id).toBe("c-1");
	});

	it("filters comments with THUMBS_UP but not other reactions", () => {
		const pr: PullRequestData = {
			comments: {
				nodes: [
					{ id: "c-1", databaseId: 801, body: "Nice!", author: { login: "reviewer" }, createdAt: "2024-01-01T00:00:00Z", reactions: { nodes: [{ content: "HEART" }] } },
					{ id: "c-2", databaseId: 802, body: "Done", author: { login: "dev" }, createdAt: "2024-01-01T00:01:00Z", reactions: { nodes: [{ content: "THUMBS_UP" }] } },
				],
			},
			reviewThreads: { nodes: [] },
			mergeable: "MERGEABLE",
			mergeStateStatus: "CLEAN",
			state: "OPEN",
			merged: false,
			reviews: { nodes: [] },
			commits: { nodes: [{ commit: { oid: "test-oid", status: null, checkSuites: { nodes: [] } } }] },
		};
		const status = snapshotPR(pr, []);
		// c-1 has HEART (not THUMBS_UP), so it's kept
		// c-2 has THUMBS_UP, so it's filtered
		expect(status.generalComments).toBe(1);
		expect(status.commentDetails![0].id).toBe("c-1");
	});
});

describe("formatStatusUpdate does not repeat all-clear on unchanged status", () => {
	const config: MonitorConfig = {
		owner: "o", repo: "r", number: 1,
		host: "github.com", mode: "all", intervalSec: 60, debounceSec: 30,
	};

	it("sends all-clear on first poll (prev=null)", () => {
		const clean: PRStatus = {
			unresolvedThreads: 0, generalComments: 0, hasConflicts: false,
			failingChecks: [], pendingChecks: [],
			lastCommentTimestamp: "", lastCommentBySelf: false,
			lastCommitOid: "", lastCommitAuthor: "", lastCommitCoauthors: "",
		lastCommitMessageHeadline: "",
			threadDetails: [], commentDetails: [], checkDetails: [],
		};
		const result = formatStatusUpdate(null, clean, config);
		expect(result).toContain("all clear");
	});

	it("sends all-clear when transitioning from issues to clean", () => {
		const hadIssues: PRStatus = {
			unresolvedThreads: 1, generalComments: 0, hasConflicts: false,
			failingChecks: ["ci/test"], pendingChecks: [],
			lastCommentTimestamp: "", lastCommentBySelf: false,
			lastCommitOid: "", lastCommitAuthor: "", lastCommitCoauthors: "",
		lastCommitMessageHeadline: "",
			threadDetails: [], commentDetails: [],
			checkDetails: [{ name: "ci/test", conclusion: "FAILURE" }],
		};
		const clean: PRStatus = {
			unresolvedThreads: 0, generalComments: 0, hasConflicts: false,
			failingChecks: [], pendingChecks: [],
			lastCommentTimestamp: "", lastCommentBySelf: false,
			lastCommitOid: "", lastCommitAuthor: "", lastCommitCoauthors: "",
		lastCommitMessageHeadline: "",
			threadDetails: [], commentDetails: [], checkDetails: [],
		};
		const result = formatStatusUpdate(hadIssues, clean, config);
		expect(result).toContain("all clear");
	});

	it("does NOT send all-clear again when status is unchanged clean", () => {
		const clean: PRStatus = {
			unresolvedThreads: 0, generalComments: 0, hasConflicts: false,
			failingChecks: [], pendingChecks: [],
			lastCommentTimestamp: "", lastCommentBySelf: false,
			lastCommitOid: "", lastCommitAuthor: "", lastCommitCoauthors: "",
		lastCommitMessageHeadline: "",
			threadDetails: [], commentDetails: [], checkDetails: [],
		};
		const result = formatStatusUpdate(clean, clean, config);
		expect(result).toBe("");
	});

	it("does NOT send all-clear on second poll with same clean state", () => {
		const clean: PRStatus = {
			unresolvedThreads: 0, generalComments: 0, hasConflicts: false,
			failingChecks: [], pendingChecks: [],
			lastCommentTimestamp: "", lastCommentBySelf: false,
			lastCommitOid: "", lastCommitAuthor: "", lastCommitCoauthors: "",
		lastCommitMessageHeadline: "",
			threadDetails: [], commentDetails: [], checkDetails: [],
		};
		const first = formatStatusUpdate(null, clean, config);
		expect(first).toContain("all clear");
		const second = formatStatusUpdate(clean, clean, config);
		expect(second).toBe("");
	});
});

describe("formatFooterStatus", () => {
	const config: MonitorConfig = {
		owner: "mobilityhouse", repo: "vgi-na-masscec", number: 366,
		host: "github.com", mode: "all", intervalSec: 60, debounceSec: 30,
	};
	const clean: PRStatus = {
		unresolvedThreads: 0, generalComments: 0, hasConflicts: false,
		failingChecks: [], pendingChecks: [],
		lastCommentTimestamp: "", lastCommentBySelf: false,
			lastCommitOid: "", lastCommitAuthor: "", lastCommitCoauthors: "",
		lastCommitMessageHeadline: "",
		threadDetails: [], commentDetails: [], checkDetails: [],
	};

	it("shows URL without emojis when no issues", () => {
		const status = clean;
		const result = formatFooterStatus(config, status);
		expect(result).toBe("📡 https://github.com/mobilityhouse/vgi-na-masscec/pull/366");
	});

	it("shows URL without emojis when status is null", () => {
		const result = formatFooterStatus(config, null);
		expect(result).toBe("📡 https://github.com/mobilityhouse/vgi-na-masscec/pull/366");
	});

	it("shows conflict emoji", () => {
		const status = { ...clean, hasConflicts: true };
		const result = formatFooterStatus(config, status);
		expect(result).toBe("📡 https://github.com/mobilityhouse/vgi-na-masscec/pull/366 ⚠️");
	});

	it("shows thread emoji", () => {
		const status = { ...clean, unresolvedThreads: 3 };
		const result = formatFooterStatus(config, status);
		expect(result).toBe("📡 https://github.com/mobilityhouse/vgi-na-masscec/pull/366 💬");
	});

	it("shows comment emoji", () => {
		const status = { ...clean, generalComments: 2 };
		const result = formatFooterStatus(config, status);
		expect(result).toBe("📡 https://github.com/mobilityhouse/vgi-na-masscec/pull/366 💭");
	});

	it("shows failing check emoji", () => {
		const status = { ...clean, failingChecks: ["ci/test"] };
		const result = formatFooterStatus(config, status);
		expect(result).toBe("📡 https://github.com/mobilityhouse/vgi-na-masscec/pull/366 ❌");
	});

	it("shows pending check emoji", () => {
		const status = { ...clean, pendingChecks: ["ci/build"] };
		const result = formatFooterStatus(config, status);
		expect(result).toBe("📡 https://github.com/mobilityhouse/vgi-na-masscec/pull/366 ⏳");
	});

	it("shows multiple emojis for multiple issues", () => {
		const status = { ...clean, hasConflicts: true, unresolvedThreads: 1, failingChecks: ["ci/test"] };
		const result = formatFooterStatus(config, status);
		expect(result).toBe("📡 https://github.com/mobilityhouse/vgi-na-masscec/pull/366 ⚠️💬❌");
	});

	it("shows all emojis when all issue types present", () => {
		const status = {
			...clean,
			hasConflicts: true, unresolvedThreads: 1, generalComments: 1,
			failingChecks: ["ci/test"], pendingChecks: ["ci/build"],
		};
		const result = formatFooterStatus(config, status);
		expect(result).toBe("📡 https://github.com/mobilityhouse/vgi-na-masscec/pull/366 ⚠️💬💭❌⏳");
	});

	it("uses custom host in URL", () => {
		const ghConfig = { ...config, host: "github.corp.com" };
		const result = formatFooterStatus(ghConfig, null);
		expect(result).toBe("📡 https://github.corp.com/mobilityhouse/vgi-na-masscec/pull/366");
	});

	it("shows auto-merge emoji when autoMerge is enabled", () => {
		const autoMergeConfig = { ...config, autoMerge: true };
		const status = clean;
		const result = formatFooterStatus(autoMergeConfig, status);
		expect(result).toBe("📡 https://github.com/mobilityhouse/vgi-na-masscec/pull/366 🔀");
	});

	it("does not show auto-merge emoji for issues", () => {
		const issueConfig = { ...config, resourceType: "issue" as const, autoMerge: true };
		const issueStatus: IssueStatus = {
			title: "test", state: "OPEN", generalComments: 0,
			lastCommentTimestamp: "", commentDetails: [],
		};
		const result = formatFooterStatus(issueConfig, issueStatus);
		expect(result).not.toContain("🔀");
	});
});

describe("linkifyPRRefs", () => {
	const OSC_OPEN = "\u001b]8;;";
	const OSC_SEP = "\u001b\\";
	const OSC_CLOSE = "\u001b]8;;\u001b\\";

	function linkify(url: string, display: string): string {
		return `${OSC_OPEN}${url}${OSC_SEP}${display}${OSC_CLOSE}`;
	}

	it("linkifies owner/repo#number patterns", () => {
		const input = "✨ v2nic/gh-pr-review#42 — open, all clear";
		const result = linkifyPRRefs(input);
		expect(result).toBe(
			`✨ ${linkify("https://github.com/v2nic/gh-pr-review/pull/42", "v2nic/gh-pr-review#42")} — open, all clear`,
		);
	});

	it("linkifies multiple PR refs in one message", () => {
		const input = "✅ All CI checks passed on mobilityhouse/vgi-na-masscec#538 ✨ mobilityhouse/vgi-na-masscec#538 — open, all clear";
		const result = linkifyPRRefs(input);
		expect(result).toBe(
			`✅ All CI checks passed on ${linkify("https://github.com/mobilityhouse/vgi-na-masscec/pull/538", "mobilityhouse/vgi-na-masscec#538")} ✨ ${linkify("https://github.com/mobilityhouse/vgi-na-masscec/pull/538", "mobilityhouse/vgi-na-masscec#538")} — open, all clear`,
		);
	});

	it("linkifies full PR URLs", () => {
		const input = "📡 https://github.com/mobilityhouse/vgi-na-masscec/pull/366";
		const result = linkifyPRRefs(input);
		expect(result).toBe(
			`📡 ${linkify("https://github.com/mobilityhouse/vgi-na-masscec/pull/366", "mobilityhouse/vgi-na-masscec#366")}`,
		);
	});

	it("linkifies PR URLs with non-github.com hosts", () => {
		const input = "📡 https://github.corp.com/owner/repo/pull/42";
		const result = linkifyPRRefs(input);
		expect(result).toBe(
			`📡 ${linkify("https://github.corp.com/owner/repo/pull/42", "owner/repo#42")}`,
		);
	});

	it("linkifies PR URLs before PR refs, avoiding double-linkification", () => {
		// If a message contains both a URL and a ref for the same PR,
		// the URL should be linkified first, and the remaining ref independently.
		const input = "Check https://github.com/v2nic/gh-pr-review/pull/42 and v2nic/gh-pr-review#42";
		const result = linkifyPRRefs(input);
		expect(result).toBe(
			`Check ${linkify("https://github.com/v2nic/gh-pr-review/pull/42", "v2nic/gh-pr-review#42")} and ${linkify("https://github.com/v2nic/gh-pr-review/pull/42", "v2nic/gh-pr-review#42")}`,
		);
	});

	it("does not linkify text without PR refs", () => {
		const input = "Just some regular text without any PR references.";
		expect(linkifyPRRefs(input)).toBe(input);
	});

	it("handles PR refs with hyphens and dots in owner/repo names", () => {
		const input = "my-org/my-repo.v2#123";
		const result = linkifyPRRefs(input);
		expect(result).toBe(
			`${linkify("https://github.com/my-org/my-repo.v2/pull/123", "my-org/my-repo.v2#123")}`,
		);
	});

	it("handles merge conflict notification", () => {
		const input = "⚠️  Merge conflicts detected on owner/repo#42";
		const result = linkifyPRRefs(input);
		expect(result).toBe(
			`⚠️  Merge conflicts detected on ${linkify("https://github.com/owner/repo/pull/42", "owner/repo#42")}`,
		);
	});

	it("handles CI failure notification with PR ref", () => {
		const input = "❌ Failing CI checks on owner/repo#42: ci/test, ci/build";
		const result = linkifyPRRefs(input);
		expect(result).toBe(
			`❌ Failing CI checks on ${linkify("https://github.com/owner/repo/pull/42", "owner/repo#42")}: ci/test, ci/build`,
		);
	});

	it("linkifies PR URLs with http scheme (normalizes to https)", () => {
		const input = "📡 http://github.corp.com/owner/repo/pull/42";
		const result = linkifyPRRefs(input);
		// The href uses https (normalized from http), display text uses owner/repo#number shorthand
		expect(result).toBe(
			`📡 ${linkify("https://github.corp.com/owner/repo/pull/42", "owner/repo#42")}`,
		);
	});

	it("linkifies footer-style URL with emojis", () => {
		const input = "📡 https://github.com/mobilityhouse/vgi-na-masscec/pull/366 ⚠️💬❌";
		const result = linkifyPRRefs(input);
		expect(result).toBe(
			`📡 ${linkify("https://github.com/mobilityhouse/vgi-na-masscec/pull/366", "mobilityhouse/vgi-na-masscec#366")} ⚠️💬❌`,
		);
	});

	it("is idempotent — linkifying already-linkified text produces the same result", () => {
		const input = "Check v2nic/gh-pr-review#42 and https://github.com/owner/repo/pull/99";
		const first = linkifyPRRefs(input);
		const second = linkifyPRRefs(first);
		expect(second).toBe(first);
	});

	it("uses defaultHost for shorthand PR refs", () => {
		const input = "owner/repo#42";
		const result = linkifyPRRefs(input, "github.corp.com");
		expect(result).toBe(
			`${linkify("https://github.corp.com/owner/repo/pull/42", "owner/repo#42")}`,
		);
	});

	it("uses defaultHost for both URLs and refs", () => {
		// Full URLs already contain the host, so defaultHost only affects shorthand refs.
		// But both should produce links to the correct host.
		const input = "Check owner/repo#42 and https://github.corp.com/other/repo/pull/99";
		const result = linkifyPRRefs(input, "github.corp.com");
		expect(result).toBe(
			`Check ${linkify("https://github.corp.com/owner/repo/pull/42", "owner/repo#42")} and ${linkify("https://github.corp.com/other/repo/pull/99", "other/repo#99")}`,
		);
	});

	// -------------------------------------------------------------------
	// Commit URL linkification
	// -------------------------------------------------------------------

	it("linkifies commit URLs with the short 7-char SHA as display text", () => {
		const sha = "abc1234567890def1234567890abcdef12345678";
		const input = `\u{1F4DD} New commit https://github.com/v2nic/pi-ghpr-monitor/commit/${sha} pushed to v2nic/pi-ghpr-monitor#42`;
		const result = linkifyPRRefs(input);
		expect(result).toBe(
			`\u{1F4DD} New commit ${linkify(`https://github.com/v2nic/pi-ghpr-monitor/commit/${sha}`, "abc1234")} pushed to ${linkify("https://github.com/v2nic/pi-ghpr-monitor/pull/42", "v2nic/pi-ghpr-monitor#42")}`,
		);
	});

	it("linkifies commit URLs with already-short 7-char SHA", () => {
		const input = "see https://github.com/owner/repo/commit/abc1234";
		const result = linkifyPRRefs(input);
		expect(result).toBe(
			`see ${linkify("https://github.com/owner/repo/commit/abc1234", "abc1234")}`,
		);
	});

	it("linkifies commit URLs on GitHub Enterprise hosts", () => {
		const sha = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
		const input = `Pushed https://github.corp.com/owner/repo/commit/${sha}`;
		const result = linkifyPRRefs(input);
		expect(result).toBe(
			`Pushed ${linkify(`https://github.corp.com/owner/repo/commit/${sha}`, "deadbee")}`,
		);
	});

	it("does not capture trailing punctuation in commit URLs", () => {
		const sha = "abc1234567890";
		const input = `Pushed https://github.com/owner/repo/commit/${sha}.`;
		const result = linkifyPRRefs(input);
		expect(result).toBe(
			`Pushed ${linkify(`https://github.com/owner/repo/commit/${sha}`, "abc1234")}.`,
		);
	});

	it("is idempotent for commit URLs", () => {
		const sha = "abc1234567890";
		const input = `Pushed https://github.com/owner/repo/commit/${sha}`;
		const first = linkifyPRRefs(input);
		const second = linkifyPRRefs(first);
		expect(second).toBe(first);
	});

	it("linkifies commit URL alongside PR refs in the same message", () => {
		const sha = "abc1234567890";
		const input = `\u{1F4DD} New commit https://github.com/v2nic/repo/commit/${sha} pushed to v2nic/repo#7. Review the PR description.`;
		const result = linkifyPRRefs(input);
		expect(result).toBe(
			`\u{1F4DD} New commit ${linkify(`https://github.com/v2nic/repo/commit/${sha}`, "abc1234")} pushed to ${linkify("https://github.com/v2nic/repo/pull/7", "v2nic/repo#7")}. Review the PR description.`,
		);
	});

	// -------------------------------------------------------------------
	// Markdown output format (for the UserMessage / pi-tui Markdown renderer)
	//
	// The pi-tui Markdown component re-linkifies URLs embedded in raw OSC 8
	// escapes, producing doubled/tripled output. The "markdown" format emits
	// `[display](url)` link syntax instead, which the Markdown component
	// renders into a single clean OSC 8 hyperlink.
	// -------------------------------------------------------------------

	it("emits markdown link syntax for full PR URLs", () => {
		const input = "📡 https://github.com/mobilityhouse/vgi-na-masscec/pull/366";
		const result = linkifyPRRefs(input, "github.com", "markdown");
		expect(result).toBe(
			"📡 [mobilityhouse/vgi-na-masscec#366](https://github.com/mobilityhouse/vgi-na-masscec/pull/366)",
		);
		// No raw OSC 8 escape sequences in markdown output
		expect(result).not.toContain("\x1b]8;;");
	});

	it("emits markdown link syntax for owner/repo#number refs", () => {
		const input = "⚠️  Merge conflicts detected on owner/repo#42";
		const result = linkifyPRRefs(input, "github.com", "markdown");
		expect(result).toBe(
			"⚠️  Merge conflicts detected on [owner/repo#42](https://github.com/owner/repo/pull/42)",
		);
		expect(result).not.toContain("\x1b]8;;");
	});

	it("emits markdown link syntax for commit URLs with short SHA display", () => {
		const sha = "abc1234567890def1234567890abcdef12345678";
		const input = `\u{1F4DD} New commit https://github.com/v2nic/pi-ghpr-monitor/commit/${sha} pushed to v2nic/pi-ghpr-monitor#42`;
		const result = linkifyPRRefs(input, "github.com", "markdown");
		expect(result).toBe(
			`\u{1F4DD} New commit [abc1234](https://github.com/v2nic/pi-ghpr-monitor/commit/${sha}) pushed to [v2nic/pi-ghpr-monitor#42](https://github.com/v2nic/pi-ghpr-monitor/pull/42)`,
		);
		expect(result).not.toContain("\x1b]8;;");
	});

	it("markdown format does not duplicate the URL (no triplication)", () => {
		const input = "🔀 PR https://github.com/v2nic/pi-ghpr-monitor/pull/59 was merged. Monitoring stopped.";
		const result = linkifyPRRefs(input, "github.com", "markdown");
		// The full URL must appear exactly once (as the markdown link target).
		const urlOccurrences = result.split("https://github.com/v2nic/pi-ghpr-monitor/pull/59").length - 1;
		expect(urlOccurrences).toBe(1);
		// The display label appears once.
		const labelOccurrences = result.split("v2nic/pi-ghpr-monitor#59").length - 1;
		expect(labelOccurrences).toBe(1);
	});
});

describe("snapshotPR extracts lastCommitOid", () => {
	it("extracts lastCommitOid from the first commit", () => {
		const pr = makeMockPR({
			commits: {
				nodes: [
					{
						commit: {
							oid: "abc123def456",
							checkSuites: { nodes: [] },
							status: null,
						},
					},
				],
			},
		});
		const status = snapshotPR(pr, []);
		expect(status.lastCommitOid).toBe("abc123def456");
	});

	it("returns empty string when no commits", () => {
		const pr = makeMockPR({ commits: { nodes: [] } });
		const status = snapshotPR(pr, []);
		expect(status.lastCommitOid).toBe("");
	});

	it("extracts lastCommitOid even with other commit data present", () => {
		const pr = makeMockPR({
			commits: {
				nodes: [
					{
						commit: {
							oid: "sha-98765",
							checkSuites: {
								nodes: [
									{
										id: "1",
										conclusion: "FAILURE",
										status: "COMPLETED",
										app: { name: "ci/test", slug: "ci-test" },
										checkRuns: { nodes: [{ name: "ci/test", conclusion: "FAILURE", status: "COMPLETED" }] },
									},
								],
							},
							status: {
								state: "FAILURE",
								contexts: [
									{ state: "FAILURE", context: "ci/circleci", description: "Failed", targetUrl: null },
								],
							},
						},
					},
				],
			},
		});
		const status = snapshotPR(pr, []);
		expect(status.lastCommitOid).toBe("sha-98765");
		expect(status.failingChecks).toContain("ci/test");
	});
});

describe("snapshotPR extracts lastCommitAuthor", () => {
	function prWithAuthor(author: CommitNode["commit"]["author"]): PullRequestData {
		return makeMockPR({
			commits: {
				nodes: [
					{ commit: { oid: "abc123", author, checkSuites: { nodes: [] }, status: null } },
				],
			},
		});
	}

	it("prefers the GitHub login", () => {
		const status = snapshotPR(prWithAuthor({ name: "Ada Lovelace", user: { login: "ada" } }), []);
		expect(status.lastCommitAuthor).toBe("ada");
	});

	it("falls back to the git author name when no linked user", () => {
		const status = snapshotPR(prWithAuthor({ name: "Ada Lovelace", user: null }), []);
		expect(status.lastCommitAuthor).toBe("Ada Lovelace");
	});

	it("returns empty string when author has neither login nor name", () => {
		const status = snapshotPR(prWithAuthor({ name: null, user: null }), []);
		expect(status.lastCommitAuthor).toBe("");
	});

	it("returns empty string when author is absent", () => {
		const status = snapshotPR(prWithAuthor(null), []);
		expect(status.lastCommitAuthor).toBe("");
	});

	it("returns empty string when there are no commits", () => {
		const status = snapshotPR(makeMockPR({ commits: { nodes: [] } }), []);
		expect(status.lastCommitAuthor).toBe("");
	});
});

describe("parseCoauthors", () => {
	it("extracts a single co-author name, stripping the email", () => {
		expect(parseCoauthors("Title\n\nCo-authored-by: Alice Smith <alice@example.com>")).toEqual([
			"Alice Smith",
		]);
	});

	it("extracts multiple co-authors in order", () => {
		const msg = "Title\n\nbody\n\nCo-authored-by: Alice <a@x.com>\nCo-authored-by: Bob <b@x.com>";
		expect(parseCoauthors(msg)).toEqual(["Alice", "Bob"]);
	});

	it("is case-insensitive on the trailer key", () => {
		expect(parseCoauthors("co-authored-by: Alice <a@x.com>")).toEqual(["Alice"]);
		expect(parseCoauthors("CO-AUTHORED-BY: Bob <b@x.com>")).toEqual(["Bob"]);
	});

	it("de-duplicates repeated co-authors", () => {
		const msg = "Co-authored-by: Alice <a@x.com>\nCo-authored-by: Alice <a@x.com>";
		expect(parseCoauthors(msg)).toEqual(["Alice"]);
	});

	it("keeps the name when there is no email", () => {
		expect(parseCoauthors("Co-authored-by: Alice")).toEqual(["Alice"]);
	});

	it("returns [] when there are no co-author trailers", () => {
		expect(parseCoauthors("feat: a change\n\njust a body")).toEqual([]);
	});

	it("returns [] for empty, null, or undefined messages", () => {
		expect(parseCoauthors("")).toEqual([]);
		expect(parseCoauthors(null)).toEqual([]);
		expect(parseCoauthors(undefined)).toEqual([]);
	});
});

describe("snapshotPR extracts lastCommitCoauthors", () => {
	function prWithMessage(messageBody: string | null | undefined): PullRequestData {
		return makeMockPR({
			commits: {
				nodes: [
					{ commit: { oid: "abc123", messageBody, checkSuites: { nodes: [] }, status: null } },
				],
			},
		});
	}

	it("joins co-authors with ', '", () => {
		const status = snapshotPR(
			prWithMessage("Title\n\nCo-authored-by: Alice <a@x.com>\nCo-authored-by: Bob <b@x.com>"),
			[],
		);
		expect(status.lastCommitCoauthors).toBe("Alice, Bob");
	});

	it("is empty when the commit has no co-authors", () => {
		const status = snapshotPR(prWithMessage("Title\n\njust a body"), []);
		expect(status.lastCommitCoauthors).toBe("");
	});

	it("is empty when the commit has no message body", () => {
		expect(snapshotPR(prWithMessage(null), []).lastCommitCoauthors).toBe("");
		expect(snapshotPR(prWithMessage(undefined), []).lastCommitCoauthors).toBe("");
	});

	it("is empty when there are no commits", () => {
		const status = snapshotPR(makeMockPR({ commits: { nodes: [] } }), []);
		expect(status.lastCommitCoauthors).toBe("");
	});
});

describe("snapshotPR maps databaseId/fullDatabaseId from GraphQL", () => {
	it("maps review comment fullDatabaseId to CommentSummary.restApiId", () => {
		const pr = makeMockPR({
			reviewThreads: {
				nodes: [
					{
						id: "PRRT_abc",
						isResolved: false,
						comments: {
							nodes: [
								{
									id: "RC_xyz",
									fullDatabaseId: "12345",
									body: "A review comment",
									author: { login: "reviewer" },
									createdAt: "2024-01-01T00:00:00Z",
									reactions: { nodes: [] },
									path: "src/main.ts",
									line: 42,
								},
							],
						},
					},
				],
			},
		});
		const status = snapshotPR(pr, []);
		expect(status.threadDetails![0].allComments![0].restApiId).toBe("12345");
	});

	it("maps general comment databaseId to CommentSummary.restApiId", () => {
		const pr = makeMockPR({
			comments: {
				nodes: [
					{
						id: "IC_general",
						databaseId: 54321,
						body: "A general comment",
						author: { login: "commenter" },
						createdAt: "2024-01-01T00:00:00Z",
						reactions: { nodes: [] },
					},
				],
			},
		});
		const status = snapshotPR(pr, []);
		expect(status.commentDetails![0].restApiId).toBe("54321");
	});

	it("prefers fullDatabaseId over databaseId for review thread comment restApiId", () => {
		const pr = makeMockPR({
			reviewThreads: {
				nodes: [
					{
						id: "PRRT_mixed",
						isResolved: false,
						comments: {
							nodes: [
								{
									id: "RC_mixed",
									fullDatabaseId: "99999",
									databaseId: 11111,
									body: "A review comment",
									author: { login: "reviewer" },
									createdAt: "2024-01-01T00:00:00Z",
									reactions: { nodes: [] },
									path: "src/main.ts",
									line: 42,
								},
							],
						},
					},
				],
			},
		});
		const status = snapshotPR(pr, []);
		expect(status.threadDetails![0].allComments![0].restApiId).toBe("99999");
	});
});

describe("formatThreadDetailBlock", () => {
	it("includes thread id and comment restApiId in detail block", () => {
		const thread: ThreadSummary = {
			id: "PRRT_abc",
			isResolved: false,
			lastCommentAuthor: "reviewer",
			lastCommentBody: "Fix this",
			fullBody: "Fix this bug",
			path: "src/main.ts",
			line: 42,
			allComments: [
				{ id: "RC_1", restApiId: "11111", author: "reviewer", body: "Fix this", fullBody: "Fix this bug", path: "src/main.ts", line: 42 },
			],
		};
		const result = formatAgentNotification({
			unresolvedThreads: 1,
			generalComments: 0,
			hasConflicts: false,
			failingChecks: [],
			pendingChecks: [],
			lastCommentTimestamp: "",
			lastCommentBySelf: false,
			lastCommitOid: "", lastCommitAuthor: "", lastCommitCoauthors: "",
		lastCommitMessageHeadline: "",
			threadDetails: [thread],
			commentDetails: [],
			checkDetails: [],
		}, {
			owner: "owner",
			repo: "repo",
			number: 42,
			host: "github.com",
			mode: "all",
			intervalSec: 60,
			debounceSec: 30,
		});
		expect(result).not.toBeNull();
		expect(result!.detailed).toContain("Thread PRRT_abc (src/main.ts:42)");
		expect(result!.detailed).toContain("(id: RC_1, restApiId: 11111)");
	});
});

describe("formatCommentDetailBlock includes restApiId", () => {
	it("includes restApiId for general comments", () => {
		const result = formatAgentNotification({
			unresolvedThreads: 0,
			generalComments: 1,
			hasConflicts: false,
			failingChecks: [],
			pendingChecks: [],
			lastCommentTimestamp: "",
			lastCommentBySelf: false,
			lastCommitOid: "", lastCommitAuthor: "", lastCommitCoauthors: "",
		lastCommitMessageHeadline: "",
			threadDetails: [],
			commentDetails: [
				{ id: "IC_1", restApiId: "54321", author: "bot", body: "Deploy done", fullBody: "Deploy notification" },
			],
			checkDetails: [],
		}, {
			owner: "owner",
			repo: "repo",
			number: 42,
			host: "github.com",
			mode: "all",
			intervalSec: 60,
			debounceSec: 30,
		});
		expect(result).not.toBeNull();
		expect(result!.detailed).toContain("Comment IC_1 by bot (restApiId: 54321)");
	});
});

describe("formatThreadDetails concise", () => {
	const config: MonitorConfig = {
		owner: "owner",
		repo: "repo",
		number: 42,
		host: "github.com",
		mode: "all",
		intervalSec: 60,
		debounceSec: 30,
	};

	it("includes thread id in concise one-liner", () => {
		const status: PRStatus = {
			unresolvedThreads: 1,
			generalComments: 0,
			hasConflicts: false,
			failingChecks: [],
			pendingChecks: [],
			lastCommentTimestamp: "",
			lastCommentBySelf: false,
			lastCommitOid: "", lastCommitAuthor: "", lastCommitCoauthors: "",
		lastCommitMessageHeadline: "",
			threadDetails: [
				{ id: "PRRT_abc", isResolved: false, lastCommentAuthor: "reviewer", lastCommentBody: "Fix this" },
			],
			commentDetails: [],
			checkDetails: [],
		};
		const result = formatStatusUpdate(null, status, config);
		expect(result).toContain("PRRT_abc");
	});

	it("includes comment id and restApiId in concise one-liner", () => {
		const status: PRStatus = {
			unresolvedThreads: 0,
			generalComments: 1,
			hasConflicts: false,
			failingChecks: [],
			pendingChecks: [],
			lastCommentTimestamp: "",
			lastCommentBySelf: false,
			lastCommitOid: "", lastCommitAuthor: "", lastCommitCoauthors: "",
		lastCommitMessageHeadline: "",
			threadDetails: [],
			commentDetails: [
				{ id: "IC_1", restApiId: "54321", author: "bot", body: "Deploy done" },
			],
			checkDetails: [],
		};
		const result = formatStatusUpdate(null, status, config);
		expect(result).toContain("restApiId: 54321");
		expect(result).toContain("IC_1");
	});
});

describe("snapshotPR ignoredBots filtering (general comments only)", () => {
	it("filters general comments from ignored bot users", () => {
		const pr = makeMockPR({
			comments: {
				nodes: [
					{ id: "IC_1", databaseId: 100, body: "Hello from bot", author: { login: "linear" }, createdAt: "2024-01-01T00:00:00Z" },
					{ id: "IC_2", databaseId: 101, body: "Hello from human", author: { login: "alice" }, createdAt: "2024-01-01T00:01:00Z" },
				],
			},
		});
		const status = snapshotPR(pr, ["linear", "sonarqubecloud"]);
		expect(status.generalComments).toBe(1);
		expect(status.commentDetails).toHaveLength(1);
		expect(status.commentDetails![0].author).toBe("alice");
	});

	it("does not filter general comments from non-ignored users", () => {
		const pr = makeMockPR({
			comments: {
				nodes: [
					{ id: "IC_1", databaseId: 100, body: "Hello", author: { login: "alice" }, createdAt: "2024-01-01T00:00:00Z" },
					{ id: "IC_2", databaseId: 101, body: "Hi", author: { login: "bob" }, createdAt: "2024-01-01T00:01:00Z" },
				],
			},
		});
		const status = snapshotPR(pr, ["linear"]);
		expect(status.generalComments).toBe(2);
		expect(status.commentDetails).toHaveLength(2);
	});

	it("does not filter review thread comments from ignored users", () => {
		const pr = makeMockPR({
			reviewThreads: {
				nodes: [
					{
						id: "PRRT_1",
						isResolved: false,
						comments: {
							nodes: [
								{ id: "RC_1", fullDatabaseId: "200", body: "Please fix", author: { login: "linear" }, createdAt: "2024-01-01T00:00:00Z" },
							],
						},
					},
				],
			},
		});
		const status = snapshotPR(pr, ["linear"]);
		expect(status.unresolvedThreads).toBe(1);
		expect(status.threadDetails).toHaveLength(1);
		expect(status.threadDetails![0].lastCommentAuthor).toBe("linear");
	});

	it("filters all comments when all authors are ignored", () => {
		const pr = makeMockPR({
			comments: {
				nodes: [
					{ id: "IC_1", databaseId: 100, body: "Bot msg 1", author: { login: "linear" }, createdAt: "2024-01-01T00:00:00Z" },
					{ id: "IC_2", databaseId: 101, body: "Bot msg 2", author: { login: "sonarqubecloud" }, createdAt: "2024-01-01T00:01:00Z" },
				],
			},
		});
		const status = snapshotPR(pr, ["linear", "sonarqubecloud"]);
		expect(status.generalComments).toBe(0);
		expect(status.commentDetails).toHaveLength(0);
	});

	it("handles empty ignoredBots array gracefully", () => {
		const pr = makeMockPR({
			comments: {
				nodes: [
					{ id: "IC_1", databaseId: 100, body: "Hello", author: { login: "alice" }, createdAt: "2024-01-01T00:00:00Z" },
				],
			},
		});
		const status = snapshotPR(pr, []);
		expect(status.generalComments).toBe(1);
		expect(status.commentDetails).toHaveLength(1);
	});

});

// ---------------------------------------------------------------------------
// Issue monitoring tests
// ---------------------------------------------------------------------------

function makeMockIssue(overrides: Partial<IssueData> = {}): IssueData {
	const defaults: IssueData = {
		title: "Test issue",
		state: "OPEN",
		comments: { nodes: [] },
	};
	return { ...defaults, ...overrides };
}

function makeIssueConfig(overrides: Partial<MonitorConfig> = {}): MonitorConfig {
	const defaults: MonitorConfig = {
		owner: "testowner",
		repo: "testrepo",
		number: 42,
		host: "github.com",
		resourceType: "issue",
		mode: "all",
		intervalSec: 60,
		debounceSec: 30,
	};
	return { ...defaults, ...overrides };
}

describe("snapshotIssue", () => {
	it("returns empty status for issue with no comments", () => {
		const issue = makeMockIssue();
		const status = snapshotIssue(issue, []);
		expect(status.generalComments).toBe(0);
		expect(status.commentDetails).toHaveLength(0);
		expect(status.state).toBe("OPEN");
		expect(status.title).toBe("Test issue");
	});

	it("captures general comments on an issue", () => {
		const issue = makeMockIssue({
			comments: {
				nodes: [
					{ id: "IC_1", databaseId: 100, body: "Looks good", author: { login: "alice" }, createdAt: "2024-01-01T00:00:00Z" },
					{ id: "IC_2", databaseId: 101, body: "Second", author: { login: "bob" }, createdAt: "2024-01-01T00:01:00Z" },
				],
			},
		});
		const status = snapshotIssue(issue, []);
		expect(status.generalComments).toBe(2);
		expect(status.commentDetails).toHaveLength(2);
		expect(status.commentDetails[0].author).toBe("alice");
		expect(status.commentDetails[1].author).toBe("bob");
	});

	it("filters acknowledged comments (thumbs up)", () => {
		const issue = makeMockIssue({
			comments: {
				nodes: [
					{
						id: "IC_1", databaseId: 100, body: "Unacknowledged", author: { login: "alice" },
						createdAt: "2024-01-01T00:00:00Z", reactions: { nodes: [] },
					},
					{
						id: "IC_2", databaseId: 101, body: "Acknowledged", author: { login: "bob" },
						createdAt: "2024-01-01T00:01:00Z",
						reactions: { nodes: [{ content: "THUMBS_UP" }] },
					},
				],
			},
		});
		const status = snapshotIssue(issue, []);
		expect(status.generalComments).toBe(1);
		expect(status.commentDetails).toHaveLength(1);
		expect(status.commentDetails[0].author).toBe("alice");
	});

	it("filters comments from ignored bots", () => {
		const issue = makeMockIssue({
			comments: {
				nodes: [
					{ id: "IC_1", databaseId: 100, body: "Hello", author: { login: "alice" }, createdAt: "2024-01-01T00:00:00Z" },
					{ id: "IC_2", databaseId: 101, body: "CI report", author: { login: "linear" }, createdAt: "2024-01-01T00:01:00Z" },
				],
			},
		});
		const status = snapshotIssue(issue, ["linear"]);
		expect(status.generalComments).toBe(1);
		expect(status.commentDetails).toHaveLength(1);
		expect(status.commentDetails[0].author).toBe("alice");
	});

	it("captures state of the issue", () => {
		const issue = makeMockIssue({ state: "CLOSED" });
		const status = snapshotIssue(issue, []);
		expect(status.state).toBe("CLOSED");
	});
});

describe("formatFooterStatus for issues", () => {
	it("shows issue label with comment indicator", () => {
		const config = makeIssueConfig();
		const status: IssueStatus = {
			title: "Test",
			state: "OPEN",
			generalComments: 2,
			lastCommentTimestamp: "2024-01-01T00:00:00Z",
			commentDetails: [],
		};
		const footer = formatFooterStatus(config, status);
		expect(footer).toContain("testowner/testrepo/issues/42");
		expect(footer).toContain("(issue)");
		expect(footer).toContain("💭");
	});

	it("shows no emoji when no actionable items", () => {
		const config = makeIssueConfig();
		const status: IssueStatus = {
			title: "Test",
			state: "OPEN",
			generalComments: 0,
			lastCommentTimestamp: "2024-01-01T00:00:00Z",
			commentDetails: [],
		};
		const footer = formatFooterStatus(config, status);
		expect(footer).toContain("(issue)");
		expect(footer).not.toContain("💭");
	});

	it("does not show (issue) label for PR config", () => {
		const config: MonitorConfig = {
			owner: "testowner",
			repo: "testrepo",
			number: 42,
			host: "github.com",
			resourceType: "pr",
			mode: "all",
			intervalSec: 60,
			debounceSec: 30,
		};
		const status: IssueStatus = {
			title: "Test",
			state: "OPEN",
			generalComments: 0,
			lastCommentTimestamp: "2024-01-01T00:00:00Z",
			commentDetails: [],
		};
		const footer = formatFooterStatus(config, status);
		expect(footer).not.toContain("(issue)");
	});
});

describe("linkifyPRRefs with issue URLs", () => {
	it("linkifies GitHub issue URLs", () => {
		const input = "See https://github.com/owner/repo/issues/42 for details";
		const result = linkifyPRRefs(input, "github.com", "osc8");
		// The issue URL should be converted to a clickable link with display text "owner/repo#42"
		const esc = "\x1b";
		expect(result).toContain(`${esc}]8;;https://github.com/owner/repo/issues/42${esc}\\`);
		expect(result).toContain("owner/repo#42");
	});

	it("linkifies issue URLs in markdown format", () => {
		const input = "See https://github.com/owner/repo/issues/42 for details";
		const result = linkifyPRRefs(input, "github.com", "markdown");
		expect(result).toContain("[owner/repo#42](https://github.com/owner/repo/issues/42)");
	});

	it("does not double-linkify already linkified issue references", () => {
		const input = linkifyPRRefs("See https://github.com/owner/repo/issues/42", "github.com", "osc8");
		const result = linkifyPRRefs(input, "github.com", "osc8");
		// Should be idempotent: no duplicate link
		const esc = "\x1b";
		const linkMatches = (result.match(new RegExp(`${esc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}]8;;https://github\\.com/owner/repo/issues/42${esc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\\\`, 'g')) || []).length;
		expect(linkMatches).toBe(1);
	});

	it("linkifies GitHub Enterprise issue URLs", () => {
		const input = "Tracked at https://github.corp.com/team/project/issues/7";
		const result = linkifyPRRefs(input, "github.corp.com", "osc8");
		const esc = "\x1b";
		expect(result).toContain(`${esc}]8;;https://github.corp.com/team/project/issues/7${esc}\\`);
		expect(result).toContain("team/project#7");
	});
});

// ---------------------------------------------------------------------------
// Approval detection tests
// ---------------------------------------------------------------------------

describe("getReviewDecision", () => {
	it("returns empty string when no reviews", () => {
		const pr = makeMockPR({ reviews: { nodes: [] } });
		expect(getReviewDecision(pr)).toBe("");
	});

	it("returns latest review decision", () => {
		const pr = makeMockPR({
			reviews: {
				nodes: [
					{ id: "r-1", state: "APPROVED", author: { login: "reviewer1" }, submittedAt: "2024-01-01T00:00:00Z" },
				],
			},
		});
		expect(getReviewDecision(pr)).toBe("APPROVED");
	});

	it("returns CHANGES_REQUESTED decision", () => {
		const pr = makeMockPR({
			reviews: {
				nodes: [
					{ id: "r-1", state: "CHANGES_REQUESTED", author: { login: "reviewer1" }, submittedAt: "2024-01-01T00:00:00Z" },
				],
			},
		});
		expect(getReviewDecision(pr)).toBe("CHANGES_REQUESTED");
	});

	it("returns COMMENTED decision", () => {
		const pr = makeMockPR({
			reviews: {
				nodes: [
					{ id: "r-1", state: "COMMENTED", author: { login: "reviewer1" }, submittedAt: "2024-01-01T00:00:00Z" },
				],
			},
		});
		expect(getReviewDecision(pr)).toBe("COMMENTED");
	});

	it("returns DISMISSED decision", () => {
		const pr = makeMockPR({
			reviews: {
				nodes: [
					{ id: "r-1", state: "DISMISSED", author: { login: "reviewer1" }, submittedAt: "2024-01-01T00:00:00Z" },
				],
			},
		});
		expect(getReviewDecision(pr)).toBe("DISMISSED");
	});

	it("ignores PENDING reviews", () => {
		const pr = makeMockPR({
			reviews: {
				nodes: [
					{ id: "r-1", state: "PENDING", author: { login: "reviewer1" }, submittedAt: "2024-01-01T00:00:00Z" },
				],
			},
		});
		expect(getReviewDecision(pr)).toBe("");
	});

	it("returns empty string when all reviews are PENDING", () => {
		const pr = makeMockPR({
			reviews: {
				nodes: [
					{ id: "r-1", state: "PENDING", author: { login: "r1" }, submittedAt: "2024-01-01T00:00:00Z" },
					{ id: "r-2", state: "PENDING", author: { login: "r2" }, submittedAt: "2024-01-01T00:01:00Z" },
				],
			},
		});
		expect(getReviewDecision(pr)).toBe("");
	});

	it("skips PENDING and returns the latest submitted review", () => {
		const pr = makeMockPR({
			reviews: {
				nodes: [
					{ id: "r-1", state: "APPROVED", author: { login: "r1" }, submittedAt: "2024-01-01T00:00:00Z" },
					{ id: "r-2", state: "PENDING", author: { login: "r2" }, submittedAt: "2024-01-01T00:02:00Z" },
				],
			},
		});
		// PENDING has later timestamp but is skipped; APPROVED is the latest real decision
		expect(getReviewDecision(pr)).toBe("APPROVED");
	});
});

describe("snapshotPR extracts review decision", () => {
	it("extracts reviewDecision and reviewAuthor from latest review", () => {
		const pr = makeMockPR({
			reviews: {
				nodes: [
					{ id: "r-1", state: "APPROVED", author: { login: "approver" }, submittedAt: "2024-01-01T00:00:00Z" },
				],
			},
		});
		const status = snapshotPR(pr, []);
		expect(status.reviewDecision).toBe("APPROVED");
		expect(status.reviewAuthor).toBe("approver");
	});

	it("returns empty strings when no reviews", () => {
		const pr = makeMockPR({ reviews: { nodes: [] } });
		const status = snapshotPR(pr, []);
		expect(status.reviewDecision).toBe("");
		expect(status.reviewAuthor).toBe("");
	});

	it("returns empty strings when only PENDING reviews", () => {
		const pr = makeMockPR({
			reviews: {
				nodes: [
					{ id: "r-1", state: "PENDING", author: { login: "r1" }, submittedAt: "2024-01-01T00:00:00Z" },
				],
			},
		});
		const status = snapshotPR(pr, []);
		expect(status.reviewDecision).toBe("");
		expect(status.reviewAuthor).toBe("");
	});

	it("extracts CHANGES_REQUESTED decision", () => {
		const pr = makeMockPR({
			reviews: {
				nodes: [
					{ id: "r-1", state: "CHANGES_REQUESTED", author: { login: "blocker" }, submittedAt: "2024-01-01T00:00:00Z" },
				],
			},
		});
		const status = snapshotPR(pr, []);
		expect(status.reviewDecision).toBe("CHANGES_REQUESTED");
		expect(status.reviewAuthor).toBe("blocker");
	});
});

describe("formatStatusUpdate — approval detection", () => {
	const config: MonitorConfig = {
		owner: "owner",
		repo: "repo",
		number: 42,
		host: "github.com",
		mode: "all",
		intervalSec: 60,
		debounceSec: 30,
	};

	const baseStatus = (): PRStatus => ({
		unresolvedThreads: 0,
		generalComments: 0,
		hasConflicts: false,
		failingChecks: [],
		pendingChecks: [],
		lastCommentTimestamp: "",
		lastCommentBySelf: false,
		lastCommitOid: "", lastCommitAuthor: "", lastCommitCoauthors: "",
		lastCommitMessageHeadline: "",
		reviewDecision: "",
		reviewAuthor: "",
	});

	it("detects first approval (prev unapproved → approved)", () => {
		const prev = baseStatus();
		const curr = { ...baseStatus(), reviewDecision: "APPROVED", reviewAuthor: "alice" };
		const update = formatStatusUpdate(prev, curr, config);
		expect(update).toContain("approved");
		expect(update).toContain("alice");
	});

	it("does NOT notify when reviewed status stays approved", () => {
		const prev = { ...baseStatus(), reviewDecision: "APPROVED", reviewAuthor: "alice" };
		const curr = { ...baseStatus(), reviewDecision: "APPROVED", reviewAuthor: "alice" };
		const update = formatStatusUpdate(prev, curr, config);
		expect(update).not.toContain("approved");
	});

	it("notifies on changes-requested after approval", () => {
		const prev = { ...baseStatus(), reviewDecision: "APPROVED", reviewAuthor: "alice" };
		const curr = { ...baseStatus(), reviewDecision: "CHANGES_REQUESTED", reviewAuthor: "bob" };
		const update = formatStatusUpdate(prev, curr, config);
		expect(update).toContain("requested changes");
		expect(update).toContain("bob");
	});

	it("detects approval after changes-requested", () => {
		const prev = { ...baseStatus(), reviewDecision: "CHANGES_REQUESTED", reviewAuthor: "bob" };
		const curr = { ...baseStatus(), reviewDecision: "APPROVED", reviewAuthor: "alice" };
		const update = formatStatusUpdate(prev, curr, config);
		expect(update).toContain("approved");
		expect(update).toContain("alice");
	});

	it("notifies on review dismissed", () => {
		const prev = { ...baseStatus(), reviewDecision: "APPROVED", reviewAuthor: "alice" };
		const curr = { ...baseStatus(), reviewDecision: "DISMISSED", reviewAuthor: "" };
		const update = formatStatusUpdate(prev, curr, config);
		expect(update).toContain("dismissed");
	});

	it("uses custom approved preference template", () => {
		const prev = baseStatus();
		const curr = { ...baseStatus(), reviewDecision: "APPROVED", reviewAuthor: "alice" };
		const update = formatStatusUpdate(prev, curr, config, { approved: "🎉 {prLabel} got approved by {reviewAuthor}!" });
		expect(update).toContain("🎉");
		expect(update).toContain("alice");
		expect(update).toContain("owner/repo#42");
	});

	it("uses custom changesRequested preference template", () => {
		const prev = { ...baseStatus(), reviewDecision: "APPROVED", reviewAuthor: "alice" };
		const curr = { ...baseStatus(), reviewDecision: "CHANGES_REQUESTED", reviewAuthor: "bob" };
		const update = formatStatusUpdate(prev, curr, config, { changesRequested: "⛔ {reviewAuthor} requested changes on {prLabel}" });
		expect(update).toContain("⛔");
		expect(update).toContain("bob");
	});

	it("does not emit approval notification on first poll (prev=null)", () => {
		const curr = { ...baseStatus(), reviewDecision: "APPROVED", reviewAuthor: "alice" };
		const update = formatStatusUpdate(null, curr, config);
		expect(update).not.toContain("approved");
	});

	it("does not emit changes-requested on first poll (prev=null)", () => {
		const curr = { ...baseStatus(), reviewDecision: "CHANGES_REQUESTED", reviewAuthor: "bob" };
		const update = formatStatusUpdate(null, curr, config);
		expect(update).not.toContain("requested changes");
	});

	it("only COMMENTED reviews do not trigger notification", () => {
		const prev = { ...baseStatus(), reviewDecision: "CHANGES_REQUESTED", reviewAuthor: "bob" };
		const curr = { ...baseStatus(), reviewDecision: "COMMENTED", reviewAuthor: "bob" };
		const update = formatStatusUpdate(prev, curr, config);
		// COMMENTED is not an approval or blocking change; no special notification
		expect(update).not.toContain("approved");
		expect(update).not.toContain("requested changes");
	});
});

describe("formatActionableItems — review state", () => {
	const config: MonitorConfig = {
		owner: "owner",
		repo: "repo",
		number: 42,
		host: "github.com",
		mode: "all",
		intervalSec: 60,
		debounceSec: 30,
	};

	const baseStatus = (): PRStatus => ({
		unresolvedThreads: 0,
		generalComments: 0,
		hasConflicts: false,
		failingChecks: [],
		pendingChecks: [],
		lastCommentTimestamp: "",
		lastCommentBySelf: false,
		lastCommitOid: "", lastCommitAuthor: "", lastCommitCoauthors: "",
		lastCommitMessageHeadline: "",
		reviewDecision: "",
		reviewAuthor: "",
	});

	it("reports approval when present alongside other items", () => {
		const status = { ...baseStatus(), reviewDecision: "APPROVED", reviewAuthor: "alice", unresolvedThreads: 2 };
		const result = formatActionableItems(status, config);
		expect(result).toContain("Approved by alice");
	});

	it("reports changes-requested as actionable", () => {
		const status = { ...baseStatus(), reviewDecision: "CHANGES_REQUESTED", reviewAuthor: "bob" };
		const result = formatActionableItems(status, config);
		expect(result).toContain("requested changes");
	});

	it("does NOT report review state when nothing is approved or blocking", () => {
		const status = { ...baseStatus(), reviewDecision: "COMMENTED", reviewAuthor: "bob" };
		const result = formatActionableItems(status, config);
		expect(result).toBeNull();
	});

	it("reports approved and unresolved threads together", () => {
		const status = { ...baseStatus(), reviewDecision: "APPROVED", reviewAuthor: "alice", unresolvedThreads: 3, failingChecks: ["ci/test"] };
		const result = formatActionableItems(status, config);
		expect(result).toContain("Approved by alice");
		expect(result).toContain("unresolved review thread");
		expect(result).toContain("Failing CI");
	});
});

describe("formatFooterStatus — review emojis", () => {
	const config: MonitorConfig = {
		owner: "owner", repo: "repo", number: 42,
		host: "github.com", mode: "all", intervalSec: 60, debounceSec: 30,
	};

	const clean: PRStatus = {
		unresolvedThreads: 0, generalComments: 0, hasConflicts: false,
		failingChecks: [], pendingChecks: [],
		lastCommentTimestamp: "", lastCommentBySelf: false,
		lastCommitOid: "", lastCommitAuthor: "", lastCommitCoauthors: "",
		lastCommitMessageHeadline: "",
		threadDetails: [], commentDetails: [], checkDetails: [],
		reviewDecision: "", reviewAuthor: "",
	};

	it("shows approved emoji when PR is approved", () => {
		const status = { ...clean, reviewDecision: "APPROVED" };
		const result = formatFooterStatus(config, status);
		expect(result).toContain("✅");
	});

	it("shows changes-requested emoji when changes are requested", () => {
		const status = { ...clean, reviewDecision: "CHANGES_REQUESTED" };
		const result = formatFooterStatus(config, status);
		expect(result).toContain("⛔");
	});

	it("shows no review emoji for COMMENTED reviews", () => {
		const status = { ...clean, reviewDecision: "COMMENTED" };
		const result = formatFooterStatus(config, status);
		expect(result).not.toContain("✅");
		expect(result).not.toContain("⛔");
	});

	it("shows no review emoji for DISMISSED reviews", () => {
		const status = { ...clean, reviewDecision: "DISMISSED" };
		const result = formatFooterStatus(config, status);
		expect(result).not.toContain("✅");
		expect(result).not.toContain("⛔");
	});

	it("shows both approval and thread emojis when both present", () => {
		const status = { ...clean, reviewDecision: "APPROVED", unresolvedThreads: 2 };
		const result = formatFooterStatus(config, status);
		expect(result).toContain("✅");
		expect(result).toContain("💬");
	});
});
