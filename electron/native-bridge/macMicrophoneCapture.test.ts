// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const helper = readFileSync(
	new URL(
		"../native/screencapturekit/Sources/OpenScreenScreenCaptureKitHelper/main.swift",
		import.meta.url,
	),
	"utf8",
);

// Source-contract checks only: unsupported macOS/device cases cannot be exercised
// here without native capture and hardware. The main task validates compilation.
describe("native macOS requested microphone contract", () => {
	it("throws before starting capture when microphone output is unsupported", () => {
		expect(helper).toContain("let configuration = try makeStreamConfiguration()");
		expect(helper).toContain(
			"private func makeStreamConfiguration() throws -> SCStreamConfiguration",
		);
		const guard = helper.match(
			/guard supportsNativeMicrophoneCapture\(streamConfig: configuration\) else \{([\s\S]*?)\n\t\t\t\}/,
		)?.[1];
		expect(guard).toContain("throw HelperError.unsupportedFeature(");
		expect(guard).toContain("switch the microphone off");
		expect(guard).not.toContain("return configuration");
		expect(guard).not.toContain('"event": "warning"');
	});

	it("requires a usable device only when the microphone was requested", () => {
		const configuration = helper.slice(
			helper.indexOf("private func makeStreamConfiguration()"),
			helper.indexOf("private func setupWriter()"),
		);
		expect(configuration).toMatch(
			/if request\.audio\.microphone\.enabled \{[\s\S]*guard let deviceId = resolveMicrophoneCaptureDeviceID\(\) else \{\s*throw HelperError\.sourceNotFound/,
		);
		expect(configuration).toContain(
			'configuration.setValue(deviceId, forKey: "microphoneCaptureDeviceID")',
		);
		expect(configuration).toMatch(/\} else \{\s*nativeMicrophoneEnabled = false\s*\}/);
	});

	it("injects native device metadata and the real default into the pure identity resolver", () => {
		const resolver = helper.slice(
			helper.indexOf("private func resolveMicrophoneCaptureDeviceID()"),
		);
		expect(resolver).toContain("MicrophoneIdentityResolver.resolve(");
		expect(resolver).toContain("deviceId: request.audio.microphone.deviceId");
		expect(resolver).toContain("deviceName: request.audio.microphone.deviceName");
		expect(resolver).toContain("devices: AVCaptureDevice.devices(for: .audio).map");
		expect(resolver).toContain("defaultDeviceId: AVCaptureDevice.default(for: .audio)?.uniqueID");
	});
});
