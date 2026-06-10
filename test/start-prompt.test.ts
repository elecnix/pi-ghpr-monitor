/**
 * Unit tests for the !/start subcommand prompt injection feature.
 *
 * When the user invokes /ghpr-monitor ! or /ghpr-monitor start, a steering
 * prompt is injected via pi.sendUserMessage() telling the LLM to monitor the
 * current pull request. The LLM then determines which PR and invokes the
 * ghpr-monitor tool itself.
 *
 * When monitoring is started with an explicit PR URL or shorthand, NO steer
 * prompt is injected — only a TUI notification confirms the monitor started.
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

		// Find the end of the !/start handler block
		const nextSectionIdx = src.indexOf("// Parse: off", handlerIdx);
		expect(nextSectionIdx).toBeGreaterThan(-1);

		const handlerBlock = src.slice(handlerIdx, nextSectionIdx);
		expect(handlerBlock).toContain("pi.sendUserMessage");
		expect(handlerBlock).toContain("Monitor the current pull request");
		expect(handlerBlock).toContain('deliverAs: "steer"');
	});

	it("does NOT auto-detect the PR using gh pr view", () => {
		// The !/start handler should NOT call gh pr view — it just tells
		// the LLM to do it, and the LLM invokes the tool itself.
		expect(src).not.toContain("gh pr view");
	});

	it("does NOT call sendStartPrompt or startMonitor from the !/start handler", () => {
		const handlerIdx = src.indexOf('raw === "!" || raw.toLowerCase() === "start"');
		expect(handlerIdx).toBeGreaterThan(-1);

		const nextSectionIdx = src.indexOf("// Parse: off", handlerIdx);
		const handlerBlock = src.slice(handlerIdx, nextSectionIdx);

		expect(handlerBlock).not.toContain("sendStartPrompt");
		expect(handlerBlock).not.toContain("startMonitor(");
	});

	it("always injects the steer prompt via pi.sendUserMessage", () => {
		const handlerIdx = src.indexOf('raw === "!" || raw.toLowerCase() === "start"');
		expect(handlerIdx).toBeGreaterThan(-1);

		const nextSectionIdx = src.indexOf("// Parse: off", handlerIdx);
		const handlerBlock = src.slice(handlerIdx, nextSectionIdx);

		expect(handlerBlock).toContain("pi.sendUserMessage");
		expect(handlerBlock).toContain("Monitor the current pull request");
		expect(handlerBlock).toContain('deliverAs: "steer"');
	});
});

describe("explicit PR arguments do NOT inject steer prompt", () => {
	it("PR URL handler does NOT call sendStartPrompt", () => {
		const urlHandlerIdx = src.indexOf("// Try parsing as a PR URL first");
		expect(urlHandlerIdx).toBeGreaterThan(-1);
		const urlBlock = src.slice(urlHandlerIdx, src.indexOf("// Try parsing as \"owner/repo#number\""));
		expect(urlBlock).not.toContain("sendStartPrompt(config)");
	});

	it("shorthand handler does NOT call sendStartPrompt", () => {
		const shorthandIdx = src.indexOf("parsePRShorthand(raw)");
		expect(shorthandIdx).toBeGreaterThan(-1);
		const shorthandBlock = src.slice(shorthandIdx, src.indexOf("// Try parsing as \"owner/repo number"));
		expect(shorthandBlock).not.toContain("sendStartPrompt(config)");
	});

	it("owner/repo number handler does NOT call sendStartPrompt", () => {
		const ownerRepoIdx = src.indexOf("// Try parsing as \"owner/repo number [message]\"");
		expect(ownerRepoIdx).toBeGreaterThan(-1);
		const usageIdx = src.indexOf("Usage:", ownerRepoIdx);
		expect(usageIdx).toBeGreaterThan(-1);
		const ownerRepoBlock = src.slice(ownerRepoIdx, usageIdx);
		expect(ownerRepoBlock).not.toContain("sendStartPrompt(config)");
	});

	it("tool action=start handler does NOT call sendStartPrompt", () => {
		const toolStartIdx = src.indexOf('case "start": {');
		expect(toolStartIdx).toBeGreaterThan(-1);
		const toolStartBlock = src.slice(toolStartIdx, src.indexOf('case "status": {'));
		expect(toolStartBlock).not.toContain("sendStartPrompt(config)");
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
		// The "No PR monitors running" messages should mention !/start
		const hintIdx = src.indexOf("No PR monitors running");
		expect(hintIdx).toBeGreaterThan(-1);
		const hintText = src.slice(hintIdx, hintIdx + 200);
		expect(hintText).toMatch(/!/);
	});
});