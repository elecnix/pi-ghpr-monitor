/**
 * Tests for content type safety in sendPRNotification calls.
 *
 * The regression: formatAgentNotification() returns {concise, detailed} | null,
 * but callers were passing the whole object as the `detailed` parameter to
 * sendPRNotification, causing pi.sendMessage() to receive an object instead
 * of a string for the `content` field. This crashes the pi coding agent.
 *
 * These structural tests ensure:
 * 1. formatAgentNotification results are always destructured before use
 * 2. No caller passes the {concise, detailed} object where a string is expected
 * 3. sendPRNotification's `content` field is always a string
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const src = fs.readFileSync(
	path.join(__dirname, "..", "src", "index.ts"),
	"utf-8",
);

/**
 * Extract the body of a named function from source code.
 */
function extractFunctionBody(source: string, fnName: string): string | null {
	const idx = source.indexOf(`function ${fnName}(`);
	if (idx === -1) return null;

	let parenDepth = 0;
	let i = idx;
	for (; i < source.length; i++) {
		const ch = source[i];
		if (ch === "(") { parenDepth++; }
		else if (ch === ")") {
			parenDepth--;
			if (parenDepth === 0) {
				i++;
				break;
			}
		}
	}

	const bodyOpen = source.indexOf("{", i);
	if (bodyOpen === -1) return null;

	let braceDepth = 0;
	for (let j = bodyOpen; j < source.length; j++) {
		if (source[j] === "{") braceDepth++;
		else if (source[j] === "}") {
			braceDepth--;
			if (braceDepth === 0) {
				return source.slice(idx, j + 1);
			}
		}
	}
	return null;
}

