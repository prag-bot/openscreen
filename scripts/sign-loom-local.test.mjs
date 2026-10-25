import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import {
	discoverSignablePaths,
	LOCAL_SIGNING_FINGERPRINT as fingerprint,
	LOCAL_SIGNING_NAME,
	LOOM_BUNDLE_ID,
	parseArguments,
	resolveStagedApp,
	selectSigningIdentity,
	signLocalLoom,
	verifyDesignatedRequirement,
} from "./sign-loom-local.mjs";

const validIdentity = `  1) ${fingerprint} "${LOCAL_SIGNING_NAME}"\n     1 valid identities found\n`;
const validSignature = `Identifier=${LOOM_BUNDLE_ID}\nCodeDirectory v=20500 flags=0x10000(runtime)\nAuthority=${LOCAL_SIGNING_NAME}\n# designated => identifier "${LOOM_BUNDLE_ID}" and certificate leaf = H"${fingerprint.toLowerCase()}"`;
const directories = [];
afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
	);
});

async function fixture() {
	const directory = await fs.realpath(
		await fs.mkdtemp(path.join(os.tmpdir(), "openscreen-signing-test-")),
	);
	directories.push(directory);
	const app = path.join(directory, "stage.noindex", "Openscreen Loom.app");
	const contents = path.join(app, "Contents");
	async function file(relative, binary = false) {
		const target = path.join(contents, relative);
		await fs.mkdir(path.dirname(target), { recursive: true });
		await fs.writeFile(target, binary ? Buffer.from("cffaedfe00000000", "hex") : "local test data");
		return target;
	}
	const main = await file("MacOS/Openscreen Loom", true);
	const helper = await file("Frameworks/Helper.app/Contents/MacOS/Helper", true);
	const native = await file("Resources/electron/native/bin/darwin-arm64/capture-helper", true);
	const module = await file("Resources/app.asar.unpacked/addon.node", true);
	const resource = await file("Resources/app.asar");
	const emptyBundle = await file("Resources/data.bundle/image.png");
	const info = await file("Info.plist");
	await fs.symlink(native, path.join(contents, "Resources/native-alias"));
	return { app, directory, main, helper, native, module, resource, emptyBundle, info };
}

function dependencies(overrides = {}) {
	const calls = [];
	const signed = [];
	return {
		calls,
		signed,
		platform: "darwin",
		async run(command, args) {
			calls.push({ command, args });
			if (command === "/usr/bin/security") return { stdout: validIdentity, stderr: "" };
			if (command === "/usr/bin/plutil") return { stdout: LOOM_BUNDLE_ID, stderr: "" };
			return { stdout: "", stderr: args.includes("--display") ? validSignature : "" };
		},
		async loadSigner() {
			return async (options) => {
				signed.push(options);
			};
		},
		...overrides,
	};
}

test("selects only the pinned valid codesigning identity and exact common name", () => {
	assert.equal(selectSigningIdentity(validIdentity), fingerprint);
	assert.equal(selectSigningIdentity(validIdentity, fingerprint.toLowerCase()), fingerprint);
	assert.throws(
		() => selectSigningIdentity("0 valid identities found"),
		/not valid for code signing/,
	);
	assert.throws(
		() =>
			selectSigningIdentity(
				validIdentity.replace(LOCAL_SIGNING_NAME, `${LOCAL_SIGNING_NAME} Other`),
			),
		/not valid/,
	);
	assert.throws(
		() => selectSigningIdentity(validIdentity.replace(fingerprint, "B".repeat(40))),
		/not valid/,
	);
	for (const unsafe of ["-", LOCAL_SIGNING_NAME, "", "A".repeat(39)])
		assert.throws(() => selectSigningIdentity(validIdentity, unsafe), /explicit 40-character/);
});

