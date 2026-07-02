/**
 * Tests for the preferences module
 *
 * Tests schema validation, load/save, template interpolation,
 * and preference lookup with fallback to defaults.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
	PreferencesSchema,
	validatePreferences,
	loadPreferences,
	savePreferences,
	getPreferencesPath,
	setPreferencesPath,
	interpolateTemplate,
	getPreferenceWithDefault,
	DEFAULT_PREFERENCES,
	DEFAULT_DISABLE_MERGE_TOOL,
	getEffectivePreferences,
	type Preferences,
	type TemplateVars,
} from "../src/preferences";
import type { ThreadSummary, CommentSummary, CheckSummary } from "../src/analyzer";

// ---------------------------------------------------------------------------
// Helper: create a temp dir for preferences testing
// ---------------------------------------------------------------------------

let tmpDir: string;
let originalPath: string | undefined;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ghpr-prefs-test-"));
	setPreferencesPath(undefined); // Reset first
});

afterEach(() => {
	// Clean up temp dir and reset preferences path
	fs.rmSync(tmpDir, { recursive: true, force: true });
	setPreferencesPath(undefined);
});

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

describe("validatePreferences", () => {
	it("accepts an empty object", () => {
		const result = validatePreferences("{}");
		expect(result.ok).toBe(true);
		expect(result.preferences).toEqual({});
	});

	it("accepts valid partial preferences", () => {
		const result = validatePreferences('{"conflict": "⚠️ Conflict on {prLabel}!"}');
		expect(result.ok).toBe(true);
		expect(result.preferences).toEqual({
			conflict: "⚠️ Conflict on {prLabel}!",
		});
	});

	it("accepts all valid preference keys", () => {
		const json = JSON.stringify({
			newComments: "New comments on {prLabel}",
			conflict: "Conflict on {prLabel}",
			ciFailure: "CI failing on {prLabel}",
			reminder: "Still issues on {prLabel}",
			allClear: "All clear on {prLabel}",
			firstPoll: "Monitoring {prLabel}...",
			ciGreenMerge: "Please merge {prLabel}",
		});
		const result = validatePreferences(json);
		expect(result.ok).toBe(true);
		expect(Object.keys(result.preferences!)).toHaveLength(7);
	});

	it("rejects invalid JSON", () => {
		const result = validatePreferences("not json");
		expect(result.ok).toBe(false);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toContain("Invalid JSON");
	});

	it("rejects unknown preference keys", () => {
		const result = validatePreferences('{"unknownKey": "value"}');
		expect(result.ok).toBe(false);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toContain("Unknown preference keys");
		expect(result.errors[0]).toContain("unknownKey");
	});

	it("rejects non-string values", () => {
		const result = validatePreferences('{"conflict": 123}');
		expect(result.ok).toBe(false);
		expect(result.errors.some((e: string) => e.includes("Expected string"))).toBe(true);
	});

	it("rejects array value", () => {
		const result = validatePreferences('["conflict"]');
		expect(result.ok).toBe(false);
	});

	it("accepts null value as reset to default", () => {
		const result = validatePreferences('{"conflict": null}');
		expect(result.ok).toBe(true);
		// null means reset — key should be removed from the result
		expect(result.preferences!.conflict).toBeUndefined();
	});

	it("accepts null alongside string values", () => {
		const result = validatePreferences('{"conflict": null, "ciFailure": "💥 CI failed on {prLabel}: {failingChecks}"}');
		expect(result.ok).toBe(true);
		expect(result.preferences!.conflict).toBeUndefined();
		expect(result.preferences!.ciFailure).toBe("💥 CI failed on {prLabel}: {failingChecks}");
	});

	it("accepts empty string values (not treated as bare strings)", () => {
		const result = validatePreferences('{"conflict": ""}');
		expect(result.ok).toBe(true);
		expect(result.preferences!.conflict).toBe("");
	});

	it("allows valid keys alongside invalid ones", () => {
		// Extra keys should be rejected, but valid keys should pass
		const result = validatePreferences('{"conflict": "foo", "bogus": "bar"}');
		expect(result.ok).toBe(false);
		expect(result.errors[0]).toContain("bogus");
	});

	it("rejects bare strings without template variables", () => {
		const result = validatePreferences('{"ciFailure": "second"}');
		expect(result.ok).toBe(false);
		expect(result.errors[0]).toContain("without template variables");
		expect(result.errors[0]).toContain("ciFailure");
	});

	it("rejects multiple bare strings without template variables", () => {
		const result = validatePreferences('{"ciFailure": "oops", "conflict": "uh oh"}');
		expect(result.ok).toBe(false);
		expect(result.errors[0]).toContain("ciFailure");
		expect(result.errors[0]).toContain("conflict");
	});

	it("accepts preference with template variables", () => {
		const result = validatePreferences('{"ciFailure": "💥 CI failed on {prLabel}: {failingChecks}"}');
		expect(result.ok).toBe(true);
	});

	it("accepts disableMergeTool as a boolean", () => {
		const result = validatePreferences('{"disableMergeTool": true}');
		expect(result.ok).toBe(true);
		expect(result.preferences!.disableMergeTool).toBe(true);
	});

	it("rejects disableMergeTool as a string", () => {
		const result = validatePreferences('{"disableMergeTool": "yes"}');
		expect(result.ok).toBe(false);
		expect(result.errors.some((e: string) => e.includes("disableMergeTool"))).toBe(true);
	});

});

// ---------------------------------------------------------------------------
// Template interpolation
// ---------------------------------------------------------------------------

describe("interpolateTemplate", () => {
	const vars: TemplateVars = {
		owner: "v2nic",
		repo: "pi-ghpr-monitor",
		number: 32,
		host: "github.com",
		prLabel: "v2nic/pi-ghpr-monitor#32",
		prUrl: "https://github.com/v2nic/pi-ghpr-monitor/pull/32",
	};

	it("replaces all basic template variables", () => {
		const result = interpolateTemplate("{owner}/{repo}#{number} on {host}", vars);
		expect(result).toBe("v2nic/pi-ghpr-monitor#32 on github.com");
	});

	it("replaces prLabel", () => {
		const result = interpolateTemplate("PR: {prLabel}", vars);
		expect(result).toBe("PR: v2nic/pi-ghpr-monitor#32");
	});

	it("replaces prUrl", () => {
		const result = interpolateTemplate("PR: {prUrl}", vars);
		expect(result).toBe("PR: https://github.com/v2nic/pi-ghpr-monitor/pull/32");
	});

	it("replaces situation-specific variables when provided", () => {
		const result = interpolateTemplate("{unresolvedThreads} threads, {generalComments} comments, {failingChecks} failures", {
			...vars,
			unresolvedThreads: 3,
			generalComments: 2,
			failingChecks: "ci/test, ci/build",
		});
		expect(result).toBe("3 threads, 2 comments, ci/test, ci/build failures");
	});

	it("leaves unknown placeholders intact", () => {
		const result = interpolateTemplate("Hello {unknown} {owner}", vars);
		expect(result).toBe("Hello {unknown} v2nic");
	});

	it("leaves situation-specific placeholders intact when not provided", () => {
		const result = interpolateTemplate("{unresolvedThreads} threads on {prLabel}", vars);
		expect(result).toBe("{unresolvedThreads} threads on v2nic/pi-ghpr-monitor#32");
	});

	it("handles conflict variable", () => {
		const result = interpolateTemplate("Conflict: {conflict}", {
			...vars,
			conflict: true,
		});
		expect(result).toBe("Conflict: true");
	});

	it("handles empty template", () => {
		const result = interpolateTemplate("", vars);
		expect(result).toBe("");
	});

	it("handles template with no variables", () => {
		const result = interpolateTemplate("No variables here", vars);
		expect(result).toBe("No variables here");
	});
});

// ---------------------------------------------------------------------------
// Preference lookup with fallback
// ---------------------------------------------------------------------------

describe("getPreferenceWithDefault", () => {
	const vars: TemplateVars = {
		owner: "v2nic",
		repo: "pi-ghpr-monitor",
		number: 32,
		host: "github.com",
		prLabel: "v2nic/pi-ghpr-monitor#32",
		prUrl: "https://github.com/v2nic/pi-ghpr-monitor/pull/32",
	};

	it("returns default when preference is undefined", () => {
		const result = getPreferenceWithDefault("conflict", {}, vars, "default conflict message");
		expect(result).toBe("default conflict message");
	});

	it("returns default when preference is empty string", () => {
		const result = getPreferenceWithDefault("conflict", { conflict: "" }, vars, "default conflict message");
		expect(result).toBe("default conflict message");
	});

	it("returns interpolated preference when set", () => {
		const result = getPreferenceWithDefault("conflict", { conflict: "⚠️ Conflict on {prLabel}!" }, vars, "default");
		expect(result).toBe("⚠️ Conflict on v2nic/pi-ghpr-monitor#32!");
	});

	it("interpolates situation-specific variables", () => {
		const result = getPreferenceWithDefault("newComments", { newComments: "{unresolvedThreads} threads on {prLabel}" }, {
			...vars,
			unresolvedThreads: 5,
		}, "default");
		expect(result).toBe("5 threads on v2nic/pi-ghpr-monitor#32");
	});
});

// ---------------------------------------------------------------------------
// Load / Save
// ---------------------------------------------------------------------------

describe("loadPreferences / savePreferences", () => {
	it("returns empty object when file does not exist", () => {
		const prefsPath = path.join(tmpDir, "test1.json");
		setPreferencesPath(prefsPath);
		const prefs = loadPreferences();
		expect(prefs).toEqual({});
	});

	it("saves and loads preferences round-trip", () => {
		const prefsPath = path.join(tmpDir, "test2.json");
		setPreferencesPath(prefsPath);
		const prefs: Preferences = {
			conflict: "⚠️ Conflict on {prLabel}!",
			ciFailure: "CI failing: {failingChecks}",
		};
		savePreferences(prefs);

		const loaded = loadPreferences();
		expect(loaded).toEqual(prefs);
	});

	it("persists preferences to disk", () => {
		const prefsPath = path.join(tmpDir, "test3.json");
		setPreferencesPath(prefsPath);
		savePreferences({ allClear: "✨ {prLabel} all clear!" });

		expect(fs.existsSync(prefsPath)).toBe(true);
		const raw = JSON.parse(fs.readFileSync(prefsPath, "utf-8"));
		expect(raw.allClear).toBe("✨ {prLabel} all clear!");
	});

	it("ignores invalid preferences file on load", () => {
		const prefsPath = path.join(tmpDir, "test4.json");
		setPreferencesPath(prefsPath);
		fs.writeFileSync(prefsPath, "not json", "utf-8");

		const prefs = loadPreferences();
		expect(prefs).toEqual({});
	});

	it("ignores preferences with wrong schema on load", () => {
		const prefsPath = path.join(tmpDir, "test5.json");
		setPreferencesPath(prefsPath);
		fs.writeFileSync(prefsPath, JSON.stringify({ unknownKey: "value" }), "utf-8");

		const prefs = loadPreferences();
		expect(prefs).toEqual({});
	});

	it("replaces entire preferences file on save", () => {
		const prefsPath = path.join(tmpDir, "test6.json");
		setPreferencesPath(prefsPath);
		savePreferences({ conflict: "first {prLabel}" });
		savePreferences({ ciFailure: "CI down, see {prLabel}" });

		const loaded = loadPreferences();
		expect(loaded).toEqual({ ciFailure: "CI down, see {prLabel}" });
		// conflict should NOT be present since save replaces the whole file
		expect("conflict" in loaded).toBe(false);
	});

	it("strips bare-string preferences on load", () => {
		const prefsPath = path.join(tmpDir, "test-bare.json");
		setPreferencesPath(prefsPath);
		// Simulate a corrupted preferences file with bare strings
		const badPrefs = { ciFailure: "second", conflict: "Conflict on {prLabel}!" };
		fs.writeFileSync(prefsPath, JSON.stringify(badPrefs), "utf-8");

		const loaded = loadPreferences();
		// ciFailure ("second") should be stripped, conflict (has template var) should remain
		expect(loaded.ciFailure).toBeUndefined();
		expect(loaded.conflict).toBe("Conflict on {prLabel}!");
	});

	it("saves null-reset preferences (keys removed from file)", () => {
		const prefsPath = path.join(tmpDir, "test-null-reset.json");
		setPreferencesPath(prefsPath);
		// First set a preference
		savePreferences({ conflict: "Conflict on {prLabel}!" });
		expect(loadPreferences().conflict).toBe("Conflict on {prLabel}!");

		// Now save with null (reset) — validatePreferences strips null keys
		const result = validatePreferences('{"conflict": null}');
		expect(result.ok).toBe(true);
		savePreferences(result.preferences!);

		// conflict should be gone (reset to default)
		const loaded = loadPreferences();
		expect(loaded.conflict).toBeUndefined();
	});

	it("merge: null reset preserves other custom preferences", () => {
		// This simulates the merge logic in index.ts:
		//   const merged = { ...currentPreferences, ...validated };
		//   for (const key of result.resetKeys ?? []) delete merged[key];
		const current: Preferences = { conflict: "Custom {prLabel}!", ciFailure: "CI: {failingChecks}" };

		// Validate a null reset for conflict only
		const result = validatePreferences('{"conflict": null}');
		expect(result.ok).toBe(true);
		expect(result.resetKeys).toContain("conflict");

		// Merge: current + validated, then remove reset keys
		const merged = { ...current, ...result.preferences! };
		for (const key of result.resetKeys ?? []) {
			delete merged[key];
		}

		// conflict should be gone (was reset)
		expect(merged.conflict).toBeUndefined();
		// ciFailure should be preserved from current
		expect(merged.ciFailure).toBe("CI: {failingChecks}");
	});
});

// ---------------------------------------------------------------------------
// DEFAULT_PREFERENCES and getEffectivePreferences
// ---------------------------------------------------------------------------

describe("DEFAULT_PREFERENCES", () => {
	it("has all preference keys", () => {
		expect(Object.keys(DEFAULT_PREFERENCES)).toHaveLength(9);
		expect(DEFAULT_PREFERENCES).toHaveProperty("newComments");
		expect(DEFAULT_PREFERENCES).toHaveProperty("conflict");
		expect(DEFAULT_PREFERENCES).toHaveProperty("ciFailure");
		expect(DEFAULT_PREFERENCES).toHaveProperty("reminder");
		expect(DEFAULT_PREFERENCES).toHaveProperty("allClear");
		expect(DEFAULT_PREFERENCES).toHaveProperty("firstPoll");
		expect(DEFAULT_PREFERENCES).toHaveProperty("descriptionStaleness");
		expect(DEFAULT_PREFERENCES).toHaveProperty("prCreateNudge");
		expect(DEFAULT_PREFERENCES).toHaveProperty("ciGreenMerge");
	});

	it("non-undefined defaults contain template variables", () => {
		for (const [key, value] of Object.entries(DEFAULT_PREFERENCES)) {
			if (value !== undefined) {
				expect(value).toMatch(/\{\w+\}/);
			}
		}
	});

	it("reminder has a computed default (undefined)", () => {
		expect(DEFAULT_PREFERENCES.reminder).toBeUndefined();
	});

	it("allClear default matches the hardcoded message", () => {
		expect(DEFAULT_PREFERENCES.allClear).toBe("✨ {prLabel} — open, all clear");
	});

	it("conflict default matches the hardcoded message", () => {
		expect(DEFAULT_PREFERENCES.conflict).toBe("⚠️  Merge conflicts detected on {prLabel}");
	});

	it("firstPoll default includes intervalSec variable", () => {
		expect(DEFAULT_PREFERENCES.firstPoll).toContain("{intervalSec}");
	});

	it("ciGreenMerge default includes merge request", () => {
		expect(DEFAULT_PREFERENCES.ciGreenMerge).toContain("Please merge");
		expect(DEFAULT_PREFERENCES.ciGreenMerge).toContain("{prLabel}");
	});

	it("disableMergeTool is a boolean, not a template string", () => {
		expect(DEFAULT_PREFERENCES).not.toHaveProperty("disableMergeTool");
	});

	it("disableMergeTool defaults to false", () => {
		expect(DEFAULT_DISABLE_MERGE_TOOL).toBe(false);
	});
});

describe("getEffectivePreferences", () => {
	it("returns static defaults when no overrides are set", () => {
		const effective = getEffectivePreferences({});
		// Keys with static defaults should be present
		expect(effective.conflict).toBe(DEFAULT_PREFERENCES.conflict);
		expect(effective.allClear).toBe(DEFAULT_PREFERENCES.allClear);
		expect(effective.ciFailure).toBe(DEFAULT_PREFERENCES.ciFailure);
		expect(effective.newComments).toBe(DEFAULT_PREFERENCES.newComments);
		expect(effective.firstPoll).toBe(DEFAULT_PREFERENCES.firstPoll);
		// reminder has no static default (computed at runtime)
		expect(effective.reminder).toBeUndefined();
	});

	it("overrides defaults with custom preferences", () => {
		const prefs: Preferences = { conflict: "🚨 CONFLICT on {prLabel}!" };
		const effective = getEffectivePreferences(prefs);
		expect(effective.conflict).toBe("🚨 CONFLICT on {prLabel}!");
		// Other keys still have defaults
		expect(effective.allClear).toBe(DEFAULT_PREFERENCES.allClear);
	});

	it("treats empty string overrides as default (use default)", () => {
		const prefs: Preferences = { conflict: "" };
		const effective = getEffectivePreferences(prefs);
		expect(effective.conflict).toBe(DEFAULT_PREFERENCES.conflict);
	});

	it("merges partial overrides with defaults", () => {
		const prefs: Preferences = { ciFailure: "💥 CI failed: {failingChecks}" };
		const effective = getEffectivePreferences(prefs);
		expect(effective.ciFailure).toBe("💥 CI failed: {failingChecks}");
		expect(effective.conflict).toBe(DEFAULT_PREFERENCES.conflict);
		expect(effective.allClear).toBe(DEFAULT_PREFERENCES.allClear);
	});

	it("includes custom reminder preference", () => {
		const prefs: Preferences = { reminder: "⏰ {prLabel} needs attention" };
		const effective = getEffectivePreferences(prefs);
		expect(effective.reminder).toBe("⏰ {prLabel} needs attention");
	});

	it("omits reminder when no override is set (computed default)", () => {
		const effective = getEffectivePreferences({});
		expect(effective.reminder).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Integration: preferences override notification formatting
// ---------------------------------------------------------------------------

describe("preferences in notification formatting", () => {
	const config = {
		owner: "v2nic",
		repo: "pi-ghpr-monitor",
		number: 32,
		host: "github.com",
		mode: "all" as const,
		intervalSec: 60,
		debounceSec: 30,
	};

	const cleanStatus = {
		unresolvedThreads: 0,
		generalComments: 0,
		hasConflicts: false,
		failingChecks: [] as string[],
		pendingChecks: [] as string[],
		lastCommentTimestamp: "",
		lastCommentBySelf: false,
		lastCommitOid: "",
		threadDetails: [] as ThreadSummary[],
		commentDetails: [] as CommentSummary[],
		checkDetails: [] as CheckSummary[],
	};

	it("formatActionableItems uses preference for conflict", async () => {
		const { formatActionableItems } = await import("../src/analyzer");
		const status = { ...cleanStatus, hasConflicts: true };
		const prefs: Preferences = { conflict: "🚨 MERGE CONFLICT on {prLabel}!" };

		const result = formatActionableItems(status, config, prefs);
		expect(result).toContain("🚨 MERGE CONFLICT on v2nic/pi-ghpr-monitor#32!");
		expect(result).not.toContain("Merge conflicts detected");
	});

	it("formatActionableItems uses preference for ciFailure", async () => {
		const { formatActionableItems } = await import("../src/analyzer");
		const status = { ...cleanStatus, failingChecks: ["ci/test"] };
		const prefs: Preferences = { ciFailure: "💥 CI FAILED: {failingChecks}" };

		const result = formatActionableItems(status, config, prefs);
		expect(result).toContain("💥 CI FAILED: ci/test");
		expect(result).not.toContain("Failing CI checks");
	});

	it("formatActionableItems uses preference for newComments (threads)", async () => {
		const { formatActionableItems } = await import("../src/analyzer");
		const status = {
			...cleanStatus,
			unresolvedThreads: 3,
			threadDetails: [
				{ id: "t1", isResolved: false, lastCommentAuthor: "user", lastCommentBody: "fix this" },
			],
		};
		const prefs: Preferences = { newComments: "📬 {unresolvedThreads} threads need review on {prLabel}" };

		const result = formatActionableItems(status, config, prefs);
		expect(result).toContain("📬 3 threads need review on v2nic/pi-ghpr-monitor#32");
	});

	it("formatActionableItems uses preference for reminder (overrides all)", async () => {
		const { formatActionableItems } = await import("../src/analyzer");
		const status = {
			...cleanStatus,
			hasConflicts: true,
			unresolvedThreads: 2,
			generalComments: 1,
			failingChecks: ["ci/test"],
			threadDetails: [
				{ id: "t1", isResolved: false, lastCommentAuthor: "user", lastCommentBody: "fix this" },
			],
			commentDetails: [
				{ id: "c1", restApiId: "1", author: "user", body: "comment" },
			],
			checkDetails: [
				{ name: "ci/test", conclusion: "FAILURE" },
			],
		};
		const prefs: Preferences = { reminder: "⏰ Reminder: {prLabel} needs attention ({unresolvedThreads} threads, {generalComments} comments)" };

		const result = formatActionableItems(status, config, prefs);
		expect(result).toBe("⏰ Reminder: v2nic/pi-ghpr-monitor#32 needs attention (2 threads, 1 comments)");
		// When reminder is set, it replaces the entire concise summary
		expect(result).not.toContain("Merge conflicts detected");
		expect(result).not.toContain("Failing CI");
	});

	it("formatActionableItems uses default when no preferences set", async () => {
		const { formatActionableItems } = await import("../src/analyzer");
		const status = { ...cleanStatus, hasConflicts: true };

		const result = formatActionableItems(status, config, {});
		expect(result).toContain("Merge conflicts detected on v2nic/pi-ghpr-monitor#32");
	});

	it("formatStatusUpdate uses preference for allClear", async () => {
		const { formatStatusUpdate } = await import("../src/analyzer");
		const prefs: Preferences = { allClear: "🎉 {prLabel} is all good!" };
		const prev = {
			...cleanStatus,
			hasConflicts: true,
			failingChecks: ["ci/test"],
			pendingChecks: ["ci/build"] as string[],
		};
		const curr = { ...cleanStatus };

		const result = formatStatusUpdate(prev, curr, config, prefs);
		expect(result).toContain("🎉 v2nic/pi-ghpr-monitor#32 is all good!");
		expect(result).not.toContain("open, all clear");
	});

	it("formatStatusUpdate uses preference for conflict", async () => {
		const { formatStatusUpdate } = await import("../src/analyzer");
		const prefs: Preferences = { conflict: "🚨 CONFLICT on {prLabel}!" };
		const curr = { ...cleanStatus, hasConflicts: true };

		const result = formatStatusUpdate(null, curr, config, prefs);
		expect(result).toContain("🚨 CONFLICT on v2nic/pi-ghpr-monitor#32!");
		expect(result).not.toContain("Merge conflicts detected");
	});

	it("formatStatusUpdate uses preference for ciFailure", async () => {
		const { formatStatusUpdate } = await import("../src/analyzer");
		const prefs: Preferences = { ciFailure: "💥 CI failing on {prLabel}: {failingChecks}" };
		const curr = {
			...cleanStatus,
			failingChecks: ["ci/test"],
			checkDetails: [{ name: "ci/test", conclusion: "FAILURE" }],
		};

		const result = formatStatusUpdate(null, curr, config, prefs);
		expect(result).toContain("💥 CI failing on v2nic/pi-ghpr-monitor#32: ci/test");
		expect(result).not.toContain("Failing CI checks");
	});

	it("formatStatusUpdate uses preference for newComments with threads", async () => {
		const { formatStatusUpdate } = await import("../src/analyzer");
		const prefs: Preferences = { newComments: "📬 {unresolvedThreads} threads on {prLabel}" };
		const curr = {
			...cleanStatus,
			unresolvedThreads: 3,
			threadDetails: [
				{ id: "t1", isResolved: false, lastCommentAuthor: "user", lastCommentBody: "fix this" },
			],
		};

		const result = formatStatusUpdate(null, curr, config, prefs);
		expect(result).toContain("📬 3 threads on v2nic/pi-ghpr-monitor#32");
	});

	it("formatStatusUpdate uses preference for newComments with general comments", async () => {
		const { formatStatusUpdate } = await import("../src/analyzer");
		const prefs: Preferences = { newComments: "📬 {generalComments} comments on {prLabel}" };
		const curr = {
			...cleanStatus,
			generalComments: 2,
			commentDetails: [
				{ id: "c1", restApiId: "1", author: "user", body: "comment" },
			],
		};

		const result = formatStatusUpdate(null, curr, config, prefs);
		expect(result).toContain("📬 2 comments on v2nic/pi-ghpr-monitor#32");
	});

	it("formatStatusUpdate with no preferences uses defaults", async () => {
		const { formatStatusUpdate } = await import("../src/analyzer");
		const curr = { ...cleanStatus, hasConflicts: true };

		const result = formatStatusUpdate(null, curr, config);
		expect(result).toContain("Merge conflicts detected on v2nic/pi-ghpr-monitor#32");
	});

	it("descriptionStaleness preference is accepted by validatePreferences", () => {
		const result = validatePreferences(JSON.stringify({ descriptionStaleness: "\u{1F4DD} New push to {prLabel} — check the description!" }));
		expect(result.ok).toBe(true);
		expect(result.preferences?.descriptionStaleness).toBe("\u{1F4DD} New push to {prLabel} — check the description!");
	});

	it("descriptionStaleness preference supports {owner}, {repo}, {number}, {host}, {prLabel} variables", () => {
		const result = interpolateTemplate("New push to {prLabel} ({owner}/{repo}#{number}) on {host}", {
			owner: "v2nic",
			repo: "pi-ghpr-monitor",
			number: 37,
			host: "github.com",
			prLabel: "v2nic/pi-ghpr-monitor#37",
			prUrl: "https://github.com/v2nic/pi-ghpr-monitor/pull/37",
		});
		expect(result).toBe("New push to v2nic/pi-ghpr-monitor#37 (v2nic/pi-ghpr-monitor#37) on github.com");
	});

	it("descriptionStaleness preference is included in PreferencesSchema keys", () => {
		expect(Object.keys(PreferencesSchema.properties)).toContain("descriptionStaleness");
	});

	it("interpolateTemplate substitutes {commitOid}, {commitShortOid}, and {commitUrl}", () => {
		const result = interpolateTemplate(
			"\u{1F4DD} New commit {commitShortOid} ({commitUrl}) pushed to {prLabel} (full sha {commitOid})",
			{
				owner: "v2nic",
				repo: "pi-ghpr-monitor",
				number: 37,
				host: "github.com",
				prLabel: "v2nic/pi-ghpr-monitor#37",
				prUrl: "https://github.com/v2nic/pi-ghpr-monitor/pull/37",
				commitOid: "abc1234567890def1234567890abcdef12345678",
				commitShortOid: "abc1234",
				commitUrl: "https://github.com/v2nic/pi-ghpr-monitor/commit/abc1234567890def1234567890abcdef12345678",
			},
		);
		expect(result).toBe(
			"\u{1F4DD} New commit abc1234 (https://github.com/v2nic/pi-ghpr-monitor/commit/abc1234567890def1234567890abcdef12345678) pushed to v2nic/pi-ghpr-monitor#37 (full sha abc1234567890def1234567890abcdef12345678)",
		);
	});

	it("interpolateTemplate leaves commit placeholders untouched when not provided", () => {
		// In contexts where no commit data is available (e.g. ciFailure prompt),
		// commit placeholders should be left as-is rather than substituted with
		// undefined/empty strings, so the user notices their template is being
		// used in a context that doesn't supply the variable.
		const result = interpolateTemplate("Failed on {prLabel} for {commitShortOid}", {
			owner: "v2nic",
			repo: "pi-ghpr-monitor",
			number: 37,
			host: "github.com",
			prLabel: "v2nic/pi-ghpr-monitor#37",
			prUrl: "https://github.com/v2nic/pi-ghpr-monitor/pull/37",
		});
		expect(result).toBe("Failed on v2nic/pi-ghpr-monitor#37 for {commitShortOid}");
	});

	it("validatePreferences accepts descriptionStaleness using {commitShortOid} variable", () => {
		const result = validatePreferences(
			JSON.stringify({
				descriptionStaleness:
					"\u{1F4DD} {commitShortOid} pushed to {prLabel} \u2014 review description",
			}),
		);
		expect(result.ok).toBe(true);
		expect(result.preferences?.descriptionStaleness).toContain("{commitShortOid}");
	});
});