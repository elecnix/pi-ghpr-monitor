/**
 * Unit tests for the !/start subcommand prompt injection feature.
 *
 * When the user invokes /ghpr-monitor ! or /ghpr-monitor start, a steering
 * prompt is injected via pi.sendUserMessage() telling the LLM to monitor the
 * current pull request. The LLM then determines which PR and invokes the
 * ghpr-monitor tool itself.
 *
 * When monitoring is started with an explicit PR URL or shorthand, NO
 * "monitor the current PR" steer prompt is injected — only a TUI notification
 * confirms the monitor started (an optional user message after the URL is
 * forwarded, but that is user-supplied text, not the auto steer).
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const src = fs.readFileSync(
	path.join(__dirname, "..", "src", "index.ts"),
	"utf-8",
);

describe("!/start subcommand injects steer prompt", () => {
	it("handles ! and start subcommands in the command handler", () => {
		expect(src).toContain('raw === "!" || raw.toLowerCase() === "start"');
	});

	it("injects a steer prompt telling the LLM to monitor the current PR", () => {
		const handlerIdx = src.indexOf('raw === "!" || raw.toLowerCase() === "start"');
		expect(handlerIdx).toBeGreaterThan(-1);

		// The next branch in the command handler is the debug toggle.
		const nextSectionIdx = src.indexOf('if (raw.toLowerCase() === "debug")', handlerIdx);
		expect(nextSectionIdx).toBeGreaterThan(-1);

		const handlerBlock = src.slice(handlerIdx, nextSectionIdx);
		expect(handlerBlock).toContain("pi.sendUserMessage");
		expect(handlerBlock).toContain("Monitor the current pull request");
		expect(handlerBlock).toContain('deliverAs: "steer"');
	});

	it("does NOT auto-detect the PR using gh pr view", () => {
		expect(src).not.toContain("gh pr view");
	});

	it("does NOT call sendStartPrompt or startMonitor from the !/start handler", () => {
		const handlerIdx = src.indexOf('raw === "!" || raw.toLowerCase() === "start"');
		expect(handlerIdx).toBeGreaterThan(-1);
		const nextSectionIdx = src.indexOf('if (raw.toLowerCase() === "debug")', handlerIdx);
		const handlerBlock = src.slice(handlerIdx, nextSectionIdx);

		expect(handlerBlock).not.toContain("sendStartPrompt");
		expect(handlerBlock).not.toContain("startMonitor(");
	});
});

describe("explicit PR arguments do NOT inject the 'monitor current PR' steer", () => {
	it("PR URL handler does NOT inject the current-PR steer", () => {
		const urlHandlerIdx = src.indexOf("// PR URL");
		expect(urlHandlerIdx).toBeGreaterThan(-1);
		const urlBlock = src.slice(urlHandlerIdx, src.indexOf("// Shorthand owner/repo#123"));
		expect(urlBlock).not.toContain("Monitor the current pull request");
		expect(urlBlock).not.toContain("sendStartPrompt");
	});

	it("shorthand handler does NOT inject the current-PR steer", () => {
		const shorthandIdx = src.indexOf("// Shorthand owner/repo#123");
		expect(shorthandIdx).toBeGreaterThan(-1);
		const shorthandBlock = src.slice(shorthandIdx, src.indexOf("// owner/repo <number> [message]"));
		expect(shorthandBlock).not.toContain("Monitor the current pull request");
		expect(shorthandBlock).not.toContain("sendStartPrompt");
	});

	it("owner/repo number handler does NOT inject the current-PR steer", () => {
		const ownerRepoIdx = src.indexOf("// owner/repo <number> [message]");
		expect(ownerRepoIdx).toBeGreaterThan(-1);
		const usageIdx = src.indexOf("Usage:", ownerRepoIdx);
		expect(usageIdx).toBeGreaterThan(-1);
		const ownerRepoBlock = src.slice(ownerRepoIdx, usageIdx);
		expect(ownerRepoBlock).not.toContain("Monitor the current pull request");
		expect(ownerRepoBlock).not.toContain("sendStartPrompt");
	});

	it("tool action=start handler does NOT inject the current-PR steer", () => {
		const toolStartIdx = src.indexOf('case "start": {');
		expect(toolStartIdx).toBeGreaterThan(-1);
		const toolStartBlock = src.slice(toolStartIdx, src.indexOf('case "status": {'));
		expect(toolStartBlock).not.toContain("Monitor the current pull request");
		expect(toolStartBlock).not.toContain("sendStartPrompt");
	});
});

describe("sendStartPrompt function has been removed", () => {
	it("no sendStartPrompt function definition exists", () => {
		expect(src).not.toContain("function sendStartPrompt(");
	});
});

describe("!/start subcommand completions and usage", () => {
	it("! and start are in the argument completions", () => {
		const completionsIdx = src.indexOf("getArgumentCompletions");
		expect(completionsIdx).toBeGreaterThan(-1);
		const completionsBlock = src.slice(completionsIdx, completionsIdx + 400);
		expect(completionsBlock).toContain('"!"');
		expect(completionsBlock).toContain('"start"');
	});

	it("usage message mentions ! and start subcommands", () => {
		const usageIdx = src.indexOf("Usage:");
		expect(usageIdx).toBeGreaterThan(-1);
		const usageBlock = src.slice(usageIdx, usageIdx + 400);
		expect(usageBlock).toContain("/ghpr-monitor !");
		expect(usageBlock).toContain("start");
	});

	it("no-PR hint mentions !/start for starting", () => {
		const hintIdx = src.indexOf("No PR monitors running");
		expect(hintIdx).toBeGreaterThan(-1);
		const hintText = src.slice(hintIdx, hintIdx + 200);
		expect(hintText).toMatch(/!/);
	});
});