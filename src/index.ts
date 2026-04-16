/**
 * pi-ghpr-monitor — Pi extension for monitoring GitHub PRs
 *
 * Registers:
 *   /ghpr-monitor [on|off|owner/repo number]  — user-facing command
 *   ghpr-monitor                                 — LLM-callable tool
 *
 * The tool polls a PR for comments, conflicts, and CI status, then
 * injects notifications into the agent session so the LLM can take action.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import {
	type PullRequestData,
	type PRStatus,
	type MonitorConfig,
	snapshotPR,
	formatStatusUpdate,
} from "./analyzer";

// ---------------------------------------------------------------------------
// GraphQL query (same as gh-pr-review's AWAIT_QUERY)
// ---------------------------------------------------------------------------

const AWAIT_QUERY = `query AwaitPR(
  $owner: String!,
  $repo: String!,
  $number: Int!,
  $firstComments: Int!,
  $firstThreads: Int!,
  $firstReviewComments: Int!,
  $firstCheckSuites: Int!,
  $firstChecks: Int!
) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      comments(first: $firstComments) {
        nodes { id body author { login } createdAt }
        pageInfo { hasNextPage endCursor }
      }
      reviewThreads(first: $firstThreads) {
        nodes {
          id
          isResolved
          isOutdated
          comments(first: $firstReviewComments) {
            nodes { id body author { login } createdAt }
            pageInfo { hasNextPage endCursor }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
      mergeable
      mergeStateStatus
      commits(last: 1) {
        nodes {
          commit {
            checkSuites(first: $firstCheckSuites) {
              nodes {
                id
                conclusion
                status
                app { name slug }
                checkRuns(first: $firstChecks) {
                  nodes {
                    name
                    conclusion
                    status
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}`;

// ---------------------------------------------------------------------------
// GitHub API helpers
// ---------------------------------------------------------------------------

interface GhResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

function runGh(args: string[], stdin?: string): Promise<GhResult> {
	return new Promise((resolve) => {
		const { spawn } = require("node:child_process") as typeof import("node:child_process");
		const proc = spawn("gh", args, { stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		proc.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
		proc.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
		if (stdin) {
			proc.stdin.write(stdin);
			proc.stdin.end();
		}
		proc.on("close", (code: number | null) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
	});
}

async function ghGraphQL(
	query: string,
	variables: Record<string, unknown>,
	host?: string,
	mockBaseUrl?: string,
): Promise<unknown> {
	if (mockBaseUrl) {
		// In test mode, call the mock server directly via HTTP
		const resp = await fetch(`${mockBaseUrl}/graphql`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ query, variables }),
		});
		if (!resp.ok) throw new Error(`Mock server returned ${resp.status}`);
		return resp.json();
	}

	const payload = JSON.stringify({ query, variables });
	const args = ["api", "graphql", "--input", "-"];
	if (host && host !== "github.com") {
		args.push("--hostname", host);
	}
	const result = await runGh(args, payload);
	if (result.exitCode !== 0) {
		throw new Error(`gh api graphql failed: ${result.stderr}`);
	}
	return JSON.parse(result.stdout);
}

async function fetchPRData(config: MonitorConfig, signal?: AbortSignal, mockBaseUrl?: string): Promise<PullRequestData> {
	const vars: Record<string, unknown> = {
		owner: config.owner,
		repo: config.repo,
		number: config.number,
		firstComments: 100,
		firstThreads: 100,
		firstReviewComments: 100,
		firstCheckSuites: 100,
		firstChecks: 100,
	};
	const raw = await ghGraphQL(
		AWAIT_QUERY,
		vars,
		config.host !== "github.com" ? config.host : undefined,
		mockBaseUrl,
	);
	const outer = raw as { data?: { repository?: { pullRequest?: PullRequestData } } };
	if (!outer.data?.repository?.pullRequest) {
		throw new Error(`PR ${config.owner}/${config.repo}#${config.number} not found or not accessible`);
	}
	return outer.data.repository.pullRequest;
}

// ---------------------------------------------------------------------------
// Monitor state management
// ---------------------------------------------------------------------------

type MonitorState =
	| { status: "idle" }
	| { status: "running"; config: MonitorConfig; controller: AbortController }
	| { status: "stopped" };

// ---------------------------------------------------------------------------
// Main extension
// ---------------------------------------------------------------------------

export default function ghprMonitorExtension(pi: ExtensionAPI) {
	let monitorState: MonitorState = { status: "idle" };
	let lastStatus: PRStatus | null = null;

	// For testing: allows pointing at a mock server
	let mockBaseUrl: string | undefined;

	const STEERING_PROMPT = `You have access to the ghpr-monitor tool. When the user asks you to watch or monitor a PR, use ghpr-monitor with action "start" to begin monitoring. When asked to stop, use action "stop". While monitoring, you will receive PR status updates as notifications — respond to them naturally by addressing any issues noted (unresolved comments, conflicts, failing checks, etc.).`;

	// Inject steering prompt when monitor is idle (so the LLM knows about the tool)
	pi.on("before_agent_start", async (event, _ctx) => {
		// Always inject steering prompt so the LLM knows the tool exists
		return {
			systemPrompt: event.systemPrompt + "\n\n" + STEERING_PROMPT,
		};
	});

	// Clean up on session shutdown
	pi.on("session_shutdown", async () => {
		stopMonitor();
	});

	function startMonitor(config: MonitorConfig): string {
		stopMonitor();

		const controller = new AbortController();
		monitorState = { status: "running", config, controller };
		lastStatus = null;

		pollLoop(config, controller.signal).catch((err) => {
			if (controller.signal.aborted) return;
			pi.sendMessage({
				customType: "ghpr-monitor-error",
				content: `PR monitor error: ${err instanceof Error ? err.message : String(err)}`,
				display: true,
			});
			monitorState = { status: "idle" };
		});

		return `Started monitoring ${config.owner}/${config.repo}#${config.number} (interval: ${config.intervalSec}s, mode: ${config.mode})`;
	}

	function stopMonitor(): string {
		if (monitorState.status === "running") {
			monitorState.controller.abort();
			const config = monitorState.config;
			monitorState = { status: "idle" };
			lastStatus = null;
			return `Stopped monitoring ${config.owner}/${config.repo}#${config.number}`;
		}
		monitorState = { status: "idle" };
		lastStatus = null;
		return "No monitor running";
	}

	async function pollLoop(config: MonitorConfig, signal: AbortSignal): Promise<void> {
		// Initial check
		const initialMsg = `📡 Monitoring ${config.owner}/${config.repo}#${config.number}... (polling every ${config.intervalSec}s)`;
		pi.sendMessage({
			customType: "ghpr-monitor",
			content: initialMsg,
			display: true,
			details: { action: "start", owner: config.owner, repo: config.repo, number: config.number },
		});

		for (;;) {
			if (signal.aborted) return;

			try {
				const pr = await fetchPRData(config, signal, mockBaseUrl);
				const curr = snapshotPR(pr);
				const update = formatStatusUpdate(lastStatus, curr, config);

				if (update) {
					pi.sendMessage({
						customType: "ghpr-monitor",
						content: update,
						display: true,
						details: {
							action: "update",
							owner: config.owner,
							repo: config.repo,
							number: config.number,
							status: curr,
						},
					});
				}

				lastStatus = curr;
			} catch (err) {
				if (signal.aborted) return;
				pi.sendMessage({
					customType: "ghpr-monitor-error",
					content: `Poll error for ${config.owner}/${config.repo}#${config.number}: ${err instanceof Error ? err.message : String(err)}`,
					display: true,
				});
			}

			// Wait for interval (abortable)
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, config.intervalSec * 1000);
				signal.addEventListener(
					"abort",
					() => {
						clearTimeout(timer);
						resolve();
					},
					{ once: true },
				);
			});

			if (signal.aborted) return;
		}
	}

	// -----------------------------------------------------------------------
	// Register the /ghpr-monitor command
	// -----------------------------------------------------------------------

	pi.registerCommand("ghpr-monitor", {
		description: "Start or stop PR monitoring: /ghpr-monitor [on|off] or /ghpr-monitor owner/repo number",
		getArgumentCompletions: (prefix: string) => {
			const completions = ["on", "off", "stop"];
			return completions.filter((c) => c.startsWith(prefix)).map((c) => ({ value: c, label: c }));
		},
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();

			if (arg === "off" || arg === "stop") {
				const msg = stopMonitor();
				ctx.ui.notify(msg, "info");
				return;
			}

			if (arg === "on" || arg === "") {
				if (monitorState.status === "running") {
					ctx.ui.notify(
						`Already monitoring ${monitorState.config.owner}/${monitorState.config.repo}#${monitorState.config.number}`,
						"warning",
					);
					return;
				}
				ctx.ui.notify(
					"Usage: /ghpr-monitor owner/repo <pr-number>\nOr: /ghpr-monitor off — stop monitoring",
					"info",
				);
				return;
			}

			// Parse "owner/repo number"
			const parts = args.trim().split(/\s+/);
			if (parts.length >= 2 && parts[0].includes("/")) {
				const [ownerRepo, numStr] = [parts[0], parts[1]];
				const [owner, repo] = ownerRepo.split("/");
				const number = parseInt(numStr, 10);
				if (!owner || !repo || isNaN(number)) {
					ctx.ui.notify("Invalid format. Use: /ghpr-monitor owner/repo <pr-number>", "error");
					return;
				}
				const config: MonitorConfig = {
					owner,
					repo,
					number,
					host: "github.com",
					mode: "all",
					intervalSec: 60,
					debounceSec: 30,
				};
				const msg = startMonitor(config);
				ctx.ui.notify(msg, "success");
				return;
			}

			ctx.ui.notify(
				"Usage:\n  /ghpr-monitor owner/repo <pr-number>  — start monitoring\n  /ghpr-monitor off  — stop monitoring",
				"info",
			);
		},
	});

	// -----------------------------------------------------------------------
	// Register the ghpr-monitor tool (LLM-callable)
	// -----------------------------------------------------------------------

	const GhprMonitorParams = Type.Object({
		action: StringEnum(["start", "stop", "status"] as const, {
			description: "Action: start monitoring, stop monitoring, or check status",
		}),
		owner: Type.Optional(Type.String({ description: "Repository owner (e.g. 'v2nic')" })),
		repo: Type.Optional(Type.String({ description: "Repository name (e.g. 'gh-pr-review')" })),
		pr_number: Type.Optional(Type.Number({ description: "Pull request number" })),
		mode: Type.Optional(
			StringEnum(["all", "comments", "conflicts", "actions"] as const, {
				description: "What to watch for (default: all)",
			}),
		),
		interval: Type.Optional(Type.Number({ description: "Polling interval in seconds (default: 60, minimum: 10)" })),
	});

	pi.registerTool({
		name: "ghpr-monitor",
		label: "GH PR Monitor",
		description:
			"Monitor a GitHub pull request for comments, conflicts, and CI status changes. Use action='start' with owner, repo, and pr_number to begin monitoring. Use action='stop' to stop. Use action='status' to check current monitoring state. Updates are injected as notifications into the session.",
		promptSnippet: "Monitor a GitHub PR for changes (comments, conflicts, CI failures)",
		promptGuidelines: [
			"When the user asks you to watch or monitor a PR, use ghpr-monitor with action='start'.",
			"When the user wants to stop monitoring, use action='stop'.",
			"You will receive PR status updates as notifications — address any issues noted.",
		],
		parameters: GhprMonitorParams,

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			switch (params.action) {
				case "start": {
					if (monitorState.status === "running") {
						const c = monitorState.config;
						return {
							content: [
								{
									type: "text",
									text: `Already monitoring ${c.owner}/${c.repo}#${c.number}. Stop it first with action='stop'.`,
								},
							],
							details: { action: "start", status: "already_running", config: monitorState.config },
						};
					}

					if (!params.owner || !params.repo || !params.pr_number) {
						return {
							content: [
								{
									type: "text",
									text: "Missing required parameters: owner, repo, and pr_number are required for action='start'.",
								},
							],
							details: { action: "start", status: "missing_params" },
						};
					}

					const config: MonitorConfig = {
						owner: params.owner,
						repo: params.repo,
						number: params.pr_number,
						host: "github.com",
						mode: params.mode || "all",
						intervalSec: Math.max(10, params.interval || 60),
						debounceSec: 30,
					};

					const msg = startMonitor(config);
					return {
						content: [{ type: "text", text: msg }],
						details: { action: "start", status: "started", config },
					};
				}

				case "stop": {
					const msg = stopMonitor();
					return {
						content: [{ type: "text", text: msg }],
						details: { action: "stop", status: "stopped" },
					};
				}

				case "status": {
					if (monitorState.status === "idle") {
						return {
							content: [{ type: "text", text: "No PR monitor is currently active." }],
							details: { action: "status", status: "idle" },
						};
					}
					if (monitorState.status === "running") {
						const c = monitorState.config;
						const statusLine = lastStatus
							? `\nLast update: ${lastStatus.unresolvedThreads} unresolved threads, ${lastStatus.generalComments} comments, conflicts: ${lastStatus.hasConflicts}, failing: ${lastStatus.failingChecks.join(", ") || "none"}`
							: "\nNo status update received yet.";
						return {
							content: [
								{
									type: "text",
									text: `Monitoring ${c.owner}/${c.repo}#${c.number} (mode: ${c.mode}, interval: ${c.intervalSec}s)${statusLine}`,
								},
							],
							details: { action: "status", status: "running", config: c, lastStatus },
						};
					}
					return {
						content: [{ type: "text", text: `Monitor state: ${monitorState.status}` }],
						details: { action: "status", status: monitorState.status },
					};
				}

				default:
					return {
						content: [{ type: "text", text: `Unknown action: ${params.action}` }],
						details: { action: params.action, status: "unknown" },
					};
			}
		},
	});
}