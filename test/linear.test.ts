/**
 * Unit tests for the pure Linear monitoring module (src/linear.ts).
 *
 * Covers reference parsing, the documented API-key auth convention,
 * issue snapshotting, change detection, notification formatting, and the
 * GraphQL client (via an injected fetch implementation — no network).
 */

import { describe, it, expect } from "vitest";
import {
	LINEAR_GRAPHQL_ENDPOINT,
	LINEAR_API_KEY_ENV,
	parseLinearRef,
	getLinearApiKey,
	buildLinearHeaders,
	snapshotLinearIssue,
	formatLinearUpdate,
	formatLinearActionable,
	formatLinearFooter,
	linearGraphQL,
	fetchLinearIssue,
} from "../src/linear";
import type { LinearIssueData, LinearIssueStatus } from "../src/linear";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeIssue(overrides: Partial<LinearIssueData> = {}): LinearIssueData {
	const defaults: LinearIssueData = {
		id: "uuid-1",
		identifier: "ENG-123",
		title: "Fix the flux capacitor",
		url: "https://linear.app/acme/issue/ENG-123/fix-the-flux-capacitor",
		state: { name: "In Progress", type: "started" },
		priority: 2,
		priorityLabel: "High",
		assignee: { name: "Marty McFly", displayName: "marty" },
		comments: { nodes: [] },
		attachments: { nodes: [] },
	};
	return { ...defaults, ...overrides };
}

// ---------------------------------------------------------------------------
// parseLinearRef
// ---------------------------------------------------------------------------

