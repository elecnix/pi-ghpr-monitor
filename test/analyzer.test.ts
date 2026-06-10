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
	linkifyPRRefs,
} from "../src/analyzer";
import type { PullRequestData, PRStatus, MonitorConfig, CommitNode, ReactionNode } from "../src/analyzer";

function makeMockPR(overrides: Partial<PullRequestData> = {}): PullRequestData {
	const defaults: PullRequestData = {
		comments: { nodes: [] },
		reviewThreads: { nodes: [] },
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
			lastCommitOid: "",
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
			lastCommitOid: "",
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
			lastCommitOid: "",
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
			lastCommitOid: "",
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
			lastCommitOid: "",
		};
		const curr: PRStatus = {
			unresolvedThreads: 0,
			generalComments: 0,
			hasConflicts: false,
			failingChecks: [],
			pendingChecks: [],
			lastCommentTimestamp: "",
			lastCommentBySelf: false,
			lastCommitOid: "",
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
			lastCommitOid: "",
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
			lastCommitOid: "",
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
			lastCommitOid: "",
		};
		const update = formatStatusUpdate(null, curr, config);
		expect(update).not.toContain("pending");
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
			lastCommitOid: "",
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
			lastCommitOid: "",
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
			lastCommitOid: "",
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
			lastCommitOid: "",
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
			lastCommitOid: "",
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
			lastCommitOid: "",
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
			lastCommitOid: "",
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
			lastCommitOid: "",
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
			lastCommitOid: "",
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
			lastCommitOid: "",
			threadDetails: [],
			commentDetails: [
				{ id: "C_1", author: "teammate", body: "Can you add tests?" },
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
			lastCommitOid: "",
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
			lastCommitOid: "",
			threadDetails: [],
			commentDetails: [
				{ id: "C_1", author: "user", body: longBody },
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
			lastCommitOid: "",
			threadDetails: [],
			commentDetails: [
				{ id: "C_1", author: "v2nic", body: multilineBody },
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
					{ id: "c-1", body: "Please fix this", author: { login: "reviewer" }, createdAt: "2024-01-01T00:00:00Z", reactions: { nodes: [] } },
					{ id: "c-2", body: "Quality Gate Passed", author: { login: "sonarqubecloud" }, createdAt: "2024-01-01T00:01:00Z", reactions: { nodes: [{ content: "THUMBS_UP" }] } },
				],
			},
			reviewThreads: { nodes: [] },
			mergeable: "MERGEABLE",
			mergeStateStatus: "CLEAN",
			state: "OPEN",
			merged: false,
			commits: { nodes: [{ commit: { oid: "test-oid", checkSuites: { nodes: [] } } }] },
		};
		const status = snapshotPR(pr);
		// c-2 is acknowledged, so only c-1 counts
		expect(status.generalComments).toBe(1);
		expect(status.commentDetails).toHaveLength(1);
		expect(status.commentDetails[0].id).toBe("c-1");
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
								{ id: "tc-1", body: "Fix this", author: { login: "reviewer" }, createdAt: "2024-01-01T00:00:00Z", reactions: { nodes: [] } },
							],
						},
					},
					{
						id: "t-2",
						isResolved: false,
						comments: {
							nodes: [
								{ id: "tc-2", body: "Looks good now", author: { login: "dev" }, createdAt: "2024-01-01T00:01:00Z", reactions: { nodes: [{ content: "THUMBS_UP" }] } },
							],
						},
					},
				],
			},
			mergeable: "MERGEABLE",
			mergeStateStatus: "CLEAN",
			state: "OPEN",
			merged: false,
			commits: { nodes: [{ commit: { oid: "test-oid", checkSuites: { nodes: [] } } }] },
		};
		const status = snapshotPR(pr);
		// t-2 is filtered because its last comment has THUMBS_UP
		expect(status.unresolvedThreads).toBe(1);
		expect(status.threadDetails).toHaveLength(1);
		expect(status.threadDetails[0].id).toBe("t-1");
	});

	it("does not filter comments without reactions", () => {
		const pr: PullRequestData = {
			comments: {
				nodes: [
					{ id: "c-1", body: "Please fix", author: { login: "reviewer" }, createdAt: "2024-01-01T00:00:00Z", reactions: { nodes: [] } },
				],
			},
			reviewThreads: { nodes: [] },
			mergeable: "MERGEABLE",
			mergeStateStatus: "CLEAN",
			state: "OPEN",
			merged: false,
			commits: { nodes: [{ commit: { oid: "test-oid", checkSuites: { nodes: [] } } }] },
		};
		const status = snapshotPR(pr);
		expect(status.generalComments).toBe(1);
		expect(status.commentDetails[0].id).toBe("c-1");
	});

	it("filters comments with THUMBS_UP but not other reactions", () => {
		const pr: PullRequestData = {
			comments: {
				nodes: [
					{ id: "c-1", body: "Nice!", author: { login: "reviewer" }, createdAt: "2024-01-01T00:00:00Z", reactions: { nodes: [{ content: "HEART" }] } },
					{ id: "c-2", body: "Done", author: { login: "dev" }, createdAt: "2024-01-01T00:01:00Z", reactions: { nodes: [{ content: "THUMBS_UP" }] } },
				],
			},
			reviewThreads: { nodes: [] },
			mergeable: "MERGEABLE",
			mergeStateStatus: "CLEAN",
			state: "OPEN",
			merged: false,
			commits: { nodes: [{ commit: { oid: "test-oid", checkSuites: { nodes: [] } } }] },
		};
		const status = snapshotPR(pr);
		// c-1 has HEART (not THUMBS_UP), so it's kept
		// c-2 has THUMBS_UP, so it's filtered
		expect(status.generalComments).toBe(1);
		expect(status.commentDetails[0].id).toBe("c-1");
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
			lastCommitOid: "",
			threadDetails: [], commentDetails: [], checkDetails: [],
		};
		const result = formatStatusUpdate(null, clean, config);
		expect(result).toContain("no issues");
	});

	it("sends all-clear when transitioning from issues to clean", () => {
		const hadIssues: PRStatus = {
			unresolvedThreads: 1, generalComments: 0, hasConflicts: false,
			failingChecks: ["ci/test"], pendingChecks: [],
			lastCommentTimestamp: "", lastCommentBySelf: false,
			lastCommitOid: "",
			threadDetails: [], commentDetails: [],
			checkDetails: [{ name: "ci/test", conclusion: "FAILURE" }],
		};
		const clean: PRStatus = {
			unresolvedThreads: 0, generalComments: 0, hasConflicts: false,
			failingChecks: [], pendingChecks: [],
			lastCommentTimestamp: "", lastCommentBySelf: false,
			lastCommitOid: "",
			threadDetails: [], commentDetails: [], checkDetails: [],
		};
		const result = formatStatusUpdate(hadIssues, clean, config);
		expect(result).toContain("no issues");
	});

	it("does NOT send all-clear again when status is unchanged clean", () => {
		const clean: PRStatus = {
			unresolvedThreads: 0, generalComments: 0, hasConflicts: false,
			failingChecks: [], pendingChecks: [],
			lastCommentTimestamp: "", lastCommentBySelf: false,
			lastCommitOid: "",
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
			lastCommitOid: "",
			threadDetails: [], commentDetails: [], checkDetails: [],
		};
		const first = formatStatusUpdate(null, clean, config);
		expect(first).toContain("no issues");
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
			lastCommitOid: "",
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
});

