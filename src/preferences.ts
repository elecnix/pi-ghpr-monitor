/**
 * Preferences module for pi-ghpr-monitor
 *
 * Stores customizable prompt overrides in
 * ~/.config/pi-ghpr-monitor/preferences.json
 *
 * Each preference is an optional string template that can reference
 * template variables. When a preference is set, it replaces the
 * hardcoded default message for that situation. When not set, the
 * default is used.
 *
 * Template variables available in all preferences:
 *   {owner}, {repo}, {number}, {host}, {prLabel}
 *
 * Additional situation-specific variables:
 *   newComments:  {unresolvedThreads}, {generalComments}
 *   conflict:     (none extra)
 *   ciFailure:    {failingChecks}
 *   reminder:     {unresolvedThreads}, {generalComments}, {failingChecks}, {conflict}
 *   allClear:     (none extra)
 *   firstPoll:    {intervalSec}
 *   descriptionStaleness: {commitOid}, {commitShortOid}, {commitUrl}, {commitAuthor}, {commitCoauthors}, {commitMessageHeadline}
 *   prCreateNudge: {prUrl}
 *   retriggerComments: (boolean, no template vars)
 */

import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Static } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { log } from "./logger";
import { DEFAULT_PR_CREATE_NUDGE } from "./pr-create-hook";

// ---------------------------------------------------------------------------
// TypeBox schema
// ---------------------------------------------------------------------------

export const PreferencesSchema = Type.Object(
	{
		newComments: Type.Optional(
			Type.String({
				description:
					"Prompt override for new review comments / unresolved threads. Variables: {owner}, {repo}, {number}, {host}, {prLabel}, {unresolvedThreads}, {generalComments}",
			}),
		),
		ignoredBots: Type.Optional(
			Type.Array(Type.String(), {
				description:
					"GitHub usernames whose general comments (IssueComment) should be silently ignored. Review thread comments are unaffected.",
			}),
		),
		conflict: Type.Optional(
			Type.String({
				description:
					"Prompt override for merge conflicts. Variables: {owner}, {repo}, {number}, {host}, {prLabel}",
			}),
		),
		ciFailure: Type.Optional(
			Type.String({
				description:
					"Prompt override for CI failures. Variables: {owner}, {repo}, {number}, {host}, {prLabel}, {failingChecks}",
			}),
		),
		reminder: Type.Optional(
			Type.String({
				description:
					"Prompt override for periodic reminders. Variables: {owner}, {repo}, {number}, {host}, {prLabel}, {unresolvedThreads}, {generalComments}, {failingChecks}, {conflict}",
			}),
		),
		allClear: Type.Optional(
			Type.String({
				description:
					"Prompt override for all-clear status. Variables: {owner}, {repo}, {number}, {host}, {prLabel}",
			}),
		),
		firstPoll: Type.Optional(
			Type.String({
				description:
					"Prompt override for the initial status on first poll. Variables: {owner}, {repo}, {number}, {host}, {prLabel}, {intervalSec}",
			}),
		),
		descriptionStaleness: Type.Optional(
			Type.String({
				description:
					"Prompt override for description staleness nudge when new commits are detected. Variables: {owner}, {repo}, {number}, {host}, {prLabel}, {prUrl}, {commitOid}, {commitShortOid}, {commitUrl}, {commitAuthor}, {commitCoauthors}, {commitMessageHeadline}",
			}),
		),
		prCreateNudge: Type.Optional(
			Type.String({
				description:
					"Prompt override for auto-detecting gh pr create output and nudging the LLM to start monitoring. Variables: {owner}, {repo}, {number}, {host}, {prLabel}, {prUrl}",
			}),
		),
		ciGreenMerge: Type.Optional(
			Type.String({
				description:
					"Prompt override for when auto-merge is enabled and CI turns green. Variables: {owner}, {repo}, {number}, {host}, {prLabel}",
			}),
		),
		retriggerComments: Type.Optional(
			Type.Boolean({
				description:
					"When true, reminders and periodic nudges re-report all comments and threads, even those already seen. Default false (only report new items).",
			}),
		),
	},
	{
		additionalProperties: false,
	},
);

export type Preferences = Static<typeof PreferencesSchema>;

/** Default value for retriggerComments (used at runtime; not a template). */
export const DEFAULT_RETRIGGER_COMMENTS = false;

/** Allowed preference keys for validation error messages */
const ALLOWED_KEYS = new Set(Object.keys(PreferencesSchema.properties));

/** Preference keys that are not string templates (skip template variable validation). */
const NON_TEMPLATE_KEY_VALUES = ["ignoredBots", "retriggerComments"] as const;
/** Runtime set for .has() lookups. */
const NON_TEMPLATE_KEYS = new Set<string>(NON_TEMPLATE_KEY_VALUES);

