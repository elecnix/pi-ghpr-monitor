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
		// The argument is `markdownDetailed` (detailed content linkified with
		// markdown link syntax for the pi-tui Markdown renderer), derived from
		// `detailed` and always a string.
		expect(fnBody!).toMatch(/pi\.sendUserMessage\(\s*(markdown|linkified)?Detailed/);
	});

	it("sendPRNotification uses pi.sendMessage() with display:false when delivering to agent", () => {
		const fnBody = extractFunctionBody(src, "sendPRNotification");
		expect(fnBody).not.toBeNull();

		// When sendUserMessage is also called (delivery is set), the CustomMessage
		// should use display:!delivery (false) to avoid a duplicate visible message.
		// The UserMessage from sendUserMessage is already visible in the TUI,
		// so the CustomMessage should be hidden in the TUI to prevent duplicates.
		expect(fnBody!).toContain("display: !delivery");
	});

	it("sendPRNotification also uses pi.sendMessage() for state tracking", () => {
		const fnBody = extractFunctionBody(src, "sendPRNotification");
		expect(fnBody).not.toBeNull();

		// pi.sendMessage() with customType must still be called for session state
		// tracking and event sourcing, even when display is false.
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
		const mergedIdx = src.indexOf("Monitoring stopped.");
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
		const forceCheckIdx = src.indexOf("if (mon.forceNotify)");
		expect(forceCheckIdx).toBeGreaterThan(-1);

		const nearby = src.slice(forceCheckIdx, forceCheckIdx + 1000);
		expect(nearby).toContain("sendPRNotification(");
	});

	it("periodic nudge notifications use sendPRNotification", () => {
		const nudgeIdx = src.indexOf("Periodic nudge");
		expect(nudgeIdx).toBeGreaterThan(-1);

		const nearby = src.slice(nudgeIdx, Math.min(nudgeIdx + 800, src.length));
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

describe("pi.sendMessage() with customType is retained for TUI-only messages", () => {
	it("initial monitoring message uses pi.sendMessage() with display:true (TUI-only, no UserMessage)", () => {
		const initialIdx = src.indexOf("defaultInitialMsg");
		expect(initialIdx).toBeGreaterThan(-1);

		const nearby = src.slice(Math.max(0, initialIdx - 200), initialIdx + 800);
		expect(nearby).toContain("pi.sendMessage(");
		// The initial monitoring message does not have a corresponding UserMessage,
		// so it should use display: true to be visible in the TUI
		expect(nearby).toContain("display: true");
	});
});

describe("Error messages must NOT leak into LLM context", () => {
	it("error messages do NOT use pi.sendMessage() with ghpr-monitor-error", () => {
		// Regression: pi.sendMessage() with customType creates a CustomMessage that
		// is converted to a role:"user" message in the LLM context by pi-agent-core's
		// convertToLlm(). This means poll errors (auth failures, rate limits) were
		// visible to the LLM, causing it to react to transient infrastructure issues.
		// The fix: use uiCtx.notify() for error messages instead, which shows a
		// transient TUI notification without creating any session entry.
		const errorIdx = src.indexOf("ghpr-monitor-error");
		expect(errorIdx).toBe(-1);
	});

	it("error messages use uiCtx.notify() for TUI-only display", () => {
		// Check that the poll error handler uses uiCtx.notify
		// Search for the poll error handling logic
		const pollErrCatchIdx = src.indexOf("errMsg");
		expect(pollErrCatchIdx).toBeGreaterThan(-1);

		// After the error message construction, we should find uiCtx?.notify
		// Look for the block around the error handling in pollLoop
		const isRateLimitIdx = src.indexOf("isRateLimit");
		expect(isRateLimitIdx).toBeGreaterThan(-1);

		// The error notification area should use uiCtx.notify, not pi.sendMessage
		const errorBlock = src.slice(isRateLimitIdx, isRateLimitIdx + 800);
		expect(errorBlock).toContain("uiCtx");
		expect(errorBlock).toContain("notify");
	});

	it("fatal error messages use uiCtx.notify() for TUI-only display", () => {
		// Check that the fatal error handler (startMonitor catch) uses uiCtx.notify
		const fatalErrBlock = src.indexOf("PR monitor error for");
		expect(fatalErrBlock).toBeGreaterThan(-1);

		const nearby = src.slice(fatalErrBlock - 100, fatalErrBlock + 300);
		expect(nearby).toContain("uiCtx");
		expect(nearby).toContain("notify");
	});

	it("no pi.sendMessage calls create ghpr-monitor-error CustomMessages", () => {
		// Ensure there are zero remaining ghpr-monitor-error custom types in sendMessage calls
		const regex = /pi\.sendMessage\([\s\S]*?customType:\s*['"]ghpr-monitor-error['"]/g;
		const matches = src.match(regex);
		expect(matches).toBeNull();
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

			// Check if it's the !/start subcommand steer prompt
			const nearby = src.slice(Math.max(0, idx - 300), idx + 300);
			const isStartSubcommandPrompt = nearby.includes("Monitor the current pull request");

			// Check if it's a steering prompt message (user-provided message after PR URL)
			const isSteerPrompt = nearby.includes("steerMessage");

			// Check if it's in a comment
			const lineStart = src.lastIndexOf("\n", idx) + 1;
			const lineText = src.slice(lineStart, idx).trimStart();
			const isComment = lineText.startsWith("//") || lineText.startsWith("*");

			// Check if it's the PR create hook nudge
			const isPrCreateNudge = nearby.includes("createPRCreateNudge") || nearby.includes("injecting nudge");

			expect(
				insideSendPR || isStartSubcommandPrompt || isSteerPrompt || isComment || isPrCreateNudge,
				`pi.sendUserMessage() at index ${idx} should be inside sendPRNotification(), the !/start prompt, or a steering prompt`
			).toBe(true);
		}
	});
});
describe("Queued update preserves detailed content", () => {
	it("pollLoop computes formatAgentStatusUpdate before queuing updates", () => {
		// Regression: when the agent turn is active, queued updates were using
		// formatStatusUpdate() for both concise and detailed, losing enriched
		// content (full body, path, line number). The fix computes
		// formatAgentStatusUpdate() once so queuedUpdate.detailed gets the
		// enriched version.
		const pollBody = extractFunctionBody(src, "pollLoop");
		expect(pollBody).not.toBeNull();

		// The pollLoop must call formatAgentStatusUpdate to produce both
		// concise and detailed content for the status update path.
		expect(pollBody!).toContain("formatAgentStatusUpdate");
	});

	it("queuedUpdate uses detUpdate (detailed) not update (concise) for the detailed field", () => {
		// Verify the queued update assignment uses detUpdate for detailed,
		// not the concise `update` string from formatStatusUpdate.
		const pollBody = extractFunctionBody(src, "pollLoop");
		expect(pollBody).not.toBeNull();

		// Find the queuedUpdate assignment using a whitespace-tolerant regex
		// so the test doesn't break if the assignment is reformatted across
		// multiple lines (e.g. by prettier).
		const queuedAssignMatch = pollBody!.match(/queuedUpdate\s*=\s*\{[^}]+\}/);
		expect(queuedAssignMatch).not.toBeNull();

		const assignment = queuedAssignMatch![0];
		// The concise field should use `update` (formatStatusUpdate's return)
		// and the detailed field should use `detUpdate` (formatAgentStatusUpdate's detailed)
		expect(assignment).toContain("concise: update");
		expect(assignment).toContain("detailed: detUpdate");

		// The detailed field should NOT be `update` (which was the bug)
		expect(assignment).not.toMatch(/detailed:\s*update[,\s}]/);
	});

	it("queuedUpdate does not use identical concise and detailed strings", () => {
		// The bug was: queuedUpdate = { concise: update, detailed: update, ... }
		// This meant both fields got the same truncated content.
		// After the fix: queuedUpdate = { concise: update, detailed: detUpdate, ... }
		// where detUpdate comes from formatAgentStatusUpdate and can contain
		// enriched content (thread details, comment details, etc.).
		const pollBody = extractFunctionBody(src, "pollLoop");
		expect(pollBody).not.toBeNull();

		// Find the queuedUpdate assignment and verify it uses different variables
		const queuedAssignMatch = pollBody!.match(/queuedUpdate\s*=\s*\{[^}]+\}/);
		expect(queuedAssignMatch).not.toBeNull();

		const assignment = queuedAssignMatch![0];
		// The assignment should have concise: update and detailed: detUpdate
		// (different variable names, meaning different content)
		expect(assignment).toContain("concise: update");
		expect(assignment).toContain("detailed: detUpdate");

		// Should NOT have both concise and detailed set to the same variable
		expect(assignment).not.toMatch(/concise:\s*update[^,]*,\s*detailed:\s*update/);
	});

	it("formatAgentStatusUpdate is computed before the if/update block", () => {
		// The formatAgentStatusUpdate call should be OUTSIDE and BEFORE the
		// if (update) block, so both the queued and immediate paths can use it.
		const pollBody = extractFunctionBody(src, "pollLoop");
		expect(pollBody).not.toBeNull();

		const formatCallIdx = pollBody!.indexOf("formatAgentStatusUpdate");
		expect(formatCallIdx).toBeGreaterThan(-1);

		const ifUpdateIdx = pollBody!.indexOf("if (update)");
		expect(ifUpdateIdx).toBeGreaterThan(-1);

		// The formatAgentStatusUpdate call must come before the if (update) block
		expect(formatCallIdx).toBeLessThan(ifUpdateIdx);
	});

	it("queuedForceChecks entries have distinct concise and detailed strings", () => {
		// The force-check path already correctly computes both concise and
		// detailed via formatAgentNotification. Verify this stays the case.
		const pollBody = extractFunctionBody(src, "pollLoop");
		expect(pollBody).not.toBeNull();

		// Find the queuedForceChecks.push in the forceNotify block
		const forceNotifyIdx = pollBody!.indexOf("if (mon.forceNotify)");
		expect(forceNotifyIdx).toBeGreaterThan(-1);

		const forceBlock = pollBody!.slice(forceNotifyIdx, forceNotifyIdx + 1000);

		// Should compute formatAgentNotification for detailed content
		expect(forceBlock).toContain("formatAgentNotification");

		// The push should use distinct variables for concise and detailed
		const pushMatch = forceBlock.match(/queuedForceChecks\.push\(\{[^}]+\}\)/);
		expect(pushMatch).not.toBeNull();
		expect(pushMatch![0]).toContain("concise: msg");
		expect(pushMatch![0]).toContain("detailed: detMsg");
	});

	it("turn_end flush delivers both concise and detailed from queuedUpdate", () => {
		// When the agent turn ends, the queued update is flushed via
		// sendPRNotification, which should receive both the concise and
		// detailed strings.
		const turnEndIdx = src.indexOf('"turn_end"');
		expect(turnEndIdx).toBeGreaterThan(-1);

		const turnEndBlock = src.slice(turnEndIdx, turnEndIdx + 800);

		// The flush should pass both concise and detailed to sendPRNotification
		expect(turnEndBlock).toContain("update.concise");
		expect(turnEndBlock).toContain("update.detailed");
	});

	it("turn_end flush delivers both concise and detailed from queuedForceChecks", () => {
		// When the agent turn ends, queued force-check results are flushed via
		// sendPRNotification, which should receive both concise and detailed.
		const turnEndIdx = src.indexOf('"turn_end"');
		expect(turnEndIdx).toBeGreaterThan(-1);

		const turnEndBlock = src.slice(turnEndIdx, turnEndIdx + 1500);

		// The force-check flush should pass both fc.concise and fc.detailed
		expect(turnEndBlock).toContain("fc.concise");
		expect(turnEndBlock).toContain("fc.detailed");
	});
});

