/**
 * Regression guard: wakeOn — per-monitor control over which events trigger
 * a turn.
 *
 * #106 made all monitor notifications informational: they never woke the
 * agent, so sessions sat idle through failing CI and merged PRs. Reverting
 * wholesale (everything steers) would bring back the noise #106 fixed.
 *
 * The design landed on here: notifications stay informational BY DEFAULT,
 * and each monitor takes a `wakeOn` list of event kinds (or ["*"]) whose
 * events wake the agent via pi.sendMessage(..., { deliverAs: "followUp",
 * triggerTurn: true }) — a single custom message that starts a turn when
 * the agent is idle and never interrupts mid-turn work. first-poll never
 * wakes (it is the initial state snapshot, not a change). Degraded-API
 * diagnostics keep their per-episode dedup and only wake when explicitly
 * listed. The deliberate PR/issue create-hook nudges keep their steer
 * delivery.
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

function shouldWakeBlock(): string {
	const start = src.indexOf("function shouldWake");
	const end = src.indexOf("function handleNotification", start);
	expect(start).toBeGreaterThan(-1);
	return src.slice(start, end);
}

describe("wakeOn configuration", () => {
	it("MonitorConfig carries wakeOn", () => {
		const keysSrc = fs.readFileSync(path.join(__dirname, "..", "src", "keys.ts"), "utf-8");
		expect(keysSrc).toMatch(/wakeOn\?: string\[\]/);
	});

	it("the tool start action accepts wakeOn and stores it on the monitor configs", () => {
		expect(src.match(/wakeOn: params\.wakeOn/g)?.length).toBeGreaterThanOrEqual(2); // PR/issue + run configs
		expect(src).toContain("wakeOn: Type.Optional(");
	});

	it("the tool documents wakeOn in its prompt guidelines", () => {
		expect(src).toContain("wakeOn=[");
	});
});

describe("shouldWake decides per event kind", () => {
	it("is false without wakeOn (informational default)", () => {
		const block = shouldWakeBlock();
		expect(block).toContain("if (!wakeOn || wakeOn.length === 0) return false;");
	});

	it("never wakes on first-poll (initial snapshot, not a change)", () => {
		const block = shouldWakeBlock();
		expect(block).toContain('if (type === "first-poll") return false;');
	});

	it('supports "*" and case-insensitive kind matching', () => {
		const block = shouldWakeBlock();
		expect(block).toContain('wakeOn.some((k) => k === "*" || k.toLowerCase() === type.toLowerCase())');
	});

	it("handleNotification computes wake via shouldWake and passes it to deliver()", () => {
		const start = src.indexOf("function handleNotification");
		const end = src.indexOf("/** Deliver now", start);
		const block = src.slice(start, end);
		expect(block).toContain("shouldWake(mon, n.type)");
		expect(block).toContain("deliver(concise, detailed, host, key, wake);");
	});
});

describe("delivery paths", () => {
	it("wake delivery is a single custom message with followUp + triggerTurn (never interrupts)", () => {
		const block = sendPRNotificationBlock();
		expect(block).toContain('options?.wake ? { deliverAs: "followUp", triggerTurn: true } : undefined');
		// The wake path must NOT go through sendUserMessage (which always
		// starts a turn and would duplicate the visible message).
		expect(block).toContain("pi.sendUserMessage(markdownDetailed, { deliverAs: delivery })");
		expect(block).toContain("if (!options?.displayOnly && delivery)");
	});

	it("default delivery is informational (plain custom message, display true)", () => {
		const block = sendPRNotificationBlock();
		expect(block).toContain('customType: "ghpr-monitor"');
		expect(block).toContain("display: !delivery || options?.displayOnly ? true : false");
	});

	it("deliver() queues with the wake flag and passes it through", () => {
		const start = src.indexOf("function deliver(");
		const end = src.indexOf("function handleExit", start);
		const block = src.slice(start, end);
		expect(block).toContain("queuedUpdates.push({ concise, detailed, host, monitorKey, wake });");
		expect(block).toContain("sendPRNotification(concise, detailed, { host, wake });");
	});

	it("turn_end flush preserves the wake flag", () => {
		const turnEndIdx = src.indexOf('pi.on("turn_end"');
		const flushIdx = src.indexOf("queuedUpdates.length > 0", turnEndIdx);
		const blockEnd = src.indexOf("queuedPrCreateNudges.length > 0", flushIdx);
		const block = src.slice(flushIdx, blockEnd);
		expect(block).toContain("sendPRNotification(u.concise, u.detailed, { host: u.host, wake: u.wake });");
	});

	it("forceCheck results wake (user-initiated check)", () => {
		const start = src.indexOf("async function forceCheck");
		const block = src.slice(start, start + 3000);
		expect(block).toContain("sendPRNotification(concise, detailed, { host: config.host, wake: true });");
	});

	it("first-poll remains TUI-only (no agent turn)", () => {
		const block = src.slice(
			src.indexOf("function handleNotification"),
			src.indexOf("/** Deliver now", src.indexOf("function handleNotification")),
		);
		expect(block).toContain('n.type === "first-poll"');
		expect(block).toContain("display: true");
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

describe("degraded events are deduped per episode", () => {
	function handleNotificationBlock(): string {
		const start = src.indexOf("function handleNotification");
		const end = src.indexOf("/** Deliver now", start);
		expect(start).toBeGreaterThan(-1);
		return src.slice(start, end);
	}

	it("handleNotification has a degraded-episode dedup branch", () => {
		const block = handleNotificationBlock();
		expect(block).toContain('n.type === "degraded"');
		expect(block).toContain("mon.lastDegradedSurface");
		expect(block).toContain("return;");
	});

	it("any non-degraded event ends a degraded episode", () => {
		const block = handleNotificationBlock();
		expect(block).toContain("mon.lastDegradedSurface = null;");
	});

	it("ActiveMonitor tracks the degraded surface (reset on creation)", () => {
		const monBlock = src.slice(
			src.indexOf("export interface ActiveMonitor"),
			src.indexOf("function createActiveMonitor"),
		);
		expect(monBlock).toContain("lastDegradedSurface");
		const createBlock = src.slice(
			src.indexOf("function createActiveMonitor"),
			src.indexOf("function commitOidOf"),
		);
		expect(createBlock).toContain("lastDegradedSurface: null");
	});

	it("Notification type carries degraded_surface", () => {
		const renderSrc = fs.readFileSync(path.join(__dirname, "..", "src", "render.ts"), "utf-8");
		const notifBlock = renderSrc.slice(
			renderSrc.indexOf("export interface Notification"),
			renderSrc.indexOf("formatFooterStatus"),
		);
		expect(notifBlock).toContain("degraded_surface?:");
		expect(notifBlock).toContain("degraded_message?:");
	});
});

describe("status display surfaces the wake configuration", () => {
	it("formatMonitorStatusLine shows the wakeOn kinds", () => {
		const renderSrc = fs.readFileSync(path.join(__dirname, "..", "src", "render.ts"), "utf-8");
		expect(renderSrc).toContain("config.wakeOn");
	});
});
