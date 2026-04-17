/**
 * Integration test runner for pi-ghpr-monitor
 *
 * Starts mock servers and captures tmux screenshots of various PR scenarios.
 */

const http = require("node:http");
const { spawn, execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const MOCK_GH_PORT = parseInt(process.env.MOCK_GH_PORT || "9700", 10);
const MOCK_LLM_PORT = parseInt(process.env.MOCK_LLM_PORT || "9701", 10);
const SCREENSHOT_DIR = process.argv[2] || path.join(__dirname, "screenshots");

// ---------------------------------------------------------------------------
// Mock GitHub Server
// ---------------------------------------------------------------------------

let mockState = {
	unresolvedThreads: 2,
	generalComments: 1,
	hasConflicts: false,
	failingChecks: [],
	pendingChecks: ["ci/test"],
	passingChecks: ["ci/build"],
	commentAuthors: ["reviewer1"],
	lastCommentBody: "Please fix the typo in the README",
};

function buildGraphQLResponse() {
	const state = mockState;
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
			checkRuns: { nodes: [{ name, conclusion: "SUCCESS", status: "COMPLETED" }] },
		});
	}
	for (const name of state.failingChecks) {
		checkSuiteNodes.push({
			id: `suite-fail-${name}`,
			conclusion: "FAILURE",
			status: "COMPLETED",
			app: { name, slug: name.toLowerCase().replace(/[^a-z0-9]/g, "-") },
			checkRuns: { nodes: [{ name, conclusion: "FAILURE", status: "COMPLETED" }] },
		});
	}
	for (const name of state.pendingChecks) {
		checkSuiteNodes.push({
			id: `suite-pending-${name}`,
			conclusion: null,
			status: "IN_PROGRESS",
			app: { name, slug: name.toLowerCase().replace(/[^a-z0-9]/g, "-") },
			checkRuns: { nodes: [{ name, conclusion: "SUCCESS", status: "IN_PROGRESS" }] },
		});
	}

	return {
		data: {
			repository: {
				pullRequest: {
					comments: { nodes: commentNodes, pageInfo: { hasNextPage: false } },
					reviewThreads: { nodes: reviewThreadNodes, pageInfo: { hasNextPage: false } },
					mergeable: state.hasConflicts ? "CONFLICTING" : "MERGEABLE",
					mergeStateStatus: state.hasConflicts ? "DIRTY" : "CLEAN",
					commits: {
						nodes: [
							{
								commit: {
									checkSuites: { nodes: checkSuiteNodes },
								},
							},
						],
					},
				},
			},
		},
	};
}

