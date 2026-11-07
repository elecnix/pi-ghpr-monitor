/**
 * Monitors resume when Pi resumes a session after a restart.
 *
 * The adapter records each monitor in the Pi session as a custom entry
 * (`pi.appendEntry`), and records its removal when it stops for any reason
 * other than the Pi process ending. On `session_start` it reads the current
 * branch's entries and starts the monitors that are still recorded as live.
 *
 * The behavioural tests load the real extension with a fake Pi API and a fake
 * bridge. A second `ghprMonitorExtension(pi)` call stands in for a new Pi
 * process: it starts with an empty in-memory monitor map and sees only the
 * session entries the first one wrote.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import type { MonitorConfig } from "../src/keys";
import type { Notification } from "../src/render";

// --- fakes -----------------------------------------------------------------

vi.mock("@mariozechner/pi-tui", () => {
	class Text { constructor(public text: string) {} }
	class Box { children: unknown[] = []; addChild(c: unknown) { this.children.push(c); } }
	return { Text, Box };
});

interface SpawnCall {
	config: MonitorConfig;
	opts: { instance?: string } | undefined;
	onNotification: (n: Notification) => void;
	onExit: (code: number | null, stderr: string) => void;
	aborted: boolean;
}
const spawnCalls: SpawnCall[] = [];
const resetInstanceCalls: string[] = [];

vi.mock("../src/gh-monitor-bridge", () => ({
	spawnMonitor: (config: MonitorConfig, handlers: { onNotification: (n: Notification) => void; onExit: (c: number | null, s: string) => void }, opts?: { instance?: string }) => {
		const call: SpawnCall = { config, opts, onNotification: handlers.onNotification, onExit: handlers.onExit, aborted: false };
		spawnCalls.push(call);
		return { abort: () => { call.aborted = true; }, child: {} };
	},
	spawnOnce: async () => [],
	resetInstance: (name: string) => { resetInstanceCalls.push(name); },
	prefsGet: async () => ({ templates: {}, ignoredBots: [], retriggerComments: false }),
	prefsSet: async () => ({ templates: {}, ignoredBots: [], retriggerComments: false }),
	prefsReset: async () => ({ templates: {}, ignoredBots: [], retriggerComments: false }),
	prefsPath: async () => "/dev/null",
}));

const deployFetches: string[] = [];
let deploySnapshots: Array<{ id: number; environment: string; state: string }> = [];
vi.mock("../src/deployments", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/deployments")>();
	return {
		...actual,
		fetchDeploymentsForSha: async (_repo: string, sha: string) => { deployFetches.push(sha); return deploySnapshots; },
		fetchMergedHeadOid: async () => "abc1234def",
	};
});

import ghprMonitorExtension from "../src/index";
import { MONITOR_ENTRY_TYPE, restorableMonitors, instanceName } from "../src/session-monitors";

type Handler = (event: any, ctx: any) => unknown;

interface SessionEntry { type: string; id: string; customType?: string; data?: unknown }

/** A Pi session file: the entries survive across fake Pi processes. */
class FakeSession {
	entries: SessionEntry[] = [];
	constructor(public id = "sess-1") {}
	manager() {
		return {
			getSessionId: () => this.id,
			getSessionFile: () => `/tmp/${this.id}.jsonl`,
			getBranch: () => [...this.entries],
			getEntries: () => [...this.entries],
		};
	}
}

/** One Pi process running the extension against a session. */
class FakePi {
	handlers = new Map<string, Handler[]>();
	commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
	tools = new Map<string, { execute: (...a: any[]) => Promise<any> }>();
	sent: Array<{ message: any; options: any }> = [];
	notices: string[] = [];
	status: string | undefined;

	constructor(public session: FakeSession) {
		ghprMonitorExtension(this.api() as any);
	}

	api() {
		return {
			on: (name: string, h: Handler) => {
				const list = this.handlers.get(name) ?? [];
				list.push(h);
				this.handlers.set(name, list);
			},
			registerCommand: (name: string, def: any) => this.commands.set(name, def),
			registerTool: (def: any) => this.tools.set(def.name, def),
			registerMessageRenderer: () => {},
			sendMessage: (message: any, options?: any) => this.sent.push({ message, options }),
			sendUserMessage: () => {},
			appendEntry: (customType: string, data?: unknown) => {
				this.session.entries.push({ type: "custom", id: `e${this.session.entries.length}`, customType, data });
			},
		};
	}