describe("sendPRNotification always receives strings, not objects", () => {
	it("sendPRNotification content field must always be a string", () => {
		const fnBody = extractFunctionBody(src, "sendPRNotification");
		expect(fnBody).not.toBeNull();

		// The sendPRNotification function should assign a string value
		// to the content field, never an object. This can be `detailed`
		// directly or `markdownDetailed` (derived from `detailed` via
		// linkifyPRRefs and always a string).
		const hasDetailed = fnBody!.includes("content: detailed") || fnBody!.includes("content: markdownDetailed") || fnBody!.includes("content: linkifiedDetailed");
		expect(hasDetailed).toBe(true);
	});

	it("formatAgentNotification result is destructured before passing to sendPRNotification in reminder path", () => {
		// Find the reminder notification call site
		const reminderIdx = src.indexOf("needsReminder && !agentTurnActive");
		expect(reminderIdx).toBeGreaterThan(-1);

		const nearby = src.slice(reminderIdx, reminderIdx + 800);

		// The call to sendPRNotification should NOT pass the whole
		// formatAgentNotification result object as the second argument.
		// It should either destructure it first or use .detailed
		//
		// BAD:  sendPRNotification(reminder, detReminder ?? reminder, ...)
		//       where detReminder = formatAgentNotification(curr, config) = {concise, detailed}
		//
		// GOOD: sendPRNotification(reminder, detReminder.detailed ?? reminder, ...)
		//       where detReminder = formatAgentNotification(curr, config)
		//   OR: const { concise: remConcise, detailed: remDetailed } = formatAgentNotification(curr, config) ?? { concise: reminder, detailed: reminder };
		//       sendPRNotification(reminder, remDetailed, ...)

		// Check that we don't have the buggy pattern where the whole object is passed
		const sendPRCallMatch = nearby.match(/sendPRNotification\s*\(\s*\w+\s*,\s*(\w+)/);
		if (sendPRCallMatch) {
			const secondArg = sendPRCallMatch[1];
			// Find the declaration of this variable
			const declPattern = new RegExp(`const ${secondArg}\\s*=\\s*formatAgentNotification`, "g");
			const hasDecl = declPattern.test(nearby);

			if (hasDecl) {
				// If the variable comes from formatAgentNotification, it must be
				// destructured or .detailed must be accessed (with optional chaining)
				const usagePattern = new RegExp(`${secondArg}\\?\\.detailed|${secondArg}\\.detailed|${secondArg}\\s*\\.\\s*detailed`);
				const usesDetailedProperty = usagePattern.test(nearby);
				// Or it should be destructured: const { concise: ..., detailed: ... } = formatAgentNotification(...)
				const destructured = nearby.includes("concise:") && nearby.includes("detailed:");

				expect(
					usesDetailedProperty || destructured,
					`formatAgentNotification result '${secondArg}' must use .detailed property or be destructured, not passed as-is as the second arg to sendPRNotification`
				).toBe(true);
			}
		}
	});

	it("formatAgentNotification result is destructured before passing to sendPRNotification in nudge path", () => {
		const nudgeIdx = src.indexOf("Periodic nudge");
		expect(nudgeIdx).toBeGreaterThan(-1);

		const nearby = src.slice(nudgeIdx, nudgeIdx + 600);

		const sendPRCallMatch = nearby.match(/sendPRNotification\s*\(\s*\w+\s*,\s*(\w+)/);
		if (sendPRCallMatch) {
			const secondArg = sendPRCallMatch[1];
			const declPattern = new RegExp(`const ${secondArg}\\s*=\\s*formatAgentNotification`, "g");
			const hasDecl = declPattern.test(nearby);

			if (hasDecl) {
				// Must use .detailed or ?.detailed to extract the string value
				const usagePattern = new RegExp(`${secondArg}\\?\\.detailed|${secondArg}\\.detailed`);
				const usesDetailedProperty = usagePattern.test(nearby);
				const destructured = nearby.includes("concise:") && nearby.includes("detailed:");

				expect(
					usesDetailedProperty || destructured,
					`formatAgentNotification result '${secondArg}' must use .detailed property or be destructured`
				).toBe(true);
			}
		}
	});

	it("formatAgentNotification result is never passed directly as sendPRNotification second argument", () => {
		// Search the entire source for patterns like:
		// sendPRNotification(xxx, detYYY ?? xxx, ...)
		// where detYYY = formatAgentNotification(...) (which returns {concise, detailed} | null)
		//
		// The ?? xxx fallback only works for null; when non-null, the whole object
		// is passed, which is wrong.

		// Find all calls to formatAgentNotification in index.ts
		const re = /const\s+(\w+)\s*=\s*formatAgentNotification\s*\(/g;
		let match;
		const varNames: string[] = [];
		while ((match = re.exec(src)) !== null) {
			varNames.push(match[1]);
		}

		for (const varName of varNames) {
			// Find all usages of this variable
			const usageRe = new RegExp(`\\b${varName}\\b`, "g");
			let usageMatch;
			while ((usageMatch = usageRe.exec(src)) !== null) {
				const idx = usageMatch.index;
				const afterVar = src.slice(idx + varName.length, idx + varName.length + 10);

				// Valid patterns: ?.detailed, ?.concise, .detailed, .concise
				// These extract a string property from the result object
				if (/^\?\.(detailed|concise)/.test(afterVar) || /^\.(detailed|concise)/.test(afterVar)) {
					// Accessing .detailed or .concise property (possibly with optional chaining) — good
					const prop = afterVar.match(/^\?\.(detailed|concise)/)?.[1] || afterVar.match(/^\.(detailed|concise)/)?.[1];
					expect(
						prop === "detailed" || prop === "concise",
						`At index ${idx}: ${varName}${afterVar.slice(0, 2)} accesses '${prop}' — only .detailed and .concise properties should be accessed on formatAgentNotification results`
					).toBe(true);
				} else {
					// Check for the buggy pattern: `varName ?? fallback` (with optional whitespace)
					// This catches cases like `detItems ?? fallback` where the whole object is passed
					const restOfLine = src.slice(idx, idx + 200);
					const nullishCoalesce = new RegExp(`^${varName}\\s*\\?\\?\\s*\\w+`);
					if (nullishCoalesce.test(restOfLine)) {
						const broaderContext = src.slice(Math.max(0, idx - 150), idx + 200);
						if (broaderContext.includes("sendPRNotification")) {
							expect(
								false,
								`At index ${idx}: '${varName} ?? fallback' is passed to sendPRNotification — when varName is non-null, the whole {concise, detailed} object is used. Must use ${varName}?.detailed ?? fallback instead.`
							).toBe(true);
						}
					}
					// Check for accessing a property other than .detailed/.concise
					const propMatch = afterVar.match(/^\.?(\w+)/);
					if (propMatch && propMatch[1] !== "detailed" && propMatch[1] !== "concise") {
						const prop = propMatch[1];
						expect(
							false,
							`At index ${idx}: ${varName}.${prop} — only .detailed and .concise properties should be accessed on formatAgentNotification results`
						).toBe(true);
					}
					// Check for passing the whole object as a function argument (e.g., sendPRNotification(x, varName, ...))
					if (/^[,)]/.test(afterVar.trimStart())) {
						const before = src.slice(Math.max(0, idx - 100), idx);
						if (before.includes("sendPRNotification")) {
							expect(
								false,
								`At index ${idx}: ${varName} (a formatAgentNotification result object) is passed directly to sendPRNotification — must use ${varName}?.detailed instead`
							).toBe(true);
						}
					}
				}
				// Other cases (assignment, comparison, null check, etc.) are fine
			}
		}
	});

	it("pi.sendMessage content field in sendPRNotification is never assigned an object", () => {
		const fnBody = extractFunctionBody(src, "sendPRNotification");
		expect(fnBody).not.toBeNull();

		// The function should use a string value for the content field
		// (`detailed` directly or `markdownDetailed` derived from it)
		// This ensures the type system enforces string content at compile time
		const hasDetailed = fnBody!.includes("content: detailed,") || fnBody!.includes("content: markdownDetailed") || fnBody!.includes("content: linkifiedDetailed");
		expect(hasDetailed).toBe(true);
	});
});