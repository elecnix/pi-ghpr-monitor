/**
 * Tests for the PR create hook module
 *
 * Tests:
 * 1. Detection of gh pr create commands in bash command strings
 * 2. Parsing PR URLs from stdout
 * 3. Steer message generation from preference templates
 * 4. Deduplication of already-seen PRs
 */

import { describe, it, expect } from "vitest";
import {
	isPRCreateCommand,
	parsePRUrlsFromOutput,
	createPRCreateNudge,
	type ParsedPR,
} from "../src/pr-create-hook";

// ---------------------------------------------------------------------------
// isPRCreateCommand
// ---------------------------------------------------------------------------

describe("isPRCreateCommand", () => {
	it("detects basic gh pr create", () => {
		expect(isPRCreateCommand("gh pr create")).toBe(true);
	});

	it("detects gh pr create with flags", () => {
		expect(isPRCreateCommand("gh pr create --title 'My PR' --body 'Description'")).toBe(true);
	});

	it("detects gh pr create with --web flag", () => {
		expect(isPRCreateCommand("gh pr create --web")).toBe(true);
	});

	it("detects gh pr create with multiline command", () => {
		expect(isPRCreateCommand("gh pr create \\\n  --title 'Test' \\\n  --body 'Body'")).toBe(true);
	});

	it("detects gh pr create with base/head flags", () => {
		expect(isPRCreateCommand("gh pr create --base main --head feature/foo")).toBe(true);
	});

	it("detects gh pr create with --draft flag", () => {
		expect(isPRCreateCommand("gh pr create --draft --title 'WIP'")).toBe(true);
	});

	it("returns false for gh pr list", () => {
		expect(isPRCreateCommand("gh pr list")).toBe(false);
	});

	it("returns false for gh pr view", () => {
		expect(isPRCreateCommand("gh pr view 42")).toBe(false);
	});

	it("returns false for gh pr checkout", () => {
		expect(isPRCreateCommand("gh pr checkout 42")).toBe(false);
	});

	it("returns false for gh pr status", () => {
		expect(isPRCreateCommand("gh pr status")).toBe(false);
	});

	it("returns false for gh pr merge", () => {
		expect(isPRCreateCommand("gh pr merge 42")).toBe(false);
	});

	it("returns false for non-gh commands", () => {
		expect(isPRCreateCommand("git push origin main")).toBe(false);
	});

	it("returns false for empty string", () => {
		expect(isPRCreateCommand("")).toBe(false);
	});

	it("returns false for gh issue create", () => {
		expect(isPRCreateCommand("gh issue create --title 'Bug'")).toBe(false);
	});

	it("detects gh pr create with assignee flag", () => {
		expect(isPRCreateCommand("gh pr create --assignee me")).toBe(true);
	});

	it("detects gh pr create with label flag", () => {
		expect(isPRCreateCommand("gh pr create --label bug,enhancement")).toBe(true);
	});

	it("detects gh pr create --fill flag", () => {
		expect(isPRCreateCommand("gh pr create --fill")).toBe(true);
	});

	it("detects gh pr create with --fill and other flags", () => {
		expect(isPRCreateCommand("gh pr create --fill --assignee me")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// parsePRUrlsFromOutput
// ---------------------------------------------------------------------------

describe("parsePRUrlsFromOutput", () => {
	it("parses a single PR URL from typical gh pr create output", () => {
		const output = "https://github.com/v2nic/pi-ghpr-monitor/pull/42";
		const result = parsePRUrlsFromOutput(output);
		expect(result).toHaveLength(1);
		expect(result[0]).toEqual({
			owner: "v2nic",
			repo: "pi-ghpr-monitor",
			number: 42,
			host: "github.com",
		});
	});

	it("parses a PR URL with trailing newlines", () => {
		const output = "\nhttps://github.com/v2nic/pi-ghpr-monitor/pull/42\n  \n";
		const result = parsePRUrlsFromOutput(output);
		expect(result).toHaveLength(1);
		expect(result[0].owner).toBe("v2nic");
		expect(result[0].number).toBe(42);
	});

	it("parses a PR URL with surrounding text (simulating gh pr create output)", () => {
		const output = `Creating pull request for feature/foo into main in v2nic/pi-ghpr-monitor

https://github.com/v2nic/pi-ghpr-monitor/pull/42`;
		const result = parsePRUrlsFromOutput(output);
		expect(result).toHaveLength(1);
		expect(result[0].number).toBe(42);
	});

	it("parses multiple PR URLs", () => {
		const output = "https://github.com/v2nic/repo/pull/1\nhttps://github.com/v2nic/repo/pull/2";
		const result = parsePRUrlsFromOutput(output);
		expect(result).toHaveLength(2);
		expect(result[0].number).toBe(1);
		expect(result[1].number).toBe(2);
	});

	it("deduplicates identical PR URLs", () => {
		const output = "https://github.com/v2nic/repo/pull/1\nhttps://github.com/v2nic/repo/pull/1";
		const result = parsePRUrlsFromOutput(output);
		expect(result).toHaveLength(1);
	});

	it("parses GitHub Enterprise URLs", () => {
		const output = "https://github.corp.com/team/project/pull/100";
		const result = parsePRUrlsFromOutput(output);
		expect(result).toHaveLength(1);
		expect(result[0]).toEqual({
			owner: "team",
			repo: "project",
			number: 100,
			host: "github.corp.com",
		});
	});

	it("ignores non-PR GitHub URLs", () => {
		const output = "https://github.com/v2nic/repo/issues/5";
		const result = parsePRUrlsFromOutput(output);
		expect(result).toHaveLength(0);
	});

	it("returns empty array for output with no PR URLs", () => {
		const output = "Some random output without any PR URL";
		const result = parsePRUrlsFromOutput(output);
		expect(result).toHaveLength(0);
	});

	it("returns empty array for empty string", () => {
		expect(parsePRUrlsFromOutput("")).toHaveLength(0);
	});

	it("parses PR URL with trailing slash content (e.g., /files)", () => {
		const output = "https://github.com/v2nic/repo/pull/42/files";
		const result = parsePRUrlsFromOutput(output);
		expect(result).toHaveLength(1);
		expect(result[0].number).toBe(42);
	});

	it("parses PR URL with query parameters in --web output", () => {
		// gh pr create --web might produce a URL with ?expand=1
		const output = "https://github.com/v2nic/repo/pull/42?expand=1";
		const result = parsePRUrlsFromOutput(output);
		expect(result).toHaveLength(1);
		expect(result[0].number).toBe(42);
	});

	it("parses http PR URLs too", () => {
		const output = "http://github.com/v2nic/repo/pull/42";
		const result = parsePRUrlsFromOutput(output);
		expect(result).toHaveLength(1);
		expect(result[0].number).toBe(42);
	});
});

// ---------------------------------------------------------------------------
// createPRCreateNudge
// ---------------------------------------------------------------------------

describe("createPRCreateNudge", () => {
	const samplePR: ParsedPR = {
		owner: "v2nic",
		repo: "pi-ghpr-monitor",
		number: 42,
		host: "github.com",
	};

	it("generates the default nudge message", () => {
		const result = createPRCreateNudge(samplePR);
		expect(result).toContain("ghpr-monitor(action='start', url='https://github.com/v2nic/pi-ghpr-monitor/pull/42')");
		expect(result).toContain("Monitor this PR");
	});

	it("uses custom template when provided", () => {
		const template = "New PR {prLabel} ready! Monitor it with ghpr-monitor.";
		const result = createPRCreateNudge(samplePR, template);
		expect(result).toBe("New PR v2nic/pi-ghpr-monitor#42 ready! Monitor it with ghpr-monitor.");
	});

	it("supports all template variables", () => {
		const template = "{owner}/{repo}#{number} on {host} at {prUrl} ({prLabel})";
		const result = createPRCreateNudge(samplePR, template);
		expect(result).toBe("v2nic/pi-ghpr-monitor#42 on github.com at https://github.com/v2nic/pi-ghpr-monitor/pull/42 (v2nic/pi-ghpr-monitor#42)");
	});

	it("handles empty template by using default", () => {
		const result = createPRCreateNudge(samplePR, "");
		expect(result).toContain("ghpr-monitor");
	});

	it("handles GitHub Enterprise host in template", () => {
		const ghePR: ParsedPR = {
			owner: "team",
			repo: "project",
			number: 100,
			host: "github.corp.com",
		};
		const result = createPRCreateNudge(ghePR);
		expect(result).toContain("https://github.corp.com/team/project/pull/100");
	});
});

// ---------------------------------------------------------------------------
// Deduplication helper
// ---------------------------------------------------------------------------

describe("PR URL deduplication (PRKeySet)", () => {
	// Simulates the Set<string> used in index.ts for tracking nudged PRs
	function prKey(pr: ParsedPR): string {
		return pr.host === "github.com"
			? `${pr.owner}/${pr.repo}#${pr.number}`
			: `${pr.host}/${pr.owner}/${pr.repo}#${pr.number}`;
	}

	it("generates correct keys for github.com", () => {
		expect(prKey({ owner: "a", repo: "b", number: 1, host: "github.com" })).toBe("a/b#1");
	});

	it("generates correct keys for GitHub Enterprise", () => {
		expect(prKey({ owner: "team", repo: "proj", number: 100, host: "github.corp.com" })).toBe("github.corp.com/team/proj#100");
	});

	it("deduplicates in a Set", () => {
		const seen = new Set<string>();
		const pr1: ParsedPR = { owner: "a", repo: "b", number: 1, host: "github.com" };
		const pr2: ParsedPR = { owner: "a", repo: "b", number: 1, host: "github.com" };
		const pr3: ParsedPR = { owner: "a", repo: "b", number: 2, host: "github.com" };

		// Same PR twice — should be seen once
		expect(seen.has(prKey(pr1))).toBe(false);
		seen.add(prKey(pr1));
		expect(seen.has(prKey(pr2))).toBe(true);

		// Different PR — not yet seen
		expect(seen.has(prKey(pr3))).toBe(false);
		seen.add(prKey(pr3));
		expect(seen.has(prKey(pr3))).toBe(true);
	});
});
