/**
 * Linear ticket monitoring — pure logic + a thin GraphQL client.
 *
 * This mirrors the structure of analyzer.ts (pure, runtime-free functions that
 * are trivially unit-testable) plus a small client that talks to Linear's
 * GraphQL API.
 *
 * ## API access (documented best practice for a dev workstation)
 *
 * Linear recommends a **personal API key** for personal scripts and local
 * development (OAuth is only recommended for apps built for others). The key is
 * created under Settings → Security & Access → Personal API keys and supplied
 * to this extension via the `LINEAR_API_KEY` environment variable — the same
 * "auth lives outside the code" model the PR monitor uses with the `gh` CLI.
 *
 * Crucially, personal API keys are sent in the `Authorization` header **without**
 * a `Bearer` prefix (that prefix is only for OAuth access tokens):
 *
 *     Authorization: <API_KEY>
 *
 * Endpoint: https://api.linear.app/graphql
 * See https://linear.app/developers/graphql for the authoritative reference.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const LINEAR_GRAPHQL_ENDPOINT = "https://api.linear.app/graphql";
export const LINEAR_API_KEY_ENV = "LINEAR_API_KEY";

// ---------------------------------------------------------------------------
// Reference parsing
// ---------------------------------------------------------------------------

export interface LinearRef {
	/** Human issue identifier, e.g. "ENG-123" (team prefix upper-cased). */
	key: string;
}

// A bare Linear issue key: team prefix (letters/digits, must start with a
// letter) + "-" + a number, e.g. "ENG-123".
const LINEAR_KEY_RE = /^([A-Za-z][A-Za-z0-9]*)-([0-9]+)$/;
// A Linear issue URL: https://linear.app/<workspace>/issue/<KEY>[/<slug>]
const LINEAR_URL_RE = /^https?:\/\/linear\.app\/[^/]+\/issue\/([A-Za-z][A-Za-z0-9]*-[0-9]+)/i;