	ctx() {
		return {
			sessionManager: this.session.manager(),
			ui: {
				notify: (msg: string) => this.notices.push(msg),
				setStatus: (_k: string, v: string | undefined) => { this.status = v; },
			},
			hasUI: true,
		};
	}

	async emit(name: string, event: any = {}) {
		for (const h of this.handlers.get(name) ?? []) await h({ type: name, ...event }, this.ctx());
	}

	async startTool(params: Record<string, unknown>) {
		return this.tools.get("ghpr-monitor")!.execute("call-1", { action: "start", ...params }, undefined, undefined, this.ctx());
	}

	async tool(params: Record<string, unknown>) {
		return this.tools.get("ghpr-monitor")!.execute("call-1", params, undefined, undefined, this.ctx());
	}

	async command(args: string) {
		await this.commands.get("ghpr-monitor")!.handler(args, this.ctx());
	}
}

function note(type: string, extra: Partial<Notification> = {}): Notification {
	return { type, pr_label: "octo/demo#42", message: `${type} on octo/demo#42`, ...extra } as Notification;
}

/** Start Pi, open the session, start a monitor, then quit Pi. */
async function firstRun(session: FakeSession, params: Record<string, unknown> = { url: "octo/demo#42" }) {
	const pi = new FakePi(session);
	await pi.emit("session_start", { reason: "startup" });
	await pi.startTool(params);
	return pi;
}

beforeEach(() => {
	spawnCalls.length = 0;
	resetInstanceCalls.length = 0;
	deployFetches.length = 0;
	deploySnapshots = [];
});

// --- pure entry folding -----------------------------------------------------

describe("restorableMonitors", () => {
	const config: MonitorConfig = { owner: "octo", repo: "demo", number: 42, host: "github.com", resourceType: "pr", mode: "all", intervalSec: 60 };
	const entry = (data: unknown) => ({ type: "custom", customType: MONITOR_ENTRY_TYPE, data });

	it("returns nothing when the session has no monitor entries", () => {
		expect(restorableMonitors([])).toEqual([]);
		expect(restorableMonitors([{ type: "message" }, { type: "custom", customType: "other", data: { op: "watch" } }])).toEqual([]);
	});

	it("returns a watched monitor", () => {
		const out = restorableMonitors([entry({ op: "watch", key: "octo/demo#42", config })]);
		expect(out).toEqual([{ key: "octo/demo#42", config }]);
	});

	it("drops a monitor whose last entry is an unwatch", () => {
		expect(restorableMonitors([
			entry({ op: "watch", key: "octo/demo#42", config }),
			entry({ op: "unwatch", key: "octo/demo#42", reason: "stopped" }),
		])).toEqual([]);
	});

	it("keeps the latest config when a monitor is recorded twice", () => {
		const out = restorableMonitors([
			entry({ op: "watch", key: "octo/demo#42", config }),
			entry({ op: "watch", key: "octo/demo#42", config: { ...config, autoMerge: true } }),
		]);
		expect(out).toEqual([{ key: "octo/demo#42", config: { ...config, autoMerge: true } }]);
	});

	it("restarts a monitor that was watched again after a stop", () => {
		const out = restorableMonitors([
			entry({ op: "watch", key: "octo/demo#42", config }),
			entry({ op: "unwatch", key: "octo/demo#42", reason: "stopped" }),
			entry({ op: "watch", key: "octo/demo#42", config }),
		]);
		expect(out.map((m) => m.key)).toEqual(["octo/demo#42"]);
	});

	it("ignores malformed entries", () => {
		expect(restorableMonitors([
			entry(undefined),
			entry({ op: "watch" }),
			entry({ op: "watch", key: "k", config: { owner: "o" } }),
			entry({ op: "bogus", key: "k" }),
		])).toEqual([]);
	});

	it("carries the deployment-tracking state", () => {
		const out = restorableMonitors([
			entry({ op: "watch", key: "octo/demo#42", config: { ...config, trackDeployments: true }, deploy: { sha: "abc1234", snapshots: [] } }),
		]);
		expect(out[0]!.deploy).toEqual({ sha: "abc1234", snapshots: [] });
	});
});

