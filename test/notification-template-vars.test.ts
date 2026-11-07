/**
 * Regression guards for the notification-template bugs reported against the
 * first-poll ack message:
 *
 * 1. `{pollMode}` — the gh-monitor default `first-poll` template is
 *    "📡 Monitoring {prLabel} ({pollMode})", so the adapter must document that
 *    token (with its sibling `{intervalSec}`) where the other template
 *    variables are documented. Otherwise a user editing templates, or the LLM
 *    writing one, has no way to know the token exists.
 *
 * 2. `/pull/` on issue monitors — the ack for an issue carries a bare
 *    `owner/repo#n` ref, and `linkifyPRRefs` used to expand every ref to
 *    `.../pull/<n>`, sending an issue monitor (e.g.
 *    patty-io/pi-patty-bg-tasks#32) to a /pull/ URL. The adapter must thread
 *    the monitor's resource kind from the config through to the linkifier.
 *
 * These are white-box structural tests over src/index.ts: the extension
 * factory needs a live Pi runtime, so the wiring is asserted at the source
 * level, the same way the other adapter tests (informational-notifications,
 * check-dedup) verify it. The linkifier's behavior itself is covered by
 * test/render.test.ts.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const src = fs.readFileSync(path.join(__dirname, "..", "src", "index.ts"), "utf-8");

function block(startMarker: string, endMarker: string): string {
	const start = src.indexOf(startMarker);
	const end = src.indexOf(endMarker, start + 1);
	expect(start).toBeGreaterThan(-1);
	expect(end).toBeGreaterThan(start);
	return src.slice(start, end);
}

describe("documented template variables", () => {
	it("lists {pollMode} and {intervalSec} alongside the other template variables", () => {
		const docLine = src.split("\n").find((line) => line.includes('"Template variables:'));
		expect(docLine).toBeDefined();
		expect(docLine).toContain("{prLabel}");
		expect(docLine).toContain("{pollMode}");
		expect(docLine).toContain("{intervalSec}");
	});
});

describe("issue monitors link bare refs to /issues/", () => {
	it("derives the ref kind from the monitor's resourceType", () => {
		const handle = block("function handleNotification", "function deliverFailingChecksWithLogs");
		expect(handle).toContain('const refKind = config.resourceType === "issue" ? "issue" : "pr";');
	});

	it("passes the ref kind to both linkifyPRRefs calls on the first-poll ack path", () => {
		const pollPath = block('if (n.type === "first-poll") {', "\t\t\treturn;");
		expect(pollPath).toContain('linkifyPRRefs(detailed, host, "markdown", refKind)');
		expect(pollPath).toContain('linkifyPRRefs(concise, host, "osc8", refKind)');
	});

	it("forwards the ref kind through deliver() and the mid-turn queue", () => {
		expect(src).toContain('sendPRNotification(concise, detailed, { host, refKind, wake });');
		expect(src).toContain("queuedUpdates.push({ concise, detailed, host, monitorKey, wake, refKind });");
		expect(src).toContain("sendPRNotification(u.concise, u.detailed, { host: u.host, refKind: u.refKind, wake: u.wake });");
	});

	it("makes sendPRNotification apply the ref kind to the markdown and osc8 renders", () => {
		const send = block("function sendPRNotification", "// Track agent turn state");
		expect(send).toContain("const refKind = options?.refKind ?? \"pr\";");
		expect(send).toContain('linkifyPRRefs(detailed, linkifyHost, "markdown", refKind)');
		expect(send).toContain('linkifyPRRefs(concise, linkifyHost, "osc8", refKind)');
	});
});
