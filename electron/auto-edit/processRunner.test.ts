// @vitest-environment node
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { type ProcessRequest, runBoundedProcess } from "./processRunner";

const run = (script: string, options: Partial<ProcessRequest> = {}) =>
	runBoundedProcess({
		command: process.execPath,
		args: ["-e", script],
		cwd: tmpdir(),
		env: process.env,
		timeoutMs: 3_000,
		maxOutputBytes: 1_024,
		...options,
	});

describe("bounded subprocess transport (synthetic Node children, never Codex inference)", () => {
	it.skipIf(process.platform === "win32")(
		"terminates remaining private-group helpers after a successful leader exit",
		async () => {
			const isAlive = (pid: number) => {
				try {
					process.kill(pid, 0);
					return true;
				} catch {
					return false;
				}
			};
			const result = await run(
				'const { spawn } = require("node:child_process"); const helper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: false }); helper.unref(); process.stdout.write(JSON.stringify({ helperPid: helper.pid }));',
			);
			const { helperPid } = JSON.parse(result.stdout) as { helperPid: number };
			expect(Number.isInteger(helperPid) && helperPid > 0).toBe(true);
			try {
				expect(result.exitCode).toBe(0);
				expect(result.stderr).toBe("");
				await expect.poll(() => isAlive(helperPid), { timeout: 2_000, interval: 10 }).toBe(false);
			} finally {
				// Keep the red regression run recoverable: remove only this synthetic helper.
				if (isAlive(helperPid)) process.kill(helperPid, "SIGKILL");
			}
		},
	);

	it("passes stdin without a shell and decodes split UTF-8/unterminated lines", async () => {
		const lines: string[] = [];
		const result = await run(
			'process.stdin.on("data", d => process.stdout.write(d)); process.stdin.on("end", () => { process.stdout.write(Buffer.from([0xc3])); setTimeout(() => process.stdout.write(Buffer.from([0xa9])), 5); });',
			{ input: "literal $(never-execute)\n", onStdoutLine: (line) => lines.push(line) },
		);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("literal $(never-execute)\né");
		expect(lines).toEqual(["literal $(never-execute)", "é"]);
	});

	it("bounds combined stdout and stderr", async () => {
		await expect(
			run(
				'process.stdout.write("a".repeat(700)); process.stderr.write("b".repeat(700)); setInterval(() => {}, 1000);',
			),
		).rejects.toThrow(/size limit/);
	});

	it("terminates immediately when the streaming event validator rejects a tool event", async () => {
		await expect(
			run('process.stdout.write("forbidden\\n"); setInterval(() => {}, 1000);', {
				onStdoutLine: () => {
					throw new Error("internal details must not leak");
				},
			}),
		).rejects.toThrow("Codex attempted a tool action or returned an unsupported event.");
	});

	it("times out bounded work and propagates abort", async () => {
		await expect(run("setInterval(() => {}, 1000)", { timeoutMs: 30 })).rejects.toMatchObject({
			name: "TimeoutError",
		});
		const controller = new AbortController();
		const pending = run("setInterval(() => {}, 1000)", { signal: controller.signal });
		controller.abort();
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
	});

	it("returns a rejected promise for pre-aborted work and generic spawn failures", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(run("", { signal: controller.signal })).rejects.toMatchObject({
			name: "AbortError",
		});
		await expect(run("", { command: "/nonexistent/private-executable-name" })).rejects.toThrow(
			"Could not start the configured Codex executable.",
		);
	});
});
