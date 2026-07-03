/**
 * Tests for the Linear monitor manager (src/linear-monitor.ts).
 *
 * The manager owns the set of monitored issues, the per-poll diff/deliver
 * cycle, throttling during agent turns, and backoff on error. It talks to the
 * host (the pi extension) through an injected {@link LinearMonitorHost} and to
 * Linear through an injected fetch — so these tests never touch the network or
 * the pi runtime.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { LinearMonitorManager } from "../src/linear-monitor";
import type { LinearMonitorHost } from "../src/linear-monitor";
import type { LinearIssueData } from "../src/linear";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function makeIssue(overrides: Partial<LinearIssueData> = {}): LinearIssueData {
	return {
		id: "uuid-1",
		identifier: "ENG-123",
		title: "Fix the flux capacitor",
		url: "https://linear.app/acme/issue/ENG-123/fix",
		state: { name: "In Progress", type: "started" },
		priority: 2,
		priorityLabel: "High",
		assignee: { displayName: "marty" },
		comments: { nodes: [] },
		attachments: { nodes: [] },
		...overrides,
	};
}

interface Delivered {
	concise: string;
	detailed: string;
}

class FakeHost implements LinearMonitorHost {
	delivered: Delivered[] = [];
	notifications: Array<{ msg: string; level: string }> = [];
	footer: string | undefined = undefined;
	turnActive = false;
	ignoredBots: string[] = [];
	apiKey: string | null = "lin_api_test";

	/** The issue the fake fetch returns; mutate between polls to simulate change. */
	issue: LinearIssueData | null = makeIssue();
	/** When set, the next fetch rejects with this error. */
	failWith: Error | null = null;

	fetchImpl = (async () => {
		if (this.failWith) {
			const status = /rate limit/i.test(this.failWith.message) ? 429 : 200;
			if (status === 429) return new Response("{}", { status: 429 });
			throw this.failWith;
		}
		return new Response(JSON.stringify({ data: { issue: this.issue } }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}) as unknown as typeof fetch;

	sendNotification(concise: string, detailed: string): void {
		this.delivered.push({ concise, detailed });
	}
	notify(msg: string, level: "info" | "warning" | "error"): void {
		this.notifications.push({ msg, level });
	}
	setFooter(text: string | undefined): void {
		this.footer = text;
	}
	isAgentTurnActive(): boolean {
		return this.turnActive;
	}
	getIgnoredBots(): string[] {
		return this.ignoredBots;
	}
	getApiKey(): string | null {
		return this.apiKey;
	}
}

// ---------------------------------------------------------------------------

describe("LinearMonitorManager", () => {
	let host: FakeHost;
	let mgr: LinearMonitorManager;

	beforeEach(() => {
		host = new FakeHost();
		mgr = new LinearMonitorManager(host);
	});

	it("registers and lists monitors", () => {
		const res = mgr.add({ key: "ENG-123" }, { autoStart: false });
		expect(res.key).toBe("ENG-123");
		expect(mgr.list()).toContain("ENG-123");
		expect(res.alreadyMonitoring).toBeFalsy();
	});

	it("does not double-register the same issue", () => {
		mgr.add({ key: "ENG-123" }, { autoStart: false });
		const again = mgr.add({ key: "ENG-123" }, { autoStart: false });
		expect(again.alreadyMonitoring).toBe(true);
		expect(mgr.list()).toHaveLength(1);
	});

	it("refuses to start without an API key and points at LINEAR_API_KEY", () => {
		host.apiKey = null;
		const res = mgr.add({ key: "ENG-123" }, { autoStart: false });
		expect(res.error).toMatch(/LINEAR_API_KEY/);
		expect(mgr.list()).toHaveLength(0);
	});

	it("first poll seeds state without notifying, and updates the footer", async () => {
		mgr.add({ key: "ENG-123" }, { autoStart: false });
		await mgr.pollOnce("ENG-123");
		expect(host.delivered).toHaveLength(0);
		expect(host.footer).toContain("ENG-123");
	});

	it("delivers a notification when a new comment appears", async () => {
		mgr.add({ key: "ENG-123" }, { autoStart: false });
		await mgr.pollOnce("ENG-123"); // seed

		host.issue = makeIssue({
			comments: { nodes: [{ id: "c1", body: "please review", createdAt: "2026-01-02T00:00:00Z", user: { displayName: "alice" } }] },
		});
		await mgr.pollOnce("ENG-123");

		expect(host.delivered).toHaveLength(1);
		expect(host.delivered[0].detailed).toContain("please review");
	});

	it("queues updates while the agent is working, flushing on turn end", async () => {
		mgr.add({ key: "ENG-123" }, { autoStart: false });
		await mgr.pollOnce("ENG-123"); // seed

		host.turnActive = true;
		host.issue = makeIssue({ state: { name: "Done", type: "completed" } });
		await mgr.pollOnce("ENG-123");
		expect(host.delivered).toHaveLength(0); // throttled

		host.turnActive = false;
		mgr.flushQueued();
		expect(host.delivered).toHaveLength(1);
		expect(host.delivered[0].concise).toContain("Done");
	});

	it("does not re-deliver an unchanged update", async () => {
		mgr.add({ key: "ENG-123" }, { autoStart: false });
		await mgr.pollOnce("ENG-123"); // seed
		host.issue = makeIssue({ state: { name: "Done", type: "completed" } });
		await mgr.pollOnce("ENG-123");
		await mgr.pollOnce("ENG-123"); // same state again — no new change
		expect(host.delivered).toHaveLength(1);
	});

	it("force-check reports current items even without a change", async () => {
		host.issue = makeIssue({
			comments: { nodes: [{ id: "c1", body: "look at this", createdAt: "2026-01-02T00:00:00Z", user: { displayName: "alice" } }] },
		});
		mgr.add({ key: "ENG-123" }, { autoStart: false });
		await mgr.pollOnce("ENG-123"); // seed — sees the comment as "existing", no diff
		expect(host.delivered).toHaveLength(0);

		mgr.check("ENG-123");
		await mgr.pollOnce("ENG-123");
		expect(host.delivered).toHaveLength(1);
		expect(host.delivered[0].detailed).toContain("look at this");
	});

	it("notifies the TUI and backs off on a poll error (no crash)", async () => {
		mgr.add({ key: "ENG-123" }, { autoStart: false });
		host.failWith = new Error("network down");
		await mgr.pollOnce("ENG-123");
		expect(host.delivered).toHaveLength(0);
		expect(host.notifications.some((n) => n.level === "warning")).toBe(true);
		expect(mgr.get("ENG-123")!.backoffSec).toBeGreaterThan(0);
	});

	it("treats HTTP 429 as a rate-limit backoff", async () => {
		mgr.add({ key: "ENG-123" }, { autoStart: false });
		host.failWith = new Error("rate limit");
		await mgr.pollOnce("ENG-123");
		expect(host.notifications.some((n) => /rate limit/i.test(n.msg))).toBe(true);
	});

	it("stops a single monitor and clears the footer when none remain", () => {
		mgr.add({ key: "ENG-123" }, { autoStart: false });
		host.footer = "something";
		const msg = mgr.stop("ENG-123");
		expect(msg).toMatch(/ENG-123/);
		expect(mgr.list()).toHaveLength(0);
		expect(host.footer).toBeUndefined();
	});

	it("stopAll clears every monitor", () => {
		mgr.add({ key: "ENG-1" }, { autoStart: false });
		mgr.add({ key: "ENG-2" }, { autoStart: false });
		mgr.stopAll();
		expect(mgr.list()).toHaveLength(0);
	});
});