/** Type union of non-template preference keys — derived from the canonical array. */
type NonTemplateKey = (typeof NON_TEMPLATE_KEY_VALUES)[number];

// ---------------------------------------------------------------------------
// Default preference templates
//
// These are the built-in message templates used when no custom preference
// is set. They are shown in the preferences display so users know what
// each key defaults to and can craft overrides that match the style.
// ---------------------------------------------------------------------------

/**
 * Default preference templates for each key.
 *
 * Keys with simple template-string defaults are shown verbatim in the
 * preferences display. Keys whose runtime default is a computed,
 * multi-line summary (rather than a single template) use `undefined` here
 * and are labelled "(computed)" in the display.
 */
export const DEFAULT_PREFERENCES: Partial<Record<keyof Preferences, string | undefined>> = {
	newComments: "💬 {unresolvedThreads} unresolved review thread(s) on {prLabel}",
	conflict: "⚠️  Merge conflicts detected on {prLabel}",
	ciFailure: "❌ Failing CI checks on {prLabel}: {failingChecks}",
	reminder: undefined,
	allClear: "✨ {prLabel} — no issues, all clear",
	firstPoll: "📡 Monitoring {owner}/{repo}#{number}... (polling every {intervalSec}s)",
	descriptionStaleness: undefined,
	prCreateNudge: DEFAULT_PR_CREATE_NUDGE,
	ciGreenMerge: "✅ CI is green on {prLabel}. Please merge the pull request.",
};

// ---------------------------------------------------------------------------
// Preference file path
// ---------------------------------------------------------------------------

const CONFIG_DIR = path.join(os.homedir(), ".config", "pi-ghpr-monitor");
const PREFERENCES_FILE = path.join(CONFIG_DIR, "preferences.json");

/**
 * Override the preferences file path (for testing).
 * When set, loadPreferences/savePreferences use this path instead
 * of the default ~/.config/pi-ghpr-monitor/preferences.json.
 */
let preferencesPathOverride: string | undefined;

/**
 * Set a custom preferences file path. Used in tests to avoid writing
 * to the real config directory.
 */
export function setPreferencesPath(overridePath: string | undefined): void {
	preferencesPathOverride = overridePath;
}

function getEffectiveFilePath(): string {
	return preferencesPathOverride ?? PREFERENCES_FILE;
}

// ---------------------------------------------------------------------------
// Template interpolation
// ---------------------------------------------------------------------------

export interface TemplateVars {
	owner: string;
	repo: string;
	number: number;
	host: string;
	prLabel: string;
	prUrl: string;
	// Situation-specific (may be undefined depending on context)
	unresolvedThreads?: number;
	generalComments?: number;
	failingChecks?: string;
	conflict?: boolean;
	intervalSec?: number;
	// Commit-related (used by descriptionStaleness)
	commitOid?: string;
	commitShortOid?: string;
	commitUrl?: string;
	commitAuthor?: string;
	commitCoauthors?: string;
	commitMessageHeadline?: string;
}

const TEMPLATE_VAR_RE = /\{(owner|repo|number|host|prLabel|prUrl|unresolvedThreads|generalComments|failingChecks|conflict|intervalSec|commitOid|commitShortOid|commitUrl|commitAuthor|commitCoauthors|commitMessageHeadline)\}/g;

/** Non-global version for .test() checks. The /g flag causes .test() to
 *  advance lastIndex across successive calls, producing false negatives.
 *  Use TEMPLATE_VAR_RE for .replace() (needs /g) and this for .test().
 *  Derived from TEMPLATE_VAR_RE.source to keep a single source of truth.
 */
const TEMPLATE_VAR_RE_NONGLOBAL = new RegExp(TEMPLATE_VAR_RE.source);

/**
 * Replace template placeholders with actual values.
 * Unknown placeholders are left as-is.
 */
