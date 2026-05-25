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
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const src = fs.readFileSync(
	path.join(__dirname, "..", "src", "index.ts"),
	"utf-8",
);

describe("Source file has no escaped template literal characters", () => {
	it("contains no literal backslash-backtick outside of string literals", () => {
		// The byte sequence 0x5c 0x60 (backslash + backtick) creates
		// an invalid escape sequence that causes:
		//   ParseError: Expecting Unicode escape sequence \uXXXX
		//
		// In valid TypeScript, template literals use raw backticks,
		// not escaped ones.
		const lines = src.split("\n");
		const errors: string[] = [];

		for (let i = 0; i < lines.length; i++) {
			for (let j = 0; j < lines[i].length - 1; j++) {
				if (lines[i].charCodeAt(j) === 0x5c && lines[i].charCodeAt(j + 1) === 0x60) {
					const line = lines[i];
					// Check if we're inside a single or double quoted string
					const beforeSlice = line.slice(0, j);
					const singleQuotes = (beforeSlice.match(/'/g) || []).length;
					const doubleQuotes = (beforeSlice.match(/"/g) || []).length;
					const insideString = singleQuotes % 2 === 1 || doubleQuotes % 2 === 1;

					if (!insideString) {
						const context = line.slice(Math.max(0, j - 20), Math.min(line.length, j + 20));
						errors.push(
							"Line " + (i + 1) + ", col " + (j + 1) + ": found escaped backtick outside of string literal. " +
							"This causes ParseError. Context: ..." + context + "..."
						);
					}
				}
			}
		}

		expect(errors).toHaveLength(0);
	});

	it("contains no literal backslash-dollar-brace outside of string literals", () => {
		// The byte sequence 0x5c 0x24 0x7b (backslash + dollar + open-brace)
		// creates a broken template interpolation marker. Template literals
		// use dollar-brace for interpolation, not backslash-dollar-brace.
		const lines = src.split("\n");
		const errors: string[] = [];

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			for (let j = 0; j < line.length - 2; j++) {
				if (line.charCodeAt(j) === 0x5c && line.charCodeAt(j + 1) === 0x24 && line.charCodeAt(j + 2) === 0x7b) {
					const beforeSlice = line.slice(0, j);
					const singleQuotes = (beforeSlice.match(/'/g) || []).length;
					const doubleQuotes = (beforeSlice.match(/"/g) || []).length;
					const insideString = singleQuotes % 2 === 1 || doubleQuotes % 2 === 1;

					if (!insideString) {
						const context = line.slice(Math.max(0, j - 20), Math.min(line.length, j + 25));
						errors.push(
							"Line " + (i + 1) + ", col " + (j + 1) + ": found escaped dollar-brace outside of string literal. " +
							"This breaks template interpolation. Context: ..." + context + "..."
						);
					}
				}
			}
		}

		expect(errors).toHaveLength(0);
	});

	it("has valid template literal syntax (backticks are properly paired)", () => {
		// Verify that the source file can be parsed as JavaScript by checking
		// that backticks come in pairs (for template literals).
		const lines = src.split("\n");
		let inTemplate = false;
		let templateStartLine = 0;

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			for (let j = 0; j < line.length; j++) {
				if (line[j] === "`" && (j === 0 || line[j - 1] !== "\\")) {
					if (!inTemplate) {
						inTemplate = true;
						templateStartLine = i + 1;
					} else {
						inTemplate = false;
					}
				}
			}
		}

		expect(inTemplate).toBe(false);
	});
});