/**
 * Unit tests for PR URL parsing
 */

import { describe, it, expect } from "vitest";

// Inline the parser since it's not exported from analyzer.ts
const PR_URL_RE = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/([0-9]+)/i;

interface ParsedPR {
	owner: string;
	repo: string;
	number: number;
	host: string;
}

function parsePRUrl(input: string): ParsedPR | null {
	const m = input.trim().match(PR_URL_RE);
	if (!m) return null;
	const host = m[1] === "github.com" ? "github.com" : m[1];
	return { owner: m[2], repo: m[3], number: parseInt(m[4], 10), host };
}

describe("parsePRUrl", () => {
	it("parses a standard GitHub PR URL", () => {
		const result = parsePRUrl("https://github.com/v2nic/pi-ghpr-monitor/pull/366");
		expect(result).toEqual({
			owner: "v2nic",
			repo: "pi-ghpr-monitor",
			number: 366,
			host: "github.com",
		});
	});

	it("parses a PR URL with trailing path segments", () => {
		const result = parsePRUrl("https://github.com/v2nic/pi-ghpr-monitor/pull/366/files");
		expect(result).not.toBeNull();
		expect(result?.owner).toBe("v2nic");
		expect(result?.number).toBe(366);
	});

	it("parses a PR URL with query params", () => {
		const result = parsePRUrl("https://github.com/v2nic/pi-ghpr-monitor/pull/366?expand=1");
		expect(result).not.toBeNull();
		expect(result?.number).toBe(366);
	});

	it("parses a GitHub Enterprise URL", () => {
		const result = parsePRUrl("https://github.corp.com/team/project/pull/42");
		expect(result).toEqual({
			owner: "team",
			repo: "project",
			number: 42,
			host: "github.corp.com",
		});
	});

	it("parses an http URL", () => {
		const result = parsePRUrl("http://github.com/owner/repo/pull/1");
		expect(result).not.toBeNull();
		expect(result?.number).toBe(1);
	});

	it("returns null for non-PR URLs", () => {
		expect(parsePRUrl("https://github.com/v2nic/pi-ghpr-monitor")).toBeNull();
		expect(parsePRUrl("https://github.com/v2nic/pi-ghpr-monitor/issues/5")).toBeNull();
		expect(parsePRUrl("not a url")).toBeNull();
		expect(parsePRUrl("")).toBeNull();
		expect(parsePRUrl("owner/repo 42")).toBeNull();
	});

	it("returns null for PR URL with non-numeric number", () => {
		expect(parsePRUrl("https://github.com/owner/repo/pull/abc")).toBeNull();
	});

	it("handles whitespace around URL", () => {
		const result = parsePRUrl("  https://github.com/v2nic/pi-ghpr-monitor/pull/366  ");
		expect(result).not.toBeNull();
		expect(result?.number).toBe(366);
	});
});
describe("parsePRUrl with steer message", () => {
	// Mirror the logic from index.ts: only treat trailing text as a steer
	// message if it doesn't start with URL-continuation characters.
	function extractSteerMessage(raw: string): string | undefined {
		const m = raw.trim().match(PR_URL_RE);
		if (!m) return undefined;
		const afterUrl = raw.trim().slice(m[0].length).trim();
		return afterUrl && !/^[\/?#]/.test(afterUrl) ? afterUrl : undefined;
	}

	it("parses URL without trailing message", () => {
		expect(extractSteerMessage("https://github.com/owner/repo/pull/42")).toBeUndefined();
	});

	it("extracts steer message after URL", () => {
		expect(extractSteerMessage("https://github.com/owner/repo/pull/42 Address any CI failure")).toBe("Address any CI failure");
	});

	it("extracts multi-word steer message", () => {
		expect(extractSteerMessage("https://github.com/owner/repo/pull/42 You are assigned to finishing the work of this PR")).toBe("You are assigned to finishing the work of this PR");
	});

	it("URL with trailing slash — not a steer message", () => {
		expect(extractSteerMessage("https://github.com/owner/repo/pull/42/")).toBeUndefined();
	});

	it("URL with /changes — not a steer message", () => {
		expect(extractSteerMessage("https://github.com/mobilityhouse/vgi-na-masscec/pull/412/changes")).toBeUndefined();
	});

	it("URL with /files — not a steer message", () => {
		expect(extractSteerMessage("https://github.com/owner/repo/pull/42/files")).toBeUndefined();
	});

	it("URL with /commits — not a steer message", () => {
		expect(extractSteerMessage("https://github.com/owner/repo/pull/42/commits")).toBeUndefined();
	});

	it("URL with /checks — not a steer message", () => {
		expect(extractSteerMessage("https://github.com/owner/repo/pull/42/checks")).toBeUndefined();
	});

	it("URL with query params — not a steer message", () => {
		expect(extractSteerMessage("https://github.com/owner/repo/pull/42?expand=1")).toBeUndefined();
	});

	it("URL with fragment — not a steer message", () => {
		expect(extractSteerMessage("https://github.com/owner/repo/pull/42#discussion_r1234")).toBeUndefined();
	});


});

describe("parsePRShorthand", () => {
	function parsePRShorthand(input: string): ParsedPR | null {
		const hashM = input.trim().match(/^([^\s#/]+)\/([^#]+)#([0-9]+)$/);
		if (hashM) {
			return { owner: hashM[1], repo: hashM[2], number: parseInt(hashM[3], 10), host: "github.com" };
		}
		return null;
	}

	it("parses owner/repo#number format", () => {
		const result = parsePRShorthand("mobilityhouse/vgi-na-masscec#373");
		expect(result).toEqual({
			owner: "mobilityhouse",
			repo: "vgi-na-masscec",
			number: 373,
			host: "github.com",
		});
	});

	it("parses simple owner/repo#1 format", () => {
		const result = parsePRShorthand("v2nic/pi-ghpr-monitor#366");
		expect(result).toEqual({
			owner: "v2nic",
			repo: "pi-ghpr-monitor",
			number: 366,
			host: "github.com",
		});
	});

	it("handles whitespace around shorthand", () => {
		const result = parsePRShorthand("  v2nic/pi-ghpr-monitor#366  ");
		expect(result).not.toBeNull();
		expect(result?.number).toBe(366);
	});

	it("returns null for URL format", () => {
		expect(parsePRShorthand("https://github.com/v2nic/pi-ghpr-monitor/pull/366")).toBeNull();
	});

	it("returns null for space-separated format", () => {
		expect(parsePRShorthand("v2nic/pi-ghpr-monitor 366")).toBeNull();
	});

	it("returns null for just owner/repo without number", () => {
		expect(parsePRShorthand("v2nic/pi-ghpr-monitor")).toBeNull();
	});

	it("returns null for empty string", () => {
		expect(parsePRShorthand("")).toBeNull();
	});

	it("returns null for repo with hash in name but no number", () => {
		expect(parsePRShorthand("v2nic/some-repo#")).toBeNull();
	});

	it("returns null for non-numeric number after hash", () => {
		expect(parsePRShorthand("v2nic/repo#abc")).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Issue URL parsing
// ---------------------------------------------------------------------------

const ISSUE_URL_RE = /^https?:\/\/([^\/]+)\/([^\/]+)\/([^\/]+)\/issues\/([0-9]+)/i;

interface ParsedResource {
	owner: string;
	repo: string;
	number: number;
	host: string;
	resourceType: "pr" | "issue";
}

function parseIssueUrl(input: string): ParsedResource | null {
	const m = input.trim().match(ISSUE_URL_RE);
	if (!m) return null;
	const host = m[1] === "github.com" ? "github.com" : m[1];
	return { owner: m[2], repo: m[3], number: parseInt(m[4], 10), host, resourceType: "issue" };
}

function parseResourceUrl(input: string): ParsedResource | null {
	const issue = parseIssueUrl(input);
	if (issue) return issue;

	const prUrlMatch = input.trim().match(/^https?:\/\/([^\/]+)\/([^\/]+)\/([^\/]+)\/pull\/([0-9]+)/i);
	if (prUrlMatch) {
		const host = prUrlMatch[1] === "github.com" ? "github.com" : prUrlMatch[1];
		return { owner: prUrlMatch[2], repo: prUrlMatch[3], number: parseInt(prUrlMatch[4], 10), host, resourceType: "pr" };
	}

	return null;
}

describe("parseIssueUrl", () => {
	it("parses a standard GitHub issue URL", () => {
		const result = parseIssueUrl("https://github.com/v2nic/pi-ghpr-monitor/issues/80");
		expect(result).toEqual({
			owner: "v2nic",
			repo: "pi-ghpr-monitor",
			number: 80,
			host: "github.com",
			resourceType: "issue",
		});
	});

	it("parses an issue URL with trailing path segments", () => {
		const result = parseIssueUrl("https://github.com/owner/repo/issues/42/");
		expect(result).not.toBeNull();
		expect(result?.number).toBe(42);
		expect(result?.resourceType).toBe("issue");
	});

	it("parses an issue URL with query params", () => {
		const result = parseIssueUrl("https://github.com/owner/repo/issues/42?foo=bar");
		expect(result).not.toBeNull();
		expect(result?.number).toBe(42);
	});

	it("parses a GitHub Enterprise issue URL", () => {
		const result = parseIssueUrl("https://github.corp.com/team/project/issues/7");
		expect(result).toEqual({
			owner: "team",
			repo: "project",
			number: 7,
			host: "github.corp.com",
			resourceType: "issue",
		});
	});

	it("returns null for PR URL", () => {
		expect(parseIssueUrl("https://github.com/owner/repo/pull/42")).toBeNull();
	});

	it("returns null for non-issue URLs", () => {
		expect(parseIssueUrl("https://github.com/owner/repo")).toBeNull();
		expect(parseIssueUrl("not a url")).toBeNull();
		expect(parseIssueUrl("")).toBeNull();
	});

	it("returns null for issue URL with non-numeric number", () => {
		expect(parseIssueUrl("https://github.com/owner/repo/issues/abc")).toBeNull();
	});

	it("handles whitespace around URL", () => {
		const result = parseIssueUrl("  https://github.com/owner/repo/issues/42  ");
		expect(result).not.toBeNull();
		expect(result?.number).toBe(42);
	});

	it("parses http URL", () => {
		const result = parseIssueUrl("http://github.com/owner/repo/issues/1");
		expect(result).not.toBeNull();
		expect(result?.number).toBe(1);
	});
});

describe("parseResourceUrl", () => {
	it("returns pr for pull request URL", () => {
		const result = parseResourceUrl("https://github.com/owner/repo/pull/42");
		expect(result?.resourceType).toBe("pr");
		expect(result?.number).toBe(42);
	});

	it("returns issue for issue URL", () => {
		const result = parseResourceUrl("https://github.com/owner/repo/issues/42");
		expect(result?.resourceType).toBe("issue");
		expect(result?.number).toBe(42);
	});

	it("returns null for non-resource URLs", () => {
		expect(parseResourceUrl("https://github.com/owner/repo")).toBeNull();
		expect(parseResourceUrl("not a url")).toBeNull();
	});
});
