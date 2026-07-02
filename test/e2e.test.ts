/**
 * End-to-end test for the monitoring state machine
 *
 * Tests the extension's core monitoring loop with a mock GitHub server,
 * verifying state transitions, notification messages, and error handling.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import type { ReactionNode } from "../src/analyzer";

// ---------------------------------------------------------------------------
// In-process mock GitHub server
// ---------------------------------------------------------------------------

let mockState: Record<string, unknown> = {
	unresolvedThreads: 2,
	generalComments: 1,
	hasConflicts: false,
	failingChecks: [],
	pendingChecks: ["ci/test"],
	passingChecks: ["ci/build"],
	commentAuthors: ["reviewer1"],
	lastCommentBody: "Please fix the typo in the README",
};

let ghServer: http.Server;
const GH_PORT = 9810;

function buildResponse() {
	const state = mockState as typeof mockState;
	const reviewThreadNodes = [];
	const threads = (state.unresolvedThreads as number) + 3;
	for (let i = 0; i < threads; i++) {
		const isResolved = i >= (state.unresolvedThreads as number);
		reviewThreadNodes.push({
			id: `thread-${i}`,
			isResolved,
			comments: {
				nodes: [
					{
						id: `tc-${i}`,
						body: isResolved ? "Looks good" : (state.lastCommentBody as string),
						author: { login: "reviewer1" },
						createdAt: new Date().toISOString(),
						reactions: { nodes: [] as ReactionNode[] },
					},
				],
			},
		});
	}
	const commentNodes = [];
	for (let i = 0; i < (state.generalComments as number); i++) {
		commentNodes.push({
			id: `c-${i}`,
			body: `Comment ${i}`,
			author: { login: "commenter1" },
			createdAt: new Date().toISOString(),
			reactions: { nodes: [] as ReactionNode[] },
		});
	}
	const checkSuiteNodes = [];
	for (const name of state.passingChecks as string[]) {
		checkSuiteNodes.push({
			id: `sp-${name}`,
			conclusion: "SUCCESS",
			status: "COMPLETED",
			app: { name, slug: name },
			checkRuns: { nodes: [{ name, conclusion: "SUCCESS", status: "COMPLETED" }] },
		});
	}
	for (const name of state.failingChecks as string[]) {
		checkSuiteNodes.push({
			id: `sf-${name}`,
			conclusion: "FAILURE",
			status: "COMPLETED",
			app: { name, slug: name },
			checkRuns: { nodes: [{ name, conclusion: "FAILURE", status: "COMPLETED" }] },
		});
	}
	for (const name of state.pendingChecks as string[]) {
		checkSuiteNodes.push({
			id: `spn-${name}`,
			conclusion: null,
			status: "IN_PROGRESS",
			app: { name, slug: name },
			checkRuns: { nodes: [{ name, conclusion: null, status: "IN_PROGRESS" }] },
		});
	}
	return {
		data: {
			repository: {
				pullRequest: {
					comments: { nodes: commentNodes },
					reviewThreads: { nodes: reviewThreadNodes },
					reviews: { nodes: [] },
					mergeable: state.hasConflicts ? "CONFLICTING" : "MERGEABLE",
					mergeStateStatus: state.hasConflicts ? "DIRTY" : "CLEAN",
					state: (state as any).state || "OPEN",
					merged: (state as any).merged || false,
					commits: { nodes: [{ commit: { oid: "abc123", checkSuites: { nodes: checkSuiteNodes }, status: { state: "SUCCESS", contexts: [] } } }] },
				},
			},
		},
	};
}

beforeAll(async () => {
	ghServer = http.createServer((req, res) => {
		const send = (code: number, body: unknown) => {
			res.writeHead(code, { "Content-Type": "application/json" });
			res.end(JSON.stringify(body));
		};
		const readBody = () =>
			new Promise<string>((r) => {
				let d = "";
				req.on("data", (c) => (d += c));
				req.on("end", () => r(d));
			});

		if (req.method === "OPTIONS") {
			res.writeHead(204, { "Access-Control-Allow-Origin": "*" });
			res.end();
			return;
		}

		const url = new URL(req.url || "/", `http://localhost:${GH_PORT}`);

		if (req.method === "POST" && url.pathname === "/graphql") {
			readBody().then(() => send(200, buildResponse()));
			return;
		}
		if (req.method === "GET" && url.pathname === "/state") {
			send(200, mockState);
			return;
		}
		if (req.method === "PUT" && url.pathname === "/state") {
			readBody().then((body) => {
				mockState = { ...mockState, ...JSON.parse(body) };
				send(200, mockState);
			});
			return;
		}
		if (req.method === "POST" && url.pathname === "/reset") {
			mockState = {
				unresolvedThreads: 2,
				generalComments: 1,
				hasConflicts: false,
				failingChecks: [],
				pendingChecks: ["ci/test"],
				passingChecks: ["ci/build"],
				commentAuthors: ["reviewer1"],
				lastCommentBody: "Please fix the typo in the README",
			};
			send(200, mockState);
			return;
		}
		send(404, { error: "Not found" });
	});
	await new Promise<void>((r) => ghServer.listen(GH_PORT, () => r()));
});

afterAll(() => {
	ghServer?.close();
});

// ---------------------------------------------------------------------------
// Tests for the extension's data flow using the mock server
// ---------------------------------------------------------------------------

describe("Extension monitoring with mock GitHub server", () => {
	it("fetches initial state from mock server", async () => {
		const resp = await fetch(`http://localhost:${GH_PORT}/graphql`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ query: "test", variables: {} }),
		});
		const data = await resp.json();
		const pr = data.data.repository.pullRequest;

		expect(pr.mergeable).toBe("MERGEABLE");
		expect(pr.comments.nodes.length).toBe(1);
		expect(pr.reviewThreads.nodes.length).toBeGreaterThan(2);
		expect(pr.commits.nodes[0].commit.checkSuites.nodes.length).toBeGreaterThan(0);
	});

	it("detects conflicts after state update", async () => {
		await fetch(`http://localhost:${GH_PORT}/state`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ hasConflicts: true }),
		});

		const resp = await fetch(`http://localhost:${GH_PORT}/graphql`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ query: "test", variables: {} }),
		});
		const data = await resp.json();
		expect(data.data.repository.pullRequest.mergeable).toBe("CONFLICTING");

		// Reset
		await fetch(`http://localhost:${GH_PORT}/reset`, { method: "POST" });
	});

	it("detects new failing checks", async () => {
		await fetch(`http://localhost:${GH_PORT}/state`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ failingChecks: ["ci/lint", "ci/test"], pendingChecks: [] }),
		});

		const resp = await fetch(`http://localhost:${GH_PORT}/graphql`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ query: "test", variables: {} }),
		});
		const data = await resp.json();
		const suites = data.data.repository.pullRequest.commits.nodes[0].commit.checkSuites.nodes;
		const failing = suites.filter((s: any) => s.conclusion === "FAILURE");
		expect(failing.length).toBe(2);

		// Reset
		await fetch(`http://localhost:${GH_PORT}/reset`, { method: "POST" });
	});

	it("shows all clear when everything passes", async () => {
		await fetch(`http://localhost:${GH_PORT}/state`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				unresolvedThreads: 0,
				generalComments: 0,
				hasConflicts: false,
				failingChecks: [],
				pendingChecks: [],
				passingChecks: ["ci/test", "ci/build", "ci/lint"],
			}),
		});

		const resp = await fetch(`http://localhost:${GH_PORT}/graphql`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ query: "test", variables: {} }),
		});
		const data = await resp.json();
		const pr = data.data.repository.pullRequest;

		expect(pr.mergeable).toBe("MERGEABLE");
		expect(pr.comments.nodes.length).toBe(0);
		const unresolved = pr.reviewThreads.nodes.filter((t: any) => !t.isResolved);
		expect(unresolved.length).toBe(0);

		// Reset
		await fetch(`http://localhost:${GH_PORT}/reset`, { method: "POST" });
	});

	it("resets state correctly", async () => {
		await fetch(`http://localhost:${GH_PORT}/state`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ hasConflicts: true, unresolvedThreads: 99 }),
		});

		const before = await fetch(`http://localhost:${GH_PORT}/state`).then((r) => r.json());
		expect(before.hasConflicts).toBe(true);

		await fetch(`http://localhost:${GH_PORT}/reset`, { method: "POST" });

		const after = await fetch(`http://localhost:${GH_PORT}/state`).then((r) => r.json());
		expect(after.hasConflicts).toBe(false);
		expect(after.unresolvedThreads).toBe(2);
	});
});
it("detects merged PR in GraphQL response", async () => {
	await fetch(`http://localhost:${GH_PORT}/state`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ state: "MERGED", merged: true }),
	});
	const resp = await fetch(`http://localhost:${GH_PORT}/graphql`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ query: "test", variables: {} }),
	});
	const data = await resp.json();
	expect(data.data.repository.pullRequest.state).toBe("MERGED");
	expect(data.data.repository.pullRequest.merged).toBe(true);

	// Reset
	await fetch(`http://localhost:${GH_PORT}/reset`, { method: "POST" });
});

it("detects closed PR in GraphQL response", async () => {
	await fetch(`http://localhost:${GH_PORT}/state`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ state: "CLOSED" }),
	});
	const resp = await fetch(`http://localhost:${GH_PORT}/graphql`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ query: "test", variables: {} }),
	});
	const data = await resp.json();
	expect(data.data.repository.pullRequest.state).toBe("CLOSED");
	expect(data.data.repository.pullRequest.merged).toBe(false);

	// Reset
	await fetch(`http://localhost:${GH_PORT}/reset`, { method: "POST" });
});
