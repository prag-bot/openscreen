#!/usr/bin/env node

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const LOCAL_SIGNING_NAME = "OpenScreen Local Signing";
// Public certificate fingerprint, never a private key. Keep this identity across rebuilds.
export const LOCAL_SIGNING_FINGERPRINT = "A3DEC068A1B596CCDBEB3F339B9FC43A786A03B1";
export const LOOM_BUNDLE_ID = "com.local.openscreen.loom";
export const DEFAULT_STAGED_APP = path.join(
	root,
	"release/loom.noindex/mac-arm64/Openscreen Loom.app",
);
const entitlements = path.join(root, "macos.entitlements");
const execFileAsync = promisify(execFile);
const execute = (command, args) =>
	execFileAsync(command, args, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });

export function parseArguments(args) {
	const options = { app: DEFAULT_STAGED_APP, check: false, identity: LOCAL_SIGNING_FINGERPRINT };
	for (let index = 0; index < args.length; index++) {
		const argument = args[index];
		if (argument === "--check") options.check = true;
		else if (argument === "--app" || argument === "--identity") {
			const value = args[++index];
			if (!value || value.startsWith("--")) throw new Error(`Missing value for ${argument}.`);
			options[argument === "--app" ? "app" : "identity"] = value;
		} else
			throw new Error(
				`Unknown argument: ${argument}. Use --check, --app <staged.app>, or --identity <SHA-1>.`,
			);
	}
	return options;
}

export function selectSigningIdentity(output, fingerprint = LOCAL_SIGNING_FINGERPRINT) {
	if (!/^[a-fA-F0-9]{40}$/.test(fingerprint))
		throw new Error(
			"The signing identity must be an explicit 40-character certificate SHA-1 fingerprint; ad-hoc signing is forbidden.",
		);
	const expected = fingerprint.toUpperCase();
	const matches = output.split(/\r?\n/).flatMap((line) => {
		const match = /^\s*\d+\)\s+([a-fA-F0-9]{40})\s+"([^"]+)"\s*$/.exec(line);
		return match && match[1].toUpperCase() === expected && match[2] === LOCAL_SIGNING_NAME
			? [match[1].toUpperCase()]
			: [];
	});
	if (!matches.length)
		throw new Error(
			`The pinned ${LOCAL_SIGNING_NAME} identity (${expected}) is not valid for code signing. Unlock the login keychain or restore that existing identity; do not create a replacement or fall back to ad-hoc signing.`,
		);
	return expected;
}

async function loadSigner() {
	const require = createRequire(import.meta.url);
	if (require("@electron/osx-sign/package.json").version !== "1.3.3")
		throw new Error(
			"Expected the pinned @electron/osx-sign 1.3.3; restore repository dependencies first.",
		);
	return (await import("@electron/osx-sign")).signAsync;
}

export async function preflightLocalSigning(options = {}, dependencies = {}) {
	const run = dependencies.run ?? execute;
	if ((dependencies.platform ?? process.platform) !== "darwin")
		throw new Error("Persistent local Loom signing requires macOS.");
	const fingerprint = options.identity ?? LOCAL_SIGNING_FINGERPRINT;
	// Validate syntax before invoking any external tool, including rejecting '-'.
	if (!/^[a-fA-F0-9]{40}$/.test(fingerprint)) selectSigningIdentity("", fingerprint);
	const { stdout } = await run("/usr/bin/security", ["find-identity", "-v", "-p", "codesigning"]);
	const identity = selectSigningIdentity(stdout, fingerprint);
	await fs.access(entitlements);
	return { identity, sign: await (dependencies.loadSigner ?? loadSigner)() };
}

export async function resolveStagedApp(appPath) {
	const app = await fs.realpath(path.resolve(appPath));
	if (path.extname(app) !== ".app" || !(await fs.stat(app)).isDirectory())
		throw new Error("Signing target must be an existing .app directory.");
	if (
		!app
			.split(path.sep)
			.slice(0, -1)
			.some((part) => part.endsWith(".noindex"))
	)
		throw new Error(
			"Sign only a staged app inside a .noindex directory. Never sign the canonical Projects installation in place.",
		);
	return app;
}

const machOMagic = new Set([
	"feedface",
	"feedfacf",
	"cefaedfe",
	"cffaedfe",
	"cafebabe",
	"bebafeca",
	"cafebabf",
	"bfbafeca",
]);

