/**
 * Regression guard: monitor notifications are INFORMATIONAL.
 *
 * pi.sendUserMessage() always triggers a new agent turn. Monitor status
 * notifications (new comments, CI changes, new commits, merge/close, ...)
 * must NOT wake the agent: they are delivered as a custom ghpr-monitor
 * message (TUI display via the concise renderer + full content appended to
 * the LLM history), so the agent sees them on its next turn without a turn
 * being started. Only the deliberate PR/issue create-hook nudges — and the
 * explicit user-initiated commands (/ghpr-monitor !, steer messages) — are
 * allowed to steer.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const src = fs.readFileSync(
	path.join(__dirname, "..", "src", "index.ts"),
	"utf-8",
);

function sendPRNotificationBlock(): string {
	const start = src.indexOf("function sendPRNotification");
	const end = src.indexOf("// Track agent turn state", start);
	expect(start).toBeGreaterThan(-1);
	return src.slice(start, end);
}

describe("monitor notifications are informational (no turn trigger)", () => {
	it("sendPRNotification defaults to no deliverAs (no sendUserMessage by default)", () => {
		const block = sendPRNotificationBlock();
		// Default delivery: informational custom message, no steer.
		expect(block).toMatch(/const delivery = options\?\.deliverAs;/);
		expect(block).not.toContain('deliverAs ?? "steer"');
	});

	it("sendUserMessage is only reachable via an explicit deliverAs option", () => {
		const block = sendPRNotificationBlock();
		expect(block).toContain("pi.sendMessage({");
		expect(block).toContain("if (!options?.displayOnly && delivery)");
		expect(block).toContain("pi.sendUserMessage(markdownDetailed, { deliverAs: delivery })");
	});

	it("default delivery displays in the TUI (display true)", () => {
		const block = sendPRNotificationBlock();
		expect(block).toContain("display: !delivery || options?.displayOnly ? true : false");
		expect(block).toContain('customType: "ghpr-monitor"');
	});

	it("deliver() sends monitor notifications without deliverAs", () => {
		const start = src.indexOf("function deliver(");
		const end = src.indexOf("function handleExit", start);
		const block = src.slice(start, end);
		expect(block).toContain("queuedUpdates.push");
		expect(block).toContain("sendPRNotification(concise, detailed, { host });");
		expect(block).not.toContain('deliverAs: "steer"');
	});

	it("turn_end flush of queued updates is informational", () => {
		const turnEndIdx = src.indexOf('pi.on("turn_end"');
		const flushIdx = src.indexOf("queuedUpdates.length > 0", turnEndIdx);
		const blockEnd = src.indexOf("queuedPrCreateNudges.length > 0", flushIdx);
		const block = src.slice(flushIdx, blockEnd);
		expect(block).toContain("sendPRNotification(u.concise, u.detailed, { host: u.host });");
		expect(block).not.toContain('deliverAs: "steer"');
	});

	it("forceCheck one-shot results are informational", () => {
		const start = src.indexOf("async function forceCheck");
		const block = src.slice(start, start + 2500);
		expect(block).toContain("sendPRNotification(concise, detailed, { host: config.host });");
		expect(block).not.toContain('deliverAs: "steer"');
	});

	it("create-hook nudges keep their deliberate steer delivery", () => {
		const turnEndIdx = src.indexOf('pi.on("turn_end"');
		const block = src.slice(turnEndIdx, turnEndIdx + 1200);
		const nudgeFlushes = block.match(/sendPRNotification\(nudge\.message, nudge\.message, \{ deliverAs: "steer", host: nudge\.host \}\)/g);
		expect(nudgeFlushes).not.toBeNull();
		expect(nudgeFlushes!.length).toBe(2); // PR + issue create hooks
	});

	it("status subcommand uses nextTurn (existing no-turn pattern)", () => {
		const statusBlock = src.slice(
			src.indexOf('raw.toLowerCase() === "status"'),
			src.indexOf('raw.toLowerCase() === "check"'),
		);
		expect(statusBlock).toContain('deliverAs: "nextTurn"');
		expect(statusBlock).not.toContain("pi.sendUserMessage");
	});
});