/** Parse a Linear issue key ("ENG-123") or issue URL into a {@link LinearRef}. */
export function parseLinearRef(input: string): LinearRef | null {
	const trimmed = input.trim();

	const urlMatch = trimmed.match(LINEAR_URL_RE);
	if (urlMatch) return { key: urlMatch[1].toUpperCase() };

	const keyMatch = trimmed.match(LINEAR_KEY_RE);
	if (keyMatch) return { key: trimmed.toUpperCase() };

	return null;
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

/** Read the personal API key from the environment (default: process.env). */
export function getLinearApiKey(env: NodeJS.ProcessEnv = process.env): string | null {
	const raw = env[LINEAR_API_KEY_ENV];
	if (!raw) return null;
	const trimmed = raw.trim();
	return trimmed.length > 0 ? trimmed : null;
}

/**
 * Build the request headers for a Linear API call.
 *
 * Personal API keys are sent raw (NO "Bearer" prefix) — this is the documented
 * convention and differs from OAuth access tokens.
 */
export function buildLinearHeaders(apiKey: string): Record<string, string> {
	return {
		"Content-Type": "application/json",
		Authorization: apiKey,
	};
}

// ---------------------------------------------------------------------------
// GraphQL response types
// ---------------------------------------------------------------------------

export interface LinearUserNode {
	name?: string | null;
	displayName?: string | null;
}

export interface LinearCommentNode {
	id: string;
	body: string;
	createdAt: string;
	user?: LinearUserNode | null;
}

export interface LinearAttachmentNode {
	id: string;
	title?: string | null;
	url: string;
}

export interface LinearIssueData {
	id: string;
	identifier: string;
	title: string;
	url: string;
	state: { name: string; type: string };
	priority: number;
	priorityLabel: string;
	assignee?: LinearUserNode | null;
	comments: { nodes: LinearCommentNode[] };
	attachments: { nodes: LinearAttachmentNode[] };
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

export interface LinearCommentSummary {
	id: string;
	author: string;
	/** First line, truncated — for concise display. */
	body: string;
	/** Full comment body — for the detailed agent notification. */
	fullBody: string;
}

export interface LinearLinkSummary {
	id: string;
	title: string;
	url: string;
}

export interface LinearIssueStatus {
	identifier: string;
	title: string;
	url: string;
	stateName: string;
	stateType: string;
	priority: number;
	priorityLabel: string;
	/** Assignee display name, or "" when unassigned. */
	assignee: string;
	comments: LinearCommentSummary[];
	lastCommentTimestamp: string;
	links: LinearLinkSummary[];
}

/** Truncate to the first line, capping length with an ellipsis. */
function firstLine(text: string | null | undefined, max: number): string {
	if (!text) return "";
	const line = text.split("\n")[0] ?? "";
	return line.length > max ? line.slice(0, max - 1) + "…" : line;
}

function userName(user: LinearUserNode | null | undefined): string {
	return user?.displayName ?? user?.name ?? "";
}

/** Build a {@link LinearIssueStatus} snapshot from raw issue data. */
export function snapshotLinearIssue(issue: LinearIssueData, ignoredBots: string[] = []): LinearIssueStatus {
	const ignored = ignoredBots.length > 0 ? new Set(ignoredBots) : null;

	const comments = issue.comments.nodes
		.filter((c) => !ignored?.has(userName(c.user)))
		.map((c) => ({
			id: c.id,
			author: userName(c.user),
			body: firstLine(c.body, 120),
			fullBody: c.body,
		}));

	let lastCommentTimestamp = "";
	for (const c of issue.comments.nodes) {
		if (c.createdAt > lastCommentTimestamp) lastCommentTimestamp = c.createdAt;
	}

	const links = issue.attachments.nodes.map((a) => ({
		id: a.id,
		title: a.title ?? "",
		url: a.url,
	}));

	return {
		identifier: issue.identifier,
		title: issue.title,
		url: issue.url,
		stateName: issue.state.name,
		stateType: issue.state.type,
		priority: issue.priority,
		priorityLabel: issue.priorityLabel,
		assignee: userName(issue.assignee),
		comments,
		lastCommentTimestamp,
		links,
	};
}

// ---------------------------------------------------------------------------
// Change detection & formatting
// ---------------------------------------------------------------------------

export interface LinearNotification {
	concise: string;
	detailed: string;
}

function commentLines(comments: LinearCommentSummary[]): { concise: string; detailed: string } {
	const concise = `💬 ${comments.length} new comment(s) on {ISSUE}:`;
	const detailedHeader = `💬 ${comments.length} new comment(s) on {ISSUE}:`;
	const detailedBody = comments.map((c) => `  - [${c.author || "unknown"}] ${c.fullBody}`).join("\n");
	return { concise, detailed: `${detailedHeader}\n${detailedBody}` };
}

/**
 * Detect changes between two snapshots and format an agent notification.
 * Returns null when there is no prior snapshot (first observation) or nothing
 * actionable changed.
 */
export function formatLinearUpdate(
	prev: LinearIssueStatus | null,
	curr: LinearIssueStatus,
): LinearNotification | null {
	if (!prev) return null;

	const issue = curr.identifier;
	const conciseParts: string[] = [];
	const detailedParts: string[] = [];

	// New comments (by id).
	const prevCommentIds = new Set(prev.comments.map((c) => c.id));
	const newComments = curr.comments.filter((c) => !prevCommentIds.has(c.id));
	if (newComments.length > 0) {
		const { concise, detailed } = commentLines(newComments);
		conciseParts.push(concise);
		detailedParts.push(detailed);
	}

	// State transition.
	if (prev.stateName !== curr.stateName) {
		const line = `🔄 ${issue} moved from "${prev.stateName}" to "${curr.stateName}"`;
		conciseParts.push(line);
		detailedParts.push(line);
	}

	// Assignee change.
	if (prev.assignee !== curr.assignee) {
		const to = curr.assignee || "nobody";
		const from = prev.assignee || "nobody";
		const line = `👤 ${issue} reassigned from ${from} to ${to}`;
		conciseParts.push(line);
		detailedParts.push(line);
	}

	// Priority change.
	if (prev.priority !== curr.priority) {
		const line = `⚡ ${issue} priority changed to ${curr.priorityLabel}`;
		conciseParts.push(line);
		detailedParts.push(line);
	}

	// Newly linked resources (e.g. a linked PR).
	const prevLinkIds = new Set(prev.links.map((l) => l.id));
	const newLinks = curr.links.filter((l) => !prevLinkIds.has(l.id));
	if (newLinks.length > 0) {
		const conciseLink = `🔗 ${newLinks.length} new link(s) on ${issue}`;
		const detailedLink = `🔗 ${newLinks.length} new link(s) on ${issue}:\n${newLinks
			.map((l) => `  - ${l.title ? `${l.title}: ` : ""}${l.url}`)
			.join("\n")}`;
		conciseParts.push(conciseLink);
		detailedParts.push(detailedLink);
	}

	if (conciseParts.length === 0) return null;

	return {
		concise: conciseParts.join("\n").replace(/\{ISSUE\}/g, issue),
		detailed: detailedParts.join("\n").replace(/\{ISSUE\}/g, issue),
	};
}

/**
 * Format the currently-actionable items on an issue (used for reminders,
 * nudges, forced checks, and status). Returns null when nothing is actionable.
 */
export function formatLinearActionable(curr: LinearIssueStatus): LinearNotification | null {
	if (curr.comments.length === 0) return null;
	const { concise, detailed } = commentLines(curr.comments);
	return {
		concise: concise.replace(/\{ISSUE\}/g, curr.identifier),
		detailed: detailed.replace(/\{ISSUE\}/g, curr.identifier),
	};
}

/** Format the footer status line for the TUI. */
export function formatLinearFooter(status: LinearIssueStatus | null, ref: LinearRef): string {
	if (!status) return `📋 ${ref.key}: monitoring…`;
	const bits = [status.stateName];
	if (status.comments.length > 0) bits.push(`${status.comments.length} comment(s)`);
	return `📋 ${status.identifier}: ${bits.join(", ")}`;
}

// ---------------------------------------------------------------------------
// GraphQL client
// ---------------------------------------------------------------------------

export interface LinearFetchOptions {
	apiKey: string;
	/** Injected fetch (defaults to global fetch) — lets tests avoid the network. */
	fetchImpl?: typeof fetch;
	/** Override the endpoint (e.g. point at a mock server). */
	endpoint?: string;
	signal?: AbortSignal;
}

interface LinearGraphQLResult {
	data?: unknown;
	errors?: Array<{ message: string }>;
}

/** Execute a GraphQL query against Linear. Throws on rate limits and errors. */
export async function linearGraphQL(
	query: string,
	variables: Record<string, unknown>,
	opts: LinearFetchOptions,
): Promise<unknown> {
	const doFetch = opts.fetchImpl ?? fetch;
	const endpoint = opts.endpoint ?? LINEAR_GRAPHQL_ENDPOINT;

	const resp = await doFetch(endpoint, {
		method: "POST",
		headers: buildLinearHeaders(opts.apiKey),
		body: JSON.stringify({ query, variables }),
		signal: opts.signal,
	});

	if (resp.status === 429) {
		throw new Error("Linear API rate limit exceeded (HTTP 429)");
	}
	if (!resp.ok) {
		throw new Error(`Linear API returned HTTP ${resp.status}`);
	}

	const json = (await resp.json()) as LinearGraphQLResult;
	if (json.errors && json.errors.length > 0) {
		throw new Error(`Linear GraphQL error: ${json.errors.map((e) => e.message).join("; ")}`);
	}
	return json.data;
}

const ISSUE_QUERY = `query MonitorIssue($id: String!) {
  issue(id: $id) {
    id
    identifier
    title
    url
    priority
    priorityLabel
    state { name type }
    assignee { name displayName }
    comments(first: 50) {
      nodes { id body createdAt user { name displayName } }
    }
    attachments(first: 50) {
      nodes { id title url }
    }
  }
}`;

/** Fetch a single issue by its human identifier (e.g. "ENG-123"). */
export async function fetchLinearIssue(ref: LinearRef, opts: LinearFetchOptions): Promise<LinearIssueData> {
	const data = (await linearGraphQL(ISSUE_QUERY, { id: ref.key }, opts)) as {
		issue?: LinearIssueData | null;
	};
	if (!data.issue) {
		throw new Error(`Linear issue ${ref.key} not found or not accessible`);
	}
	return data.issue;
}
