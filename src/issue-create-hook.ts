/**
 * Issue create hook — detects when the agent creates an issue via gh issue create
 * and injects a steer message nudging the LLM to start monitoring it.
 */

// Re-export the ParsedPR type for test use
export type { ParsedSelector as ParsedIssue } from "./keys";

import type { ParsedSelector as ParsedIssue } from "./keys";

// ---------------------------------------------------------------------------
// Issue URL regex
// ---------------------------------------------------------------------------

const ISSUE_URL_RE = /https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/issues\/([0-9]+)/gi;

// ---------------------------------------------------------------------------
// gh issue create command detection
// ---------------------------------------------------------------------------

/**
 * Patterns that match issue creation commands in bash tool calls.
 * Handles multiline commands (backslash continuations) by collapsing
 * whitespace before matching.
 */
const ISSUE_CREATE_PATTERNS = [
	// gh issue create with any flags, anywhere in the command
	/\bgh\s+issue\s+create\b/,
];

/**
 * Check if a bash command string is an issue creation command.
 * Handles multiline commands (backslash line continuations) by
 * collapsing all whitespace into single spaces before matching.
 */
export function isIssueCreateCommand(command: string): boolean {
	const collapsed = command.replace(/\s+/g, " ").trim();
	return ISSUE_CREATE_PATTERNS.some((re) => re.test(collapsed));
}

// ---------------------------------------------------------------------------
// Issue URL extraction from stdout
// ---------------------------------------------------------------------------

/**
 * Extract ParsedIssue entries from a stdout/stderr string.
 * Handles the typical gh issue create output which includes the URL
 * on its own line or embedded in surrounding text.
 *
 * Deduplicates by issue key (owner/repo#number).
 */
export function parseIssueUrlsFromOutput(output: string): ParsedIssue[] {
	const seen = new Set<string>();
	const results: ParsedIssue[] = [];

	// Reset regex state
	ISSUE_URL_RE.lastIndex = 0;

	let match: RegExpExecArray | null;
	while ((match = ISSUE_URL_RE.exec(output)) !== null) {
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
export const DEFAULT_ISSUE_CREATE_NUDGE =
	"📡 Monitor this issue with ghpr-monitor(action='start', url='{issueUrl}') to track comments and status changes.";

/**
 * Available template variables for the issueCreateNudge preference:
 *   {owner}, {repo}, {number}, {host}, {issueLabel}, {issueUrl}
 */
export interface IssueCreateNudgeVars {
	owner: string;
	repo: string;
	number: number;
	host: string;
	issueLabel: string;
	issueUrl: string;
}

const TEMPLATE_VAR_RE = /\{(owner|repo|number|host|issueLabel|issueUrl)\}/g;

/**
 * Interpolate the nudge template with issue variables.
 */
function interpolateNudge(template: string, vars: IssueCreateNudgeVars): string {
	return template.replace(TEMPLATE_VAR_RE, (_, key: string) => {
		switch (key) {
			case "owner": return vars.owner;
			case "repo": return vars.repo;
			case "number": return String(vars.number);
			case "host": return vars.host;
			case "issueLabel": return vars.issueLabel;
			case "issueUrl": return vars.issueUrl;
			default: return _;
		}
	});
}

/**
 * Generate a steer message nudging the LLM to monitor a newly created issue.
 *
 * @param issue - The parsed issue info
 * @param template - Optional custom template from preferences. Uses default if empty/undefined.
 */
export function createIssueCreateNudge(issue: ParsedIssue, template?: string): string {
	const vars: IssueCreateNudgeVars = {
		owner: issue.owner,
		repo: issue.repo,
		number: issue.number,
		host: issue.host,
		issueLabel: `${issue.owner}/${issue.repo}#${issue.number}`,
		issueUrl: `https://${issue.host}/${issue.owner}/${issue.repo}/issues/${issue.number}`,
	};

	const tpl = template && template.trim() !== "" ? template : DEFAULT_ISSUE_CREATE_NUDGE;
	return interpolateNudge(tpl, vars);
}