export function interpolateTemplate(template: string, vars: TemplateVars): string {
	return template.replace(TEMPLATE_VAR_RE, (match, key: string) => {
		switch (key) {
			case "owner":
				return vars.owner;
			case "repo":
				return vars.repo;
			case "number":
				return String(vars.number);
			case "host":
				return vars.host;
			case "prLabel":
				return vars.prLabel;
			case "prUrl":
				return vars.prUrl;
			case "unresolvedThreads":
				return vars.unresolvedThreads !== undefined ? String(vars.unresolvedThreads) : match;
			case "generalComments":
				return vars.generalComments !== undefined ? String(vars.generalComments) : match;
			case "failingChecks":
				return vars.failingChecks ?? match;
			case "conflict":
				return vars.conflict !== undefined ? String(vars.conflict) : match;
			case "intervalSec":
				return vars.intervalSec !== undefined ? String(vars.intervalSec) : match;
			case "commitOid":
				return vars.commitOid ?? match;
			case "commitShortOid":
				return vars.commitShortOid ?? match;
			case "commitUrl":
				return vars.commitUrl ?? match;
			case "commitAuthor":
				return vars.commitAuthor ?? match;
			case "commitCoauthors":
				return vars.commitCoauthors ?? match;
			case "commitMessageHeadline":
				return vars.commitMessageHeadline ?? match;
			default:
				return match;
		}
	});
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ValidationResult {
	ok: boolean;
	errors: string[];
	preferences?: Preferences;
	/** Keys that were set to null (reset to default). Used by the caller to
	 *  remove these keys from the current preferences when merging. */
	resetKeys?: (keyof Preferences)[];
}

/**
 * Validate a JSON string against the PreferencesSchema.
 * Returns a structured result with errors if invalid.
 *
 * In addition to structural validation, this checks that each preference
 * value contains at least one template variable (e.g. {owner}, {prLabel}).
 * Bare strings without template variables are rejected because they produce
 * nonsensical notifications that get injected into the LLM context as user
 * messages — the agent cannot distinguish a literal "second" from a real
 * user prompt.
 *
 * Null values are accepted and mean "reset this key to default".
 * When a null value is encountered, the key is removed from the preferences
 * object, causing the default template to be used instead.
 */
export function validatePreferences(jsonString: string): ValidationResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonString);
	} catch (e) {
		return {
			ok: false,
			errors: [`Invalid JSON: ${(e as Error).message}`],
		};
	}

	// Check for extra keys not in the schema
	if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
		const parsedObj = parsed as Record<string, unknown>;
		const extraKeys = Object.keys(parsedObj).filter((k) => !ALLOWED_KEYS.has(k));
		if (extraKeys.length > 0) {
			return {
				ok: false,
				errors: [
					`Unknown preference keys: ${extraKeys.join(", ")}. Allowed keys: ${[...ALLOWED_KEYS].join(", ")}`,
				],
			};
		}
	}

	// Normalize: remove null values (meaning "reset to default").
	// Null is not part of the TypeBox schema (Optional[String]), so we strip
	// nulls before schema validation. After stripping, the key is removed
	// entirely from the saved preferences, which means the default will be used.
	// We track which keys were null so the caller can remove them from the
	// current preferences when merging.
	const resetKeys: (keyof Preferences)[] = [];
	if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
		const parsedObj = parsed as Record<string, unknown>;
		for (const key of [...Object.keys(parsedObj)]) {
			if (parsedObj[key] === null) {
				resetKeys.push(key as keyof Preferences);
				delete parsedObj[key];
			}
		}
	}

	// Use TypeBox Value.Check for structural validation
	if (!Value.Check(PreferencesSchema, parsed)) {
		const errors: string[] = [];
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return {
				ok: false,
				errors: ["Preferences must be a JSON object with optional string values. Use null to reset a key to default."],
			};
		}

		const parsedObj = parsed as Record<string, unknown>;
		for (const [key, value] of Object.entries(parsedObj)) {
			if (value === undefined) continue;
			if (key === "ignoredBots") {
				if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
					errors.push(`Expected array of strings for '${key}', got ${typeof value}`);
				}
			} else if (typeof value !== "string") {
				errors.push(`Expected string or null for '${key}', got ${typeof value}`);
			}
		}

		if (errors.length === 0) {
			errors.push("Preferences validation failed. Check that all values are strings or null (to reset to default).");
		}

		return { ok: false, errors };
	}

	// Check that each preference value contains at least one template variable.
	// Bare strings without template variables are dangerous because they get
	// injected into the LLM context as user messages, and the agent cannot
	// distinguish them from real user input.
	// Empty strings are allowed — they act as "use default".
	const templatelessKeys: string[] = [];
	const prefs = parsed as Preferences;
	for (const [key, value] of Object.entries(prefs)) {
		if (NON_TEMPLATE_KEYS.has(key)) continue;
		if (typeof value === "string" && value !== "" && !TEMPLATE_VAR_RE_NONGLOBAL.test(value)) {
			templatelessKeys.push(key);
		}
	}
	if (templatelessKeys.length > 0) {
		return {
			ok: false,
			errors: [
				`Preference${templatelessKeys.length > 1 ? "s" : ""} without template variables: ${templatelessKeys.join(", ")}. ` +
				`Each preference must contain at least one template variable (e.g. {owner}, {repo}, {prLabel}) ` +
				`so the notification includes PR context. Bare strings get injected into the LLM as user messages ` +
				`and can be mistaken for real user input.`,
			],
		};
	}

	return {
		ok: true,
		errors: [],
		preferences: parsed as Preferences,
		resetKeys,
	};
}

