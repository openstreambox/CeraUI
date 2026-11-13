import fs from "node:fs";

import {
	collectBoundedChild,
	SpawnAbortError,
	SpawnTimeoutError,
} from "./bounded-spawn.ts";
import { logger } from "./logger.ts";
import { DEFAULT_SPAWN_TIMEOUT_MS } from "./spawn-policy.ts";

export type ExecResult = { stdout: string; stderr: string };

const SECRET_FLAG_RE =
	/pass(word)?|secret|psk|token|key|pin|puk|stream[-_]?id|account|user(name)?|login|credential|auth/i;
// Short options whose value is a credential (curl `-u user:password`).
const SECRET_SHORT_FLAGS = new Set(["-u", "-U"]);

/**
 * Produce a log-safe rendering of argv. Three shapes are redacted, because the
 * binaries this backend drives disagree about where a secret goes:
 *
 *  - `--pin <secret>` (mmcli/nmcli), `--streamid <id>`, `--account <name>`,
 *    `-u user:password` — the token AFTER a secret-looking flag.
 *  - `--uim-verify-pin=PIN2,<secret>` (qmicli) — the secret rides INSIDE the
 *    token, so the separate-token rule alone would log a live PIN verbatim.
 *  - `scheme://user:password@host` — URL credentials anywhere in a token.
 *
 * Best-effort only — callers handling secrets should also prefer runWithStdin().
 */
export function redactArgv(args: readonly string[]): string {
	const out: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] ?? "";
		const prev = i > 0 ? args[i - 1] : undefined;
		if (
			prev !== undefined &&
			(SECRET_FLAG_RE.test(prev) || SECRET_SHORT_FLAGS.has(prev))
		) {
			out.push("***");
			continue;
		}
		const eq = arg.indexOf("=");
		if (eq > 0 && SECRET_FLAG_RE.test(arg.slice(0, eq))) {
			out.push(`${arg.slice(0, eq)}=***`);
			continue;
		}
		out.push(
			arg.replace(/([a-z][a-z0-9+.-]{0,20}:\/\/)[^/@\s]{1,256}@/gi, "$1***@"),
		);
	}
	return out.join(" ");
}

/** Why a tool could not do its job, in a closed vocabulary the support
 * download keeps while the tool's own error text stays [value].
 */
export const TOOL_FAILURE_CLASSES = [
	"timeout",
	"missing-executable",
	"permission",
	"rejected-configuration",
	"network-unreachable",
] as const;
export type ToolFailureClass = (typeof TOOL_FAILURE_CLASSES)[number];
const FAILURE_CLASS_SET: ReadonlySet<string> = new Set(TOOL_FAILURE_CLASSES);

// Documented exit statuses of the tools whose failures callers report.
const TOOL_EXIT_CLASSES: Readonly<
	Record<string, Readonly<Record<number, ToolFailureClass>>>
> = {
	// nmcli(1): 2 invalid input, 3 timeout, 10 connection/device/AP not found.
	nmcli: {
		2: "rejected-configuration",
		3: "timeout",
		10: "rejected-configuration",
	},
	// curl(1): 5/6 could not resolve proxy/host, 7 could not connect, 28 timeout.
	curl: {
		5: "network-unreachable",
		6: "network-unreachable",
		7: "network-unreachable",
		28: "timeout",
	},
};

/** Classify a failed tool run from typed facts only: the error's class name,
 * system error code, exit status and the tool's documented exit codes.
 */
export function classifyToolFailure(
	file: string | undefined,
	error: unknown,
): ToolFailureClass | undefined {
	if (!error || typeof error !== "object") return undefined;
	const e = error as {
		failureClass?: unknown;
		name?: unknown;
		code?: unknown;
		syscall?: unknown;
		message?: unknown;
	};
	if (
		typeof e.failureClass === "string" &&
		FAILURE_CLASS_SET.has(e.failureClass)
	)
		return e.failureClass as ToolFailureClass;
	if (
		typeof e.name === "string" &&
		["RunTimeoutError", "SpawnTimeoutError", "TimeoutError"].includes(e.name)
	)
		return "timeout";
	const code = e.code;
	if (typeof code === "string") {
		if (code === "ETIMEDOUT") return "timeout";
		if (code === "EACCES" || code === "EPERM") return "permission";
		if (
			[
				"ENETUNREACH",
				"EHOSTUNREACH",
				"ENETDOWN",
				"ENOTFOUND",
				"EAI_AGAIN",
			].includes(code)
		)
			return "network-unreachable";
		if (
			code === "ENOENT" &&
			((typeof e.syscall === "string" && e.syscall.includes("spawn")) ||
				(typeof e.message === "string" &&
					/^spawn |posix_spawn/.test(e.message)))
		)
			return "missing-executable";
		return undefined;
	}
	if (typeof code === "number") {
		if (code === 126) return "permission";
		if (code === 127) return "missing-executable";
		const name = file?.split("/").at(-1);
		return name ? TOOL_EXIT_CLASSES[name]?.[code] : undefined;
	}
	return undefined;
}