describe("Duplicate notification prevention via display flag", () => {
	it("sendPRNotification uses display:!delivery on CustomMessage", () => {
		const fnBody = extractFunctionBody(src, "sendPRNotification");
		expect(fnBody).not.toBeNull();

		// The CustomMessage should use display: !delivery so it's hidden when
		// a UserMessage is also being sent (preventing visual duplicates).
		expect(fnBody!).toContain("display: !delivery");
	});

	it("sendPRNotification does not use hardcoded display:true on CustomMessage", () => {
		const fnBody = extractFunctionBody(src, "sendPRNotification");
		expect(fnBody).not.toBeNull();

		// Strip comments from the function body before checking for display: true
		// to avoid false positives from docstrings that mention "display: true".
		const codeOnly = fnBody!
			.split("\n")
			.filter((line: string) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
			.join("\n");

		// The code should NOT contain hardcoded display: true (which caused the bug)
		expect(codeOnly).not.toContain("display: true");
	});

	it("initial monitoring message uses display:true in pi.sendMessage", () => {
		// The initial monitoring message is intentionally TUI-visible via pi.sendMessage
		// (not agent-facing, so display:true is correct — it's an informational notice,
		// not an error that the LLM should react to). This is fine because the
		// initial message is brief and non-actionable, and it's sent before any agent
		// context is active, making it unlikely to trigger an LLM reaction.
		const initialIdx = src.indexOf("defaultInitialMsg");
		expect(initialIdx).toBeGreaterThan(-1);

		const nearby = src.slice(Math.max(0, initialIdx - 200), initialIdx + 800);
		expect(nearby).toContain("display: true");
	});
});