describe("instanceName", () => {
	it("is stable for a session and monitor key", () => {
		expect(instanceName("sess-1", "octo/demo#42")).toBe(instanceName("sess-1", "octo/demo#42"));
	});

	it("differs across sessions and monitors", () => {
		expect(instanceName("sess-1", "octo/demo#42")).not.toBe(instanceName("sess-2", "octo/demo#42"));
		expect(instanceName("sess-1", "octo/demo#42")).not.toBe(instanceName("sess-1", "octo/demo#43"));
	});

	it("uses only filename-safe characters", () => {
		expect(instanceName("sess-1", "ghe.example.com/octo/demo@run/7")).toMatch(/^[A-Za-z0-9._-]+$/);
	});
});

// --- behaviour across a Pi restart -----------------------------------------

describe("monitor persistence across a Pi restart", () => {
	it("records the monitor in the session when it starts", async () => {
		const session = new FakeSession();
		await firstRun(session);
		const data = session.entries.filter((e) => e.customType === MONITOR_ENTRY_TYPE).map((e) => e.data as any);
		expect(data).toHaveLength(1);
		expect(data[0].op).toBe("watch");
		expect(data[0].config).toMatchObject({ owner: "octo", repo: "demo", number: 42 });
	});

	it("starts gh monitor with a session-scoped named instance", async () => {
		const session = new FakeSession();
		await firstRun(session);
		expect(spawnCalls).toHaveLength(1);
		expect(spawnCalls[0]!.opts?.instance).toBe(instanceName("sess-1", "octo/demo#42"));
	});

	it("re-arms a monitor after session shutdown and a new session_start", async () => {
		const session = new FakeSession();
		const first = await firstRun(session, { url: "octo/demo#42", wakeOn: ["new-failing-checks"] });
		await first.emit("session_shutdown", { reason: "quit" });
		expect(spawnCalls[0]!.aborted).toBe(true);

		const second = new FakePi(session);
		await second.emit("session_start", { reason: "resume" });

		expect(spawnCalls).toHaveLength(2);
		const resumed = spawnCalls[1]!;
		expect(resumed.config).toMatchObject({ owner: "octo", repo: "demo", number: 42, wakeOn: ["new-failing-checks"] });
		// Same instance name, so gh monitor diffs from the stored snapshot.
		expect(resumed.opts?.instance).toBe(spawnCalls[0]!.opts?.instance);
	});

	it("does not record an unwatch on session shutdown", async () => {
		const session = new FakeSession();
		const first = await firstRun(session);
		await first.emit("session_shutdown", { reason: "quit" });
		const ops = session.entries.filter((e) => e.customType === MONITOR_ENTRY_TYPE).map((e) => (e.data as any).op);
		expect(ops).toEqual(["watch"]);
		expect(resetInstanceCalls).toEqual([]);
	});

	it("re-arms after a hard kill (no session_shutdown)", async () => {
		const session = new FakeSession();
		await firstRun(session);
		const second = new FakePi(session);
		await second.emit("session_start", { reason: "startup" });
		expect(spawnCalls).toHaveLength(2);
	});

	it("does not re-arm a monitor the agent stopped", async () => {
		const session = new FakeSession();
		const first = await firstRun(session);
		await first.tool({ action: "stop", url: "octo/demo#42" });
		await first.emit("session_shutdown", { reason: "quit" });

		const second = new FakePi(session);
		await second.emit("session_start", { reason: "resume" });
		expect(spawnCalls).toHaveLength(1);
		expect(resetInstanceCalls).toEqual([instanceName("sess-1", "octo/demo#42")]);
	});

	it("does not re-arm a monitor the user stopped with /ghpr-monitor off", async () => {
		const session = new FakeSession();
		const first = await firstRun(session);
		await first.command("off");
		const second = new FakePi(session);
		await second.emit("session_start", { reason: "resume" });
		expect(spawnCalls).toHaveLength(1);
	});

	it("does not re-arm a monitor that ended on merge", async () => {
		const session = new FakeSession();
		const first = await firstRun(session);
		spawnCalls[0]!.onNotification(note("merged"));
		spawnCalls[0]!.onExit(0, "");
		const second = new FakePi(session);
		await second.emit("session_start", { reason: "resume" });
		expect(spawnCalls).toHaveLength(1);
	});

	it("does not re-arm a monitor that exited with an error", async () => {
		const session = new FakeSession();
		const first = await firstRun(session);
		spawnCalls[0]!.onExit(1, "boom");
		const second = new FakePi(session);
		await second.emit("session_start", { reason: "resume" });
		expect(spawnCalls).toHaveLength(1);
	});

	it("starts nothing when the session has no monitor entries", async () => {
		const pi = new FakePi(new FakeSession());
		await pi.emit("session_start", { reason: "resume" });
		expect(spawnCalls).toHaveLength(0);
		expect(pi.sent).toHaveLength(0);
	});

	it("does not start a second gh monitor for a monitor that is already running", async () => {
		const session = new FakeSession();
		const pi = await firstRun(session);
		await pi.emit("session_start", { reason: "reload" });
		expect(spawnCalls).toHaveLength(1);
		await pi.command("on");
		expect(spawnCalls).toHaveLength(1);
	});

	it("keeps the auto-merge toggle across a restart", async () => {
		const session = new FakeSession();
		const first = await firstRun(session);
		await first.command("merge");
		const second = new FakePi(session);
		await second.emit("session_start", { reason: "resume" });
		expect(spawnCalls[1]!.config.autoMerge).toBe(true);
	});

	it("tells the session which monitors it resumed, without starting a turn", async () => {
		const session = new FakeSession();
		await firstRun(session);
		const second = new FakePi(session);
		await second.emit("session_start", { reason: "resume" });
		expect(second.sent).toHaveLength(1);
		expect(second.sent[0]!.message.content).toContain("octo/demo#42");
		expect(second.sent[0]!.options?.triggerTurn).toBeFalsy();
	});

	it("does not wake the agent on a re-armed monitor's first poll", async () => {
		const session = new FakeSession();
		await firstRun(session, { url: "octo/demo#42", wakeOn: ["*"] });
		const second = new FakePi(session);
		await second.emit("session_start", { reason: "resume" });
		const before = second.sent.length;
		spawnCalls[1]!.onNotification(note("first-poll"));
		const after = second.sent.slice(before);
		expect(after).toHaveLength(1);
		expect(after[0]!.options?.triggerTurn).toBeFalsy();
	});

	it("delivers a merge that happened while Pi was down, then forgets the monitor", async () => {
		const session = new FakeSession();
		await firstRun(session, { url: "octo/demo#42", wakeOn: ["merged"] });
		const second = new FakePi(session);
		await second.emit("session_start", { reason: "resume" });
		const before = second.sent.length;
		spawnCalls[1]!.onNotification(note("merged"));
		spawnCalls[1]!.onExit(0, "");
		const merged = second.sent.slice(before);
		expect(merged).toHaveLength(1);
		expect(merged[0]!.options?.triggerTurn).toBe(true);

		const third = new FakePi(session);
		await third.emit("session_start", { reason: "resume" });
		expect(spawnCalls).toHaveLength(2);
	});
});

