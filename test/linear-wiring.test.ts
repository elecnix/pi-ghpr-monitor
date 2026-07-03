/**
 * Structural tests for the Linear monitoring wiring in src/index.ts.
 *
 * White-box tests (mirroring code-structure.test.ts) that ensure the Linear
 * command, tool, renderer, and lifecycle hooks stay wired up. The behavioral
 * logic itself is covered by test/linear.test.ts and test/linear-monitor.test.ts.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const src = fs.readFileSync(path.join(__dirname, "..", "src", "index.ts"), "utf-8");

describe("Linear monitoring wiring", () => {
	it("constructs a LinearMonitorManager", () => {
		expect(src).toContain("new LinearMonitorManager(");
	});

	it("registers the /linear-monitor command", () => {
		expect(src).toContain('pi.registerCommand("linear-monitor"');
	});

	it("registers the linear-monitor tool", () => {
		expect(src).toContain('name: "linear-monitor"');
	});

	it("registers a message renderer for linear-monitor messages", () => {
		expect(src).toContain('pi.registerMessageRenderer<{ concise: string }>("linear-monitor"');
	});

	it("delivers Linear notifications via pi.sendUserMessage (agent context)", () => {
		const fnStart = src.indexOf("function sendLinearNotification(");
		expect(fnStart).toBeGreaterThan(-1);
		const fnBlock = src.slice(fnStart, fnStart + 600);
		expect(fnBlock).toContain("pi.sendUserMessage(");
		expect(fnBlock).toContain("customType: \"linear-monitor\"");
	});

	it("flushes queued Linear updates on turn_end", () => {
		const turnEndIdx = src.indexOf('pi.on("turn_end"');
		const turnEndBlock = src.slice(turnEndIdx, src.indexOf('pi.on("session_shutdown"'));
		expect(turnEndBlock).toContain("linearManager.flushQueued()");
	});

	it("stops all Linear monitors on session_shutdown", () => {
		const shutdownIdx = src.indexOf('pi.on("session_shutdown"');
		const shutdownBlock = src.slice(shutdownIdx, shutdownIdx + 400);
		expect(shutdownBlock).toContain("linearManager.stopAll()");
	});

	it("the linear-monitor tool exposes start/status/check but NOT stop", () => {
		const toolIdx = src.indexOf("const LinearMonitorParams");
		const toolBlock = src.slice(toolIdx, toolIdx + 400);
		expect(toolBlock).toContain('Type.Literal("start")');
		expect(toolBlock).toContain('Type.Literal("status")');
		expect(toolBlock).toContain('Type.Literal("check")');
		expect(toolBlock).not.toContain('Type.Literal("stop")');
	});

	it("reads the Linear API key from the LINEAR_API_KEY environment (via getLinearApiKey)", () => {
		expect(src).toContain("getApiKey: () => getLinearApiKey()");
	});
});
