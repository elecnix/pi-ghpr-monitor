/**
 * Tests for standalone GitHub Actions workflow-run monitoring.
 *
 * Mirrors the watch-by-run-id feature shipped in gh-monitor#18: when a run_id
 * is supplied, the monitor polls GET /repos/{owner}/{repo}/actions/runs/{run_id}
 * until status == "completed", emitting one notification per genuinely-new
 * status transition (queued → in_progress → completed) and auto-stopping
 * with the run's conclusion.
 *
 * Existing PR/issue monitoring must remain unchanged (backward compatible) —
 * see the dedicated regression suites (analyzer, multi-pr, throttle).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
// Pure run helpers live in importable modules with no pi-tui dependency:
//  - analyzer.ts: RunStatus, snapshotRun, diffRun, isRunTerminal, formatFooterStatus
//  - run-monitor.ts: parseRunUrl, runKey, fetchRunData, RunData (REST shape)
import {
	type RunStatus,
	type MonitorConfig,
	snapshotRun,
	diffRun,
	isRunTerminal,
	formatFooterStatus,
} from "../src/analyzer";
import {
	type RunData,
	parseRunUrl,
	runKey,
	fetchRunData,
} from "../src/run-monitor";

// ---------------------------------------------------------------------------
// Pure unit tests — parsing, keys, snapshots, diffs, footer
// ---------------------------------------------------------------------------

describe("parseRunUrl", () => {
	it("parses a standard GitHub Actions run URL", () => {
		const result = parseRunUrl("https://github.com/elecnix/pi-ghpr-monitor/actions/runs/30433642");
		expect(result).toEqual({
			owner: "elecnix",
			repo: "pi-ghpr-monitor",
			runId: 30433642,
			host: "github.com",
		});
	});

	it("parses a run URL with trailing path segments", () => {
		const result = parseRunUrl("https://github.com/elecnix/pi-ghpr-monitor/actions/runs/30433642/attempts/1");
		expect(result).not.toBeNull();
		expect(result!.runId).toBe(30433642);
	});

	it("parses a run URL with query params", () => {
		const result = parseRunUrl("https://github.com/elecnix/pi-ghpr-monitor/actions/runs/42?check_suite_focus=true");
		expect(result!.runId).toBe(42);
	});

	it("parses a GitHub Enterprise run URL", () => {
		const result = parseRunUrl("https://github.corp.com/team/project/actions/runs/99");
		expect(result).toEqual({
			owner: "team",
			repo: "project",
			runId: 99,
			host: "github.corp.com",
		});
	});

	it("returns null for non-run URLs", () => {
		expect(parseRunUrl("https://github.com/elecnix/pi-ghpr-monitor/pull/123")).toBeNull();
		expect(parseRunUrl("https://github.com/elecnix/pi-ghpr-monitor/issues/5")).toBeNull();
		expect(parseRunUrl("https://github.com/elecnix/pi-ghpr-monitor")).toBeNull();
		expect(parseRunUrl("not a url")).toBeNull();
		expect(parseRunUrl("")).toBeNull();
	});

	it("returns null for a run URL with a non-numeric id", () => {
		expect(parseRunUrl("https://github.com/owner/repo/actions/runs/abc")).toBeNull();
	});

	it("handles whitespace around a run URL", () => {
		const result = parseRunUrl("  https://github.com/elecnix/pi-ghpr-monitor/actions/runs/7  ");
		expect(result!.runId).toBe(7);
	});
});

describe("runKey", () => {
	it("generates a github.com key with the @run/ prefix", () => {
		expect(runKey("elecnix", "pi-ghpr-monitor", 30433642)).toBe("elecnix/pi-ghpr-monitor@run/30433642");
	});

	it("includes the host for GitHub Enterprise", () => {
		expect(runKey("team", "project", 99, "github.corp.com")).toBe("github.corp.com/team/project@run/99");
	});

	it("accepts a MonitorConfig with resourceType run", () => {
		const config: MonitorConfig = {
			owner: "elecnix",
			repo: "pi-ghpr-monitor",
			number: 0,
			host: "github.com",
			resourceType: "run",
			mode: "all",
			intervalSec: 60,
			debounceSec: 30,
			runId: 42,
		};
		expect(runKey(config)).toBe("elecnix/pi-ghpr-monitor@run/42");
	});

	it("does not collide with a PR key for the same owner/repo", () => {
		// PR keys use owner/repo#number; run keys use owner/repo@run/<id>
		expect(runKey("elecnix", "pi-ghpr-monitor", 42)).not.toMatch(/#42$/);
		expect(runKey("elecnix", "pi-ghpr-monitor", 42)).toContain("@run/42");
	});
});

const sampleRun = (overrides: Partial<RunData> = {}): RunData => ({
	id: 30433642,
	name: "CI",
	display_title: "CI #42",
	event: "push",
	status: "in_progress",
	conclusion: null,
	head_branch: "main",
	head_sha: "abc123def456789012345678901234567890abcd",
	html_url: "https://github.com/elecnix/pi-ghpr-monitor/actions/runs/30433642",
	run_number: 42,
	...overrides,
});

describe("snapshotRun", () => {
	it("distills a RunData REST response into a stable RunStatus", () => {
		const s = snapshotRun(sampleRun());
		expect(s.runId).toBe(30433642);
		expect(s.name).toBe("CI");
		expect(s.displayTitle).toBe("CI #42");
		expect(s.event).toBe("push");
		expect(s.status).toBe("in_progress");
		expect(s.conclusion).toBe("");
		expect(s.headBranch).toBe("main");
		expect(s.runNumber).toBe(42);
		expect(s.htmlUrl).toBe("https://github.com/elecnix/pi-ghpr-monitor/actions/runs/30433642");
	});

	it("truncates the head SHA to 7 chars", () => {
		const s = snapshotRun(sampleRun());
		expect(s.shortSha).toBe("abc123d");
		expect(s.headSha).toBe("abc123def456789012345678901234567890abcd");
	});

	it("handles a null name and empty head sha", () => {
		const s = snapshotRun(sampleRun({ name: null as unknown as string, head_sha: "" }));
		expect(s.name).toBe("");
		expect(s.shortSha).toBe("");
	});

	it("captures the conclusion on a completed run", () => {
		const s = snapshotRun(sampleRun({ status: "completed", conclusion: "success" }));
		expect(s.status).toBe("completed");
		expect(s.conclusion).toBe("success");
		expect(isRunTerminal(s)).toBe(true);
	});

	it("is non-terminal while queued or in progress", () => {
		expect(isRunTerminal(snapshotRun(sampleRun({ status: "queued" })))).toBe(false);
		expect(isRunTerminal(snapshotRun(sampleRun({ status: "in_progress" })))).toBe(false);
	});
});

describe("diffRun", () => {
	it("is silent on the first poll (prev == null)", () => {
		const curr = snapshotRun(sampleRun({ status: "in_progress" }));
		expect(diffRun(null, curr)).toEqual([]);
	});

	it("emits nothing when the status is unchanged", () => {
		const prev = snapshotRun(sampleRun({ status: "in_progress" }));
		const curr = snapshotRun(sampleRun({ status: "in_progress" }));
		expect(diffRun(prev, curr)).toEqual([]);
	});

	it("emits run-queued on transition to queued", () => {
		const prev = snapshotRun(sampleRun({ status: "in_progress" }));
		const curr = snapshotRun(sampleRun({ status: "queued" }));
		expect(diffRun(prev, curr)).toEqual([{ type: "run-queued" }]);
	});

	it("emits run-in-progress on transition to in_progress", () => {
		const prev = snapshotRun(sampleRun({ status: "queued" }));
		const curr = snapshotRun(sampleRun({ status: "in_progress" }));
		expect(diffRun(prev, curr)).toEqual([{ type: "run-in-progress" }]);
	});

	it("emits run-completed with the conclusion on transition to completed", () => {
		const prev = snapshotRun(sampleRun({ status: "in_progress" }));
		const curr = snapshotRun(sampleRun({ status: "completed", conclusion: "failure" }));
		expect(diffRun(prev, curr)).toEqual([{ type: "run-completed", conclusion: "failure" }]);
	});

	it("emits run-completed directly from queued to completed", () => {
		const prev = snapshotRun(sampleRun({ status: "queued" }));
		const curr = snapshotRun(sampleRun({ status: "completed", conclusion: "success" }));
		expect(diffRun(prev, curr)).toEqual([{ type: "run-completed", conclusion: "success" }]);
	});
});

describe("formatFooterStatus (run target)", () => {
	const runConfig = (runId = 42): MonitorConfig => ({
		owner: "elecnix",
		repo: "pi-ghpr-monitor",
		number: 0,
		host: "github.com",
		resourceType: "run",
		mode: "all",
		intervalSec: 60,
		debounceSec: 30,
		runId,
	});

	it("shows the run URL before the first poll", () => {
		const footer = formatFooterStatus(runConfig(30433642), null);
		expect(footer).toContain("actions/runs/30433642");
	});

	it("shows a pending emoji while in progress", () => {
		const status = snapshotRun(sampleRun({ status: "in_progress" }));
		const footer = formatFooterStatus(runConfig(), status);
		expect(footer).toContain("⏳");
	});

	it("shows a failure emoji when the conclusion is failure", () => {
		const status = snapshotRun(sampleRun({ status: "completed", conclusion: "failure" }));
		const footer = formatFooterStatus(runConfig(), status);
		expect(footer).toContain("❌");
	});

	it("shows a success emoji when the conclusion is success", () => {
		const status = snapshotRun(sampleRun({ status: "completed", conclusion: "success" }));
		const footer = formatFooterStatus(runConfig(), status);
		expect(footer).toContain("✅");
	});
});

// ---------------------------------------------------------------------------
// REST fetch — fetchRunData against an in-process mock GitHub REST server
// ---------------------------------------------------------------------------

describe("fetchRunData (REST)", () => {
	let server: http.Server;
	const port = 9820;
	const base = `http://localhost:${port}`;
	let runState: RunData;

	beforeAll(async () => {
		runState = sampleRun();
		server = http.createServer((req, res) => {
			const send = (code: number, body: unknown) => {
				res.writeHead(code, { "Content-Type": "application/json" });
				res.end(JSON.stringify(body));
			};
			const url = new URL(req.url || "/", base);
			// GET /repos/{owner}/{repo}/actions/runs/{run_id}
			const m = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/actions\/runs\/([0-9]+)$/);
			if (req.method === "GET" && m) {
				if (Number(m[3]) !== runState.id) {
					send(404, { message: "Not Found" });
					return;
				}
				send(200, runState);
				return;
			}
			send(404, { error: "Not found" });
		});
		await new Promise<void>((r) => server.listen(port, () => r()));
	});

	afterAll(() => server?.close());

	it("parses the REST response into RunData", async () => {
		const config: MonitorConfig = {
			owner: "elecnix",
			repo: "pi-ghpr-monitor",
			number: 0,
			host: "github.com",
			resourceType: "run",
			mode: "all",
			intervalSec: 60,
			debounceSec: 30,
			runId: 30433642,
		};
		const data = await fetchRunData(config, undefined, base);
		expect(data.id).toBe(30433642);
		expect(data.status).toBe("in_progress");
		expect(data.html_url).toContain("actions/runs/30433642");
	});

	it("throws a clear error when the run is not found", async () => {
		const config: MonitorConfig = {
			owner: "elecnix",
			repo: "pi-ghpr-monitor",
			number: 0,
			host: "github.com",
			resourceType: "run",
			mode: "all",
			intervalSec: 60,
			debounceSec: 30,
			runId: 999999,
		};
		await expect(fetchRunData(config, undefined, base)).rejects.toThrow(/not found|404/i);
	});
});

// ---------------------------------------------------------------------------
// White-box structural tests — the tool surface and poll loop wiring
// ---------------------------------------------------------------------------

const src = fs.readFileSync(
	path.join(__dirname, "..", "src", "index.ts"),
	"utf-8",
);
const runSrc = fs.readFileSync(
	path.join(__dirname, "..", "src", "run-monitor.ts"),
	"utf-8",
);

describe("run-monitor tool surface (white-box)", () => {
	it("exposes a run_id parameter on the ghpr-monitor tool", () => {
		expect(src).toMatch(/run_id\s*[:=]\s*Type\.Optional\(Type\.Number/);
	});

	it("describes run_id as monitoring a single workflow run until completion", () => {
		expect(src).toMatch(/run_id.*workflow run/i);
	});

	it("defines pollRunLoop for the run poll loop", () => {
		expect(src).toContain("async function pollRunLoop(mon: ActiveMonitor)");
	});

	it("polls the REST actions/runs endpoint", () => {
		expect(src).toContain("actions/runs/");
	});

	it("auto-stops when the run status is completed", () => {
		const loopStart = src.indexOf("async function pollRunLoop(mon: ActiveMonitor)");
		const loopBlock = src.slice(loopStart, src.length);
		expect(loopBlock).toContain("completed");
		expect(loopBlock).toContain("monitors.delete(key)");
		expect(loopBlock).toContain("updateFooter()");
	});

	it("startMonitor dispatches to pollRunLoop for run targets", () => {
		const startFn = src.slice(
			src.indexOf("function startMonitor(config: MonitorConfig)"),
			src.indexOf("function stopMonitorByKey"),
		);
		expect(startFn).toContain("pollRunLoop");
	});

	it("run keys use the @run/ namespace so they cannot collide with PR keys", () => {
		expect(runSrc).toContain("function runKey");
		expect(runSrc).toContain("@run/");
	});

	it("parseRunUrl is exported", () => {
		expect(runSrc).toContain("export function parseRunUrl");
	});

	it("run_id is mutually exclusive with the PR/issue selector in the start action", () => {
		// When run_id is provided, the tool must not also require/resolve
		// a PR number — it builds a run config directly.
		const startBlock = src.slice(
			src.indexOf("case \"start\": {"),
			src.indexOf("case \"status\": {"),
		);
		expect(startBlock).toContain("run_id");
		expect(startBlock).toMatch(/resourceType:\s*["']run["']/);
	});

	it("the run monitor emits a completion notification carrying the conclusion", () => {
		const loopStart = src.indexOf("async function pollRunLoop(mon: ActiveMonitor)");
		const loopBlock = src.slice(loopStart, src.length);
		expect(loopBlock).toMatch(/run-completed|completed/i);
		expect(loopBlock).toContain("sendPRNotification");
	});
});

describe("run-monitor preferences (white-box)", () => {
	const prefsSrc = fs.readFileSync(
		path.join(__dirname, "..", "src", "preferences.ts"),
		"utf-8",
	);

	it("declares runQueued, runInProgress, runCompleted template keys", () => {
		expect(prefsSrc).toContain("runQueued");
		expect(prefsSrc).toContain("runInProgress");
		expect(prefsSrc).toContain("runCompleted");
	});

	it("registers run template variables in the interpolation regex", () => {
		expect(prefsSrc).toMatch(/runId/);
		expect(prefsSrc).toMatch(/runName/);
		expect(prefsSrc).toMatch(/runNumber/);
		expect(prefsSrc).toMatch(/runConclusion/);
	});
});

// ---------------------------------------------------------------------------
// Backward compatibility — PR/issue monitoring unchanged
// ---------------------------------------------------------------------------

describe("backward compatibility", () => {
	it("still exposes the existing PR-focused parameters", () => {
		expect(src).toContain("owner: Type.Optional");
		expect(src).toContain("repo: Type.Optional");
		expect(src).toContain("pr_number: Type.Optional");
	});

	it("keeps the original PR/issue poll loops", () => {
		expect(src).toContain("async function pollLoop(mon: ActiveMonitor)");
		expect(src).toContain("async function pollIssueLoop(mon: ActiveMonitor)");
	});

	it("the action union still excludes a stop action for the LLM", () => {
		const actionMatch = src.match(/action:\s*Type\.Union\(\[(.+?)\]\)/);
		expect(actionMatch).not.toBeNull();
		const actions = actionMatch![1];
		expect(actions).toContain('"start"');
		expect(actions).toContain("status");
		expect(actions).toContain("check");
		expect(actions).toContain("merge");
		expect(actions).toContain("preferences");
		expect(actions).not.toContain("stop");
	});
});