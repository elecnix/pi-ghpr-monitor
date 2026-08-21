/**
 * Unit tests for keys.ts — URL/shorthand parsing and monitor keys.
 */
import { describe, it, expect } from "vitest";
import {
	parsePRUrl,
	parseIssueUrl,
	parsePRShorthand,
	parseRunUrl,
	prKey,
	runKey,
	monitorKey,
	resourceUrl,
	type MonitorConfig,
} from "../src/keys";

function cfg(over: Partial<MonitorConfig> = {}): MonitorConfig {
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

describe("parsePRUrl", () => {
	it("parses a standard GitHub PR URL", () => {
		expect(parsePRUrl("https://github.com/octo/demo/pull/42")).toEqual({
			owner: "octo", repo: "demo", number: 42, host: "github.com",
		});
	});
	it("normalizes non-github hosts", () => {
		expect(parsePRUrl("https://gh.example.com/octo/demo/pull/7")?.host).toBe("gh.example.com");
	});
	it("returns null for non-PR URLs", () => {
		expect(parsePRUrl("https://github.com/octo/demo/issues/5")).toBeNull();
	});
});

describe("parseIssueUrl", () => {
	it("parses an issue URL", () => {
		expect(parseIssueUrl("https://github.com/octo/demo/issues/5")).toEqual({
			owner: "octo", repo: "demo", number: 5, host: "github.com",
		});
	});
});

describe("parsePRShorthand", () => {
	it("parses owner/repo#123", () => {
		expect(parsePRShorthand("octo/demo#42")).toEqual({
			owner: "octo", repo: "demo", number: 42, host: "github.com",
		});
	});
	it("returns null for a bare number", () => {
		expect(parsePRShorthand("42")).toBeNull();
	});
});

describe("parseRunUrl", () => {
	it("parses an actions run URL", () => {
		expect(parseRunUrl("https://github.com/octo/demo/actions/runs/99")).toEqual({
			owner: "octo", repo: "demo", runId: 99, host: "github.com",
		});
	});
	it("ignores trailing path/query", () => {
		expect(parseRunUrl("https://github.com/octo/demo/actions/runs/99/attempts/1")?.runId).toBe(99);
		expect(parseRunUrl("https://github.com/octo/demo/actions/runs/42?check_suite_focus=true")?.runId).toBe(42);
	});
	it("returns null for non-run URLs", () => {
		expect(parseRunUrl("https://github.com/octo/demo/pull/123")).toBeNull();
	});
});

describe("prKey / runKey / monitorKey", () => {
	it("prKey from config and args match", () => {
		expect(prKey(cfg())).toBe("octo/demo#42");
		expect(prKey("octo", "demo", 42)).toBe("octo/demo#42");
	});
	it("prKey includes host for enterprise", () => {
		expect(prKey(cfg({ host: "gh.example.com" }))).toBe("gh.example.com/octo/demo#42");
	});
	it("runKey from config and args match", () => {
		expect(runKey(cfg({ resourceType: "run", number: 0, runId: 99 }))).toBe("octo/demo@run/99");
		expect(runKey("octo", "demo", 99)).toBe("octo/demo@run/99");
	});
	it("monitorKey dispatches by resource type", () => {
		expect(monitorKey(cfg())).toBe("octo/demo#42");
		expect(monitorKey(cfg({ resourceType: "issue" }))).toBe("octo/demo#42");
		expect(monitorKey(cfg({ resourceType: "run", number: 0, runId: 5 }))).toBe("octo/demo@run/5");
	});
});

describe("resourceUrl", () => {
	it("builds a PR URL", () => {
		expect(resourceUrl(cfg())).toBe("https://github.com/octo/demo/pull/42");
	});
	it("builds an issue URL", () => {
		expect(resourceUrl(cfg({ resourceType: "issue" }))).toBe("https://github.com/octo/demo/issues/42");
	});
	it("builds a run URL", () => {
		expect(resourceUrl(cfg({ resourceType: "run", number: 0, runId: 9 }))).toBe(
			"https://github.com/octo/demo/actions/runs/9",
		);
	});
});