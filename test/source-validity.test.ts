/**
 * Tests for source file validity — catches corruption issues that prevent
 * the extension from loading at runtime.
 *
 * These tests verify that the TypeScript source file does not contain
 * syntax errors that would prevent the Pi runtime from parsing it, such
 * as escaped template literal backticks or interpolation markers that
 * should be raw characters.
 *
 * The bug: a merge commit introduced escaped template literal characters
 * into src/index.ts. The line had literal backslash-backtick and
 * backslash-dollar-brace instead of raw backtick and dollar-brace.
 * This caused a ParseError when the Pi runtime loaded the extension.
 *
 * The classifier uses a single-pass O(n) approach that precomputes a
 * context array, then checks are O(1) per position. It tracks:
 * - Single and double quoted strings (with escape sequences)
 * - Template literals with nested ${} expressions (switching to code
 *   context inside interpolations so backticks/interpolation markers
 *   inside expressions are correctly classified)
 * - Line comments and block comments
 * - Escape sequences inside all string/template contexts
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const src = fs.readFileSync(
	path.join(__dirname, "..", "src", "index.ts"),
	"utf-8",
);

type Context = "code" | "string" | "comment" | "template";

/**
 * Single-pass tokenizer that precomputes the lexical context at each
 * character position in the source. Runs in O(n) time and produces
 * an array of context values that can be looked up in O(1).
 *
 * Inside template literal interpolation expressions (${...}), characters
 * are classified as "code" (not "template"), so that valid escape
 * sequences like \{ inside expressions are not misclassified, and
 * nested strings/comments inside ${} are handled correctly.
 */
