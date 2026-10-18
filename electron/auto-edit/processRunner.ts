import { spawn } from "node:child_process";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

export interface ProcessRequest {
	command: string;
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	input?: string;
	signal?: AbortSignal;
	timeoutMs: number;
	maxOutputBytes: number;
	onStdoutLine?: (line: string) => void;
}

export interface ProcessResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export type ProcessRunner = (request: ProcessRequest) => Promise<ProcessResult>;

/** Only these predetermined diagnostics can cross the transport's error boundary. */
export class ProcessOutputError extends Error {
	constructor(kind: "backend" | "tool" | "unsupported" | "malformed") {
		const messages = {
			backend:
				"Codex reported a backend or request error. Retry or check the configured service; no cuts were applied.",
			tool: "Codex attempted a tool action; the plan was rejected.",
			unsupported: "Codex returned an unsupported event; the plan was rejected.",
			malformed: "Codex returned malformed event data.",
		};
		super(messages[kind]);
		this.name = "ProcessOutputError";
	}
}

function safeOutputError(error: unknown): Error {
	return error instanceof ProcessOutputError
		? error
		: new Error("Codex attempted a tool action or returned an unsupported event.");
}

export function abortError(): Error {
	const error = new Error("Auto edit canceled.");
	error.name = "AbortError";
	return error;
}

export function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw abortError();
}

/** No shell; bounded pipes and a private process group so cancellation kills descendants too. */
export const runBoundedProcess: ProcessRunner = async (request) => {
	throwIfAborted(request.signal);
	return new Promise((resolve, reject) => {
		let stdout = "";
		let stderr = "";
		let outputBytes = 0;
		let pendingLine = "";
		let failure: Error | undefined;
		let settled = false;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		const decoder = new StringDecoder("utf8");
		const child = spawn(request.command, request.args, {
			cwd: request.cwd,
			env: request.env,
			stdio: ["pipe", "pipe", "pipe"],
			shell: false,
			windowsHide: true,
			detached: process.platform !== "win32",
		});

		const killGroup = (signal: NodeJS.Signals) => {
			try {
				if (process.platform === "win32" && child.pid) {
					const terminator = spawn(
						path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
						["/pid", String(child.pid), "/T", "/F"],
						{ windowsHide: true, shell: false, stdio: "ignore" },
					);
					terminator.on("error", () => {
						try {
							child.kill();
						} catch {
							/* Already gone. */
						}
					});
				} else if (child.pid) process.kill(-child.pid, signal);
				else child.kill(signal);
			} catch {
				// A process can exit between the close check and signal delivery.
				try {
					child.kill(signal);
				} catch {
					/* Already gone. */
				}
			}
		};
		const fail = (error: Error) => {
			if (failure || settled) return;
			failure = error;
			killGroup("SIGTERM");
			killTimer = setTimeout(() => killGroup("SIGKILL"), 250);
		};
		const onAbort = () => fail(abortError());
		const timer = setTimeout(() => {
			const error = new Error("Codex planning timed out. Try a shorter recording or retry.");
			error.name = "TimeoutError";
			fail(error);
		}, request.timeoutMs);
		const finish = (error?: Error, exitCode = 0) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (killTimer) clearTimeout(killTimer);
			request.signal?.removeEventListener("abort", onAbort);
			// Even a successful leader can leave unref'ed, stdio-ignored helpers. This
			// invocation owns the private group, so none may outlive its result.
			killGroup("SIGKILL");
			if (error || failure) reject(error ?? failure);
			else resolve({ stdout, stderr, exitCode });
		};
		const acceptText = (text: string) => {
			stdout += text;
			if (!request.onStdoutLine) return;
			pendingLine += text;
			let newline = pendingLine.indexOf("\n");
			while (newline !== -1) {
				const line = pendingLine.slice(0, newline);
				pendingLine = pendingLine.slice(newline + 1);
				if (line.trim()) request.onStdoutLine(line);
				newline = pendingLine.indexOf("\n");
			}
		};
		const accountOutput = (chunk: Buffer) => {
			outputBytes += chunk.length;
			if (outputBytes > request.maxOutputBytes) {
				fail(new Error("Codex output exceeded the safe size limit."));
				return false;
			}
			return !failure;
		};

		request.signal?.addEventListener("abort", onAbort, { once: true });
		if (request.signal?.aborted) onAbort();
		child.stdout.on("data", (chunk: Buffer) => {
			if (!accountOutput(chunk)) return;
			try {
				acceptText(decoder.write(chunk));
			} catch (error) {
				fail(safeOutputError(error));
			}
		});
		child.stderr.on("data", (chunk: Buffer) => {
			if (accountOutput(chunk)) stderr += chunk.toString("utf8");
		});
		child.stdin.on("error", () => {
			if (!failure) fail(new Error("Could not send the transcript to Codex."));
		});
		child.on("error", () => finish(new Error("Could not start the configured Codex executable.")));
		child.on("close", (code) => {
			if (!failure) {
				try {
					acceptText(decoder.end());
					if (pendingLine.trim()) request.onStdoutLine?.(pendingLine);
				} catch (error) {
					failure = safeOutputError(error);
				}
			}
			finish(undefined, code ?? -1);
		});
		child.stdin.end(request.input ?? "");
	});
};
