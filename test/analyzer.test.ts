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
	formatStatusUpdate,
	formatActionableItems,
	snapshotPR,
} from "../src/analyzer";
import type { PullRequestData, PRStatus, MonitorConfig, CommitNode, ReactionNode } from "../src/analyzer";

function makeMockPR(overrides: Partial<PullRequestData> = {}): PullRequestData {
	const defaults: PullRequestData = {
		comments: { nodes: [] },
		reviewThreads: { nodes: [] },
		mergeable: "MERGEABLE",
		mergeStateStatus: "CLEAN",
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
					{ id: "1", isResolved: false, isOutdated: false, comments: { nodes: [], pageInfo: { hasNextPage: false } } },
					{ id: "2", isResolved: true, isOutdated: false, comments: { nodes: [], pageInfo: { hasNextPage: false } } },
					{ id: "3", isResolved: false, isOutdated: false, comments: { nodes: [], pageInfo: { hasNextPage: false } } },
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
		};
		const curr: PRStatus = {
			unresolvedThreads: 0,
			generalComments: 0,
			hasConflicts: false,
			failingChecks: [],
			pendingChecks: [],
			lastCommentTimestamp: "",
			lastCommentBySelf: false,
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
		};
		const update = formatStatusUpdate(null, curr, config);
		// When prev is null, format uses "N new" format since prev count defaults to 0
		expect(update).toContain("new unresolved review thread");
	});

	it("reports pending checks on first status", () => {
		const curr: PRStatus = {
			unresolvedThreads: 0,
			generalComments: 0,
			hasConflicts: false,
			failingChecks: [],
			pendingChecks: ["ci/test", "ci/lint"],
			lastCommentTimestamp: "",
			lastCommentBySelf: false,
		};
		const update = formatStatusUpdate(null, curr, config);
		expect(update).toContain("pending");
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
			threadDetails: [
				{ id: "PRRT_1", isResolved: false, isOutdated: false, commentCount: 1, lastCommentAuthor: "reviewer", lastCommentBody: "Please fix this typo" },
				{ id: "PRRT_2", isResolved: false, isOutdated: false, commentCount: 1, lastCommentAuthor: "bot", lastCommentBody: "Build failed" },
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
			commits: { nodes: [{ commit: { checkSuites: { nodes: [] } } }] },
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
						isOutdated: false,
						comments: {
							nodes: [
								{ id: "tc-1", body: "Fix this", author: { login: "reviewer" }, createdAt: "2024-01-01T00:00:00Z", reactions: { nodes: [] } },
							],
							pageInfo: { hasNextPage: false },
						},
					},
					{
						id: "t-2",
						isResolved: false,
						isOutdated: false,
						comments: {
							nodes: [
								{ id: "tc-2", body: "Looks good now", author: { login: "dev" }, createdAt: "2024-01-01T00:01:00Z", reactions: { nodes: [{ content: "THUMBS_UP" }] } },
							],
							pageInfo: { hasNextPage: false },
						},
					},
				],
			},
			mergeable: "MERGEABLE",
			mergeStateStatus: "CLEAN",
			state: "OPEN",
			merged: false,
			commits: { nodes: [{ commit: { checkSuites: { nodes: [] } } }] },
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
			commits: { nodes: [{ commit: { checkSuites: { nodes: [] } } }] },
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
			commits: { nodes: [{ commit: { checkSuites: { nodes: [] } } }] },
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
			threadDetails: [], commentDetails: [],
			checkDetails: [{ name: "ci/test", conclusion: "FAILURE" }],
		};
		const clean: PRStatus = {
			unresolvedThreads: 0, generalComments: 0, hasConflicts: false,
			failingChecks: [], pendingChecks: [],
			lastCommentTimestamp: "", lastCommentBySelf: false,
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
			threadDetails: [], commentDetails: [], checkDetails: [],
		};
		const first = formatStatusUpdate(null, clean, config);
		expect(first).toContain("no issues");
		const second = formatStatusUpdate(clean, clean, config);
		expect(second).toBe("");
	});
});
