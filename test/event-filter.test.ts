/**
 * Tests for the per-event-kind allowlist passthrough.
 *
 * After the refactor that made pi-ghpr-monitor a thin adapter around the
 * `gh monitor` CLI, the core filtering lives in `gh monitor --events`
 * (https://github.com/elecnix/gh-monitor). The adapter's job is to forward the
 * caller's `events` allowlist to that flag. These tests confirm the
 * `buildMonitorArgs` bridge function emits `--events <comma-list>` when the
 * config carries an allowlist, and omits the flag entirely when it does not
 * (preserving today's "emit everything" default).
 */

import { describe, it, expect } from "vitest";
import { buildMonitorArgs } from "../src/gh-monitor-bridge";
import type { MonitorConfig } from "../src/keys";

function baseConfig(overrides: Partial<MonitorConfig> = {}): MonitorConfig {
	return {
		owner: "o",
		repo: "r",
		number: 42,
		host: "github.com",
		resourceType: "pr",
		mode: "all",
		intervalSec: 60,
		...overrides,
	} as MonitorConfig;
}

describe("buildMonitorArgs events passthrough", () => {
	it("omits --events when config.events is undefined (emit everything)", () => {
		const args = buildMonitorArgs(baseConfig());
		expect(args).not.toContain("--events");
	});

	it("omits --events when config.events is an empty array", () => {
		// An empty array is treated as "no allowlist supplied" — the CLI's
		// default is to emit everything, so we do not forward an empty flag
		// (which the CLI would reject as an unknown-kind error).
		const args = buildMonitorArgs(baseConfig({ events: [] }));
		expect(args).not.toContain("--events");
	});

	it("forwards --events as a comma-separated list when set", () => {
		const args = buildMonitorArgs(baseConfig({ events: ["conflict", "new-failing-checks", "merged"] }));
		const idx = args.indexOf("--events");
		expect(idx).toBeGreaterThan(-1);
		expect(args[idx + 1]).toBe("conflict,new-failing-checks,merged");
	});

	it("forwards --events for a workflow-run target", () => {
		const args = buildMonitorArgs(baseConfig({ resourceType: "run", number: 0, runId: 30433642, events: ["run-completed"] }));
		const idx = args.indexOf("--events");
		expect(idx).toBeGreaterThan(-1);
		expect(args[idx + 1]).toBe("run-completed");
		// The run selector is still present alongside --events.
		expect(args).toContain("--run-id");
	});

	it("forwards --events for an issue target", () => {
		const args = buildMonitorArgs(baseConfig({ resourceType: "issue", number: 7, events: ["issue-new-comment", "issue-closed"] }));
		const idx = args.indexOf("--events");
		expect(idx).toBeGreaterThan(-1);
		expect(args[idx + 1]).toBe("issue-new-comment,issue-closed");
		expect(args).toContain("--issue");
	});

	it("preserves --once alongside --events", () => {
		const args = buildMonitorArgs(baseConfig({ events: ["merged"] }), { once: true });
		expect(args).toContain("--once");
		const idx = args.indexOf("--events");
		expect(idx).toBeGreaterThan(-1);
		expect(args[idx + 1]).toBe("merged");
	});

	it("does not mutate the config.events array", () => {
		const events = ["conflict", "merged"];
		const eventsCopy = [...events];
		buildMonitorArgs(baseConfig({ events }));
		expect(events).toEqual(eventsCopy);
	});
});