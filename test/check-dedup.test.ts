/**
 * Tests for the /ghpr-monitor check duplicate-notification fix.
 *
 * Background: `ghpr-monitor check` (action='check' / /ghpr-monitor check) runs
 * `forceCheck`, which spawns a SEPARATE, stateless `gh monitor --once` process.
 * That fresh process emits `first-poll` and re-emits the current conditions
 * (e.g. `new-commit`) as if they were new changes — duplicating what the
 * persistent `gh monitor` (started at action='start') already emitted or will
 * emit. Without dedup, a single new commit produced TWO `new-commit`
 * notifications: one from `--once`, one from the persistent poll loop.
 *
 * index.ts cannot be imported under vitest (pi-tui import), so these are
 * source-validity-style assertions that the dedup logic is present and wired
 * into both delivery paths (handleNotification for the persistent loop, and
 * forceCheck for the one-shot check).
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const src = fs.readFileSync(
	path.join(__dirname, "..", "src", "index.ts"),
	"utf-8",
);

describe("check duplicate-notification dedup", () => {
	it("defines a commitOidOf helper that extracts the short OID", () => {
		expect(src).toContain("function commitOidOf");
		// Prefers commit_short_oid, falls back to parsing commit_url.
		expect(src).toMatch(/commitOidOf[\s\S]*commit_short_oid/);
		expect(src).toMatch(/commitOidOf[\s\S]*commit_url/);
	});

	it("handleNotification suppresses a new-commit already seen (lastCommitOid)", () => {
		const fnStart = src.indexOf("function handleNotification(");
		expect(fnStart).toBeGreaterThan(-1);
		const fnEnd = src.indexOf("\n\t}", fnStart);
		const fn = src.slice(fnStart, fnEnd);

		// Must check the new-commit type and bail out when the OID matches.
		expect(fn).toContain('"new-commit"');
		expect(fn).toContain("mon.state.lastCommitOid === oid");
		expect(fn).toContain("return;");
		// Must record the OID so the other path can dedup against it.
		expect(fn).toContain("mon.state.lastCommitOid = oid");
	});

	it("forceCheck skips first-poll events from the stateless --once process", () => {
		const fnStart = src.indexOf("async function forceCheck(");
		expect(fnStart).toBeGreaterThan(-1);
		const fnEnd = src.indexOf("\n\t}", fnStart);
		const fn = src.slice(fnStart, fnEnd);

		// first-poll from --once is redundant: the persistent monitor already
		// showed it at start. forceCheck must skip it.
		expect(fn).toContain('"first-poll"');
		expect(fn).toContain("continue;");
	});

	it("forceCheck dedups new-commit against the persistent monitor's lastCommitOid", () => {
		const fnStart = src.indexOf("async function forceCheck(");
		expect(fnStart).toBeGreaterThan(-1);
		const fnEnd = src.indexOf("\n\t}", fnStart);
		const fn = src.slice(fnStart, fnEnd);

		expect(fn).toContain('"new-commit"');
		expect(fn).toContain("mon.state.lastCommitOid === oid");
		expect(fn).toContain("continue;");
		// Records the OID so a later persistent poll loop event is suppressed.
		expect(fn).toContain("mon.state.lastCommitOid = oid");
	});

	it("MonitorState tracks lastCommitOid (shared dedup key)", () => {
		const renderSrc = fs.readFileSync(
			path.join(__dirname, "..", "src", "render.ts"),
			"utf-8",
		);
		expect(renderSrc).toContain("lastCommitOid: string | null");
		expect(renderSrc).toMatch(/emptyMonitorState[\s\S]*lastCommitOid: null/);
	});
});