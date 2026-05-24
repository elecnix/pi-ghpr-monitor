/**
 * Tests for agent notification delivery mechanism.
 *
 * These tests verify that PR status notifications are delivered to the
 * coding agent (LLM) via pi.sendUserMessage(), not just pi.sendMessage().
 *
 * The regression: commit c9af0c9 switched all agent-facing notifications
 * from pi.sendUserMessage() to pi.sendMessage() with a custom type.
 * While pi.sendMessage() renders nicely in the TUI via a custom renderer,
 * CustomMessage content is NOT injected into the LLM's conversation context.
 * Only pi.sendUserMessage() creates a UserMessage that the coding agent
 * actually receives and can act upon.
 *
 * These structural tests ensure the fix stays in place by verifying:
 * 1. sendPRNotification uses pi.sendUserMessage() for agent delivery
 * 2. sendPRNotification also uses pi.sendMessage() for TUI rendering
 * 3. All notification paths use sendPRNotification
 * 4. No direct pi.sendUserMessage() calls bypass sendPRNotification
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
 * Handles TypeScript type annotations containing braces by tracking
 * parens depth — only enters brace-matching mode after all parens are closed.
 */
function extractFunctionBody(source: string, fnName: string): string | null {
	// Find the function declaration
	const idx = source.indexOf(`function ${fnName}(`);
	if (idx === -1) return null;

	// Walk forward to find the function body opening brace.
	// We need to skip any braces inside TypeScript type annotations
	// (which appear between the function name parens and the actual body).
	// Strategy: track parentheses depth. When we find { at parenDepth 0 or less,
	// that's the start of the function body. Then match braces to find the end.
	let parenDepth = 0;
	let i = idx;

	// Skip past the function signature (parens)
	for (; i < source.length; i++) {
		const ch = source[i];
		if (ch === '(') { parenDepth++; }
		else if (ch === ')') {
			parenDepth--;
			if (parenDepth === 0) {
				// Found closing paren of function signature
				// Now find the opening brace of the body
				i++;
				break;
			}
		}
	}

	// Find opening brace
	const bodyOpen = source.indexOf("{", i);
	if (bodyOpen === -1) return null;

	// Match braces to find the closing brace
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

describe("Agent notification delivery uses pi.sendUserMessage()", () => {
	it("sendPRNotification calls pi.sendUserMessage() for agent delivery", () => {
		const fnBody = extractFunctionBody(src, "sendPRNotification");
		expect(fnBody).not.toBeNull();

		// The function MUST call pi.sendUserMessage() to ensure the agent
		// receives the notification. pi.sendMessage() with a custom type
		// only renders in the TUI — the agent does NOT see it.
		expect(fnBody!).toContain("pi.sendUserMessage(");
	});

	it("sendPRNotification passes the detailed content to pi.sendUserMessage()", () => {
		const fnBody = extractFunctionBody(src, "sendPRNotification");
		expect(fnBody).not.toBeNull();

		// The detailed content (full comment bodies, paths, line numbers)
		// must be passed as the first argument to pi.sendUserMessage()
		// so the agent gets full information without needing extra API calls.
		expect(fnBody!).toMatch(/pi\.sendUserMessage\(\s*detailed/);
	});

	it("sendPRNotification also uses pi.sendMessage() for TUI rendering", () => {
		const fnBody = extractFunctionBody(src, "sendPRNotification");
		expect(fnBody).not.toBeNull();

		// The concise content should also be sent via pi.sendMessage() for
		// TUI rendering with the custom renderer.
		expect(fnBody!).toContain("pi.sendMessage(");
		expect(fnBody!).toContain("customType");
	});
});

describe("All notification paths use sendPRNotification for agent delivery", () => {
	it("status update notifications use sendPRNotification", () => {
		const pollBody = extractFunctionBody(src, "pollLoop");
		expect(pollBody).not.toBeNull();
		expect(pollBody!).toContain("sendPRNotification(");
	});

	it("merged/closed PR notifications use sendPRNotification", () => {
		const mergedIdx = src.indexOf("was merged");
		expect(mergedIdx).toBeGreaterThan(-1);

		const nearby = src.slice(Math.max(0, mergedIdx - 500), mergedIdx + 500);
		expect(nearby).toContain("sendPRNotification(");
	});

	it("reminder notifications use sendPRNotification", () => {
		const reminderIdx = src.indexOf("needsReminder && !agentTurnActive");
		expect(reminderIdx).toBeGreaterThan(-1);

		const nearby = src.slice(reminderIdx, reminderIdx + 600);
		expect(nearby).toContain("sendPRNotification(");
	});

	it("force-check notifications use sendPRNotification", () => {
		const forceCheckIdx = src.indexOf("mon.forceNotify && !agentTurnActive");
		expect(forceCheckIdx).toBeGreaterThan(-1);

		const nearby = src.slice(forceCheckIdx, forceCheckIdx + 800);
		expect(nearby).toContain("sendPRNotification(");
	});

	it("periodic nudge notifications use sendPRNotification", () => {
		const nudgeIdx = src.indexOf("Periodic nudge");
		expect(nudgeIdx).toBeGreaterThan(-1);

		const nearby = src.slice(nudgeIdx, Math.min(nudgeIdx + 500, src.length));
		expect(nearby).toContain("sendPRNotification(");
	});

	it("queued update flush on turn_end uses sendPRNotification", () => {
		const turnEndIdx = src.indexOf('"turn_end"');
		expect(turnEndIdx).toBeGreaterThan(-1);

		const nearby = src.slice(turnEndIdx, turnEndIdx + 800);
		expect(nearby).toContain("sendPRNotification(");
	});

	it("queued force-check flush on turn_end uses sendPRNotification", () => {
		const turnEndIdx = src.indexOf('"turn_end"');
		expect(turnEndIdx).toBeGreaterThan(-1);

		const nearby = src.slice(turnEndIdx, turnEndIdx + 1200);
		expect(nearby).toContain("sendPRNotification(");
	});
});

describe("pi.sendMessage() with customType is retained for TUI rendering", () => {
	it("initial monitoring message uses pi.sendMessage() (TUI-only)", () => {
		const initialIdx = src.indexOf("📡 Monitoring");
		expect(initialIdx).toBeGreaterThan(-1);

		const nearby = src.slice(Math.max(0, initialIdx - 200), initialIdx + 400);
		expect(nearby).toContain("pi.sendMessage(");
	});

	it("error messages use pi.sendMessage() (TUI-only)", () => {
		// Error messages are for the TUI only — search for ghpr-monitor-error
		const errorIdx = src.indexOf("ghpr-monitor-error");
		expect(errorIdx).toBeGreaterThan(-1);

		// Verify that pi.sendMessage is used near the error text
		// (search a wide range since the call may be several lines before the string)
		const nearby = src.slice(Math.max(0, errorIdx - 200), errorIdx + 200);
		expect(nearby).toContain("pi.sendMessage");
	});
});

describe("No rogue pi.sendUserMessage() calls bypass sendPRNotification", () => {
	it("all pi.sendUserMessage() calls serve a legitimate purpose", () => {
		// Find sendPRNotification bounds
		const fnBody = extractFunctionBody(src, "sendPRNotification");
		expect(fnBody).not.toBeNull();
		const fnStart = src.indexOf("function sendPRNotification(");
		const fnEnd = fnStart + fnBody!.length;

		// Find all pi.sendUserMessage() calls
		const callIdxs: number[] = [];
		const re = /pi\.sendUserMessage\(/g;
		let match;
		while ((match = re.exec(src)) !== null) {
			callIdxs.push(match.index);
		}

		for (const idx of callIdxs) {
			// Check if it's inside sendPRNotification
			const insideSendPR = idx >= fnStart && idx <= fnEnd;

			// Check if it's a steering prompt message
			const nearby = src.slice(Math.max(0, idx - 300), idx + 300);
			const isSteerPrompt =
				nearby.includes("steerMessage") ||
				nearby.includes("The user wants to start");

			// Check if it's in a comment
			const lineStart = src.lastIndexOf("\n", idx) + 1;
			const lineText = src.slice(lineStart, idx).trimStart();
			const isComment = lineText.startsWith("//") || lineText.startsWith("*");

			expect(
				insideSendPR || isSteerPrompt || isComment,
				`pi.sendUserMessage() at index ${idx} should be inside sendPRNotification() or a steering prompt`
			).toBe(true);
		}
	});
});