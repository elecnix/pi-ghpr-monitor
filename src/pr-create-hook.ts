/**
 * PR create hook — detects when the agent creates a PR via gh pr create
 * and injects a steer message nudging the LLM to start monitoring it.
 */

// Re-export the ParsedPR type for test use
export type { ParsedPR } from "./index";

import type { ParsedPR } from "./index";

// ---------------------------------------------------------------------------
// PR URL regex (same as in index.ts)
// ---------------------------------------------------------------------------

const PR_URL_RE = /https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/([0-9]+)/gi;

// ---------------------------------------------------------------------------
// gh pr create command detection
// ---------------------------------------------------------------------------

/**
 * Patterns that match PR creation commands in bash tool calls.
 * Handles multiline commands (backslash continuations) by collapsing
 * whitespace before matching.
 */
const PR_CREATE_PATTERNS = [
	// gh pr create with any flags, anywhere in the command
	/\bgh\s+pr\s+create\b/,
];

/**
 * Check if a bash command string is a PR creation command.
 * Handles multiline commands (backslash line continuations) by
 * collapsing all whitespace into single spaces before matching.
 */
export function isPRCreateCommand(command: string): boolean {
	const collapsed = command.replace(/\s+/g, " ").trim();
	return PR_CREATE_PATTERNS.some((re) => re.test(collapsed));
}

// ---------------------------------------------------------------------------
// PR URL extraction from stdout
// ---------------------------------------------------------------------------

/**
 * Extract ParsedPR entries from a stdout/stderr string.
 * Handles the typical gh pr create output which includes the URL
 * on its own line or embedded in surrounding text.
 *
 * Deduplicates by PR key (owner/repo#number).
 */
export function parsePRUrlsFromOutput(output: string): ParsedPR[] {
	const seen = new Set<string>();
	const results: ParsedPR[] = [];

	// Reset regex state
	PR_URL_RE.lastIndex = 0;

	let match: RegExpExecArray | null;
	while ((match = PR_URL_RE.exec(output)) !== null) {
		const host = match[1] === "github.com" ? "github.com" : match[1];
		const owner = match[2];
		const repo = match[3];
		const number = parseInt(match[4], 10);
		const key = host === "github.com"
			? `${owner}/${repo}#${number}`
			: `${host}/${owner}/${repo}#${number}`;

		if (!seen.has(key)) {
			seen.add(key);
			results.push({ owner, repo, number, host });
		}
	}

	return results;
}

// ---------------------------------------------------------------------------
// Steer message generation
// ---------------------------------------------------------------------------

/** Default nudge template */
export const DEFAULT_PR_CREATE_NUDGE =
	"💡 Consider monitoring with ghpr-monitor(action='start', url='{prUrl}') to track review comments, merge conflicts, and CI status.";

/**
 * Available template variables for the prCreateNudge preference:
 *   {owner}, {repo}, {number}, {host}, {prLabel}, {prUrl}
 */
export interface PRCreateNudgeVars {
	owner: string;
	repo: string;
	number: number;
	host: string;
	prLabel: string;
	prUrl: string;
}

const TEMPLATE_VAR_RE = /\{(owner|repo|number|host|prLabel|prUrl)\}/g;

/**
 * Interpolate the nudge template with PR variables.
 */
function interpolateNudge(template: string, vars: PRCreateNudgeVars): string {
	return template.replace(TEMPLATE_VAR_RE, (_, key: string) => {
		switch (key) {
			case "owner": return vars.owner;
			case "repo": return vars.repo;
			case "number": return String(vars.number);
			case "host": return vars.host;
			case "prLabel": return vars.prLabel;
			case "prUrl": return vars.prUrl;
			default: return _;
		}
	});
}

/**
 * Generate a steer message nudging the LLM to monitor a newly created PR.
 *
 * @param pr - The parsed PR info
 * @param template - Optional custom template from preferences. Uses default if empty/undefined.
 */
export function createPRCreateNudge(pr: ParsedPR, template?: string): string {
	const vars: PRCreateNudgeVars = {
		owner: pr.owner,
		repo: pr.repo,
		number: pr.number,
		host: pr.host,
		prLabel: `${pr.owner}/${pr.repo}#${pr.number}`,
		prUrl: `https://${pr.host}/${pr.owner}/${pr.repo}/pull/${pr.number}`,
	};

	const tpl = template && template.trim() !== "" ? template : DEFAULT_PR_CREATE_NUDGE;
	return interpolateNudge(tpl, vars);
}