// ---------------------------------------------------------------------------
// Merge preferences with defaults
// ---------------------------------------------------------------------------

/**
 * Merge user preferences with defaults, returning the effective value
 * for each key. Keys not overridden by the user get their default value.
 * Empty string overrides are treated as "use default" (excluded from result).
 * Keys with no static default (undefined in DEFAULT_PREFERENCES) are
 * excluded from the result — they have computed defaults at runtime.
 */
export function getEffectivePreferences(prefs: Preferences): Partial<Record<keyof Preferences, string>> {
	const result: Partial<Record<keyof Preferences, string>> = {};
	for (const key of Object.keys(DEFAULT_PREFERENCES) as (keyof Preferences)[]) {
		const override = prefs[key];
		if (override !== undefined && override !== "") {
			result[key] = override as string;
		} else if (DEFAULT_PREFERENCES[key] !== undefined) {
			result[key] = DEFAULT_PREFERENCES[key] as string;
		}
		// Keys with undefined defaults are simply omitted — they have
		// computed defaults that can't be represented as a template.
	}
	return result;
}

// ---------------------------------------------------------------------------
// Load / Save
// ---------------------------------------------------------------------------

/**
 * Load preferences from disk. Returns an empty object if the file does not
 * exist or cannot be read. Logs warnings on errors.
 * Uses the override path if set via setPreferencesPath().
 */
export function loadPreferences(): Preferences {
	const filePath = getEffectiveFilePath();
	try {
		if (!fs.existsSync(filePath)) {
			log("No preferences file found, using defaults");
			return {};
		}
		const raw = fs.readFileSync(filePath, "utf-8");
		const parsed: unknown = JSON.parse(raw);
		if (!Value.Check(PreferencesSchema, parsed)) {
			log("Preferences file is invalid, using defaults");
			return {};
		}

		// Check for bare-string preferences without template variables.
		// These are dangerous because they get injected into the LLM context
		// as user messages without any PR context.
		const prefs = parsed as Preferences;
		const templatelessKeys: string[] = [];
		for (const [key, value] of Object.entries(prefs)) {
			if (NON_TEMPLATE_KEYS.has(key)) continue;
			if (typeof value === "string" && value !== "" && !TEMPLATE_VAR_RE_NONGLOBAL.test(value)) {
				templatelessKeys.push(key);
			}
		}
		if (templatelessKeys.length > 0) {
			log(`WARNING: Preferences without template variables found: ${templatelessKeys.join(", ")}. ` +
				`These produce nonsensical notifications. Ignoring them. ` +
			`Update ~/.config/pi-ghpr-monitor/preferences.json to include template variables like {owner}, {repo}, {prLabel}.`);
			// Remove the templateless entries so they don't produce garbage notifications
			for (const key of templatelessKeys) {
				delete (prefs as Record<string, unknown>)[key];
			}
		}

		return prefs;
	} catch (err) {
		log(`Error loading preferences: ${(err as Error).message}`);
		return {};
	}
}

/**
 * Save preferences to disk. Creates the config directory if it doesn't exist.
 * Writes atomically via a temp file and rename.
 * Uses the override path if set via setPreferencesPath().
 */
export function savePreferences(prefs: Preferences): void {
	const filePath = getEffectiveFilePath();
	const dir = path.dirname(filePath);
	fs.mkdirSync(dir, { recursive: true });
	const tmpFile = filePath + ".tmp";
	fs.writeFileSync(tmpFile, JSON.stringify(prefs, null, 2) + "\n", "utf-8");
	fs.renameSync(tmpFile, filePath);
	log(`Preferences saved to ${filePath}`);
}

/**
 * Get the path to the preferences file (useful for tests and display).
 * Returns the override path if set, otherwise the default path.
 */
export function getPreferencesPath(): string {
	return getEffectiveFilePath();
}

// ---------------------------------------------------------------------------
// Preference lookup with fallback
// ---------------------------------------------------------------------------

/**
 * Look up a preference for a given situation key. If set, interpolate
 * template variables. If not set, return the default value.
 */
export function getPreferenceWithDefault(
	key: Exclude<keyof Preferences, NonTemplateKey>,
	prefs: Preferences,
	vars: TemplateVars,
	defaultValue: string,
): string {
	const template = prefs[key];
	if (template !== undefined && template !== "") {
		return interpolateTemplate(template, vars);
	}
	return defaultValue;
}