function buildContextMap(source: string): Context[] {
	const contexts: Context[] = new Array(source.length);
	const len = source.length;
	let i = 0;

	while (i < len) {
		const ch = source[i];
		const next = i + 1 < len ? source[i + 1] : "";

		// Line comments: // ... until end of line
		if (ch === "/" && next === "/") {
			const start = i;
			while (i < len && source[i] !== "\n") {
				contexts[i] = "comment";
				i++;
			}
			continue;
		}

		// Block comments: /* ... */
		if (ch === "/" && next === "*") {
			const start = i;
			contexts[i] = "comment";
			contexts[i + 1] = "comment";
			i += 2;
			while (i < len - 1 && !(source[i] === "*" && source[i + 1] === "/")) {
				contexts[i] = "comment";
				i++;
			}
			if (i < len - 1) {
				contexts[i] = "comment";
				contexts[i + 1] = "comment";
				i += 2;
			}
			continue;
		}

		// Single-quoted strings: ' ... '
		if (ch === "'") {
			contexts[i] = "string";
			i++;
			while (i < len) {
				contexts[i] = "string";
				if (source[i] === "\\") {
					i++; // skip escaped char
					if (i < len) { contexts[i] = "string"; i++; }
					continue;
				}
				if (source[i] === "'") { i++; break; }
				i++;
			}
			continue;
		}

		// Double-quoted strings: " ... "
		if (ch === '"') {
			contexts[i] = "string";
			i++;
			while (i < len) {
				contexts[i] = "string";
				if (source[i] === "\\") {
					i++; // skip escaped char
					if (i < len) { contexts[i] = "string"; i++; }
					continue;
				}
				if (source[i] === '"') { i++; break; }
				i++;
			}
			continue;
		}

		// Template literals: ` ... ` with ${} interpolation nesting
		if (ch === "`") {
			contexts[i] = "template";
			i++;
			// Track nesting depth of ${} expressions.
			// depth=0 means we're in the template string part (not inside ${}).
			// depth>0 means we're inside a ${} expression (code context).
			let depth = 0;
			while (i < len) {
				const tc = source[i];
				const tn = i + 1 < len ? source[i + 1] : "";

				// ${ starts an interpolation expression
				if (tc === "$" && tn === "{" && depth === 0) {
					depth++;
					contexts[i] = "template"; // the $ character
					contexts[i + 1] = "template"; // the { character
					i += 2;
					// Now we're inside a ${} expression, classify as code
					continue;
				}

				// } closes an interpolation expression (if we're inside one)
				if (tc === "}" && depth > 0) {
					depth--;
					contexts[i] = "template";
					i++;
					// If depth is now 0, we're back in the template string
					continue;
				}

				// Closing backtick — only ends the template if we're not
				// inside a ${} expression
				if (tc === "`" && depth === 0) {
					contexts[i] = "template";
					i++;
					break;
				}

				// Inside ${} expressions (depth > 0), we need to track
				// nested strings and comments to avoid false matches
				if (depth > 0) {
					// Nested single-quoted string inside ${}
					if (tc === "'") {
						contexts[i] = "string"; i++;
						while (i < len && source[i] !== "'") {
							contexts[i] = "string";
							if (source[i] === "\\") {
								i++; // skip escaped char
								if (i < len) { contexts[i] = "string"; }
							}
							i++;
						}
						if (i < len) { contexts[i] = "string"; i++; }
						continue;
					}
					// Nested double-quoted string inside ${}
					if (tc === '"') {
						contexts[i] = "string"; i++;
						while (i < len && source[i] !== '"') {
							contexts[i] = "string";
							if (source[i] === "\\") {
								i++; // skip escaped char
								if (i < len) { contexts[i] = "string"; }
							}
							i++;
						}
						if (i < len) { contexts[i] = "string"; i++; }
						continue;
					}
					// Nested template literal inside ${}
					if (tc === "`") {
						// Recursively classify nested template inside ${}
						// All characters (including ${ and } delimiters) get context values.
						contexts[i] = "template";
						i++;
						let innerDepth = 0;
						while (i < len) {
							const ic = source[i];
							const inext = i + 1 < len ? source[i + 1] : "";
							if (ic === "$" && inext === "{" && innerDepth === 0) {
								innerDepth++;
								contexts[i] = "template"; // $
								contexts[i + 1] = "template"; // {
								i += 2;
								continue;
							}
							if (ic === "}" && innerDepth > 0) {
								innerDepth--;
								contexts[i] = "template"; // }
								i++;
								continue;
							}
							if (ic === "`" && innerDepth === 0) {
								contexts[i] = "template";
								i++;
								break;
							}
							if (ic === "\\") {
								contexts[i] = "template";
								i++;
								if (i < len) { contexts[i] = "template"; i++; }
								continue;
							}
							contexts[i] = "template";
							i++;
						}
						continue;
					}
					// Nested block comment inside ${}
					if (tc === "/" && tn === "*") {
						contexts[i] = "comment"; contexts[i + 1] = "comment";
						i += 2;
						while (i < len - 1 && !(source[i] === "*" && source[i + 1] === "/")) {
							contexts[i] = "comment"; i++;
						}
						if (i < len - 1) {
							contexts[i] = "comment"; contexts[i + 1] = "comment";
							i += 2;
						}
						continue;
					}
					// Nested line comment inside ${}
					if (tc === "/" && tn === "/") {
						while (i < len && source[i] !== "\n") {
							contexts[i] = "comment"; i++;
						}
						continue;
					}
					// Escaped character inside ${} expression — classify as code
					if (tc === "\\") {
						// The backslash itself is code context (will be checked
						// by the byte-sequence tests)
						contexts[i] = "code";
						i++;
						if (i < len) { contexts[i] = "code"; i++; }
						continue;
					}
					// Regular code inside ${} expression
					contexts[i] = "code";
					i++;
					continue;
				}

				// Inside template string (not in ${}), escaped chars are valid
				if (tc === "\\") {
					contexts[i] = "template";
					i++; // the backslash
					if (i < len) {
						contexts[i] = "template"; // the escaped char
						i++;
					}
					continue;
				}

				// Regular character inside template string
				contexts[i] = "template";
				i++;
			}
			continue;
		}

		// Default: code context
		contexts[i] = "code";
		i++;
	}

	return contexts;
}

const contextMap = buildContextMap(src);

// Precompute line offsets for O(1) line-number lookup
const lineOffsets = src.split("\n").reduce((acc: number[], line: string, idx: number) => {
	acc.push(idx === 0 ? 0 : acc[idx - 1] + line.length + 1);
	return acc;
}, []);

function lineAt(offset: number): number {
	// Binary search for the line number at a given offset
	let lo = 0, hi = lineOffsets.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (lineOffsets[mid] <= offset) lo = mid;
		else hi = mid - 1;
	}
	return lo + 1; // 1-based line number
}

