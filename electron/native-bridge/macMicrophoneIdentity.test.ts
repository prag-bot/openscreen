// @vitest-environment node
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Execute the production pure resolver with injected metadata, without importing
// AVFoundation, enumerating devices, or starting any capture/permission flow.
describe.runIf(process.platform === "darwin")("native macOS microphone identity fixtures", () => {
	it("resolves only deterministic default, UID, exact-name, and Chromium-label identities", () => {
		const helper = readFileSync(
			new URL(
				"../native/screencapturekit/Sources/OpenScreenScreenCaptureKitHelper/main.swift",
				import.meta.url,
			),
			"utf8",
		);
		const resolver = helper.match(
			/\/\/ BEGIN PURE MICROPHONE IDENTITY\n([\s\S]*?)\/\/ END PURE MICROPHONE IDENTITY/,
		)?.[1];
		expect(resolver).toBeTruthy();
		const fixtures = readFileSync(
			new URL("./fixtures/macMicrophoneIdentity.swift", import.meta.url),
			"utf8",
		);
		const temporaryDirectory = mkdtempSync(join(tmpdir(), "openscreen-microphone-identity-"));
		try {
			const sourcePath = join(temporaryDirectory, "main.swift");
			writeFileSync(sourcePath, `import Foundation\n${resolver}\n${fixtures}`);
			const sdkArguments = process.env.OPENSCREEN_SWIFT_TEST_SDK
				? ["-sdk", process.env.OPENSCREEN_SWIFT_TEST_SDK]
				: [];
			const result = spawnSync(
				"xcrun",
				[
					"swift",
					...sdkArguments,
					"-module-cache-path",
					join(temporaryDirectory, "module-cache"),
					sourcePath,
				],
				{ encoding: "utf8", timeout: 55_000 },
			);
			expect(result.error, result.error?.message).toBeUndefined();
			expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
			expect(result.stdout).toContain("microphone identity fixtures passed: 26");
		} finally {
			rmSync(temporaryDirectory, { recursive: true, force: true });
		}
	}, 60_000);
});
