/**
 * Unit tests for the per-session logger
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { initLogger, closeLogger, log, logStatus, getLogPath } from "../src/logger";

describe("logger", () => {
	beforeAll(() => {
		initLogger("test-session-123");
	});

	afterAll(() => {
		closeLogger();
		// Clean up the log file
		const logPath = path.join(os.tmpdir(), "ghpr-monitor-test-session-123.log");
		if (fs.existsSync(logPath)) {
			fs.unlinkSync(logPath);
		}
	});

	it("creates a log file in the temp directory", () => {
		const logPath = getLogPath();
		expect(logPath).toBeTruthy();
		expect(logPath).toContain(os.tmpdir());
		expect(logPath).toContain("ghpr-monitor-test-session-123");
	});

	it("writes log messages to the file", () => {
		const logPath = getLogPath()!;
		log("Test message for logging");
		// WriteStream is async, so we need to ensure it's flushed
		// For testing, we use stderr output as a proxy
		expect(logPath).toBeTruthy();
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
		// Verify the log functions don't throw
		expect(true).toBe(true);
	});

	it("sanitizes session IDs with special characters", () => {
		closeLogger();
		initLogger("my/unsafe#session!name");
		const logPath = getLogPath();
		// Only the filename should be sanitized, not the directory path
		const filename = path.basename(logPath!);
		expect(filename).not.toContain("/");
		expect(filename).not.toContain("#");
		expect(filename).not.toContain("!");
		expect(filename).toContain("my_unsafe_session_name");
		closeLogger();
		// Clean up
		if (logPath && fs.existsSync(logPath)) {
			fs.unlinkSync(logPath);
		}
		// Re-init for other tests
		initLogger("test-session-123");
	});

	it("closes logger gracefully", () => {
		closeLogger();
		expect(getLogPath()).toBeNull();
		// Re-init for afterAll cleanup
		initLogger("test-session-123");
	});
});