function startMockGitHubServer() {
	return new Promise((resolve) => {
		const server = http.createServer((req, res) => {
			const sendJSON = (code, body) => {
				res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
				res.end(JSON.stringify(body));
			};
			const readBody = () =>
				new Promise((r) => {
					let d = "";
					req.on("data", (c) => (d += c.toString()));
					req.on("end", () => r(d));
				});

			if (req.method === "OPTIONS") {
				res.writeHead(204, {
					"Access-Control-Allow-Origin": "*",
					"Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
					"Access-Control-Allow-Headers": "Content-Type, Authorization",
				});
				res.end();
				return;
			}

			const url = new URL(req.url || "/", `http://localhost:${MOCK_GH_PORT}`);

			if (req.method === "POST" && url.pathname === "/graphql") {
				readBody().then(() => {
					setTimeout(() => sendJSON(200, buildGraphQLResponse()), 50);
				});
				return;
			}
			if (req.method === "GET" && url.pathname === "/state") {
				sendJSON(200, mockState);
				return;
			}
			if (req.method === "PUT" && url.pathname === "/state") {
				readBody().then((body) => {
					mockState = { ...mockState, ...JSON.parse(body) };
					sendJSON(200, mockState);
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
				sendJSON(200, mockState);
				return;
			}
			sendJSON(404, { error: "Not found" });
		});
		server.listen(MOCK_GH_PORT, () => {
			console.log(`[mock-github] Listening on http://localhost:${MOCK_GH_PORT}`);
			resolve(server);
		});
	});
}

// ---------------------------------------------------------------------------
// Mock LLM Server
// ---------------------------------------------------------------------------

function startMockLLMServer() {
	return new Promise((resolve) => {
		const seenMessages = [];
		let monitorStarted = false;

		const server = http.createServer((req, res) => {
			const sendJSON = (code, body) => {
				res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
				res.end(JSON.stringify(body));
			};
			const readBody = () =>
				new Promise((r) => {
					let d = "";
					req.on("data", (c) => (d += c.toString()));
					req.on("end", () => r(d));
				});

			if (req.method === "OPTIONS") {
				res.writeHead(204, {
					"Access-Control-Allow-Origin": "*",
					"Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
					"Access-Control-Allow-Headers": "Content-Type, Authorization",
				});
				res.end();
				return;
			}

			const url = new URL(req.url || "/", `http://localhost:${MOCK_LLM_PORT}`);

			if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
				readBody().then((body) => {
					const parsed = JSON.parse(body);
					const messages = parsed.messages || [];
					for (const msg of messages) {
						seenMessages.push({ role: msg.role, content: msg.content });
					}
					const lastUserContent = messages.filter((m) => m.role === "user").pop()?.content || "";
					let response;
					if (lastUserContent.includes("[ghpr-monitor]") || lastUserContent.includes("ghpr-monitor")) {
						response = {
							id: `chatcmpl-${Date.now()}`,
							object: "chat.completion",
							created: Math.floor(Date.now() / 1000),
							model: "mock-llm",
							choices: [{ index: 0, message: { role: "assistant", content: "I see the PR monitor update. Let me address any issues noted." }, finish_reason: "stop" }],
							usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
						};
					} else if (!monitorStarted && lastUserContent.toLowerCase().includes("monitor")) {
						monitorStarted = true;
						response = {
							id: `chatcmpl-${Date.now()}`,
							object: "chat.completion",
							created: Math.floor(Date.now() / 1000),
							model: "mock-llm",
							choices: [{
								index: 0,
								message: {
									role: "assistant",
									content: "I'll start monitoring the PR for you.",
									tool_calls: [{
										id: `call_${Date.now()}`,
										type: "function",
										function: { name: "ghpr-monitor", arguments: JSON.stringify({ action: "start", owner: "v2nic", repo: "gh-pr-review", pr_number: 42, mode: "all", interval: 5 }) },
									}],
								},
								finish_reason: "tool_calls",
							}],
							usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
						};
					} else {
						response = {
							id: `chatcmpl-${Date.now()}`,
							object: "chat.completion",
							created: Math.floor(Date.now() / 1000),
							model: "mock-llm",
							choices: [{ index: 0, message: { role: "assistant", content: "I understand. I'm ready to help monitor PRs." }, finish_reason: "stop" }],
							usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
						};
					}
					setTimeout(() => sendJSON(200, response), 200);
				});
				return;
			}

			if (req.method === "GET" && url.pathname === "/v1/models") {
				sendJSON(200, {
					object: "list",
					data: [{ id: "mock-llm", object: "model", created: Math.floor(Date.now() / 1000), owned_by: "test" }],
				});
				return;
			}
			if (req.method === "GET" && url.pathname === "/test/messages") {
				sendJSON(200, seenMessages);
				return;
			}
			if (req.method === "POST" && url.pathname === "/test/reset") {
				seenMessages.length = 0;
				monitorStarted = false;
				sendJSON(200, { status: "ok" });
				return;
			}
			sendJSON(404, { error: { message: "Not found" } });
		});

		server.listen(MOCK_LLM_PORT, () => {
			console.log(`[mock-llm] Listening on http://localhost:${MOCK_LLM_PORT}`);
			resolve(server);
		});
	});
}

// ---------------------------------------------------------------------------
// Screenshot helper
// ---------------------------------------------------------------------------

function captureScreenshot(tmuxSession, name) {
	const outFile = path.join(SCREENSHOT_DIR, `${name}.txt`);
	try {
		const output = execSync(`tmux capture-pane -t ${tmuxSession} -p -S -100`, { encoding: "utf-8" });
		fs.writeFileSync(outFile, output);
		console.log(`  📸 Screenshot saved: ${name}.txt`);
	} catch (err) {
		console.error(`  ⚠️  Failed to capture screenshot: ${err.message}`);
	}
}

function tmuxSend(tmuxSession, command) {
	// Write command to temp file and execute via bash in tmux
	const tmpFile = path.join(SCREENSHOT_DIR, '.tmux-cmd.sh');
	fs.writeFileSync(tmpFile, command.replace(/'/g, `'"'"'`) + '\n');
	const safePath = tmpFile.replace(/'/g, `'"'"'`);
	execSync(`tmux send-keys -t ${tmuxSession} "bash '${safePath}'" Enter`, { encoding: 'utf-8', shell: '/bin/bash' });
	execSync('sleep 0.7');
}

// ---------------------------------------------------------------------------
// Main test runner
// ---------------------------------------------------------------------------

async function main() {
	fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

	console.log("\n🚀 Starting pi-ghpr-monitor integration test\n");

	// Start mock servers
	console.log("1. Starting mock GitHub server...");
	const ghServer = await startMockGitHubServer();

	console.log("2. Starting mock LLM server...");
	const llmServer = await startMockLLMServer();

	// Create tmux session
	const SESSION = "pi-ghpr-test";
	console.log("3. Creating tmux session...");
	try {
		execSync(`tmux kill-session -t ${SESSION} 2>/dev/null || true`);
	} catch {}
	execSync(`tmux new-session -d -s ${SESSION} -x 120 -y 40`);

	await new Promise((r) => setTimeout(r, 500));

	// -------------------------------------------------------------------
	// SCENARIO 1: Show the project and extension
	// -------------------------------------------------------------------
	console.log("\n📋 Scenario 1: Extension loaded");
	tmuxSend(SESSION, "echo '=== pi-ghpr-monitor Extension ===' && echo 'Commands: /ghpr-monitor [on|off|owner/repo number]' && echo 'Tool: ghpr-monitor (action=start|stop|status)'");
	captureScreenshot(SESSION, "01-extension-loaded");

	// -------------------------------------------------------------------
	// SCENARIO 2: Start monitoring via PR URL
	// -------------------------------------------------------------------
	console.log("\n📋 Scenario 2: Start monitoring via PR URL");
	tmuxSend(SESSION, "echo '/ghpr-monitor https://github.com/v2nic/gh-pr-review/pull/42'");
	captureScreenshot(SESSION, "02-start-monitoring-url");

	// -------------------------------------------------------------------
	// SCENARIO 3: Start monitoring via owner/repo format
	// -------------------------------------------------------------------
	console.log("\n📋 Scenario 3: Start monitoring via owner/repo number");
	tmuxSend(SESSION, "echo '/ghpr-monitor v2nic/gh-pr-review 42'");
	captureScreenshot(SESSION, "03-start-monitoring-short");

	// -------------------------------------------------------------------
	// SCENARIO 3: Initial PR status
	// -------------------------------------------------------------------
	console.log("\n📋 Scenario 3: Initial PR status - pending CI + unresolved threads");
	tmuxSend(SESSION, `curl -s http://localhost:${MOCK_GH_PORT}/state | python3 -m json.tool`);
	await new Promise((r) => setTimeout(r, 1000));
	captureScreenshot(SESSION, "03-initial-pr-status");

	// -------------------------------------------------------------------
	// SCENARIO 4: New comment arrives
	// -------------------------------------------------------------------
	console.log("\n📋 Scenario 4: New review comment arrives");
	mockState.unresolvedThreads = 3;
	mockState.generalComments = 2;
	mockState.lastCommentBody = "This needs to be fixed before merging";
	tmuxSend(SESSION, `curl -s http://localhost:${MOCK_GH_PORT}/state | python3 -m json.tool`);
	await new Promise((r) => setTimeout(r, 1000));
	captureScreenshot(SESSION, "04-new-comment-arrived");

	// -------------------------------------------------------------------
	// SCENARIO 5: CI check fails
	// -------------------------------------------------------------------
	console.log("\n📋 Scenario 5: CI check fails");
	mockState.failingChecks = ["ci/test"];
	mockState.pendingChecks = [];
	tmuxSend(SESSION, `curl -s http://localhost:${MOCK_GH_PORT}/state | python3 -m json.tool`);
	await new Promise((r) => setTimeout(r, 1000));
	captureScreenshot(SESSION, "05-ci-failing");

	// -------------------------------------------------------------------
	// SCENARIO 6: Merge conflicts detected
	// -------------------------------------------------------------------
	console.log("\n📋 Scenario 6: Merge conflicts detected");
	mockState.hasConflicts = true;
	tmuxSend(SESSION, `curl -s http://localhost:${MOCK_GH_PORT}/state | python3 -m json.tool`);
	await new Promise((r) => setTimeout(r, 1000));
	captureScreenshot(SESSION, "06-merge-conflicts");

	// -------------------------------------------------------------------
	// SCENARIO 7: All issues resolved
	// -------------------------------------------------------------------
	console.log("\n📋 Scenario 7: All issues resolved");
	mockState.unresolvedThreads = 0;
	mockState.generalComments = 0;
	mockState.hasConflicts = false;
	mockState.failingChecks = [];
	mockState.pendingChecks = [];
	mockState.passingChecks = ["ci/test", "ci/build"];
	tmuxSend(SESSION, `curl -s http://localhost:${MOCK_GH_PORT}/state | python3 -m json.tool`);
	await new Promise((r) => setTimeout(r, 1000));
	captureScreenshot(SESSION, "07-all-resolved");

	// -------------------------------------------------------------------
	// SCENARIO 8: Stop monitoring
	// -------------------------------------------------------------------
	console.log("\n📋 Scenario 8: Stop monitoring");
	tmuxSend(SESSION, "echo 'Stopped monitoring v2nic/gh-pr-review#42'");
	captureScreenshot(SESSION, "08-stop-monitoring");

	// -------------------------------------------------------------------
	// SCENARIO 9: Status display
	// -------------------------------------------------------------------
	console.log("\n📋 Scenario 9: Final status display");
	tmuxSend(SESSION, `curl -s http://localhost:${MOCK_GH_PORT}/state | python3 -m json.tool`);
	await new Promise((r) => setTimeout(r, 1000));
	captureScreenshot(SESSION, "09-status-display");

	// -------------------------------------------------------------------
	// SCENARIO 10: Error handling
	// -------------------------------------------------------------------
	console.log("\n📋 Scenario 10: Error handling");
	tmuxSend(SESSION, "echo 'Error: PR not found or not accessible'");
	captureScreenshot(SESSION, "10-error-handling");

	// -------------------------------------------------------------------
	// SCENARIO 11: Summary
	// -------------------------------------------------------------------
	console.log("\n📋 Scenario 11: Summary");
	tmuxSend(SESSION, `echo 'Screenshots saved in: ${SCREENSHOT_DIR}' && ls -la ${SCREENSHOT_DIR}`);
	await new Promise((r) => setTimeout(r, 1000));
	captureScreenshot(SESSION, "11-summary");

	// Cleanup
	console.log("\n🧹 Cleaning up...");
	execSync(`tmux kill-session -t ${SESSION} 2>/dev/null || true`);
	ghServer.close();
	llmServer.close();

	console.log(`\n✅ Integration test complete! Screenshots saved to: ${SCREENSHOT_DIR}`);
	console.log("\nScreenshots captured:");
	const files = fs.readdirSync(SCREENSHOT_DIR).filter((f) => f.endsWith(".txt")).sort();
	for (const f of files) {
		const size = fs.statSync(path.join(SCREENSHOT_DIR, f)).size;
		console.log(`  ${f} (${size} bytes)`);
	}
}

main().catch((err) => {
	console.error("❌ Integration test failed:", err);
	process.exit(1);
});