/**
 * Unit tests for the /ghpr-monitor no-args behavior and status subcommand.
 *
 * When /ghpr-monitor is invoked without arguments (or with just "on"):
 * - If monitors are running, shows current status via ctx.ui.notify
 * - If no monitors are running, sends a steer message to the agent
 *   (this PR only adds the status subcommand; removing the steer is #41)
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

describe("no-args behavior", () => {
	it("shows status when monitors are already running and no args given", () => {
		const onBlockStart = src.indexOf('if (raw.toLowerCase() === "on" || raw === "")');
		expect(onBlockStart).toBeGreaterThan(-1);

		const runningBranch = src.slice(
			src.indexOf("if (monitors.size > 0)", onBlockStart),
			src.indexOf("pi.sendUserMessage", onBlockStart),
		);
		expect(runningBranch).toContain("formatCurrentStatus()");
		expect(runningBranch).toContain("ctx.ui.notify(statusText");
	});

	it("sends steer message when no monitors running (to be replaced by #41)", () => {
		// This PR (#40) does not change the no-monitors steer behavior;
		// that's covered by #41. Verify the steer message still exists.
		const onBlockStart = src.indexOf('if (raw.toLowerCase() === "on" || raw === "")');
		expect(onBlockStart).toBeGreaterThan(-1);
		const onBlock = src.slice(onBlockStart, onBlockStart + 1200);
		expect(onBlock).toContain("pi.sendUserMessage");
	});

	it("command description mentions status subcommand", () => {
		const descMatch = src.match(/description:\s*"Monitor[^"]*"/);
		expect(descMatch).not.toBeNull();
		expect(descMatch![0]).toContain("/ghpr-monitor status");
	});

	it("header comment documents no-args and status behavior", () => {
		const headerComment = src.slice(0, src.indexOf("// -----------") > 0 ? src.indexOf("// -----------") : 2000);
		expect(headerComment).toContain("status");
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
			src.indexOf("// Parse: check [PR identifier]"),
		);
		expect(statusBlock).toContain("pi.sendMessage");
		expect(statusBlock).toContain('"nextTurn"');
		// Must NOT use pi.sendUserMessage (which always triggers a turn)
		expect(statusBlock).not.toContain("pi.sendUserMessage");
	});

	it("uses display true for TUI rendering", () => {
		const statusBlock = src.slice(
			src.indexOf('raw.toLowerCase() === "status"'),
			src.indexOf("// Parse: check [PR identifier]"),
		);
		expect(statusBlock).toContain("display: true");
	});

	it("uses the registered ghpr-monitor message renderer", () => {
		const statusBlock = src.slice(
			src.indexOf('raw.toLowerCase() === "status"'),
			src.indexOf("// Parse: check [PR identifier]"),
		);
		expect(statusBlock).toContain('customType: "ghpr-monitor"');
	});

	it("shows usage hint when no monitors are running", () => {
		const statusBlock = src.slice(
			src.indexOf('raw.toLowerCase() === "status"'),
			src.indexOf("// Parse: check [PR identifier]"),
		);
		expect(statusBlock).toContain("No PR monitors running");
		expect(statusBlock).toContain("ctx.ui.notify");
	});

	it("uses shared buildDetailedStatusLines helper (no duplication)", () => {
		// The shared helper should exist and be used by both the command
		// handler and the tool action='status'
		expect(src).toContain("function buildDetailedStatusLines()");
		// The command handler should call the helper
		const statusCmdBlock = src.slice(
			src.indexOf('raw.toLowerCase() === "status"'),
			src.indexOf("// Parse: check [PR identifier]"),
		);
		expect(statusCmdBlock).toContain("buildDetailedStatusLines()");
		// The tool action='status' should also call the helper
		const toolStatusIdx = src.indexOf('case "status"');
		const toolStatusBlock = src.slice(toolStatusIdx, toolStatusIdx + 500);
		expect(toolStatusBlock).toContain("buildDetailedStatusLines()");
	});

	it("includes concise status for the TUI message renderer", () => {
		const statusBlock = src.slice(
			src.indexOf('raw.toLowerCase() === "status"'),
			src.indexOf("// Parse: check [PR identifier]"),
		);
		expect(statusBlock).toContain("conciseStatus");
		expect(statusBlock).toContain("concise:");
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