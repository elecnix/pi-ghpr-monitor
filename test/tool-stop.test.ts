/**
 * Structural tests for the ghpr-monitor tool's `stop` action.
 *
 * The monitor's default changed: the LLM *can* now stop monitoring via
 * `ghpr-monitor(action='stop')`. Stopping is deliberately framed as an
 * explicit last-resort operation — for monitors known to be obsolete or
 * redundant — rather than something the agent does on a whim. This keeps
 * the always-on behaviour: monitors keep running until the PR is
 * merged/closed (or a watched run completes), the user stops them, or the
 * agent explicitly stops an obsolete/redundant one.
 *
 * These are white-box tests: they read src/index.ts and assert the
 * structural patterns exist. If a fix is accidentally reverted, the test
 * fails with a clear message.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const src = fs.readFileSync(
	path.join(__dirname, "..", "src", "index.ts"),
	"utf-8",
);

describe("ghpr-monitor tool exposes the stop action to the LLM", () => {
	it("'stop' is in the action union", () => {
		const actionMatch = src.match(/action:\s*Type\.Union\(\[([^\]]+)\]\)/);
		expect(actionMatch).not.toBeNull();
		const actions = actionMatch![1];
		expect(actions).toContain('Type.Literal("start")');
		expect(actions).toContain('Type.Literal("status")');
		expect(actions).toContain('Type.Literal("check")');
		expect(actions).toContain('Type.Literal("stop")');
	});

	it("tool description tells the agent stop is a last resort", () => {
		const descIdx = src.indexOf('name: "ghpr-monitor"');
		expect(descIdx).toBeGreaterThan(-1);
		const descBlock = src.slice(descIdx, descIdx + 1200);
		expect(descBlock).toContain("action='stop'");
		expect(descBlock).toContain("last resort");
		expect(descBlock).not.toContain("agent cannot stop monitoring");
	});

	it("steering prompt allows stopping as a last resort (not forbidden)", () => {
		expect(src).toContain("action='stop'");
		expect(src).toContain("last resort");
		expect(src).not.toContain("You must NOT stop monitoring on your own");
		expect(src).not.toContain("Do NOT stop monitoring on your own");
	});

	it("usage/error text no longer marks stop as user-only", () => {
		expect(src).not.toContain("stop monitoring (user only)");
		expect(src).toContain("stop all monitors (last resort)");
	});
});

describe("tool stop action stops monitors", () => {
	// The stop case lives between the check case and the merge case in the switch.
	const stopBlockStart = src.indexOf('case "stop": {');
	const stopBlockEnd = src.indexOf('case "merge": {', stopBlockStart);
	expect(stopBlockStart).toBeGreaterThan(-1);
	expect(stopBlockEnd).toBeGreaterThan(stopBlockStart);
	const stopBlock = src.slice(stopBlockStart, stopBlockEnd);

	it("stops all monitors when no target is given", () => {
		expect(stopBlock).toContain("stopAllMonitors()");
		expect(stopBlock).toContain('status: "stopped_all"');
	});

	it("stops a specific PR/issue monitor by key", () => {
		expect(stopBlock).toContain("resolvePR()");
		expect(stopBlock).toContain("prKey(resolved.owner, resolved.repo, resolved.number, resolved.host)");
		expect(stopBlock).toContain("stopMonitorByKey(key)");
		expect(stopBlock).toContain('status: "stopped"');
	});

	it("stops a specific workflow-run monitor by run key", () => {
		expect(stopBlock).toContain("params.run_id");
		expect(stopBlock).toContain("runKey(params.owner, params.repo, params.run_id)");
	});

	it("reports idle when no monitors are active", () => {
		expect(stopBlock).toContain('monitors.size === 0');
		expect(stopBlock).toContain('status: "idle"');
	});

	it("reports not_found when the target is not monitored", () => {
		expect(stopBlock).toContain("Not monitoring ${key}");
		expect(stopBlock).toContain('status: "not_found"');
	});

	it("the user-facing /ghpr-monitor off command still exists", () => {
		expect(src).toContain("stopAllMonitors()");
		expect(src).toContain("stopMonitorByKey");
	});
});
