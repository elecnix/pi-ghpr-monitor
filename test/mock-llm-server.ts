/**
 * Fake OpenAI Chat Completions API server for testing pi-ghpr-monitor
 *
 * Simulates an LLM that:
 * 1. Receives messages from Pi
 * 2. Decides when to call ghpr-monitor tool
 * 3. Responds to PR status updates
 *
 * Start with: npx tsx test/mock-llm-server.ts [port]
 * Default port: 9701
 *
 * This server also serves as a test orchestrator — it receives webhooks
 * for monitoring notifications and can be queried for test state.
 */

import * as http from "node:http";

export interface MockLLMConfig {
	port: number;
	/** Delay in ms before responding (simulates thinking) */
	responseDelay: number;
	/** Whether to auto-start the ghpr-monitor tool on first prompt */
	autoStart: boolean;
}

const DEFAULT_CONFIG: MockLLMConfig = {
	port: 9701,
	responseDelay: 200,
	autoStart: true,
};

// Track what messages the LLM has "seen"
interface SeenMessage {
	role: string;
	content: string | null;
	toolCalls?: unknown[];
}

const seenMessages: SeenMessage[] = [];
let monitorStarted = false;

function buildResponse(messages: SeenMessage[]): object {
	const lastUserMsg = messages.filter((m) => m.role === "user").pop();
	const lastUserContent = typeof lastUserMsg?.content === "string" ? lastUserMsg.content : "";

	// If the LLM sees a ghpr-monitor notification, respond appropriately
	if (lastUserContent.includes("[ghpr-monitor]")) {
		return {
			id: `chatcmpl-${Date.now()}`,
			object: "chat.completion",
			created: Math.floor(Date.now() / 1000),
			model: "mock-llm",
			choices: [
				{
					index: 0,
					message: {
						role: "assistant",
						content: `I see the PR monitor update. Let me address the issues:\n\n${lastUserContent}`,
					},
					finish_reason: "stop",
				},
			],
			usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
		};
	}

	// If first prompt and autoStart, call the ghpr-monitor tool
	if (!monitorStarted && DEFAULT_CONFIG.autoStart && lastUserContent.toLowerCase().includes("monitor")) {
		monitorStarted = true;
		return {
			id: `chatcmpl-${Date.now()}`,
			object: "chat.completion",
			created: Math.floor(Date.now() / 1000),
			model: "mock-llm",
			choices: [
				{
					index: 0,
					message: {
						role: "assistant",
						content: null,
						tool_calls: [
							{
								id: `call_${Date.now()}`,
								type: "function",
								function: {
									name: "ghpr-monitor",
									arguments: JSON.stringify({
										action: "start",
										owner: "v2nic",
										repo: "gh-pr-review",
										pr_number: 42,
										mode: "all",
										interval: 5,
									}),
								},
							},
						],
					},
					finish_reason: "tool_calls",
				},
			],
			usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
		};
	}

	// Default response
	return {
		id: `chatcmpl-${Date.now()}`,
		object: "chat.completion",
		created: Math.floor(Date.now() / 1000),
		model: "mock-llm",
		choices: [
			{
				index: 0,
				message: {
					role: "assistant",
					content: "I understand. I'm ready to help monitor PRs.",
				},
				finish_reason: "stop",
			},
		],
		usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
	};
}

export function createMockLLMServer(port: number = 9701): http.Server {
	const config = { ...DEFAULT_CONFIG, port };
	monitorStarted = false;
	seenMessages.length = 0;

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

		if (req.method === "OPTIONS") {
			res.writeHead(204, {
				"Access-Control-Allow-Origin": "*",
				"Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
				"Access-Control-Allow-Headers": "Content-Type, Authorization",
			});
			res.end();
			return;
		}

		const url = new URL(req.url || "/", `http://localhost:${port}`);

		switch (`${req.method} ${url.pathname}`) {
			// OpenAI-compatible chat completions
			case "POST /v1/chat/completions": {
				readBody().then((body) => {
					try {
						const parsed = JSON.parse(body);
						const messages = parsed.messages || [];
						for (const msg of messages) {
							seenMessages.push({
								role: msg.role,
								content: msg.content,
								toolCalls: msg.tool_calls,
							});
						}
						const response = buildResponse(messages);
						setTimeout(() => sendJSON(200, response), config.responseDelay);
					} catch (err) {
						sendJSON(400, { error: { message: "Invalid JSON" } });
					}
				});
				return;
			}

			// Models list (for provider discovery)
			case "GET /v1/models": {
				sendJSON(200, {
					object: "list",
					data: [
						{
							id: "mock-llm",
							object: "model",
							created: Math.floor(Date.now() / 1000),
							owned_by: "test",
						},
					],
				});
				return;
			}

			// Test inspection endpoints
			case "GET /test/messages": {
				sendJSON(200, seenMessages);
				return;
			}

			case "POST /test/reset": {
				seenMessages.length = 0;
				monitorStarted = false;
				sendJSON(200, { status: "ok" });
				return;
			}

			default:
				sendJSON(404, { error: { message: "Not found" } });
		}
	});

	server.listen(config.port, () => {
		console.log(`[mock-llm] Listening on http://localhost:${config.port}`);
		console.log(`[mock-llm] Chat:  POST http://localhost:${config.port}/v1/chat/completions`);
		console.log(`[mock-llm] Models: GET http://localhost:${config.port}/v1/models`);
		console.log(`[mock-llm] Messages: GET http://localhost:${config.port}/test/messages`);
		console.log(`[mock-llm] Reset:  POST http://localhost:${config.port}/test/reset`);
	});

	return server;
}

// Run if executed directly
if (require.main === module || process.argv[1]?.includes("mock-llm-server")) {
	const port = parseInt(process.argv[2] || "9701", 10);
	createMockLLMServer(port);
}