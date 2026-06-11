/**
 * GraphQL schema validation test
 *
 * Validates that all fields in the AWAIT_QUERY exist on their respective
 * GitHub GraphQL types by checking each field against the schema using
 * introspection. Catches schema mismatches like `databaseId` on
 * `PullRequestReviewThread` before they reach production.
 *
 * The QUERY_FIELDS map lists every field selected in AWAIT_QUERY, grouped
 * by its GraphQL type. When you add a field to the query, you MUST also
 * add it here. If a field doesn't exist on its type, this test will fail
 * with a clear message suggesting similar field names.
 *
 * Authentication: Uses GITHUB_TOKEN/GH_TOKEN env vars (CI) or gh auth
 * token (local). The CI workflow sets GITHUB_TOKEN for this test.
 */

import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Extract AWAIT_QUERY from source (for reference/documentation)
// ---------------------------------------------------------------------------

const srcPath = path.join(__dirname, "..", "src", "index.ts");
const src = fs.readFileSync(srcPath, "utf-8");

const queryMatch = src.match(/const AWAIT_QUERY = `([\s\S]*?)`;/);
if (!queryMatch) {
	throw new Error("Could not find AWAIT_QUERY in source");
}
const AWAIT_QUERY = queryMatch[1];

// ---------------------------------------------------------------------------
// GraphQL type → field mapping
// ---------------------------------------------------------------------------

/**
 * Maps each GraphQL type to the fields selected in AWAIT_QUERY.
 *
 * IMPORTANT: This map MUST be kept in sync with AWAIT_QUERY in src/index.ts.
 * When you add a field to the query, add it here too. If a field doesn't
 * exist on its type, this test will catch it.
 *
 * The type mapping follows the GitHub GraphQL schema:
 *   repository { pullRequest { ... } }          → Repository, PullRequest
 *   comments.nodes { ... }                      → IssueComment
 *   reviewThreads.nodes { ... }                  → PullRequestReviewThread
 *   reviewThreads.nodes.comments.nodes { ... }    → PullRequestReviewComment
 *   commits.nodes { commit { ... } }              → PullRequestCommit, Commit
 *   commit.checkSuites.nodes { ... }              → CheckSuite
 *   checkRuns.nodes { ... }                       → CheckRun
 *   commit.status { ... }                         → Status, StatusContext
 *   author { ... }                                → User
 *   reactions.nodes { ... }                       → Reaction
 */
const QUERY_FIELDS: Record<string, string[]> = {
	Repository: ["pullRequest"],
	PullRequest: ["state", "merged", "comments", "reviewThreads", "mergeable", "mergeStateStatus", "commits"],
	IssueComment: ["id", "databaseId", "body", "author", "createdAt", "reactions"],
	PullRequestReviewThread: ["id", "isResolved", "comments"],
	PullRequestReviewComment: ["id", "fullDatabaseId", "body", "author", "createdAt", "path", "line", "diffHunk", "reactions"],
	PullRequestCommit: ["commit"],
	Commit: ["oid", "checkSuites", "status"],
	CheckSuite: ["id", "conclusion", "status", "app", "checkRuns"],
	CheckRun: ["name", "conclusion", "status"],
	Status: ["state", "contexts"],
	StatusContext: ["state", "context", "description", "targetUrl"],
	Reaction: ["content"],
	User: ["login"],
	App: ["name", "slug"],
};

// ---------------------------------------------------------------------------
// GitHub GraphQL helpers
// ---------------------------------------------------------------------------

/**
 * Get a GitHub API token for authentication.
 * Uses GITHUB_TOKEN/GH_TOKEN (CI) or gh auth token (local).
 */
function getToken(): string | null {
	if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
	if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
	try {
		return execSync("gh auth token", { encoding: "utf-8", timeout: 5000 }).trim();
	} catch {
		return null;
	}
}

const GITHUB_GRAPHQL_URL = "https://api.github.com/graphql";

/**
 * Execute a GraphQL query directly against the GitHub API using fetch.
 * Uses fetch for consistent behavior across environments (the gh CLI
 * may silently drop invalid fields for GITHUB_TOKEN in CI).
 */
async function graphqlFetch(query: string, variables?: Record<string, unknown>): Promise<any> {
	const token = getToken();
	if (!token) {
		throw new Error("No GitHub token available. Set GITHUB_TOKEN or GH_TOKEN, or run gh auth login.");
	}

	const response = await fetch(GITHUB_GRAPHQL_URL, {
		method: "POST",
		headers: {
			"Authorization": `Bearer ${token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ query, ...(variables ? { variables } : {}) }),
	});

	return await response.json();
}

/**
 * Fetch field names for a single type from GitHub's GraphQL schema
 * using introspection. Queries one type at a time to stay within
 * GitHub's query complexity limits.
 */
async function fetchTypeFields(typeName: string): Promise<Set<string>> {
	const introspectionQuery = `query IntrospectType($name: String!) {
		__type(name: $name) {
			name
			kind
			fields(includeDeprecated: true) {
				name
			}
		}
	}`;

	const response = await graphqlFetch(introspectionQuery, { name: typeName });
	if (response.errors) {
		throw new Error(`GraphQL introspection failed for ${typeName}: ${JSON.stringify(response.errors)}`);
	}

	const typeData = response.data?.__type;
	if (!typeData) {
		throw new Error(`Type "${typeName}" does not exist in GitHub GraphQL schema`);
	}

	return new Set((typeData.fields || []).map((f: any) => f.name));
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("GraphQL schema validation", () => {
	// Skip in environments without a GitHub token
	const hasToken = !!getToken();
	const itIfAvailable = hasToken ? it : it.skip;

	itIfAvailable("AWAIT_QUERY fields exist on their respective GitHub GraphQL types", { timeout: 60000 }, async () => {
		const errors: string[] = [];

		for (const [typeName, expectedFields] of Object.entries(QUERY_FIELDS)) {
			const typeFields = await fetchTypeFields(typeName);

			for (const fieldName of expectedFields) {
				if (!typeFields.has(fieldName)) {
					// Find similar field names for helpful error message
					const similar = [...typeFields].filter(name =>
						name.toLowerCase().includes(fieldName.toLowerCase()) ||
						fieldName.toLowerCase().includes(name.toLowerCase())
					);
					const suggestion = similar.length > 0
						? ` Did you mean: ${similar.map(n => `"${n}"`).join(", ")}?`
						: "";

					errors.push(
						`Field "${fieldName}" does not exist on type "${typeName}".${suggestion} ` +
						`Available: ${[...typeFields].slice(0, 20).join(", ")}${typeFields.size > 20 ? "..." : ""}`
					);
				}
			}
		}

		if (errors.length > 0) {
			// Group errors by type for clearer output
			const byType = new Map<string, string[]>();
			for (const error of errors) {
				const typeMatch = error.match(/type "(\w+)"/);
				const typeName = typeMatch ? typeMatch[1] : "Unknown";
				if (!byType.has(typeName)) byType.set(typeName, []);
				byType.get(typeName)!.push(error);
			}

			const formattedErrors = [...byType.entries()]
				.map(([type, typeErrors]) =>
					`\n  On ${type}:\n    ` + typeErrors.join("\n    ")
				)
				.join("\n");

			throw new Error(
				`GraphQL schema validation failed. ${errors.length} field(s) not found:${formattedErrors}\n\n` +
				`This means AWAIT_QUERY references fields that don't exist on their types. ` +
				`Update AWAIT_QUERY in src/index.ts AND the QUERY_FIELDS map in this test.\n\n` +
				`Verify field names against https://docs.github.com/en/graphql/reference/queries`
			);
		}
	});
});
