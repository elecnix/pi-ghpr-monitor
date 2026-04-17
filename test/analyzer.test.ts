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
} from "../src/analyzer";
import type { PullRequestData, PRStatus, MonitorConfig, CommitNode } from "../src/analyzer";

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
