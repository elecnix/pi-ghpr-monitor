/**
 * Unit tests for the /ghpr-monitor no-args steering message feature.
 *
 * When /ghpr-monitor is invoked without arguments (or with just "on") and
 * no monitor is running, the extension sends a steering message to the agent
 * asking it to invoke the ghpr-monitor tool with the proper parameters,
 * rather than showing a usage error.
 *
 * Updated for multi-PR monitoring architecture.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const src = fs.readFileSync(
	path.join(__dirname, "..", "src", "index.ts"),
	"utf-8",
);

describe("no-args steering message feature", () => {
	it("sends a steering message via pi.sendUserMessage when no args and no monitor running", () => {
		// Find the block that handles "on" or empty args
		const onBlockStart = src.indexOf('if (raw.toLowerCase() === "on" || raw === "")');
		expect(onBlockStart).toBeGreaterThan(-1);

		// The "no monitors running" branch sends a steering message
		const steerIdx = src.indexOf("The user wants to start PR monitoring", onBlockStart);
		expect(steerIdx).toBeGreaterThan(-1);

		// It must use pi.sendUserMessage with deliverAs: "steer"
		const steerBlock = src.slice(steerIdx - 200, steerIdx + 300);
		expect(steerBlock).toContain("pi.sendUserMessage");
		expect(steerBlock).toContain('deliverAs: "steer"');
	});

	it("steering message mentions ghpr-monitor tool with action='start'", () => {
		const steerIdx = src.indexOf("The user wants to start PR monitoring");
		expect(steerIdx).toBeGreaterThan(-1);
		const msgBlock = src.slice(steerIdx, steerIdx + 300);
		expect(msgBlock).toContain("ghpr-monitor");
		expect(msgBlock).toContain("action='start'");
		expect(msgBlock).toContain("url");
	});

	it("shows status when monitors are already running and no args given", () => {
		const onBlockStart = src.indexOf('if (raw.toLowerCase() === "on" || raw === "")');
		expect(onBlockStart).toBeGreaterThan(-1);

		// The "already monitoring" branch must show current status
		const runningBranch = src.slice(
			src.indexOf("if (monitors.size > 0)", onBlockStart),
			src.indexOf("pi.sendUserMessage", onBlockStart),
		);
		expect(runningBranch).toContain("formatCurrentStatus()");
		expect(runningBranch).toContain("ctx.ui.notify(statusText");
	});

	it("does not show usage error for empty args when no monitor is running", () => {
		const steerMsg = src.indexOf("The user wants to start PR monitoring");
		expect(steerMsg).toBeGreaterThan(-1);
		// The steer message path uses pi.sendUserMessage, not ctx.ui.notify with usage text
		const steerBlock = src.slice(steerMsg - 100, steerMsg + 300);
		expect(steerBlock).toContain("pi.sendUserMessage");
		expect(steerBlock).not.toContain("Usage:");
	});

	it("command description mentions no-args capability", () => {
		// The description should indicate that args are optional or leave blank works
		const descMatch = src.match(/description:\s*"Monitor[^"]*"/);
		expect(descMatch).not.toBeNull();
		// Should mention check and off, which implies args are optional
		expect(descMatch![0]).toContain("leave blank");
	});

	it("header comment documents no-args behavior", () => {
		const headerComment = src.slice(0, src.indexOf("// -----------") > 0 ? src.indexOf("// -----------") : 2000);
		expect(headerComment).toContain("no args = ask agent");
	});
});

describe("no-args branch does not regress other command handlers", () => {
	it("check command still works with per-monitor forceNotify", () => {
		expect(src).toContain("mon.forceNotify = true");
		expect(src).toContain("ctx.ui.notify");
	});

	it("off command still works with stopAllMonitors and stopMonitorByKey", () => {
		expect(src).toContain("stopAllMonitors()");
		expect(src).toContain("stopMonitorByKey");
	});

	it("URL/shorthand parsing is still present after no-args block", () => {
		const afterNoArgs = src.slice(src.indexOf("// Try parsing as a PR URL first"));
		expect(afterNoArgs).toContain("parsePRUrl");
		expect(afterNoArgs).toContain("parsePRShorthand");
	});
});