describe("linkifyPRRefs", () => {
	const OSC_OPEN = "\u001b]8;;";
	const OSC_SEP = "\u001b\\";
	const OSC_CLOSE = "\u001b]8;;\u001b\\";

	function linkify(url: string, display: string): string {
		return `${OSC_OPEN}${url}${OSC_SEP}${display}${OSC_CLOSE}`;
	}

	it("linkifies owner/repo#number patterns", () => {
		const input = "✨ v2nic/gh-pr-review#42 — no issues, all clear";
		const result = linkifyPRRefs(input);
		expect(result).toBe(
			`✨ ${linkify("https://github.com/v2nic/gh-pr-review/pull/42", "v2nic/gh-pr-review#42")} — no issues, all clear`,
		);
	});

	it("linkifies multiple PR refs in one message", () => {
		const input = "✅ All CI checks passed on mobilityhouse/vgi-na-masscec#538 ✨ mobilityhouse/vgi-na-masscec#538 — no issues, all clear";
		const result = linkifyPRRefs(input);
		expect(result).toBe(
			`✅ All CI checks passed on ${linkify("https://github.com/mobilityhouse/vgi-na-masscec/pull/538", "mobilityhouse/vgi-na-masscec#538")} ✨ ${linkify("https://github.com/mobilityhouse/vgi-na-masscec/pull/538", "mobilityhouse/vgi-na-masscec#538")} — no issues, all clear`,
		);
	});

	it("linkifies full PR URLs", () => {
		const input = "📡 https://github.com/mobilityhouse/vgi-na-masscec/pull/366";
		const result = linkifyPRRefs(input);
		expect(result).toBe(
			`📡 ${linkify("https://github.com/mobilityhouse/vgi-na-masscec/pull/366", "https://github.com/mobilityhouse/vgi-na-masscec/pull/366")}`,
		);
	});

	it("linkifies PR URLs with non-github.com hosts", () => {
		const input = "📡 https://github.corp.com/owner/repo/pull/42";
		const result = linkifyPRRefs(input);
		expect(result).toBe(
			`📡 ${linkify("https://github.corp.com/owner/repo/pull/42", "https://github.corp.com/owner/repo/pull/42")}`,
		);
	});

	it("linkifies PR URLs before PR refs, avoiding double-linkification", () => {
		// If a message contains both a URL and a ref for the same PR,
		// the URL should be linkified first, and the remaining ref independently.
		const input = "Check https://github.com/v2nic/gh-pr-review/pull/42 and v2nic/gh-pr-review#42";
		const result = linkifyPRRefs(input);
		expect(result).toBe(
			`Check ${linkify("https://github.com/v2nic/gh-pr-review/pull/42", "https://github.com/v2nic/gh-pr-review/pull/42")} and ${linkify("https://github.com/v2nic/gh-pr-review/pull/42", "v2nic/gh-pr-review#42")}`,
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
		// Both the href and display text use https (normalized from http)
		expect(result).toBe(
			`📡 ${linkify("https://github.corp.com/owner/repo/pull/42", "https://github.corp.com/owner/repo/pull/42")}`,
		);
	});

	it("linkifies footer-style URL with emojis", () => {
		const input = "📡 https://github.com/mobilityhouse/vgi-na-masscec/pull/366 ⚠️💬❌";
		const result = linkifyPRRefs(input);
		expect(result).toBe(
			`📡 ${linkify("https://github.com/mobilityhouse/vgi-na-masscec/pull/366", "https://github.com/mobilityhouse/vgi-na-masscec/pull/366")} ⚠️💬❌`,
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
			`Check ${linkify("https://github.corp.com/owner/repo/pull/42", "owner/repo#42")} and ${linkify("https://github.corp.com/other/repo/pull/99", "https://github.corp.com/other/repo/pull/99")}`,
		);
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
		const status = snapshotPR(pr);
		expect(status.lastCommitOid).toBe("abc123def456");
	});

	it("returns empty string when no commits", () => {
		const pr = makeMockPR({ commits: { nodes: [] } });
		const status = snapshotPR(pr);
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
		const status = snapshotPR(pr);
		expect(status.lastCommitOid).toBe("sha-98765");
		expect(status.failingChecks).toContain("ci/test");
	});
});
