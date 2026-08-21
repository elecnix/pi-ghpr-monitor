/**
 * Unit tests for post-merge deployment status monitoring (#85).
 *
 * Covers the pure helpers in src/deployments.ts (terminal-state logic, REST
 * payload parsing, transition formatting, gh orchestration) and the
 * structural wiring in src/index.ts (merged-event interception, per-monitor
 * deploy-tracking state, graceful degradation, tool parameter).
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	type DeploymentSnapshot,
	allDeploymentsTerminal,
	formatDeploymentUpdate,
	isTerminalDeploymentState,
	parseDeploymentsList,
	parseLatestStatusState,
	fetchDeploymentsForSha,
	TERMINAL_DEPLOYMENT_STATES,
	MAX_DEPLOYMENTS_TRACKED,
} from "../src/deployments";

// ---------------------------------------------------------------------------
// Terminal-state logic
// ---------------------------------------------------------------------------

describe("isTerminalDeploymentState", () => {
	it("treats SUCCESS, FAILURE, ERROR and INACTIVE as terminal", () => {
		expect(isTerminalDeploymentState("SUCCESS")).toBe(true);
		expect(isTerminalDeploymentState("FAILURE")).toBe(true);
		expect(isTerminalDeploymentState("ERROR")).toBe(true);
		expect(isTerminalDeploymentState("INACTIVE")).toBe(true);
	});

	it("treats in-flight states as non-terminal", () => {
		expect(isTerminalDeploymentState("PENDING")).toBe(false);
		expect(isTerminalDeploymentState("QUEUED")).toBe(false);
		expect(isTerminalDeploymentState("IN_PROGRESS")).toBe(false);
		expect(isTerminalDeploymentState("WAITING")).toBe(false);
	});

	it("is case-insensitive", () => {
		expect(isTerminalDeploymentState("success")).toBe(true);
		expect(isTerminalDeploymentState("in_progress")).toBe(false);
	});
});

describe("TERMINAL_DEPLOYMENT_STATES", () => {
	it("matches the states documented in issue #85 plus error", () => {
		expect([...TERMINAL_DEPLOYMENT_STATES].sort()).toEqual(["ERROR", "FAILURE", "INACTIVE", "SUCCESS"]);
	});
});

describe("allDeploymentsTerminal", () => {
	it("is false for an empty list (nothing seen yet)", () => {
		expect(allDeploymentsTerminal([])).toBe(false);
	});

	it("is false while any deployment is still in flight", () => {
		const snaps: DeploymentSnapshot[] = [
			{ id: "1", environment: "prod", state: "SUCCESS" },
			{ id: "2", environment: "staging", state: "IN_PROGRESS" },
		];
		expect(allDeploymentsTerminal(snaps)).toBe(false);
	});

	it("is true when all deployments reached a terminal state", () => {
		const snaps: DeploymentSnapshot[] = [
			{ id: "1", environment: "prod", state: "SUCCESS" },
			{ id: "2", environment: "staging", state: "FAILURE" },
		];
		expect(allDeploymentsTerminal(snaps)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// REST payload parsing
// ---------------------------------------------------------------------------

describe("parseDeploymentsList", () => {
	it("extracts id/environment pairs from gh api deployments output", () => {
		const json = JSON.stringify([
			{ id: 123456, sha: "abc123", environment: "production", created_at: "2024-01-01T00:00:00Z" },
			{ id: 123457, sha: "abc123", environment: "staging" },
		]);
		expect(parseDeploymentsList(json)).toEqual([
			{ id: "123456", environment: "production" },
			{ id: "123457", environment: "staging" },
		]);
	});

	it("returns [] on invalid JSON", () => {
		expect(parseDeploymentsList("not json")).toEqual([]);
	});

	it("returns [] on non-array JSON", () => {
		expect(parseDeploymentsList('{"id": 1}')).toEqual([]);
	});

	it("skips entries with missing or wrong-typed ids", () => {
		const json = JSON.stringify([{ environment: "prod" }, { id: null }, { id: "42", environment: "staging" }]);
		expect(parseDeploymentsList(json)).toEqual([{ id: "42", environment: "staging" }]);
	});

	it("defaults missing environment to 'unknown'", () => {
		const json = JSON.stringify([{ id: 7 }]);
		expect(parseDeploymentsList(json)).toEqual([{ id: "7", environment: "unknown" }]);
	});
});

describe("parseLatestStatusState", () => {
	it("extracts the state of the first (latest) status", () => {
		const json = JSON.stringify([{ id: 99, state: "success", created_at: "t" }]);
		expect(parseLatestStatusState(json)).toBe("SUCCESS");
	});

	it("uppercases the state", () => {
		expect(parseLatestStatusState(JSON.stringify([{ state: "in_progress" }]))).toBe("IN_PROGRESS");
	});

	it("returns null for empty lists, invalid JSON, or missing state", () => {
		expect(parseLatestStatusState("[]")).toBeNull();
		expect(parseLatestStatusState("nope")).toBeNull();
		expect(parseLatestStatusState(JSON.stringify([{}]))).toBeNull();
		expect(parseLatestStatusState(JSON.stringify([{ state: 42 }]))).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// formatDeploymentUpdate
// ---------------------------------------------------------------------------

describe("formatDeploymentUpdate", () => {
	const prLabel = "owner/repo#42";

	it("announces current state of each deployment on first sighting (prev = null)", () => {
		const curr: DeploymentSnapshot[] = [{ id: "1", environment: "production", state: "IN_PROGRESS" }];
		const update = formatDeploymentUpdate(null, curr, prLabel);
		expect(update).toContain("production");
		expect(update).toContain(prLabel);
		expect(update).toContain("in_progress");
	});

	it("returns empty string when nothing changed", () => {
		const curr: DeploymentSnapshot[] = [{ id: "1", environment: "production", state: "IN_PROGRESS" }];
		expect(formatDeploymentUpdate(curr, curr.map(s => ({ ...s })), prLabel)).toBe("");
	});

	it("reports state transitions with old → new and an emoji", () => {
		const prev: DeploymentSnapshot[] = [{ id: "1", environment: "production", state: "IN_PROGRESS" }];
		const curr: DeploymentSnapshot[] = [{ id: "1", environment: "production", state: "SUCCESS" }];
		const update = formatDeploymentUpdate(prev, curr, prLabel);
		expect(update).toContain("in_progress →");
		expect(update).toContain("success");
		expect(update).toContain("✅");
	});

	it("reports failure transitions with ❌", () => {
		const prev: DeploymentSnapshot[] = [{ id: "1", environment: "production", state: "IN_PROGRESS" }];
		const curr: DeploymentSnapshot[] = [{ id: "1", environment: "production", state: "FAILURE" }];
		const update = formatDeploymentUpdate(prev, curr, prLabel);
		expect(update).toContain("failure");
		expect(update).toContain("❌");
	});

	it("announces newly appeared deployments without repeating unchanged ones", () => {
		const prev: DeploymentSnapshot[] = [{ id: "1", environment: "production", state: "SUCCESS" }];
		const curr: DeploymentSnapshot[] = [
			{ id: "1", environment: "production", state: "SUCCESS" },
			{ id: "2", environment: "staging", state: "QUEUED" },
		];
		const update = formatDeploymentUpdate(prev, curr, prLabel);
		expect(update).toContain("New deployment to staging");
		expect(update).not.toContain("production");
	});

	it("handles multiple simultaneous transitions", () => {
		const prev: DeploymentSnapshot[] = [
			{ id: "1", environment: "production", state: "IN_PROGRESS" },
			{ id: "2", environment: "staging", state: "PENDING" },
		];
		const curr: DeploymentSnapshot[] = [
			{ id: "1", environment: "production", state: "SUCCESS" },
			{ id: "2", environment: "staging", state: "INACTIVE" },
		];
		const update = formatDeploymentUpdate(prev, curr, prLabel);
		expect(update.split("\n")).toHaveLength(2);
		expect(update).toContain("staging");
		expect(update).toContain("🛑");
	});
});

// ---------------------------------------------------------------------------
// gh orchestration (defensive, never throws on gh failure)
// ---------------------------------------------------------------------------

describe("fetchDeploymentsForSha", () => {
	it("throws when the deployments list cannot be fetched (gh unavailable)", async () => {
		const original = process.env.GH_MONITOR_BIN_ENV;
		// Point PATH lookup at a nonexistent binary via a bogus gh override is
		// not possible (runGh spawns "gh" directly); instead use a SHA that
		// makes gh fail fast without network. We assert the throw contract.
		process.env.GH_MONITOR_BIN_ENV = original;
		await expect(fetchDeploymentsForSha("owner/repo", "not-a-real-sha-xyz")).rejects.toBeTruthy();
	});
});

// ---------------------------------------------------------------------------
// Structural tests: index.ts wiring (index.ts can't be imported under vitest
// because of its pi-tui dependency — same approach as ci-failure-logs.test.ts)
// ---------------------------------------------------------------------------

const indexSrc = fs.readFileSync(path.join(__dirname, "..", "src", "index.ts"), "utf-8");

describe("index.ts wiring for deployment monitoring", () => {
	it("intercepts merged events to start deploy tracking", () => {
		const mergedBlock = indexSrc.slice(
			indexSrc.indexOf('if (n.type === "merged")'),
			indexSrc.indexOf("/** Deliver now, or queue for turn_end"),
		);
		expect(mergedBlock).toContain("startDeployTracking(key, mon)");
		expect(mergedBlock).toContain("config.trackDeployments");
		expect(mergedBlock).toContain('config.resourceType === "pr"');
	});

	it("carries deploy-tracking state on the monitor", () => {
		expect(indexSrc).toContain("interface DeployTrackingState");
		expect(indexSrc).toContain("deployTracking: DeployTrackingState | null");
		expect(indexSrc).toContain("lastSnapshots: DeploymentSnapshot[] | null");
		expect(indexSrc).toContain("emptyPolls: number");
		expect(indexSrc).toContain("errorCount: number");
	});

	it("keeps the monitor entry alive after gh monitor auto-stops on merge", () => {
		expect(indexSrc).toContain("if (mon.deployTracking && !mon.deployTracking.stopped)");
	});

	it("polls deployments via the Deployments REST API through src/deployments", () => {
		expect(indexSrc).toContain("fetchDeploymentsForSha(");
		expect(indexSrc).toContain("fetchMergedHeadOid(config)");
		expect(indexSrc).toContain("allDeploymentsTerminal(snapshots)");
		expect(indexSrc).toContain("formatDeploymentUpdate(dt.lastSnapshots, snapshots, prLabel)");
	});

	it("gracefully stops when no deployments exist (grace period)", () => {
		expect(indexSrc).toContain("MAX_DEPLOY_EMPTY_POLLS");
		expect(indexSrc).toContain("No deployments found for");
	});

	it("gives up after consecutive deployment poll errors", () => {
		expect(indexSrc).toContain("MAX_DEPLOY_ERRORS");
	});

	it("cancels deploy tracking when monitors are stopped", () => {
		expect(indexSrc).toContain("cancelDeployTracking(mon)");
		expect(indexSrc).toContain("cancelDeployTracking");
	});

	it("exposes a track_deployments tool parameter mapped to the monitor config", () => {
		expect(indexSrc).toContain("track_deployments: Type.Optional(Type.Boolean(");
		expect(indexSrc).toContain("trackDeployments: params.track_deployments === true");
	});

	it("documents track_deployments in the tool prompt guidelines", () => {
		expect(indexSrc).toContain("Set track_deployments=true when starting a PR monitor");
	});
});
