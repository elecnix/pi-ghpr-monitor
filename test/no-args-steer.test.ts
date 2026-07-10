/**
 * Unit tests for the /ghpr-monitor no-args behavior and status subcommand.
 *
 * When /ghpr-monitor is invoked without arguments (or with just "on"):
 * - If monitors are running, shows current status via ctx.ui.notify
 * - If no monitors are running, shows a usage hint via ctx.ui.notify (no steer, no agent turn)
 *
 * The /ghpr-monitor status subcommand displays PR status to both the TUI
 * and the LLM context without triggering an agent turn, using pi.sendMessage
 * with deliverAs: "nextTurn" (like !command behavior).
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const src = fs.readFileSync(
	path.join(__dirname, "..", "src", "index.ts"),
	"utf-8",
);

describe("no-args behavior without steer message", () => {
	it("shows usage via ctx.ui.notify when no args and no monitor running", () => {
		const onBlockStart = src.indexOf('if (raw.toLowerCase() === "on" || raw === "")');
		expect(onBlockStart).toBeGreaterThan(-1);

		// Up to the next command branch (the issue URL handler).
		const onBlock = src.slice(onBlockStart, src.indexOf("// Issue URL", onBlockStart));

		// Must NOT send a steering message
		expect(onBlock).not.toContain("pi.sendUserMessage");
		// Must use ctx.ui.notify for UI-only display
		expect(onBlock).toContain("ctx.ui.notify");
	});

	it("does not send a steering message mentioning action='start'", () => {
		expect(src.indexOf("The user wants to start PR monitoring")).toBe(-1);
	});

	it("shows status when monitors are already running and no args given", () => {
		const onBlockStart = src.indexOf('if (raw.toLowerCase() === "on" || raw === "")');
		expect(onBlockStart).toBeGreaterThan(-1);
		const onBlock = src.slice(onBlockStart, src.indexOf("// Issue URL", onBlockStart));

		const monitorsCheckStart = src.indexOf("if (monitors.size > 0)", onBlockStart);
		expect(monitorsCheckStart).toBeGreaterThan(-1);

		// The "already monitoring" branch must show current status
		expect(onBlock).toContain("formatCurrentStatus()");
		expect(onBlock).toContain('ctx.ui.notify(formatCurrentStatus()');
	});

	it("shows a usage hint when no monitor is running (not an error)", () => {
		const onBlockStart = src.indexOf('if (raw.toLowerCase() === "on" || raw === "")');
		expect(onBlockStart).toBeGreaterThan(-1);
		const onBlock = src.slice(onBlockStart, src.indexOf("// Issue URL", onBlockStart));

		expect(onBlock).toContain("No PR monitors running");
		expect(onBlock).toContain("ctx.ui.notify");
		// Should NOT be an error or warning — just info
		expect(onBlock).toContain('"info"');
	});

	it("command description mentions status/usage capability", () => {
		const descMatch = src.match(/description:\s*"Monitor[^"]*"/);
		expect(descMatch).not.toBeNull();
		expect(descMatch![0]).toContain("status/usage");
	});
});

describe("/ghpr-monitor status subcommand", () => {
	it("recognizes 'status' as a subcommand", () => {
		expect(src).toContain('raw.toLowerCase() === "status"');
	});

	it("has 'status' in command completions", () => {
		const completionsIdx = src.indexOf("getArgumentCompletions");
		expect(completionsIdx).toBeGreaterThan(-1);
		const completionsBlock = src.slice(completionsIdx, completionsIdx + 400);
		expect(completionsBlock).toContain('"status"');
	});

	it("uses pi.sendMessage with deliverAs 'nextTurn' to avoid triggering a turn", () => {
		const statusBlock = src.slice(
			src.indexOf('raw.toLowerCase() === "status"'),
			src.indexOf('raw.toLowerCase() === "check"'),
		);
		expect(statusBlock).toContain("pi.sendMessage");
		expect(statusBlock).toContain('"nextTurn"');
		// Must NOT use pi.sendUserMessage (which always triggers a turn)
		expect(statusBlock).not.toContain("pi.sendUserMessage");
	});

	it("uses display true for TUI rendering", () => {
		const statusBlock = src.slice(
			src.indexOf('raw.toLowerCase() === "status"'),
			src.indexOf('raw.toLowerCase() === "check"'),
		);
		expect(statusBlock).toContain("display: true");
	});

	it("uses the registered ghpr-monitor message renderer", () => {
		const statusBlock = src.slice(
			src.indexOf('raw.toLowerCase() === "status"'),
			src.indexOf('raw.toLowerCase() === "check"'),
		);
		expect(statusBlock).toContain('customType: "ghpr-monitor"');
	});

	it("shows usage hint when no monitors are running", () => {
		const statusBlock = src.slice(
			src.indexOf('raw.toLowerCase() === "status"'),
			src.indexOf('raw.toLowerCase() === "check"'),
		);
		expect(statusBlock).toContain("No PR monitors running");
		expect(statusBlock).toContain("ctx.ui.notify");
	});

	it("uses shared buildDetailedStatusLines helper (no duplication)", () => {
		expect(src).toContain("function buildDetailedStatusLines()");
		const statusCmdBlock = src.slice(
			src.indexOf('raw.toLowerCase() === "status"'),
			src.indexOf('raw.toLowerCase() === "check"'),
		);
		expect(statusCmdBlock).toContain("buildDetailedStatusLines()");
		const toolStatusIdx = src.indexOf('case "status"');
		const toolStatusBlock = src.slice(toolStatusIdx, toolStatusIdx + 500);
		expect(toolStatusBlock).toContain("buildDetailedStatusLines()");
	});

	it("includes concise status for the TUI message renderer", () => {
		const statusBlock = src.slice(
			src.indexOf('raw.toLowerCase() === "status"'),
			src.indexOf('raw.toLowerCase() === "check"'),
		);
		expect(statusBlock).toContain("conciseStatus");
		expect(statusBlock).toContain("concise:");
	});
});

describe("no-args branch does not regress other command handlers", () => {
	it("check command still works via forceCheck", () => {
		expect(src).toContain("forceCheck");
		expect(src).toContain("ctx.ui.notify");
	});

	it("off command still works with stopAllMonitors and stopMonitorByKey", () => {
		expect(src).toContain("stopAllMonitors()");
		expect(src).toContain("stopMonitorByKey");
	});

	it("URL/shorthand parsing is still present after no-args block", () => {
		const afterNoArgs = src.slice(src.indexOf("// Issue URL"));
		expect(afterNoArgs).toContain("parsePRUrl");
		expect(afterNoArgs).toContain("parsePRShorthand");
	});
});