describe("Source file has no escaped template literal characters", () => {
	it("contains no literal backslash-backtick in code context", () => {
		// The byte sequence 0x5c 0x60 (backslash + backtick) outside of
		// strings, comments, and template literals creates an invalid
		// escape sequence that causes:
		//   ParseError: Expecting Unicode escape sequence \uXXXX
		//
		// Inside a template literal, \` is valid (escapes a literal backtick).
		// Inside a single/double-quoted string, \` is also valid.
		// Only in code context is \` invalid.
		const errors: string[] = [];

		for (let i = 0; i < src.length - 1; i++) {
			if (src.charCodeAt(i) === 0x5c && src.charCodeAt(i + 1) === 0x60) {
				if (contextMap[i] === "code") {
					const lineNum = lineAt(i);
					const lineStart = src.lastIndexOf("\n", i) + 1;
					const lineEnd = src.indexOf("\n", i);
					const context = src.substring(
						Math.max(lineStart, i - 20),
						Math.min(lineEnd === -1 ? src.length : lineEnd, i + 20)
					);
					errors.push(
						"Line " + lineNum + ", col " + (i - lineStart + 1) +
						": found escaped backtick (0x5c 0x60) in code context." +
						" This causes ParseError. Context: ..." + context + "..."
					);
				}
			}
		}

		if (errors.length > 0) {
			throw new Error("Found escaped backticks in code context:\n" + errors.join("\n"));
		}
	});

	it("contains no literal backslash-dollar-brace in code context", () => {
		// The byte sequence 0x5c 0x24 0x7b (backslash + dollar + open-brace)
		// outside of strings, comments, and template literals creates a broken
		// template interpolation marker.
		//
		// Inside a template literal's interpolation expression, \${ is valid
		// (escapes the dollar-brace). Inside a template string part, \${ is
		// also valid. Only in code context is \${ invalid.
		const errors: string[] = [];

		for (let i = 0; i < src.length - 2; i++) {
			if (src.charCodeAt(i) === 0x5c && src.charCodeAt(i + 1) === 0x24 && src.charCodeAt(i + 2) === 0x7b) {
				if (contextMap[i] === "code") {
					const lineNum = lineAt(i);
					const lineStart = src.lastIndexOf("\n", i) + 1;
					const lineEnd = src.indexOf("\n", i);
					const context = src.substring(
						Math.max(lineStart, i - 20),
						Math.min(lineEnd === -1 ? src.length : lineEnd, i + 25)
					);
					errors.push(
						"Line " + lineNum + ", col " + (i - lineStart + 1) +
						": found escaped dollar-brace (0x5c 0x24 0x7b) in code context." +
						" This breaks template interpolation. Context: ..." + context + "..."
					);
				}
			}
		}

		if (errors.length > 0) {
			throw new Error("Found escaped dollar-brace in code context:\n" + errors.join("\n"));
		}
	});

	it("has valid template literal syntax (backticks are properly paired)", { timeout: 10000 }, () => {
		// Verify that the source file has matching backtick pairs by scanning
		// through the context map. Backticks inside strings and comments are
		// ignored. Unclosed template literals are reported with their line number.
		let inTemplate = false;
		let templateStartLine = 1;

		for (let i = 0; i < src.length; i++) {
			// Skip backticks inside strings and comments
			if (contextMap[i] === "string" || contextMap[i] === "comment") continue;

			if (src[i] === "`") {
				// Check if this backtick is escaped (preceded by backslash).
				// Escaped backticks (\`) are valid inside template literals and
				// single/double-quoted strings — they don't open or close templates.
				// The context map already classifies the backslash, so check the
				// position before it to determine if it's an escape sequence.
				if (i > 0 && src[i - 1] === "\\" && contextMap[i - 1] !== "code") {
					// The backtick is preceded by \ that is NOT in code context.
					// In template/string context, \` is an escape sequence —
					// the backtick is literal, not a delimiter. Skip it.
					// (In code context, \` would be flagged by the
					// backslash-backtick test as a bug, so we also skip it.)
					continue;
				}

				if (!inTemplate) {
					inTemplate = true;
					templateStartLine = lineAt(i);
				} else {
					inTemplate = false;
				}
			}
		}

		if (inTemplate) {
			throw new Error(
				"Unclosed template literal starting at line " + templateStartLine +
				". This would cause a ParseError."
			);
		}
	});
});