test("accepts an explicitly selected fingerprint only when valid under the expected name", () => {
	const replacement = "B".repeat(40);
	assert.equal(
		selectSigningIdentity(
			validIdentity + ` 2) ${replacement} "${LOCAL_SIGNING_NAME}"`,
			replacement,
		),
		replacement,
	);
	assert.equal(
		selectSigningIdentity(validIdentity + ` 2) ${replacement} "${LOCAL_SIGNING_NAME}"`),
		fingerprint,
	);
});

test("parses staging and preflight arguments and rejects missing or unknown options", () => {
	assert.deepEqual(
		parseArguments(["--app", "/stage.noindex/App.app", "--identity", fingerprint, "--check"]),
		{ app: "/stage.noindex/App.app", identity: fingerprint, check: true },
	);
	assert.throws(() => parseArguments(["--app"]), /Missing value/);
	assert.throws(() => parseArguments(["--identity", "--check"]), /Missing value/);
	assert.throws(() => parseArguments(["--adhoc"]), /Unknown argument/);
});

test("preflight uses codesigning policy and does not sign or require a built app", async () => {
	const deps = dependencies();
	assert.deepEqual(await signLocalLoom({ check: true }, deps), {
		identity: fingerprint,
		checked: true,
	});
	assert.deepEqual(deps.calls, [
		{ command: "/usr/bin/security", args: ["find-identity", "-v", "-p", "codesigning"] },
	]);
	assert.equal(deps.signed.length, 0);
});

test("identity failure stops before loading the signer and never falls back", async () => {
	let loaded = false;
	const deps = dependencies({
		async run() {
			return { stdout: "0 valid identities found", stderr: "" };
		},
		async loadSigner() {
			loaded = true;
			throw new Error("Must not load");
		},
	});
	await assert.rejects(signLocalLoom({ check: true }, deps), /not valid for code signing/);
	assert.equal(loaded, false);
	await assert.rejects(
		signLocalLoom({ check: true, identity: "-" }, deps),
		/ad-hoc signing is forbidden/,
	);
});

test("rejects non-macOS hosts before calling native tools", async () => {
	const deps = dependencies({ platform: "linux" });
	await assert.rejects(signLocalLoom({ check: true }, deps), /requires macOS/);
	assert.equal(deps.calls.length, 0);
});

test("discovers nested Mach-O/native modules while excluding assets and symlink aliases", async () => {
	const target = await fixture();
	const { paths } = await discoverSignablePaths(target.app);
	for (const file of [
		target.app,
		target.main,
		target.helper,
		target.native,
		target.module,
		path.join(target.app, "Contents/Frameworks/Helper.app"),
	])
		assert.equal(paths.has(file), true, file);
	for (const file of [
		target.resource,
		target.emptyBundle,
		path.dirname(target.emptyBundle),
		target.info,
		path.join(target.app, "Contents/Resources/native-alias"),
	])
		assert.equal(paths.has(file), false, file);
});

test("refuses an installed app or a staging symlink resolving outside .noindex", async () => {
	const target = await fixture();
	const installed = path.join(target.directory, "Projects", "Openscreen Loom.app");
	await fs.mkdir(installed, { recursive: true });
	const alias = path.join(path.dirname(target.app), "Installed.app");
	await fs.symlink(installed, alias);
	await assert.rejects(resolveStagedApp(installed), /staged app/);
	await assert.rejects(resolveStagedApp(alias), /staged app/);
	assert.equal(await resolveStagedApp(target.app), target.app);
});

