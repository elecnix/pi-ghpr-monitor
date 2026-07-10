/**
 * Tests for the pi-specific adapter preferences (disableMergeTool,
 * prCreateNudge, ciGreenMerge): load/save/reset, defaults, migration from the
 * legacy preferences file, and template interpolation.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	loadAdapterPrefs,
	saveAdapterPrefs,
	adapterPrefsPath,
	setAdapterPrefsPath,
	getAdapterPref,
	interpolatePref,
	DEFAULT_CI_GREEN_MERGE,
	DEFAULT_DISABLE_MERGE_TOOL,
} from "../src/adapter-prefs";
import { DEFAULT_PR_CREATE_NUDGE } from "../src/pr-create-hook";

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "adapter-prefs-"));
	setAdapterPrefsPath(path.join(tmpDir, "adapter.json"));
});

afterEach(() => {
	setAdapterPrefsPath(undefined);
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("adapter prefs load/save", () => {
	it("returns empty prefs when no file exists", () => {
		expect(loadAdapterPrefs()).toEqual({});
	});

	it("saves and reloads prefs", () => {
		saveAdapterPrefs({ disableMergeTool: true, ciGreenMerge: "merge {prLabel}" });
		expect(loadAdapterPrefs()).toMatchObject({
			disableMergeTool: true,
			ciGreenMerge: "merge {prLabel}",
		});
	});

	it("merges partial updates without dropping other keys", () => {
		saveAdapterPrefs({ disableMergeTool: true });
		saveAdapterPrefs({ prCreateNudge: "nudge {prUrl}" });
		const p = loadAdapterPrefs();
		expect(p.disableMergeTool).toBe(true);
		expect(p.prCreateNudge).toBe("nudge {prUrl}");
	});

	it("null resets a key to default (removes from file)", () => {
		saveAdapterPrefs({ disableMergeTool: true });
		saveAdapterPrefs({ disableMergeTool: undefined });
		expect(loadAdapterPrefs().disableMergeTool).toBeUndefined();
	});

	it("writes to the configured path", () => {
		saveAdapterPrefs({ disableMergeTool: true });
		expect(fs.existsSync(adapterPrefsPath())).toBe(true);
	});
});

describe("getAdapterPref defaults", () => {
	it("applies the disableMergeTool default", () => {
		expect(getAdapterPref("disableMergeTool", {})).toBe(DEFAULT_DISABLE_MERGE_TOOL);
	});

	it("applies the prCreateNudge default", () => {
		expect(getAdapterPref("prCreateNudge", {})).toBe(DEFAULT_PR_CREATE_NUDGE);
	});

	it("applies the ciGreenMerge default", () => {
		expect(getAdapterPref("ciGreenMerge", {})).toBe(DEFAULT_CI_GREEN_MERGE);
	});

	it("returns the custom value when set", () => {
		expect(getAdapterPref("ciGreenMerge", { ciGreenMerge: "custom {prLabel}" })).toBe("custom {prLabel}");
	});
});

describe("interpolatePref", () => {
	it("replaces known tokens", () => {
		expect(interpolatePref("CI green on {prLabel}", { prLabel: "octo/demo#42" })).toBe(
			"CI green on octo/demo#42",
		);
	});

	it("leaves unknown tokens literal", () => {
		expect(interpolatePref("hi {bogus}", {})).toBe("hi {bogus}");
	});
});