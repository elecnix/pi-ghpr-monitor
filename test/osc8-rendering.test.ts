/**
 * Regression guard for OSC 8 hyperlink rendering (issue: triplicated URLs).
 *
 * The bug: pi delivers PR notifications through TWO renderers:
 *   - pi.sendUserMessage()  -> UserMessageComponent -> pi-tui Markdown component
 *   - pi.sendMessage()      -> ghpr-monitor renderer -> pi-tui Text component
 *
 * The Markdown component re-linkifies URLs embedded inside raw OSC 8 escape
 * sequences (its autolink detection finds the href URL between \x1b]8;; and
 * \x1b\\ and wraps it again), producing doubled/tripled output. The Text
 * component handles raw OSC 8 correctly.
 *
 * The fix: linkifyPRRefs(text, host, "markdown") emits markdown link syntax
 * `[display](url)` for the UserMessage/Markdown path, and the default
 * "osc8" format emits raw OSC 8 for the Text/footer path. Both must render to
 * a SINGLE clickable hyperlink (URL + display each appear exactly once),
 * whether or not the terminal supports OSC 8 hyperlinks.
 *
 * This test feeds linkifyPRRefs output through the ACTUAL pi-tui components
 * and asserts no duplication — catching the rendering-layer interaction that
 * pure string tests on linkifyPRRefs cannot.
 */

import { describe, it, expect } from "vitest";
import { Text, Markdown, getCapabilities, setCapabilities } from "@earendil-works/pi-tui";
import { getMarkdownTheme, initTheme } from "@earendil-works/pi-coding-agent";
import { linkifyPRRefs, formatFooterStatus, emptyMonitorState } from "../src/render";
import type { MonitorConfig } from "../src/keys";

try {
	initTheme("dark");
} catch {
	// initTheme may already be initialized; ignore
}
const mdTheme = getMarkdownTheme();

const COMMIT_URL = "commit/7250cb4accb6019d4354dbd65686e8bbd06c6da3";
const PULL_URL = "pull/61";
const SHORT_SHA = "7250cb4";
const PR_REF = "v2nic/pi-ghpr-monitor#61";
const RUN_URL = "actions/runs/99";
const RUN_REF = "octo/demo run #99";

const RAW = `📝 New commit https://github.com/v2nic/pi-ghpr-monitor/commit/7250cb4accb6019d4354dbd65686e8bbd06c6da3 pushed to v2nic/pi-ghpr-monitor#61.`;

function countOccurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

function renderCounts(lines: string[]) {
	const joined = lines.join("\n");
	return {
		commitUrl: countOccurrences(joined, COMMIT_URL),
		pullUrl: countOccurrences(joined, PULL_URL),
		// short SHA NOT followed by the rest of the full sha (i.e. standalone display)
		shortSha: (joined.match(/7250cb4(?!accb)/g) || []).length,
		prRef: countOccurrences(joined, PR_REF),
		runUrl: countOccurrences(joined, RUN_URL),
		runRef: countOccurrences(joined, RUN_REF),
	};
}