test("signs the validated fingerprint with persistent requirements and verifies strictly", async () => {
	const target = await fixture();
	const deps = dependencies();
	const result = await signLocalLoom({ app: target.app }, deps);
	assert.equal(deps.signed.length, 1);
	const options = deps.signed[0];
	assert.equal(options.identity, fingerprint);
	assert.equal(options.identityValidation, false);
	assert.equal(options.preAutoEntitlements, false);
	assert.equal(options.preEmbedProvisioningProfile, false);
	assert.equal(options.platform, "darwin");
	assert.equal(options.strictVerify, true);
	for (const file of [target.app, target.native, target.module, target.helper]) {
		const perFile = options.optionsForFile(file);
		assert.equal(perFile.hardenedRuntime, true);
		assert.equal(perFile.timestamp, "none");
		assert.equal(path.basename(perFile.entitlements), "macos.entitlements");
		assert.equal(options.ignore(file), false);
	}
	assert.match(
		options.optionsForFile(target.app).requirements,
		/certificate leaf = H"[A-F0-9]{40}"/,
	);
	assert.equal(options.ignore(target.resource), true);
	assert.deepEqual(deps.calls.at(-2).args, [
		"--verify",
		"--deep",
		"--strict",
		"--verbose=2",
		target.app,
	]);
	assert.equal(result.identity, fingerprint);
	assert.match(result.designatedRequirement, /certificate leaf/);
});

test("refuses another bundle identifier before signing", async () => {
	const target = await fixture();
	const deps = dependencies();
	const originalRun = deps.run;
	deps.run = (command, args) =>
		command === "/usr/bin/plutil"
			? Promise.resolve({ stdout: "com.other.app" })
			: originalRun(command, args);
	await assert.rejects(signLocalLoom({ app: target.app }, deps), /different application/);
	assert.equal(deps.signed.length, 0);
});

test("signing or deep verification failures propagate without an ad-hoc retry", async () => {
	const target = await fixture();
	let attempts = 0;
	await assert.rejects(
		signLocalLoom(
			{ app: target.app },
			dependencies({
				async loadSigner() {
					return async () => {
						attempts++;
						throw new Error("Keychain access denied");
					};
				},
			}),
		),
		/Keychain access denied/,
	);
	assert.equal(attempts, 1);
	const deps = dependencies();
	const originalRun = deps.run;
	deps.run = (command, args) =>
		args.includes("--verify")
			? Promise.reject(new Error("Nested signature invalid"))
			: originalRun(command, args);
	await assert.rejects(signLocalLoom({ app: target.app }, deps), /Nested signature invalid/);
	assert.equal(deps.signed.length, 1);
});

test("accepts requirement output from either stream and rejects cdhash, wrong cert, or no runtime", () => {
	assert.match(verifyDesignatedRequirement(validSignature, fingerprint), /certificate leaf/);
	assert.match(
		verifyDesignatedRequirement(
			validSignature.replace("certificate leaf", "certificate 0"),
			fingerprint,
		),
		/certificate 0/,
	);
	assert.match(
		verifyDesignatedRequirement(validSignature.replace("# designated", "designated"), fingerprint),
		/certificate leaf/,
	);
	assert.throws(
		() =>
			verifyDesignatedRequirement(
				validSignature.replace(/certificate leaf = H"[^"]+"/, `cdhash H"${fingerprint}"`),
				fingerprint,
			),
		/designated requirement/,
	);
	assert.throws(
		() =>
			verifyDesignatedRequirement(
				validSignature.replace(fingerprint.toLowerCase(), "b".repeat(40)),
				fingerprint,
			),
		/designated requirement/,
	);
	assert.throws(
		() => verifyDesignatedRequirement(validSignature.replace("(runtime)", "(adhoc)"), fingerprint),
		/hardened runtime/,
	);
});

test("rejects weaker or extended designated requirements instead of matching their substrings", () => {
	for (const requirement of [
		`${validSignature} or true`,
		`${validSignature} and true`,
		validSignature.replace(" and certificate", " or certificate"),
		validSignature.replace(
			`identifier "${LOOM_BUNDLE_ID}"`,
			`identifier "${LOOM_BUNDLE_ID.toUpperCase()}"`,
		),
		validSignature.replace("identifier", "true or identifier"),
	])
		assert.throws(
			() => verifyDesignatedRequirement(requirement, fingerprint),
			/designated requirement/,
		);
});
