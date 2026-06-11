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
import { linkifyPRRefs } from "../src/analyzer";

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
			expect(counts).toEqual({ commitUrl: 1, pullUrl: 1, shortSha: 1, prRef: 1 });
		});

		it(`Text component (CustomMessage/footer path) renders osc8-format links singly (hyperlinks=${hyperlinks})`, () => {
			setCapabilities({ ...getCapabilities(), hyperlinks });
			const osc = linkifyPRRefs(RAW, "github.com", "osc8");
			const counts = renderCounts(new Text(osc, 0, 0).render(120));
			expect(counts).toEqual({ commitUrl: 1, pullUrl: 1, shortSha: 1, prRef: 1 });
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