describe("OSC 8 rendering through real pi-tui components (no triplication)", () => {
	for (const hyperlinks of [true, false]) {
		it(`Markdown component (UserMessage path) renders markdown-format links singly (hyperlinks=${hyperlinks})`, () => {
			setCapabilities({ ...getCapabilities(), hyperlinks });
			const md = linkifyPRRefs(RAW, "github.com", "markdown");
			// markdown format must not contain raw OSC 8 escapes
			expect(md).not.toContain("\x1b]8;;");
			const counts = renderCounts(new Markdown(md, 0, 0, mdTheme).render(120));
			expect(counts).toEqual({ commitUrl: 1, pullUrl: 1, shortSha: 1, prRef: 1, runUrl: 0, runRef: 0 });
		});

		it(`Text component (CustomMessage/footer path) renders osc8-format links singly (hyperlinks=${hyperlinks})`, () => {
			setCapabilities({ ...getCapabilities(), hyperlinks });
			const osc = linkifyPRRefs(RAW, "github.com", "osc8");
			const counts = renderCounts(new Text(osc, 0, 0).render(120));
			expect(counts).toEqual({ commitUrl: 1, pullUrl: 1, shortSha: 1, prRef: 1, runUrl: 0, runRef: 0 });
		});
	}

	it("raw OSC 8 fed to Markdown WOULD duplicate (documents why markdown format is required)", () => {
		// This asserts the buggy behavior that motivated the fix: feeding raw
		// OSC 8 escapes (osc8 format) to the Markdown component duplicates the
		// URL. If a future pi-tui version stops doing this, this test will fail
		// and we can simplify by using a single format.
		setCapabilities({ ...getCapabilities(), hyperlinks: true });
		const osc = linkifyPRRefs(RAW, "github.com", "osc8");
		const counts = renderCounts(new Markdown(osc, 0, 0, mdTheme).render(120));
		expect(counts.commitUrl).toBeGreaterThan(1);
	});
});

describe("Actions run URL linkification (footer path)", () => {
	const RUN_RAW = `📡 https://github.com/octo/demo/actions/runs/99 🏃`;

	it("formatFooterStatus returns a bare URL (no OSC-8 escape sequences)", () => {
		const config: MonitorConfig = {
			resourceType: "run", host: "github.com", owner: "octo", repo: "demo",
			number: 0, runId: 99, mode: "all", intervalSec: 60, wakeOn: [], autoMerge: false,
		};
		const footer = formatFooterStatus(config, { ...emptyMonitorState(), runStatus: "in_progress" });
		expect(footer).not.toContain("\x1b");
		expect(footer).toBe("📡 https://github.com/octo/demo/actions/runs/99 🏃");
	});

	it("osc8 format wraps the run URL in a single OSC 8 hyperlink", () => {
		setCapabilities({ ...getCapabilities(), hyperlinks: true });
		const osc = linkifyPRRefs(RUN_RAW, "github.com", "osc8");
		expect(osc).toContain("\x1b]8;;https://github.com/octo/demo/actions/runs/99\x1b\\octo/demo run #99\x1b]8;;\x1b\\");
		expect(osc).toContain("🏃");
		const counts = renderCounts(new Text(osc, 0, 0).render(120));
		expect(counts.runUrl).toBe(1);
		expect(counts.runRef).toBe(1);
	});

	it("markdown format wraps the run URL as a single markdown link", () => {
		setCapabilities({ ...getCapabilities(), hyperlinks: true });
		const md = linkifyPRRefs(RUN_RAW, "github.com", "markdown");
		expect(md).not.toContain("\x1b]8;;");
		expect(md).toContain("[octo/demo run #99](https://github.com/octo/demo/actions/runs/99)");
		expect(md).toContain("🏃");
		const counts = renderCounts(new Markdown(md, 0, 0, mdTheme).render(120));
		expect(counts.runUrl).toBe(1);
		expect(counts.runRef).toBe(1);
	});

	it("the run label columns are inside a single OSC-8 span (no leakage past the close)", () => {
		setCapabilities({ ...getCapabilities(), hyperlinks: true });
		const osc = linkifyPRRefs(RUN_RAW, "github.com", "osc8");
		const lines = new Text(osc, 0, 0).render(120);
		const line = lines[0];
		// The link label appears exactly once and the closing OSC-8 precedes the 🏃
		expect(line).toContain("octo/demo run #99");
		expect(line.indexOf("🏃") > line.indexOf("\x1b]8;;\x1b\\")).toBe(true);
		// Exactly one open and one close OSC-8 pair (no double-wrapping)
		const osc8Markers = (line.match(/\x1b\]8;;/g) || []).length;
		expect(osc8Markers).toBe(2); // one open, one close
		const closes = (line.match(/\x1b\]8;;\x1b\\/g) || []).length;
		expect(closes).toBe(1);
	});
});
