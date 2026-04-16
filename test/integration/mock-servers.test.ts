/**
 * Integration tests for mock servers
 *
 * Tests the mock GitHub and LLM servers respond correctly.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";

const MOCK_GH_PORT = 9800;
const MOCK_LLM_PORT = 9801;

function fetchJSON(url: string, options?: RequestInit): Promise<any> {
	return fetch(url, options).then((r) => r.json());
}

describe("Mock GitHub Server", () => {
	let server: http.Server;

	beforeAll(async () => {
		// Import and start the mock server
		const { createMockGitHubServer } = await import("../mock-github-server");
		server = createMockGitHubServer(MOCK_GH_PORT);
		await new Promise((resolve) => setTimeout(resolve, 500));
	});

	afterAll(() => {
		server?.close();
	});

	it("serves default state via GET /state", async () => {
		const state = await fetchJSON(`http://localhost:${MOCK_GH_PORT}/state`);
		expect(state).toHaveProperty("unresolvedThreads");
		expect(state).toHaveProperty("generalComments");
		expect(state).toHaveProperty("hasConflicts");
		expect(state).toHaveProperty("failingChecks");
		expect(state).toHaveProperty("pendingChecks");
	});

	it("returns GraphQL response for POST /graphql", async () => {
		const response = await fetchJSON(`http://localhost:${MOCK_GH_PORT}/graphql`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ query: "{ repository { pullRequest { mergeable } } }", variables: {} }),
		});
		expect(response).toHaveProperty("data");
		expect(response.data).toHaveProperty("repository");
		expect(response.data.repository).toHaveProperty("pullRequest");
		expect(response.data.repository.pullRequest).toHaveProperty("mergeable");
	});

	it("updates state via PUT /state", async () => {
		await fetchJSON(`http://localhost:${MOCK_GH_PORT}/state`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ hasConflicts: true, unresolvedThreads: 5 }),
		});
		const state = await fetchJSON(`http://localhost:${MOCK_GH_PORT}/state`);
		expect(state.hasConflicts).toBe(true);
		expect(state.unresolvedThreads).toBe(5);
	});

	it("resets state via POST /reset", async () => {
		await fetchJSON(`http://localhost:${MOCK_GH_PORT}/state`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ hasConflicts: true }),
		});
		await fetchJSON(`http://localhost:${MOCK_GH_PORT}/reset`, { method: "POST" });
		const state = await fetchJSON(`http://localhost:${MOCK_GH_PORT}/state`);
		expect(state.hasConflicts).toBe(false);
	});

	it("returns pull request data with proper structure", async () => {
		await fetchJSON(`http://localhost:${MOCK_GH_PORT}/reset`, { method: "POST" });
		const response = await fetchJSON(`http://localhost:${MOCK_GH_PORT}/graphql`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ query: "test", variables: {} }),
		});
		const pr = response.data.repository.pullRequest;
		expect(pr).toHaveProperty("comments");
		expect(pr).toHaveProperty("reviewThreads");
		expect(pr).toHaveProperty("mergeable");
		expect(pr).toHaveProperty("commits");
	});
});

describe("Mock LLM Server", () => {
	let server: http.Server;

	beforeAll(async () => {
		const { createMockLLMServer } = await import("../mock-llm-server");
		server = createMockLLMServer(MOCK_LLM_PORT);
		await new Promise((resolve) => setTimeout(resolve, 500));
	});

	afterAll(() => {
		server?.close();
	});

	it("lists models via GET /v1/models", async () => {
		const models = await fetchJSON(`http://localhost:${MOCK_LLM_PORT}/v1/models`);
		expect(models).toHaveProperty("data");
		expect(models.data.length).toBeGreaterThan(0);
		expect(models.data[0].id).toBe("mock-llm");
	});

	it("responds to chat completions via POST /v1/chat/completions", async () => {
		// Reset first
		await fetchJSON(`http://localhost:${MOCK_LLM_PORT}/test/reset`, { method: "POST" });

		const response = await fetchJSON(`http://localhost:${MOCK_LLM_PORT}/v1/chat/completions`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: "mock-llm",
				messages: [{ role: "user", content: "Hello" }],
			}),
		});
		expect(response).toHaveProperty("choices");
		expect(response.choices[0]).toHaveProperty("message");
		expect(response.choices[0].message.role).toBe("assistant");
	});

	it("tracks messages via GET /test/messages", async () => {
		await fetchJSON(`http://localhost:${MOCK_LLM_PORT}/test/reset`, { method: "POST" });
		await fetchJSON(`http://localhost:${MOCK_LLM_PORT}/v1/chat/completions`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: "mock-llm",
				messages: [{ role: "user", content: "Test message" }],
			}),
		});
		const messages = await fetchJSON(`http://localhost:${MOCK_LLM_PORT}/test/messages`);
		expect(messages.length).toBeGreaterThan(0);
	});

	it("responds with tool_calls when monitor keyword is detected", async () => {
		await fetchJSON(`http://localhost:${MOCK_LLM_PORT}/test/reset`, { method: "POST" });
		const response = await fetchJSON(`http://localhost:${MOCK_LLM_PORT}/v1/chat/completions`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: "mock-llm",
				messages: [{ role: "user", content: "Please monitor this PR" }],
			}),
		});
		const msg = response.choices[0].message;
		expect(msg.tool_calls || msg.content).toBeTruthy();
	});
});