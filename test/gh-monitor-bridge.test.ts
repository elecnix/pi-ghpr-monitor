/**
 * Tests for the gh-monitor bridge — the module that shells out to `gh monitor`,
 * parses its NDJSON event stream, and exposes prefs get/set/reset/path.
 *
 * Spawning is tested with a mock binary pointed at by GH_MONITOR_BIN (the same
 * escape hatch the adapter uses for test/sandbox runs), so no real `gh` or
 * network is involved.
 */
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	buildMonitorArgs,
	parseNotification,
	spawnMonitor,
	spawnOnce,
	prefsGet,
	prefsSet,
	prefsReset,
	prefsPath,
	type Notification,
} from "../src/gh-monitor-bridge";
import type { MonitorConfig } from "../src/keys";

const savedEnv = { ...process.env };

function mockBinary(script: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghmock-"));
	const file = path.join(dir, "mock-gh-monitor");
	fs.writeFileSync(file, `#!/usr/bin/env node\n${script}\n`, { mode: 0o755 });
	return file;
}

function prConfig(over: Partial<MonitorConfig> = {}): MonitorConfig {
	return {
		owner: "octo",
		repo: "demo",
		number: 42,
		host: "github.com",
		resourceType: "pr",
		mode: "all",
		intervalSec: 60,
		...over,
	};
}

function restoreEnv() {
	delete process.env.GH_MONITOR_BIN;
	for (const k of Object.keys(process.env)) {
		if (!(k in savedEnv)) delete process.env[k];
	}
	Object.assign(process.env, savedEnv);
}

describe("buildMonitorArgs", () => {
	it("builds PR selector args with -R and interval", () => {
		expect(buildMonitorArgs(prConfig())).toEqual([
			"monitor", "-R", "octo/demo", "--interval", "60", "42",
		]);
	});

	it("uses --issue for issue monitors", () => {
		expect(buildMonitorArgs(prConfig({ resourceType: "issue", number: 7 }))).toEqual([
			"monitor", "-R", "octo/demo", "--interval", "60", "--issue", "7",
		]);
	});

	it("uses --run-id for run monitors (no positional selector)", () => {
		expect(buildMonitorArgs(prConfig({ resourceType: "run", number: 0, runId: 99 }))).toEqual([
			"monitor", "-R", "octo/demo", "--interval", "60", "--run-id", "99",
		]);
	});

	it("appends --once for one-shot runs", () => {
		expect(buildMonitorArgs(prConfig(), { once: true })).toEqual([
			"monitor", "-R", "octo/demo", "--interval", "60", "42", "--once",
		]);
	});

	it("enforces a minimum interval of 10s", () => {
		const args = buildMonitorArgs(prConfig({ intervalSec: 3 }));
		expect(args[args.indexOf("--interval") + 1]).toBe("10");
	});
});

describe("parseNotification", () => {
	it("parses a full NDJSON line into the typed shape", () => {
		const line = JSON.stringify({
			type: "new-unresolved-threads",
			pr_label: "octo/demo#42",
			message: "💬 2 unresolved review thread(s) on octo/demo#42",
			unresolved_threads: 2,
			general_comments: 1,
			detail: "src/foo.ts:10 (by alice)\n  please fix",
			pr_url: "https://github.com/octo/demo/pull/42",
			timestamp: "2026-07-10T12:00:00Z",
		});
		const n = parseNotification(line);
		expect(n).not.toBeNull();
		expect(n!.type).toBe("new-unresolved-threads");
		expect(n!.unresolved_threads).toBe(2);
		expect(n!.detail).toContain("src/foo.ts:10");
		expect(n!.pr_url).toBe("https://github.com/octo/demo/pull/42");
	});

	it("returns null on invalid JSON", () => {
		expect(parseNotification("not json")).toBeNull();
	});

	it("returns null on empty lines", () => {
		expect(parseNotification("")).toBeNull();
		expect(parseNotification("   ")).toBeNull();
	});
});