/** Attach the typed class to an error a tool run throws. */
export function withFailureClass<T>(file: string | undefined, error: T): T {
	const failureClass = classifyToolFailure(file, error);
	if (failureClass && error && typeof error === "object")
		Object.assign(error, { failureClass });
	return error;
}

// util.promisify(exec) replacement: runs cmd through Bun's shell (string parsed
// as written) and REJECTS on non-zero exit (Bun.$ throws ShellError).
export const execP = async (cmd: string): Promise<ExecResult> => {
	const res = await Bun.$`${{ raw: cmd }}`.quiet();
	return { stdout: res.stdout.toString(), stderr: res.stderr.toString() };
};

// util.promisify(execFile) replacement: argv-only (NO shell) via Bun.spawn.
// REJECTS on non-zero exit with an error carrying stdout/stderr/code, the shape
// ssh.ts probeSshActive reads off the rejection. Aborting `signal` kills the
// child (run() maps that rejection to RunTimeoutError/RunAbortError).
export const execFileP = async (
	file: string,
	args: readonly string[] = [],
	opts?: { maxBuffer?: number; timeout?: number; signal?: AbortSignal },
): Promise<ExecResult> => {
	const maxBuffer = opts?.maxBuffer ?? 1024 * 1024;
	const timeout = opts?.timeout ?? DEFAULT_SPAWN_TIMEOUT_MS;
	const signal = opts?.signal;

	// Error messages carry the command with secret-looking values masked, the
	// same rendering run() logs.
	const command = `${file} ${redactArgv(args)}`.trim();
	if (signal?.aborted) {
		throw Object.assign(new SpawnAbortError(command), {
			stdout: "",
			stderr: "",
			code: 1,
		});
	}
	let proc: ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">>;
	try {
		proc = Bun.spawn([file, ...args], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
	} catch (error) {
		throw withFailureClass(file, error);
	}

	let stdout: string;
	let stderr: string;
	let exitCode: number;
	try {
		({ stdout, stderr, exitCode } = await collectBoundedChild(proc, command, {
			timeoutMs: timeout,
			maxBuffer,
			...(signal ? { signal } : {}),
		}));
	} catch (error) {
		if (error instanceof SpawnTimeoutError) {
			Object.assign(error, {
				stdout: error.partialStdout,
				stderr: error.partialStderr,
				code: proc.exitCode || 1,
			});
		}
		throw withFailureClass(file, error);
	}

	if (exitCode !== 0) {
		throw withFailureClass(
			file,
			Object.assign(new Error(`Command failed: ${command}`), {
				stdout,
				stderr,
				code: exitCode,
			}),
		);
	}

	return { stdout, stderr };
};

// Promise-based exec(), but without rejections
export async function execPNR(cmd: string) {
	try {
		const res = await execP(cmd);
		return { stdout: res.stdout, stderr: res.stderr, code: 0 };
	} catch (err) {
		// Bun.$ throws on non-zero exit but the ShellError still carries the
		// captured streams + real exit code: preserve them rather than blanking
		// the output, and log so the failure is never silently swallowed.
		const shellErr = err as {
			stdout?: unknown;
			stderr?: unknown;
			exitCode?: unknown;
		};
		const stdout = shellErr.stdout != null ? String(shellErr.stdout) : "";
		const stderr = shellErr.stderr != null ? String(shellErr.stderr) : "";
		const code = typeof shellErr.exitCode === "number" ? shellErr.exitCode : 1;
		logger.debug(`execPNR: command exited non-zero: ${cmd}`, { code, stderr });
		return { stdout, stderr, code };
	}
}

export function checkExecPathSafe(path: string) {
	try {
		fs.accessSync(path, fs.constants.R_OK);
		return true;
	} catch (_err) {
		logger.error(
			`\n\n${path} not found, double check the settings in setup.json`,
		);
		return false;
	}
}

export function checkExecPath(path: string) {
	if (!checkExecPathSafe(path)) process.exit(1);
}