describe("deployment tracking across a Pi restart", () => {
	const flush = () => new Promise((r) => setTimeout(r, 0));

	it("resumes polling the recorded commit without starting gh monitor or repeating states", async () => {
		const session = new FakeSession();
		const first = await firstRun(session, { url: "octo/demo#42", track_deployments: true });
		deploySnapshots = [{ id: 1, environment: "production", state: "IN_PROGRESS" }];
		spawnCalls[0]!.onNotification(note("merged"));
		spawnCalls[0]!.onExit(0, "");
		await flush(); await flush();
		const watches = session.entries.map((e) => e.data as any).filter((d) => d?.op === "watch");
		expect(watches.at(-1).deploy).toEqual({ sha: "abc1234def", snapshots: deploySnapshots });
		await first.emit("session_shutdown", { reason: "quit" });

		const second = new FakePi(session);
		await second.emit("session_start", { reason: "resume" });
		await flush();
		expect(spawnCalls).toHaveLength(1);
		expect(deployFetches.at(-1)).toBe("abc1234def");
		// Same deployment state as before the restart: only the resume notice.
		expect(second.sent).toHaveLength(1);
		expect(second.sent[0]!.message.content).toContain("Resumed monitoring");
	});
});

describe("/ghpr-monitor on", () => {
	it("resumes the recorded monitors when none is running and reports them", async () => {
		const session = new FakeSession();
		await firstRun(session);
		// A new Pi process that has not re-armed (for example, its session_start ran before the entries existed).
		const second = new FakePi(session);
		await second.command("on");
		expect(spawnCalls).toHaveLength(2);
		expect(second.notices.join("\n")).toMatch(/Resumed monitoring 1 resource\(s\): octo\/demo#42/);
	});

	it("says so when there is nothing to resume", async () => {
		const pi = new FakePi(new FakeSession());
		await pi.command("on");
		expect(spawnCalls).toHaveLength(0);
		expect(pi.notices.join("\n")).toContain("No PR monitors running");
	});
});