describe("spawnMonitor", () => {
	afterEach(restoreEnv);

	it("streams NDJSON events to onNotification", async () => {
		const events: Notification[] = [
			{ type: "first-poll", message: "📡 Monitoring octo/demo#42", pr_label: "octo/demo#42" },
			{ type: "new-unresolved-threads", message: "💬 1 thread", pr_label: "octo/demo#42", unresolved_threads: 1 },
		];
		const bin = mockBinary(`const e=${JSON.stringify(events)}; for (const x of e) console.log(JSON.stringify(x));`);
		process.env.GH_MONITOR_BIN = bin;

		const got: Notification[] = [];
		await new Promise<void>((resolve) => {
			spawnMonitor(prConfig(), {
				onNotification: (n) => got.push(n),
				onExit: () => resolve(),
			});
		});
		expect(got.map((n) => n.type)).toEqual(["first-poll", "new-unresolved-threads"]);
	});

	it("calls onExit with code 0 on clean exit (auto-stop)", async () => {
		const bin = mockBinary(`console.log(JSON.stringify({type:"merged",message:"m",pr_label:"octo/demo#42"}));`);
		process.env.GH_MONITOR_BIN = bin;
		const code = await new Promise<number | null>((resolve) => {
			spawnMonitor(prConfig(), { onNotification: () => {}, onExit: (c) => resolve(c) });
		});
		expect(code).toBe(0);
	});

	it("abort() kills the process and triggers onExit", async () => {
		const bin = mockBinary(`setInterval(() => {}, 1000);`);
		process.env.GH_MONITOR_BIN = bin;
		const code = await new Promise<number | null>((resolve) => {
			const handle = spawnMonitor(prConfig(), {
				onNotification: () => {},
				onExit: (c) => resolve(c),
			});
			setTimeout(() => handle.abort(), 100);
		});
		expect(code === null || (code as number) !== 0).toBe(true);
	});

	it("reports stderr and nonzero exit via onExit", async () => {
		const bin = mockBinary(`process.stderr.write("boom\\n"); process.exit(2);`);
		process.env.GH_MONITOR_BIN = bin;
		const result = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
			spawnMonitor(prConfig(), {
				onNotification: () => {},
				onExit: (code, stderr) => resolve({ code, stderr }),
			});
		});
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("boom");
	});
});

describe("spawnOnce", () => {
	afterEach(restoreEnv);

	it("collects all events from a --once run", async () => {
		const events = [
			{ type: "first-poll", message: "f", pr_label: "octo/demo#42" },
			{ type: "all-clear", message: "a", pr_label: "octo/demo#42" },
		];
		const bin = mockBinary(`const e=${JSON.stringify(events)}; for (const x of e) console.log(JSON.stringify(x));`);
		process.env.GH_MONITOR_BIN = bin;
		const got = await spawnOnce(prConfig());
		expect(got.map((n) => n.type)).toEqual(["first-poll", "all-clear"]);
	});

	it("rejects on nonzero exit", async () => {
		const bin = mockBinary(`process.stderr.write("nope\\n"); process.exit(1);`);
		process.env.GH_MONITOR_BIN = bin;
		await expect(spawnOnce(prConfig())).rejects.toThrow();
	});
});

describe("prefs shell-out", () => {
	afterEach(restoreEnv);

	it("prefsGet parses JSON from stdout", async () => {
		const bin = mockBinary(`console.log(JSON.stringify({templates:{conflict:"x {prLabel}"},ignoredBots:[],retriggerComments:false}));`);
		process.env.GH_MONITOR_BIN = bin;
		const p = await prefsGet();
		expect(p.templates.conflict).toBe("x {prLabel}");
	});

	it("prefsSet forwards JSON arg and returns parsed result", async () => {
		// Mock parses the JSON passed after `set` and echoes the conflict
		// template back, proving the bridge forwarded the argument correctly.
		const bin = mockBinary(`const a=process.argv.slice(2); const i=a.indexOf("set"); const json=a[i+1]||"{}"; const o=JSON.parse(json); console.log(JSON.stringify({templates:{conflict:(o.templates&&o.templates.conflict)||""},ignoredBots:[],retriggerComments:false}));`);
		process.env.GH_MONITOR_BIN = bin;
		const p = await prefsSet('{"templates":{"conflict":"y {prLabel}"}}');
		expect(p.templates.conflict).toBe("y {prLabel}");
	});

	it("prefsPath returns the trimmed stdout line", async () => {
		const bin = mockBinary(`console.log("/tmp/config/gh-monitor/preferences.json");`);
		process.env.GH_MONITOR_BIN = bin;
		expect(await prefsPath()).toBe("/tmp/config/gh-monitor/preferences.json");
	});

	it("prefsReset returns parsed JSON", async () => {
		const bin = mockBinary(`console.log(JSON.stringify({templates:{},ignoredBots:[],retriggerComments:false}));`);
		process.env.GH_MONITOR_BIN = bin;
		const p = await prefsReset();
		expect(p.retriggerComments).toBe(false);
	});
});