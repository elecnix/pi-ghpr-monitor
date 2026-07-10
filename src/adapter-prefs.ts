/**
 * Pi-specific adapter preferences.
 *
 * `gh monitor` owns the notification *templates*, `ignoredBots`, and
 * `retriggerComments` (read/written via `gh monitor prefs`). This module owns
 * the handful of preferences that are meaningful only inside the Pi harness:
 *
 *   - disableMergeTool: hide the `merge` tool action from the LLM (user-only).
 *   - prCreateNudge:    template for the steer message injected after
 *                       `gh pr create` (see pr-create-hook.ts).
 *   - ciGreenMerge:     template for the "CI is green, merge now" nudge the
 *                       adapter emits when auto-merge is enabled and CI goes
 *                       green.
 *
 * Stored at ~/.config/pi-ghpr-monitor/adapter.json, separate from gh-monitor's
 * preferences so neither side's schema has to know about the other. On first
 * load, the three keys are migrated out of the legacy
 * ~/.config/pi-ghpr-monitor/preferences.json if present.
 */

import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { DEFAULT_PR_CREATE_NUDGE } from "./pr-create-hook";

export interface AdapterPrefs {
	disableMergeTool?: boolean;
	prCreateNudge?: string;
	ciGreenMerge?: string;
}

export const DEFAULT_DISABLE_MERGE_TOOL = false;
export const DEFAULT_CI_GREEN_MERGE =
	"✅ All CI checks passed on {prLabel}. CI is green — consider merging now (auto-merge was requested).";

const CONFIG_DIR = path.join(os.homedir(), ".config", "pi-ghpr-monitor");
const ADAPTER_FILE = path.join(CONFIG_DIR, "adapter.json");
const LEGACY_PREFS_FILE = path.join(CONFIG_DIR, "preferences.json");

let pathOverride: string | undefined;

/** Override the adapter prefs file path (used by tests). */
export function setAdapterPrefsPath(override: string | undefined): void {
	pathOverride = override;
}

export function adapterPrefsPath(): string {
	return pathOverride ?? ADAPTER_FILE;
}

/** Resolve the effective value of a pi-specific pref, applying its default. */
export function getAdapterPref<K extends keyof AdapterPrefs>(
	key: K,
	prefs: AdapterPrefs,
): string | boolean | undefined {
	const v = prefs[key];
	if (v !== undefined && v !== "") return v;
	switch (key) {
		case "disableMergeTool": return DEFAULT_DISABLE_MERGE_TOOL;
		case "prCreateNudge": return DEFAULT_PR_CREATE_NUDGE;
		case "ciGreenMerge": return DEFAULT_CI_GREEN_MERGE;
		default: return undefined;
	}
}

/**
 * Load pi-specific prefs, merging the file over defaults. Best-effort migrates
 * the three keys from the legacy preferences.json if adapter.json is absent.
 */
export function loadAdapterPrefs(): AdapterPrefs {
	const file = adapterPrefsPath();
	let prefs: AdapterPrefs = {};

	if (fs.existsSync(file)) {
		try {
			prefs = JSON.parse(fs.readFileSync(file, "utf-8")) as AdapterPrefs;
		} catch {
			// corrupt file — start clean
			prefs = {};
		}
	} else if (fs.existsSync(LEGACY_PREFS_FILE) && !pathOverride) {
		// One-time migration from the legacy preferences file.
		try {
			const legacy = JSON.parse(fs.readFileSync(LEGACY_PREFS_FILE, "utf-8")) as Partial<AdapterPrefs>;
			prefs.disableMergeTool = legacy.disableMergeTool;
			prefs.prCreateNudge = legacy.prCreateNudge;
			prefs.ciGreenMerge = legacy.ciGreenMerge;
		} catch {
			prefs = {};
		}
	}
	return prefs;
}

/** Merge a partial update into the adapter prefs file and return the result. */
export function saveAdapterPrefs(partial: AdapterPrefs): AdapterPrefs {
	const current = loadAdapterPrefs();
	const merged: AdapterPrefs = { ...current };

	for (const key of Object.keys(partial) as (keyof AdapterPrefs)[]) {
		const v = partial[key];
		if (v === undefined || v === null) {
			// null/undefined resets to default → remove from file
			delete merged[key];
		} else {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(merged as any)[key] = v;
		}
	}

	const file = adapterPrefsPath();
	const dir = path.dirname(file);
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
	fs.writeFileSync(file, JSON.stringify(merged, null, 2) + "\n", { mode: 0o644 });
	return merged;
}

// ---------------------------------------------------------------------------
// Template interpolation (shared with gh-monitor's token set)
// ---------------------------------------------------------------------------

export interface PrefVars {
	owner?: string;
	repo?: string;
	number?: string | number;
	host?: string;
	prLabel?: string;
	prUrl?: string;
	commitOid?: string;
	commitShortOid?: string;
	commitUrl?: string;
	commitAuthor?: string;
	commitCoauthors?: string;
	commitMessageHeadline?: string;
	[key: string]: string | number | undefined;
}

const TOKEN_RE = /\{([a-zA-Z]+)\}/g;

/** Replace {token} placeholders with vars values; unknown tokens stay literal. */
export function interpolatePref(template: string, vars: PrefVars): string {
	return template.replace(TOKEN_RE, (match, name: string) => {
		const val = vars[name];
		if (val === undefined || val === null) return match;
		return String(val);
	});
}