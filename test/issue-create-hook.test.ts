/**
 * Tests for the issue create hook module
 *
 * Tests:
 * 1. Detection of gh issue create commands in bash command strings
 * 2. Parsing issue URLs from stdout
 * 3. Steer message generation from preference templates
 * 4. Deduplication of already-seen issues
 */

import { describe, it, expect } from "vitest";
import {
	isIssueCreateCommand,
	parseIssueUrlsFromOutput,
	createIssueCreateNudge,
	type ParsedIssue,
} from "../src/issue-create-hook";

// ---------------------------------------------------------------------------
// isIssueCreateCommand
// ---------------------------------------------------------------------------

describe("isIssueCreateCommand", () => {
	it("detects basic gh issue create", () => {
		expect(isIssueCreateCommand("gh issue create")).toBe(true);
	});

	it("detects gh issue create with flags", () => {
		expect(isIssueCreateCommand("gh issue create --title 'Bug' --body 'Description'")).toBe(true);
	});

	it("detects gh issue create with --web flag", () => {
		expect(isIssueCreateCommand("gh issue create --web")).toBe(true);
	});

	it("detects gh issue create with multiline command", () => {
		expect(isIssueCreateCommand("gh issue create \\\n  --title 'Test' \\\n  --body 'Body'")).toBe(true);
	});

	it("detects gh issue create with label flag", () => {
		expect(isIssueCreateCommand("gh issue create --label bug --title 'Found a bug'")).toBe(true);
	});

	it("detects gh issue create with assignee flag", () => {
		expect(isIssueCreateCommand("gh issue create --assignee me --title 'Task'")).toBe(true);
	});

	it("detects gh issue create with milestone flag", () => {
		expect(isIssueCreateCommand("gh issue create --milestone 'v1.0' --title 'Feature'")).toBe(true);
	});

	it("returns false for gh issue list", () => {
		expect(isIssueCreateCommand("gh issue list")).toBe(false);
	});

	it("returns false for gh issue view", () => {
		expect(isIssueCreateCommand("gh issue view 42")).toBe(false);
	});

	it("returns false for gh issue status", () => {
		expect(isIssueCreateCommand("gh issue status")).toBe(false);
	});

	it("returns false for gh issue close", () => {
		expect(isIssueCreateCommand("gh issue close 42")).toBe(false);
	});

	it("returns false for gh issue reopen", () => {
		expect(isIssueCreateCommand("gh issue reopen 42")).toBe(false);
	});

	it("returns false for gh pr create", () => {
		expect(isIssueCreateCommand("gh pr create --title 'PR'")).toBe(false);
	});

	it("returns false for non-gh commands", () => {
		expect(isIssueCreateCommand("git push origin main")).toBe(false);
	});

	it("returns false for empty string", () => {
		expect(isIssueCreateCommand("")).toBe(false);
	});

	it("detects gh issue create with project flag", () => {
		expect(isIssueCreateCommand("gh issue create --project 'Roadmap' --title 'Epic'")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// parseIssueUrlsFromOutput
// ---------------------------------------------------------------------------

describe("parseIssueUrlsFromOutput", () => {
	it("parses a single issue URL from typical gh issue create output", () => {
		const output = "https://github.com/v2nic/pi-ghpr-monitor/issues/42";
		const result = parseIssueUrlsFromOutput(output);
		expect(result).toHaveLength(1);
		expect(result[0]).toEqual({
			owner: "v2nic",
			repo: "pi-ghpr-monitor",
			number: 42,
			host: "github.com",
		});
	});

	it("parses an issue URL with trailing newlines", () => {
		const output = "\nhttps://github.com/v2nic/pi-ghpr-monitor/issues/42\n  \n";
		const result = parseIssueUrlsFromOutput(output);
		expect(result).toHaveLength(1);
		expect(result[0].owner).toBe("v2nic");
		expect(result[0].number).toBe(42);
	});

	it("parses an issue URL with surrounding text (simulating gh issue create output)", () => {
		const output = `Creating issue in v2nic/pi-ghpr-monitor

https://github.com/v2nic/pi-ghpr-monitor/issues/42`;
		const result = parseIssueUrlsFromOutput(output);
		expect(result).toHaveLength(1);
		expect(result[0].number).toBe(42);
	});

	it("parses multiple issue URLs", () => {
		const output = "https://github.com/v2nic/repo/issues/1\nhttps://github.com/v2nic/repo/issues/2";
		const result = parseIssueUrlsFromOutput(output);
		expect(result).toHaveLength(2);
		expect(result[0].number).toBe(1);
		expect(result[1].number).toBe(2);
	});

	it("deduplicates identical issue URLs", () => {
		const output = "https://github.com/v2nic/repo/issues/1\nhttps://github.com/v2nic/repo/issues/1";
		const result = parseIssueUrlsFromOutput(output);
		expect(result).toHaveLength(1);
	});

	it("parses GitHub Enterprise URLs", () => {
		const output = "https://github.corp.com/team/project/issues/100";
		const result = parseIssueUrlsFromOutput(output);
		expect(result).toHaveLength(1);
		expect(result[0]).toEqual({
			owner: "team",
			repo: "project",
			number: 100,
			host: "github.corp.com",
		});
	});

	it("ignores non-issue GitHub URLs (PRs)", () => {
		const output = "https://github.com/v2nic/repo/pull/5";
		const result = parseIssueUrlsFromOutput(output);
		expect(result).toHaveLength(0);
	});

	it("returns empty array for output with no issue URLs", () => {
		const output = "Some random output without any issue URL";
		const result = parseIssueUrlsFromOutput(output);
		expect(result).toHaveLength(0);
	});

	it("returns empty array for empty string", () => {
		expect(parseIssueUrlsFromOutput("")).toHaveLength(0);
	});

	it("parses http issue URLs too", () => {
		const output = "http://github.com/v2nic/repo/issues/42";
		const result = parseIssueUrlsFromOutput(output);
		expect(result).toHaveLength(1);
		expect(result[0].number).toBe(42);
	});
});

// ---------------------------------------------------------------------------
// createIssueCreateNudge
// ---------------------------------------------------------------------------

describe("createIssueCreateNudge", () => {
	const sampleIssue: ParsedIssue = {
		owner: "v2nic",
		repo: "pi-ghpr-monitor",
		number: 42,
		host: "github.com",
	};

	it("generates the default nudge message", () => {
		const result = createIssueCreateNudge(sampleIssue);
		expect(result).toContain("ghpr-monitor(action='start', url='https://github.com/v2nic/pi-ghpr-monitor/issues/42')");
		expect(result).toContain("Monitor this issue");
	});

	it("uses custom template when provided", () => {
		const template = "New issue {issueLabel} created. Monitor it with ghpr-monitor.";
		const result = createIssueCreateNudge(sampleIssue, template);
		expect(result).toBe("New issue v2nic/pi-ghpr-monitor#42 created. Monitor it with ghpr-monitor.");
	});

	it("supports all template variables", () => {
		const template = "{owner}/{repo}#{number} on {host} at {issueUrl} ({issueLabel})";
		const result = createIssueCreateNudge(sampleIssue, template);
		expect(result).toBe("v2nic/pi-ghpr-monitor#42 on github.com at https://github.com/v2nic/pi-ghpr-monitor/issues/42 (v2nic/pi-ghpr-monitor#42)");
	});

	it("handles empty template by using default", () => {
		const result = createIssueCreateNudge(sampleIssue, "");
		expect(result).toContain("ghpr-monitor");
	});

	it("handles GitHub Enterprise host in template", () => {
		const gheIssue: ParsedIssue = {
			owner: "team",
			repo: "project",
			number: 100,
			host: "github.corp.com",
		};
		const result = createIssueCreateNudge(gheIssue);
		expect(result).toContain("https://github.corp.com/team/project/issues/100");
	});
});

// ---------------------------------------------------------------------------
// Deduplication helper
// ---------------------------------------------------------------------------

describe("Issue URL deduplication (IssueKeySet)", () => {
	function issueKey(issue: ParsedIssue): string {
		return issue.host === "github.com"
			? `${issue.owner}/${issue.repo}#${issue.number}`
			: `${issue.host}/${issue.owner}/${issue.repo}#${issue.number}`;
	}

	it("generates correct keys for github.com", () => {
		expect(issueKey({ owner: "a", repo: "b", number: 1, host: "github.com" })).toBe("a/b#1");
	});

	it("generates correct keys for GitHub Enterprise", () => {
		expect(issueKey({ owner: "team", repo: "proj", number: 100, host: "github.corp.com" })).toBe("github.corp.com/team/proj#100");
	});

	it("deduplicates in a Set", () => {
		const seen = new Set<string>();
		const i1: ParsedIssue = { owner: "a", repo: "b", number: 1, host: "github.com" };
		const i2: ParsedIssue = { owner: "a", repo: "b", number: 1, host: "github.com" };
		const i3: ParsedIssue = { owner: "a", repo: "b", number: 2, host: "github.com" };

		expect(seen.has(issueKey(i1))).toBe(false);
		seen.add(issueKey(i1));
		expect(seen.has(issueKey(i2))).toBe(true);

		expect(seen.has(issueKey(i3))).toBe(false);
		seen.add(issueKey(i3));
		expect(seen.has(issueKey(i3))).toBe(true);
	});
});
