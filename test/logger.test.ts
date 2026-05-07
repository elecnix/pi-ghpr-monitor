/**
 * Unit tests for the per-session logger
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
	setSessionId,
	enableDebug,
	disableDebug,
	isDebugEnabled,
	closeLogger,
	log,
	logStatus,
	getLogPath,
} from "../src/logger";

describe("logger", () => {
	beforeAll(() => {
		setSessionId("test-session-123");
	});

	afterAll(() => {
		closeLogger();
		// Clean up any log files
		const logPath = path.join(os.tmpdir(), "ghpr-monitor-test-session-123.log");
		if (fs.existsSync(logPath)) {
			fs.unlinkSync(logPath);
		}
	});

	it("does not log by default", () => {
		expect(isDebugEnabled()).toBe(false);
		expect(getLogPath()).toBeNull();
	});

	it("enableDebug creates a log file and returns the path", () => {
		const logFilePath = enableDebug();
		expect(logFilePath).toBeTruthy();
		expect(logFilePath).toContain(os.tmpdir());
		expect(logFilePath).toContain("ghpr-monitor-test-session-123");
		expect(isDebugEnabled()).toBe(true);
	});

	it("writes log messages to the file", () => {
		const logPath = getLogPath()!;
		log("Test message for logging");
		expect(logPath).toBeTruthy();
		// Verify content was written
		const contents = fs.readFileSync(logPath, "utf-8");
		expect(contents).toContain("Test message for logging");
	});

	it("logs PR status snapshots", () => {
		logStatus({
			unresolvedThreads: 2,
			generalComments: 1,
			hasConflicts: false,
			failingChecks: ["ci/test"],
			pendingChecks: ["ci/build"],
			failingStatuses: ["ci/circleci: Build"],
			pendingStatuses: [],
		});
		const contents = fs.readFileSync(getLogPath()!, "utf-8");
		expect(contents).toContain("threads=2");
		expect(contents).toContain("ci/circleci: Build");
	});

	it("disableDebug stops logging and returns the log path", () => {
		const formerPath = disableDebug();
		expect(formerPath).toBeTruthy();
		expect(isDebugEnabled()).toBe(false);
		expect(getLogPath()).toBeNull();
	});

	it("disableDebug returns null when logging wasn't active", () => {
		expect(disableDebug()).toBeNull();
	});

	it("sanitizes session IDs with special characters", () => {
		closeLogger();
		setSessionId("my/unsafe#session!name");
		const logFilePath = enableDebug();
		const filename = path.basename(logFilePath);
		expect(filename).not.toContain("/");
		expect(filename).not.toContain("#");
		expect(filename).not.toContain("!");
		expect(filename).toContain("my_unsafe_session_name");
		disableDebug();
		// Clean up
		if (logFilePath && fs.existsSync(logFilePath)) {
			fs.unlinkSync(logFilePath);
		}
		// Reset for other tests
		setSessionId("test-session-123");
	});
});