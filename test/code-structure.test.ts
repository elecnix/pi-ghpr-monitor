/**
 * Structural tests — verify key bug fixes are present in src/index.ts.
 *
 * These are white-box tests: they read the source and ensure critical
 * logic patterns exist. If a fix is accidentally reverted, the test
 * fails with a clear message.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const src = fs.readFileSync(
  path.join(__dirname, "..", "src", "index.ts"),
  "utf-8"
);

describe("forceNotify fix", () => {
  it("declares forceNotify flag", () => {
    expect(src).toContain("let forceNotify = false;");
  });

  it("sets forceNotify = true in /ghpr-monitor check command", () => {
    const cmdBlock = src.slice(
      src.indexOf('if (lower === "check")'),
      src.indexOf('if (lower === "on"', src.indexOf('if (lower === "check")'))
    );
    expect(cmdBlock).toContain("forceNotify = true;");
  });

  it("sets forceNotify = true in tool check action", () => {
    const actionBlock = src.slice(
      src.indexOf('case "check":'),
      src.indexOf('default:', src.indexOf('case "check":'))
    );
    expect(actionBlock).toContain("forceNotify = true;");
  });

  it("resets forceNotify in stopMonitor", () => {
    expect(src).toMatch(/forceNotify\s*=\s*false/);
  });

  it("forceNotify block sends actionable items or all-clear", () => {
    const block = src.slice(
      src.indexOf("Force-check: always send current state"),
      src.indexOf("Periodic nudge")
    );
    expect(block).toContain("formatActionableItems(curr, config)");
    expect(block).toContain(
      "pi.sendUserMessage(msg, {deliverAs: \"steer\"})"
    );
  });

  it("forceNotify block cleared after use", () => {
    const block = src.slice(
      src.indexOf("Force-check: always send current state"),
      src.indexOf("Periodic nudge")
    );
    expect(block).toContain("forceNotify = false;");
  });
});

describe("lastSentReminder dedup fix", () => {
  it("does NOT clear lastSentReminder in turn_end (prevents escape-loop spam)", () => {
    // The fix: turn_end sets needsReminder=true but does NOT reset lastSentReminder.
    // Clearing lastSentReminder on every turn_end defeats the dedup guard,
    // causing a rapid-fire loop when the user presses Escape (turn_end → poll →
    // reminder → new turn → Escape → turn_end → clear → repeat).
    const turnEndBlock = src.slice(
      src.indexOf('pi.on("turn_end"'),
      src.indexOf('pi.on("session_shutdown"')
    );
    // needsReminder must be set in turn_end
    expect(turnEndBlock).toContain("needsReminder = true;");
    // lastSentReminder must NOT be cleared in turn_end (except when flushing a queued update)
    // Count occurrences of lastSentReminder = null in the turn_end block
    const clears = turnEndBlock.match(/lastSentReminder\s*=\s*null/g);
    // Only the queued update flush should clear it (1 occurrence max)
    // If there's more than 1, the bug is back
    const clearCount = clears ? clears.length : 0;
    expect(clearCount).toBeLessThanOrEqual(1);
    // And if there is 1, it must be inside the queuedUpdate block
    if (clearCount === 1) {
      const queuedBlock = turnEndBlock.slice(
        turnEndBlock.indexOf("if (queuedUpdate !== null)"),
        turnEndBlock.indexOf("// Schedule a reminder")
      );
      expect(queuedBlock).toContain("lastSentReminder = null");
    }
  });

  it("clears lastSentReminder when a real update is sent", () => {
    expect(src).toContain(
      "lastSentReminder = null; // real update supersedes any prior reminder"
    );
  });

  it("dedup check still exists for normal reminders", () => {
    expect(src).toContain("reminder !== lastSentReminder");
  });
});

describe("pollLoop error handler cleanup", () => {
  it("calls updateFooter() when pollLoop rejects (zombie status line bug)", () => {
    // Bug: the .catch() handler on pollLoop sets monitorState to idle
    // but does NOT call updateFooter() or reset state, leaving the
    // status line (radar emoji) visible even though monitoring has stopped.
    // If this test fails, the bug has been reintroduced.
    const catchBlock = src.slice(
      src.indexOf(".catch((err)"),
      src.indexOf("return `Started monitoring", src.indexOf(".catch((err)"))
    );

    // The catch block must call updateFooter() to clear the status line
    expect(catchBlock).toContain("updateFooter();");
    // The catch block must also reset lastStatus so stale data isn't left around
    expect(catchBlock).toContain("lastStatus = null");
  });

  it("stopMonitor resets all state (baseline for comparison)", () => {
    // stopMonitor() is the reference implementation for proper cleanup.
    // It resets: monitorState, lastStatus, lastStatusTimestamp, lastSentUpdate,
    // lastSentReminder, lastNudgeTime, needsReminder, forceNotify,
    // queuedForceCheck, consecutiveNoChange, and calls updateFooter().
    const stopFn = src.slice(
      src.indexOf("function stopMonitor"),
      src.indexOf("async function pollLoop")
    );

    expect(stopFn).toContain("lastStatus = null");
    expect(stopFn).toContain("lastSentUpdate = null");
    expect(stopFn).toContain("lastSentReminder = null");
    expect(stopFn).toContain("lastNudgeTime = 0");
    expect(stopFn).toContain("needsReminder = false");
    expect(stopFn).toContain("forceNotify = false");
    expect(stopFn).toContain("queuedForceCheck = null");
    expect(stopFn).toContain("consecutiveNoChange = 0");
    expect(stopFn).toContain("updateFooter()");
  });
});