/** Whitelist real Mach-O files and nested code bundles, excluding data and symlink aliases. */
export async function discoverSignablePaths(app) {
	const paths = new Set([app]);
	const extraBundles = [];
	async function visit(directory) {
		let hasCode = false;
		for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
			const file = path.join(directory, entry.name);
			if (entry.isSymbolicLink()) continue;
			if (entry.isDirectory()) {
				const childHasCode = await visit(file);
				hasCode ||= childHasCode;
				if (childHasCode && /\.(app|framework|xpc|bundle)$/.test(entry.name)) {
					paths.add(file);
					if (/\.(xpc|bundle)$/.test(entry.name)) extraBundles.push(file);
				}
			} else if (entry.isFile()) {
				const handle = await fs.open(file, "r");
				try {
					const magic = Buffer.alloc(4);
					const { bytesRead } = await handle.read(magic, 0, 4, 0);
					if (bytesRead === 4 && machOMagic.has(magic.toString("hex"))) {
						paths.add(file);
						hasCode = true;
					}
				} finally {
					await handle.close();
				}
			}
		}
		return hasCode;
	}
	if (!(await visit(path.join(app, "Contents"))))
		throw new Error("The staged app contains no Mach-O code to sign.");
	return { paths, extraBundles };
}

export function verifyDesignatedRequirement(output, identity) {
	const requirement = /^\s*#?\s*designated\s*=>\s*(.+)$/m.exec(output)?.[1];
	const binding =
		/^identifier\s+"([^"]+)"\s+and\s+certificate\s+(?:leaf|0)\s*=\s*H"([a-fA-F0-9]{40})"$/.exec(
			requirement?.trim() ?? "",
		);
	if (
		!binding ||
		binding[1] !== LOOM_BUNDLE_ID ||
		binding[2].toUpperCase() !== identity.toUpperCase()
	)
		throw new Error(
			"The app designated requirement must bind its bundle ID to the validated signing certificate, never a build-specific cdhash.",
		);
	if (/Signature=adhoc/i.test(output) || !/flags=[^\n]*\bruntime\b/.test(output))
		throw new Error("The staged app must have a certificate signature and hardened runtime.");
	return requirement;
}

export async function signLocalLoom(options = {}, dependencies = {}) {
	const run = dependencies.run ?? execute;
	const { identity, sign } = await preflightLocalSigning(options, dependencies);
	if (options.check) return { identity, checked: true };
	const app = await resolveStagedApp(options.app ?? DEFAULT_STAGED_APP);
	const { stdout: bundleId } = await run("/usr/bin/plutil", [
		"-extract",
		"CFBundleIdentifier",
		"raw",
		"-o",
		"-",
		path.join(app, "Contents/Info.plist"),
	]);
	if (bundleId.trim() !== LOOM_BUNDLE_ID)
		throw new Error(
			`Expected bundle ID ${LOOM_BUNDLE_ID}; refusing to sign a different application.`,
		);
	const { paths, extraBundles } = await discoverSignablePaths(app);
	const requirement = `=designated => identifier "${LOOM_BUNDLE_ID}" and certificate leaf = H"${identity}"`;
	await sign({
		app,
		identity,
		// osx-sign 1.3.3 uses find-identity's BASIC policy. This codeSign-only trusted
		// identity was already validated above with the correct codesigning policy.
		identityValidation: false,
		platform: "darwin",
		preAutoEntitlements: false,
		preEmbedProvisioningProfile: false,
		strictVerify: true,
		binaries: extraBundles,
		ignore: (file) => !paths.has(file),
		optionsForFile: (file) => ({
			entitlements,
			hardenedRuntime: true,
			timestamp: "none",
			...(file === app ? { requirements: requirement } : {}),
		}),
	});
	await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
	const detail = await run("/usr/bin/codesign", [
		"--display",
		"--requirements",
		"-",
		"--verbose=4",
		app,
	]);
	const designatedRequirement = verifyDesignatedRequirement(
		`${detail.stdout}\n${detail.stderr}`,
		identity,
	);
	return { app, identity, designatedRequirement, signedCodePaths: paths.size };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const result = await signLocalLoom(parseArguments(process.argv.slice(2)));
		console.log(JSON.stringify(result));
	} catch (cause) {
		console.error(
			`Local Loom signing failed: ${cause instanceof Error ? cause.message : String(cause)}`,
		);
		process.exitCode = 1;
	}
}
