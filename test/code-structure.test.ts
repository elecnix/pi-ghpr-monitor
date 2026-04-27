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
      src.indexOf("if (forceNotify && !agentTurnActive)"),
      src.indexOf("Periodic nudge")
    );
    expect(block).toContain("formatActionableItems(curr, config)");
    expect(block).toContain(
      "pi.sendUserMessage(msg, {deliverAs: \"steer\"})"
    );
  });

  it("forceNotify block cleared after use", () => {
    const block = src.slice(
      src.indexOf("if (forceNotify && !agentTurnActive)"),
      src.indexOf("Periodic nudge")
    );
    expect(block).toContain("forceNotify = false;");
  });
});

describe("lastSentReminder dedup fix", () => {
  it("clears lastSentReminder in turn_end when monitoring is active", () => {
    const idx = src.indexOf("// clear so reminder can re-fire after each turn");
    expect(idx).toBeGreaterThan(0);
    // Verify it's inside the turn_end handler (after turn_end, before session_shutdown)
    expect(src.indexOf("pi.on(\"turn_end\"")).toBeLessThan(idx);
    expect(src.indexOf("pi.on(\"session_shutdown\"")).toBeGreaterThan(idx);
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