describe("parseLinearRef", () => {
	it("parses a bare issue key", () => {
		expect(parseLinearRef("ENG-123")).toEqual({ key: "ENG-123" });
	});

	it("upper-cases the team prefix", () => {
		expect(parseLinearRef("eng-123")).toEqual({ key: "ENG-123" });
	});

	it("parses a Linear issue URL", () => {
		expect(parseLinearRef("https://linear.app/acme/issue/ENG-123/fix-the-flux-capacitor")).toEqual({
			key: "ENG-123",
		});
	});

	it("parses a Linear issue URL without a slug", () => {
		expect(parseLinearRef("https://linear.app/acme/issue/ABC-7")).toEqual({ key: "ABC-7" });
	});

	it("trims surrounding whitespace", () => {
		expect(parseLinearRef("  ENG-9  ")).toEqual({ key: "ENG-9" });
	});

	it("returns null for a GitHub PR URL", () => {
		expect(parseLinearRef("https://github.com/owner/repo/pull/42")).toBeNull();
	});

	it("returns null for gibberish", () => {
		expect(parseLinearRef("not a ticket")).toBeNull();
		expect(parseLinearRef("ENG123")).toBeNull();
		expect(parseLinearRef("123")).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Auth — documented best practice for a dev workstation
// ---------------------------------------------------------------------------

describe("getLinearApiKey", () => {
	it("reads the key from LINEAR_API_KEY", () => {
		expect(getLinearApiKey({ [LINEAR_API_KEY_ENV]: "lin_api_abc" } as NodeJS.ProcessEnv)).toBe("lin_api_abc");
	});

	it("trims whitespace", () => {
		expect(getLinearApiKey({ [LINEAR_API_KEY_ENV]: "  lin_api_abc \n" } as NodeJS.ProcessEnv)).toBe("lin_api_abc");
	});

	it("returns null when unset or blank", () => {
		expect(getLinearApiKey({} as NodeJS.ProcessEnv)).toBeNull();
		expect(getLinearApiKey({ [LINEAR_API_KEY_ENV]: "   " } as NodeJS.ProcessEnv)).toBeNull();
	});

	it("uses LINEAR_API_KEY as the documented env var name", () => {
		expect(LINEAR_API_KEY_ENV).toBe("LINEAR_API_KEY");
	});
});

describe("buildLinearHeaders", () => {
	it("sends the personal API key raw, WITHOUT a Bearer prefix", () => {
		// Linear's documented best practice: personal API keys use
		//   Authorization: <API_KEY>
		// NOT the OAuth-style "Authorization: Bearer <token>".
		const headers = buildLinearHeaders("lin_api_abc");
		expect(headers.Authorization).toBe("lin_api_abc");
		expect(headers.Authorization).not.toMatch(/bearer/i);
	});

	it("sets a JSON content type", () => {
		expect(buildLinearHeaders("k")["Content-Type"]).toBe("application/json");
	});
});

describe("LINEAR_GRAPHQL_ENDPOINT", () => {
	it("points at the documented endpoint", () => {
		expect(LINEAR_GRAPHQL_ENDPOINT).toBe("https://api.linear.app/graphql");
	});
});

// ---------------------------------------------------------------------------
// snapshotLinearIssue
// ---------------------------------------------------------------------------

describe("snapshotLinearIssue", () => {
	it("maps core fields", () => {
		const snap = snapshotLinearIssue(makeIssue());
		expect(snap.identifier).toBe("ENG-123");
		expect(snap.title).toBe("Fix the flux capacitor");
		expect(snap.stateName).toBe("In Progress");
		expect(snap.stateType).toBe("started");
		expect(snap.priority).toBe(2);
		expect(snap.priorityLabel).toBe("High");
		expect(snap.assignee).toBe("marty");
	});

	it("represents an unassigned issue with an empty assignee", () => {
		const snap = snapshotLinearIssue(makeIssue({ assignee: null }));
		expect(snap.assignee).toBe("");
	});

	it("summarizes comments and tracks the latest timestamp", () => {
		const snap = snapshotLinearIssue(
			makeIssue({
				comments: {
					nodes: [
						{ id: "c1", body: "first", createdAt: "2026-01-01T00:00:00Z", user: { displayName: "alice" } },
						{ id: "c2", body: "second\nmore", createdAt: "2026-01-02T00:00:00Z", user: { displayName: "bob" } },
					],
				},
			}),
		);
		expect(snap.comments.map((c) => c.id)).toEqual(["c1", "c2"]);
		expect(snap.comments[1].author).toBe("bob");
		expect(snap.comments[1].body).toBe("second"); // firstLine only in the concise body
		expect(snap.comments[1].fullBody).toBe("second\nmore");
		expect(snap.lastCommentTimestamp).toBe("2026-01-02T00:00:00Z");
	});

	it("filters out comments from ignored bots", () => {
		const snap = snapshotLinearIssue(
			makeIssue({
				comments: {
					nodes: [
						{ id: "c1", body: "human", createdAt: "2026-01-01T00:00:00Z", user: { displayName: "alice" } },
						{ id: "c2", body: "beep boop", createdAt: "2026-01-02T00:00:00Z", user: { displayName: "Linear" } },
					],
				},
			}),
			["Linear"],
		);
		expect(snap.comments.map((c) => c.id)).toEqual(["c1"]);
	});

	it("collects attachment links (e.g. linked PRs)", () => {
		const snap = snapshotLinearIssue(
			makeIssue({
				attachments: {
					nodes: [{ id: "a1", title: "PR #42", url: "https://github.com/o/r/pull/42" }],
				},
			}),
		);
		expect(snap.links).toEqual([{ id: "a1", title: "PR #42", url: "https://github.com/o/r/pull/42" }]);
	});
});

// ---------------------------------------------------------------------------
// formatLinearUpdate — change detection
// ---------------------------------------------------------------------------

function snap(overrides: Partial<LinearIssueStatus> = {}): LinearIssueStatus {
	return {
		identifier: "ENG-123",
		title: "Fix the flux capacitor",
		url: "https://linear.app/acme/issue/ENG-123",
		stateName: "In Progress",
		stateType: "started",
		priority: 2,
		priorityLabel: "High",
		assignee: "marty",
		comments: [],
		lastCommentTimestamp: "",
		links: [],
		...overrides,
	};
}

describe("formatLinearUpdate", () => {
	it("returns null on the first observation (no prior snapshot)", () => {
		expect(formatLinearUpdate(null, snap())).toBeNull();
	});

	it("returns null when nothing changed", () => {
		expect(formatLinearUpdate(snap(), snap())).toBeNull();
	});

	it("detects new comments (by id) and reports the author", () => {
		const prev = snap();
		const curr = snap({
			comments: [{ id: "c1", author: "alice", body: "please review", fullBody: "please review" }],
			lastCommentTimestamp: "2026-01-02T00:00:00Z",
		});
		const out = formatLinearUpdate(prev, curr);
		expect(out).not.toBeNull();
		expect(out!.concise).toContain("ENG-123");
		expect(out!.concise.toLowerCase()).toContain("comment");
		expect(out!.detailed).toContain("alice");
		expect(out!.detailed).toContain("please review");
	});

	it("does not re-report a comment already seen", () => {
		const prev = snap({ comments: [{ id: "c1", author: "alice", body: "hi", fullBody: "hi" }] });
		const curr = snap({ comments: [{ id: "c1", author: "alice", body: "hi", fullBody: "hi" }] });
		expect(formatLinearUpdate(prev, curr)).toBeNull();
	});

	it("detects a state transition", () => {
		const out = formatLinearUpdate(snap({ stateName: "In Progress" }), snap({ stateName: "In Review" }));
		expect(out).not.toBeNull();
		expect(out!.concise).toContain("In Progress");
		expect(out!.concise).toContain("In Review");
	});

	it("detects an assignee change", () => {
		const out = formatLinearUpdate(snap({ assignee: "marty" }), snap({ assignee: "doc" }));
		expect(out).not.toBeNull();
		expect(out!.concise.toLowerCase()).toContain("assign");
		expect(out!.concise).toContain("doc");
	});

	it("detects a priority change", () => {
		const out = formatLinearUpdate(
			snap({ priority: 2, priorityLabel: "High" }),
			snap({ priority: 1, priorityLabel: "Urgent" }),
		);
		expect(out).not.toBeNull();
		expect(out!.concise.toLowerCase()).toContain("priorit");
		expect(out!.concise).toContain("Urgent");
	});

	it("detects newly linked resources (e.g. a linked PR)", () => {
		const out = formatLinearUpdate(
			snap(),
			snap({ links: [{ id: "a1", title: "PR #42", url: "https://github.com/o/r/pull/42" }] }),
		);
		expect(out).not.toBeNull();
		expect(out!.detailed).toContain("https://github.com/o/r/pull/42");
	});

	it("combines multiple simultaneous changes into one update", () => {
		const prev = snap({ stateName: "In Progress", assignee: "marty" });
		const curr = snap({
			stateName: "Done",
			assignee: "doc",
			comments: [{ id: "c1", author: "alice", body: "shipped", fullBody: "shipped" }],
		});
		const out = formatLinearUpdate(prev, curr);
		expect(out).not.toBeNull();
		expect(out!.concise).toContain("Done");
		expect(out!.concise).toContain("doc");
		expect(out!.detailed).toContain("shipped");
	});
});

// ---------------------------------------------------------------------------
// formatLinearActionable / formatLinearFooter
// ---------------------------------------------------------------------------

describe("formatLinearActionable", () => {
	it("returns null when there are no comments to act on", () => {
		expect(formatLinearActionable(snap())).toBeNull();
	});

	it("lists current comments", () => {
		const out = formatLinearActionable(
			snap({ comments: [{ id: "c1", author: "alice", body: "look at this", fullBody: "look at this" }] }),
		);
		expect(out).not.toBeNull();
		expect(out!.concise).toContain("ENG-123");
		expect(out!.detailed).toContain("look at this");
	});
});

describe("formatLinearFooter", () => {
	it("shows a placeholder before the first poll", () => {
		expect(formatLinearFooter(null, { key: "ENG-123" })).toContain("ENG-123");
	});

	it("summarizes state and comment count", () => {
		const line = formatLinearFooter(
			snap({ stateName: "In Review", comments: [{ id: "c1", author: "a", body: "b", fullBody: "b" }] }),
			{ key: "ENG-123" },
		);
		expect(line).toContain("ENG-123");
		expect(line).toContain("In Review");
	});
});

// ---------------------------------------------------------------------------
// GraphQL client (injected fetch — no network)
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
	return new Response(JSON.stringify(body), {
		status: init.status ?? 200,
		headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
	});
}

describe("linearGraphQL", () => {
	it("POSTs to the endpoint with the raw API key in the Authorization header", async () => {
		let captured: { url: string; init: RequestInit } | null = null;
		const fetchImpl = (async (url: string, init: RequestInit) => {
			captured = { url, init };
			return jsonResponse({ data: { ok: true } });
		}) as unknown as typeof fetch;

		await linearGraphQL("query { ok }", { a: 1 }, { apiKey: "lin_api_xyz", fetchImpl });

		expect(captured).not.toBeNull();
		expect(captured!.url).toBe(LINEAR_GRAPHQL_ENDPOINT);
		expect(captured!.init.method).toBe("POST");
		const headers = captured!.init.headers as Record<string, string>;
		expect(headers.Authorization).toBe("lin_api_xyz");
		const body = JSON.parse(captured!.init.body as string);
		expect(body.query).toContain("ok");
		expect(body.variables).toEqual({ a: 1 });
	});

	it("honors an endpoint override (for a mock server)", async () => {
		let capturedUrl = "";
		const fetchImpl = (async (url: string) => {
			capturedUrl = url;
			return jsonResponse({ data: {} });
		}) as unknown as typeof fetch;
		await linearGraphQL("query { x }", {}, { apiKey: "k", fetchImpl, endpoint: "http://localhost:9999/graphql" });
		expect(capturedUrl).toBe("http://localhost:9999/graphql");
	});

	it("throws a rate-limit error on HTTP 429 (so the poll loop backs off)", async () => {
		const fetchImpl = (async () => jsonResponse({}, { status: 429 })) as unknown as typeof fetch;
		await expect(linearGraphQL("q", {}, { apiKey: "k", fetchImpl })).rejects.toThrow(/rate limit/i);
	});

	it("throws when the GraphQL response carries errors", async () => {
		const fetchImpl = (async () =>
			jsonResponse({ errors: [{ message: "Entity not found" }] })) as unknown as typeof fetch;
		await expect(linearGraphQL("q", {}, { apiKey: "k", fetchImpl })).rejects.toThrow(/Entity not found/);
	});
});

describe("fetchLinearIssue", () => {
	it("unwraps data.issue", async () => {
		const issue = makeIssue();
		const fetchImpl = (async () => jsonResponse({ data: { issue } })) as unknown as typeof fetch;
		const out = await fetchLinearIssue({ key: "ENG-123" }, { apiKey: "k", fetchImpl });
		expect(out.identifier).toBe("ENG-123");
	});

	it("throws a clear error when the issue is missing", async () => {
		const fetchImpl = (async () => jsonResponse({ data: { issue: null } })) as unknown as typeof fetch;
		await expect(fetchLinearIssue({ key: "ENG-404" }, { apiKey: "k", fetchImpl })).rejects.toThrow(/ENG-404/);
	});
});
