/**
 * Mock GitHub GraphQL server for testing pi-ghpr-monitor
 *
 * Provides a fake GitHub API that simulates PR data with:
 * - Review threads (resolved/unresolved)
 * - General comments
 * - Merge conflicts
 * - CI check suites (passing, failing, pending)
 *
 * Start with: npx tsx test/mock-github-server.ts [port]
 * Default port: 9700
 *
 * Endpoints:
 *   POST /graphql — GitHub GraphQL API (responds to AwaitPR query)
 *   GET /state    — Get current mock state
 *   PUT /state    — Update mock state (to simulate changes)
 *   POST /reset   — Reset to default state
 */

import * as http from "node:http";

export interface MockPRState {
	unresolvedThreads: number;
	generalComments: number;
	hasConflicts: boolean;
	failingChecks: string[];
	pendingChecks: string[];
	passingChecks: string[];
	commentAuthors: string[];
	lastCommentBody: string;
}

const DEFAULT_STATE: MockPRState = {
	unresolvedThreads: 2,
	generalComments: 1,
	hasConflicts: false,
	failingChecks: [],
	pendingChecks: ["ci/test"],
	passingChecks: ["ci/build"],
	commentAuthors: ["reviewer1"],
	lastCommentBody: "Please fix the typo in the README",
};

// ---------------------------------------------------------------------------
// GraphQL response builder
// ---------------------------------------------------------------------------

function buildGraphQLResponse(state: MockPRState): object {
	const reviewThreadNodes = [];
	for (let i = 0; i < state.unresolvedThreads + 3; i++) {
		const isResolved = i >= state.unresolvedThreads;
		reviewThreadNodes.push({
			id: `thread-${i}`,
			isResolved,
			isOutdated: false,
			comments: {
				nodes: [
					{
						id: `thread-comment-${i}`,
						body: isResolved ? "Looks good now" : state.lastCommentBody,
						author: { login: state.commentAuthors[i % state.commentAuthors.length] || "reviewer1" },
						createdAt: new Date(Date.now() - (i + 1) * 60000).toISOString(),
					},
				],
				pageInfo: { hasNextPage: false },
			},
		});
	}

	const commentNodes = [];
	for (let i = 0; i < state.generalComments; i++) {
		commentNodes.push({
			id: `comment-${i}`,
			body: i === 0 ? state.lastCommentBody : `General comment ${i + 1}`,
			author: { login: state.commentAuthors[i % state.commentAuthors.length] || "commenter1" },
			createdAt: new Date(Date.now() - i * 30000).toISOString(),
		});
	}

	const checkSuiteNodes = [];
	for (const name of state.passingChecks) {
		checkSuiteNodes.push({
			id: `suite-pass-${name}`,
			conclusion: "SUCCESS",
			status: "COMPLETED",
			app: { name, slug: name.toLowerCase().replace(/[^a-z0-9]/g, "-") },
			checkRuns: {
				nodes: [{ name, conclusion: "SUCCESS", status: "COMPLETED" }],
			},
		});
	}
	for (const name of state.failingChecks) {
		checkSuiteNodes.push({
			id: `suite-fail-${name}`,
			conclusion: "FAILURE",
			status: "COMPLETED",
			app: { name, slug: name.toLowerCase().replace(/[^a-z0-9]/g, "-") },
			checkRuns: {
				nodes: [{ name, conclusion: "FAILURE", status: "COMPLETED" }],
			},
		});
	}
	for (const name of state.pendingChecks) {
		checkSuiteNodes.push({
			id: `suite-pending-${name}`,
			conclusion: null,
			status: "IN_PROGRESS",
			app: { name, slug: name.toLowerCase().replace(/[^a-z0-9]/g, "-") },
			checkRuns: {
				nodes: [{ name, conclusion: "SUCCESS", status: "IN_PROGRESS" }],
			},
		});
	}

	return {
		data: {
			repository: {
				pullRequest: {
					comments: {
						nodes: commentNodes,
						pageInfo: { hasNextPage: false },
					},
					reviewThreads: {
						nodes: reviewThreadNodes,
						pageInfo: { hasNextPage: false },
					},
					mergeable: state.hasConflicts ? "CONFLICTING" : "MERGEABLE",
					mergeStateStatus: state.hasConflicts ? "DIRTY" : "CLEAN",
					state: (state as any).state || "OPEN",
					merged: (state as any).merged || false,
					commits: {
						nodes: [
							{
								commit: {
									checkSuites: {
										nodes: checkSuiteNodes,
									},
								},
							},
						],
					},
				},
			},
		},
	};
}

// ---------------------------------------------------------------------------
// HTTP Server
// ---------------------------------------------------------------------------

export function createMockGitHubServer(port: number = 9700): http.Server {
	let currentState: MockPRState = { ...DEFAULT_STATE };

	const server = http.createServer((req, res) => {
		const sendJSON = (code: number, body: unknown) => {
			res.writeHead(code, {
				"Content-Type": "application/json",
				"Access-Control-Allow-Origin": "*",
			});
			res.end(JSON.stringify(body));
		};

		const readBody = (): Promise<string> =>
			new Promise((resolve) => {
				let data = "";
				req.on("data", (chunk: Buffer) => (data += chunk.toString()));
				req.on("end", () => resolve(data));
			});

		// Handle CORS preflight
		if (req.method === "OPTIONS") {
			res.writeHead(204, {
				"Access-Control-Allow-Origin": "*",
				"Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
				"Access-Control-Allow-Headers": "Content-Type, Authorization",
			});
			res.end();
			return;
		}

		const url = new URL(req.url || "/", `http://localhost:${port}`);

		switch (`${req.method} ${url.pathname}`) {
			case "POST /graphql": {
				readBody().then((body) => {
					try {
						const parsed = JSON.parse(body);
						// We don't validate the query — just return mock data
						const response = buildGraphQLResponse(currentState);
						// Simulate network latency
						setTimeout(() => sendJSON(200, response), 50 + Math.random() * 50);
					} catch {
						sendJSON(400, { errors: [{ message: "Invalid JSON" }] });
					}
				});
				return;
			}

			case "GET /state": {
				sendJSON(200, currentState);
				return;
			}

			case "PUT /state": {
				readBody().then((body) => {
					try {
						const updates = JSON.parse(body);
						currentState = { ...currentState, ...updates };
						sendJSON(200, currentState);
					} catch {
						sendJSON(400, { error: "Invalid JSON" });
					}
				});
				return;
			}

			case "POST /reset": {
				currentState = { ...DEFAULT_STATE };
				sendJSON(200, currentState);
				return;
			}

			default:
				sendJSON(404, { error: "Not found" });
		}
	});

	server.listen(port, () => {
		console.log(`[mock-github] Listening on http://localhost:${port}`);
		console.log(`[mock-github] GraphQL: POST http://localhost:${port}/graphql`);
		console.log(`[mock-github] State:    GET  http://localhost:${port}/state`);
		console.log(`[mock-github] Update:   PUT  http://localhost:${port}/state`);
		console.log(`[mock-github] Reset:    POST http://localhost:${port}/reset`);
	});

	return server;
}

// Run if executed directly
if (require.main === module || process.argv[1]?.includes("mock-github-server")) {
	const port = parseInt(process.argv[2] || "9700", 10);
	createMockGitHubServer(port);
}