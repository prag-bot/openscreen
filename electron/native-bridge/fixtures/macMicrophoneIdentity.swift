let builtIn = MicrophoneDeviceIdentity(uniqueID: "builtin", localizedName: "MacBook Pro Microphone")
let external = MicrophoneDeviceIdentity(uniqueID: "external", localizedName: "Studio Mic")
let parenthesized = MicrophoneDeviceIdentity(uniqueID: "parentheses", localizedName: "Studio Mic (Virtual)")
let devices = [builtIn, external, parenthesized]
var assertions = 0

func expectIdentity(
	_ name: String,
	deviceId: String? = "opaque-browser-id",
	deviceName: String? = nil,
	available: [MicrophoneDeviceIdentity] = devices,
	defaultDeviceId: String? = "builtin",
	expected: String?
) {
	let actual = MicrophoneIdentityResolver.resolve(
		deviceId: deviceId,
		deviceName: deviceName,
		devices: available,
		defaultDeviceId: defaultDeviceId
	)
	guard actual == expected else {
		fatalError("\(name): expected \(String(describing: expected)), got \(String(describing: actual))")
	}
	assertions += 1
}

expectIdentity("decorated default sentinel", deviceId: "default", deviceName: "Default - MacBook Pro Microphone (Built-in)", expected: "builtin")
expectIdentity("default ignores conflicting explicit label", deviceId: "default", deviceName: "Studio Mic", expected: "builtin")
expectIdentity("unselected uses actual default", deviceId: nil, expected: "builtin")
expectIdentity("blank selection uses actual default", deviceId: " \n", deviceName: "\t", expected: "builtin")
expectIdentity("missing default fails", deviceId: "default", defaultDeviceId: nil, expected: nil)
expectIdentity("missing unselected default fails", deviceId: nil, defaultDeviceId: nil, expected: nil)
expectIdentity("native UID precedes conflicting label", deviceId: "external", deviceName: builtIn.localizedName, expected: "external")
expectIdentity("native UID disambiguates duplicate names", deviceId: "external", deviceName: external.localizedName, available: [external, MicrophoneDeviceIdentity(uniqueID: "other", localizedName: external.localizedName)], expected: "external")
expectIdentity("exact native name", deviceName: builtIn.localizedName, expected: "builtin")
expectIdentity("physical built-in suffix", deviceName: "MacBook Pro Microphone (Built-in)", expected: "builtin")
expectIdentity("recognized external transport", deviceName: "Studio Mic (Bluetooth LE)", expected: "external")
expectIdentity("USB model lowercase VID PID", deviceName: "Studio Mic (123a:4bcd)", expected: "external")
expectIdentity("USB model uppercase is not Chromium output", deviceName: "Studio Mic (123A:4BCD)", expected: nil)
expectIdentity("cross-tier exact and alias collision fails", deviceName: "Studio Mic (Virtual)", expected: nil)
expectIdentity("native UID disambiguates cross-tier collision", deviceId: "parentheses", deviceName: "Studio Mic (Virtual)", expected: "parentheses")
expectIdentity("genuine native parentheses without alias collision", deviceName: "Studio Mic (Virtual)", available: [builtIn, parenthesized], expected: "parentheses")
expectIdentity("decorated genuine native parentheses", deviceName: "Studio Mic (Virtual) (Virtual)", expected: "parentheses")
expectIdentity("duplicate exact names fail", deviceName: external.localizedName, available: [external, MicrophoneDeviceIdentity(uniqueID: "other", localizedName: external.localizedName)], expected: nil)
expectIdentity("duplicate decorated names fail", deviceName: "Studio Mic (Built-in)", available: [external, MicrophoneDeviceIdentity(uniqueID: "other", localizedName: external.localizedName)], expected: nil)
expectIdentity("unknown explicit ID fails without default substitution", deviceName: nil, expected: nil)
expectIdentity("unknown explicit label fails without default substitution", deviceName: "Missing Mic", expected: nil)
expectIdentity("unknown suffix is not stripped", deviceName: "Studio Mic (Unrecognized)", expected: nil)
expectIdentity("arbitrary parenthetical text is not stripped", deviceName: "Studio Mic (USB)", expected: nil)
expectIdentity("partial names never match", deviceName: "Studio", expected: nil)
expectIdentity("suffix must be complete", deviceName: "Studio Mic (123a:4bcd) extra", expected: nil)
expectIdentity("source names are not guessed", deviceName: "Microphone Array (Built-in)", expected: nil)

print("microphone identity fixtures passed: \(assertions)")
