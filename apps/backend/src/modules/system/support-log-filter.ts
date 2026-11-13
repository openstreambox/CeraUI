/** Render admitted journal records for the support download.
 *
 * Every rendered value is typed: the backend's own template text, members of
 * closed vocabularies, bounded numbers, interface names by the kernel naming
 * grammar, or fixed placeholders. No free text from a record is copied, so
 * there is no content filter guessing what might be private.
 */
import { appContract } from "@ceraui/rpc/contracts";
import {
	START_FAILURE_CAPTURE_CAUSES,
	START_FAILURE_CLASSES,
	START_FAILURE_PHASES,
} from "@ceraui/rpc/schemas";
import { classifyToolFailure } from "../../helpers/exec.ts";
import {
	isInterfaceName,
	isShapeSource,
	KNOWN_PROCESSES,
	matchLineShape,
} from "./support-line-shapes.ts";
import {
	boundedBackendMessage,
	boundedErrorMessage,
	boundedReason,
} from "./support-log-templates.ts";

export const WITHHELD = "[REDACTED support log line]";
export const MAX_SUPPORT_LINE_BYTES = 8192;

const CODES = new Set([
	"no_route",
	"network_timeout",
	"gsm-registration-denied",
	"missing-or-unknown-apn",
	"start_invalid",
	"capture_source_unavailable",
	"device_busy",
	"engine_unavailable",
	"discovery_failed",
	"read_failed",
	"timeout",
	"exit-code",
	"signal",
	"oom-kill",
	"ENOENT",
	"EACCES",
	"EPERM",
	"EBUSY",
	"EIO",
	"ENOSPC",
	"EPIPE",
	"EINVAL",
	"ETIMEDOUT",
	"ECONNREFUSED",
	"ECONNRESET",
	"ENETUNREACH",
	"EHOSTUNREACH",
	"Network timeout",
	"capture device busy",
	"network unavailable",
]);
const STATES = new Set([
	"unknown",
	"unavailable",
	"available",
	"ready",
	"idle",
	"pending",
	"initializing",
	"starting",
	"running",
	"stopping",
	"stopped",
	"connecting",
	"connected",
	"disconnecting",
	"disconnected",
	"failed",
	"registered",
	"searching",
	"denied",
	"input",
	"output",
	"params",
	"prepare",
	"launch",
	"retry",
	"retrying",
	"settled",
	"completed",
	"cancelled",
	"active",
	"inactive",
	"enabled",
	"disabled",
]);
const MODULES = new Set([
	"streaming",
	"streamloop",
	"modems",
	"cellular",
	"network",
	"system",
	"ui",
	"updates",
	"audio",
	"bluetooth",
	"hotspot",
	"srtla",
	"cerastream",
]);
const SIGNALS = new Set([
	"SIGTERM",
	"SIGKILL",
	"SIGINT",
	"SIGHUP",
	"SIGABRT",
	"SIGSEGV",
	"SIGPIPE",
	"SIGQUIT",
	"SIGBUS",
	"SIGILL",
]);
export function oversizedSupportLine(line: string): boolean {
	// Check length before encoding or running any pattern. Encoding work is bounded.
	return (
		line.length > MAX_SUPPORT_LINE_BYTES ||
		new TextEncoder().encode(line).byteLength > MAX_SUPPORT_LINE_BYTES
	);
}

function safeCode(value: unknown): boolean {
	return typeof value === "string"
		? CODES.has(value)
		: typeof value === "number" &&
				Number.isInteger(value) &&
				Math.abs(value) <= 65535;
}

/** An error message is the code's own error text (gaps bounded), a fixed
 * runtime text or a system-call code; anything else is [value].
 */
function safeErrorMessage(value: string): string | undefined {
	if (value.length > 300) return undefined;
	return boundedErrorMessage(value, MESSAGE_TOKENS);
}

function safeError(value: unknown): Record<string, unknown> | undefined {
	if (typeof value === "string") {
		const message = safeErrorMessage(value);
		return message === undefined ? undefined : { message };
	}

	if (!value || typeof value !== "object" || Array.isArray(value))
		return undefined;
	const error = value as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	if (
		typeof error.name === "string" &&
		[
			"Error",
			"TypeError",
			"RangeError",
			"RpcError",
			"RunTimeoutError",
			"RunAbortError",
			"SpawnTimeoutError",
			"SpawnAbortError",
			"AbortError",
			"TimeoutError",
			"OsStageError",
		].includes(error.name)
	)
		out.name = error.name;
	if (safeCode(error.code)) out.code = error.code;
	// A typed class from the caller or from the error's name and code; the
	// tool's own text stays [value].
	const failureClass = classifyToolFailure(undefined, error);
	if (failureClass) out.class = failureClass;
	if (typeof error.message === "string") {
		const message = safeErrorMessage(error.message);
		if (message !== undefined) out.message = message;
	}
	return Object.keys(out).length ? out : undefined;
}

const START_CLASSES = new Set<string>(START_FAILURE_CLASSES);
const START_PHASES = new Set<string>(START_FAILURE_PHASES);
const CAPTURE_CAUSES = new Set<string>(START_FAILURE_CAPTURE_CAUSES);
const RETRY_STATES = new Set(["scheduled", "exhausted", "not_retriable"]);

function boundedCount(value: unknown, max: number): value is number {
	return (
		typeof value === "number" &&
		Number.isInteger(value) &&
		value >= 0 &&
		value <= max
	);
}

/** A start attempt's retry state, as stream-start-retry reports it. */
function safeRetry(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value))
		return undefined;
	const retry = value as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	if (typeof retry.state === "string" && RETRY_STATES.has(retry.state))
		out.state = retry.state;
	for (const key of ["attempt", "nextAttempt", "maxAttempts"])
		if (boundedCount(retry[key], 100)) out[key] = retry[key];
	if (boundedCount(retry.delayMs, 3600000)) out.delayMs = retry.delayMs;
	if (typeof retry.suppressed === "boolean") out.suppressed = retry.suppressed;
	return Object.keys(out).length ? out : undefined;
}

function safeMetadata(
	value: unknown,
	procedure: string | undefined,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	if (!value || typeof value !== "object" || Array.isArray(value)) return out;
	for (const [key, inner] of Object.entries(value)) {
		if (procedure !== undefined) {
			if (key === "procedure" && inner === procedure) out[key] = inner;
			if (
				key === "latency_ms" &&
				typeof inner === "number" &&
				Number.isFinite(inner) &&
				inner >= 0 &&
				inner <= 300000
			)
				out[key] = inner;
			if (key === "ok" && typeof inner === "boolean") out[key] = inner;
			continue;
		}
		if (["err", "error"].includes(key)) {
			const error = safeError(inner);
			if (error) out[key] = error;
		} else if (["reason", "code"].includes(key) && safeCode(inner))
			out[key] = inner;
		else if (
			key === "class" &&
			typeof inner === "string" &&
			START_CLASSES.has(inner)
		)
			out[key] = inner;
		else if (
			key === "captureCause" &&
			typeof inner === "string" &&
			CAPTURE_CAUSES.has(inner)
		)
			out[key] = inner;
		else if (key === "retry") {
			const retry = safeRetry(inner);
			if (retry) out[key] = retry;
		} else if (
			key === "retryState" &&
			typeof inner === "string" &&
			RETRY_STATES.has(inner)
		)
			out[key] = inner;
		else if (key === "reason" && typeof inner === "string") {
			// Only a value the code itself assigns to a reason, gaps bounded.
			const reason = boundedReason(inner, MESSAGE_TOKENS);
			if (reason !== undefined) out.reason = reason;
		} else if (
			["stage", "phase", "status", "state"].includes(key) &&
			typeof inner === "string" &&
			(STATES.has(inner) || (key === "phase" && START_PHASES.has(inner)))
		)
			out[key] = inner;
		else if (
			["exitCode", "exit_code"].includes(key) &&
			typeof inner === "number" &&
			Number.isInteger(inner) &&
			inner >= 0 &&
			inner <= 255
		)
			out[key] = inner;
		else if (
			key === "signal" &&
			(inner === null ||
				(typeof inner === "string" && SIGNALS.has(inner)) ||
				(typeof inner === "number" &&
					Number.isInteger(inner) &&
					inner > 0 &&
					inner < 128))
		)
			out[key] = inner;
		else if (key === "process" && typeof inner === "string") {
			// A supervised process by name; its install path is not kept.
			const name = inner.replace(/^\/usr\/(?:local\/)?s?bin\//, "");
			if (KNOWN_PROCESSES.has(name)) out[key] = name;
		} else if (
			key === "ifname" &&
			typeof inner === "string" &&
			isInterfaceName(inner)
		)
			out[key] = inner.replace(/^(wlx|enx|wwx)[0-9a-f]{12}$/i, "$1[address]");
		else if (
			[
				"latency_ms",
				"elapsed_ms",
				"wait_ms",
				"attempt",
				"maxAttempts",
				"count",
			].includes(key) &&
			typeof inner === "number" &&
			Number.isFinite(inner) &&
			inner >= 0 &&
			inner <= 1000000
		)
			out[key] = inner;
		else if (
			["ok", "retryable", "available"].includes(key) &&
			typeof inner === "boolean"
		)
			out[key] = inner;
	}
	return out;
}

// Units a helper needs by name; any other unit is [unit], and a template
// instance of one of these is shown as name@[instance].
const KNOWN_UNITS = new Set([
	"ceralive",
	"ceralive-addon-reconciler",
	"ceralive-healthcheck",
	"ceralive-os-stage-guard",
	"ceralive-rtmp-gateway",
	"ceralive-slot-sync",
	"ceralive-software-update",
	"ceralive-srt-gateway",
	"ModemManager",
	"NetworkManager",
	"NetworkManager-wait-online",
	"wpa_supplicant",
	"hostapd",
	"systemd-journald",
	"systemd-networkd",
	"systemd-resolved",
	"systemd-timesyncd",
	"systemd-udevd",
	"bluetooth",
	"bluealsa",
	"rauc",
	"kiosk",
	"cage",
	"cog",
	"ssh",
	"getty",
]);
const UNIT_TYPES = "service|target|scope|socket|slice|timer|mount|path|device";
const UNIT = String.raw`[a-zA-Z0-9@_.\\:-]{1,128}\.(?:${UNIT_TYPES})`;

function unitName(unit: string): string {
	const parts = new RegExp(`^([^@]+?)(@[^.]*)?\\.(${UNIT_TYPES})$`).exec(unit);
	if (!parts?.[1] || !KNOWN_UNITS.has(parts[1])) return "[unit]";
	return `${parts[1]}${parts[2] === undefined ? "" : "@[instance]"}.${parts[3]}`;
}

// systemd's exit-status names (exit-status.c) and signal names.
const EXIT_STATUS_NAMES = new Set(
	(
		"SUCCESS FAILURE INVALIDARGUMENT NOTIMPLEMENTED NOPERMISSION NOTINSTALLED " +
		"NOTCONFIGURED NOTRUNNING USAGE DATAERR NOINPUT NOUSER NOHOST UNAVAILABLE " +
		"SOFTWARE OSERR OSFILE CANTCREAT IOERR TEMPFAIL PROTOCOL NOPERM CONFIG " +
		"CHDIR NICE FDS EXEC MEMORY LIMITS OOM_ADJUST SIGNAL_MASK STDIN STDOUT " +
		"CHROOT IOPRIO TIMERSLACK SECUREBITS SETSCHEDULER CPUAFFINITY GROUP USER " +
		"CAPABILITIES CGROUP SETSID CONFIRM STDERR PAM NETWORK NAMESPACE " +
		"NO_NEW_PRIVILEGES SECCOMP SELINUX_CONTEXT PERSONALITY APPARMOR " +
		"ADDRESS_FAMILIES RUNTIME_DIRECTORY CHOWN SMACK_PROCESS_LABEL KEYRING " +
		"STATE_DIRECTORY CACHE_DIRECTORY LOGS_DIRECTORY CONFIGURATION_DIRECTORY " +
		"NUMA_POLICY CREDENTIALS BPF EXCEPTION " +
		"HUP INT QUIT ILL TRAP ABRT BUS FPE KILL USR1 SEGV USR2 PIPE ALRM TERM " +
		"STKFLT CHLD CONT STOP TSTP TTIN TTOU URG XCPU XFSZ VTALRM PROF WINCH IO " +
		"PWR SYS"
	).split(" "),
);
// systemd's service results (service_result_to_string).
const SERVICE_RESULTS = new Set([
	"success",
	"resources",
	"protocol",
	"timeout",
	"exit-code",
	"signal",
	"core-dump",
	"watchdog",
	"start-limit-hit",
	"oom-kill",
	"skip-condition",
	"exec-condition",
	"condition",
	"trigger-limit-hit",
]);
const DURATION = String.raw`(?:\d{1,6}(?:\.\d{1,6})?(?:y|month|w|d|h|min|s|ms|us) ?){1,6}`;

/** A PID 1 message rebuilt from its grammar, or undefined. */
function systemdMessage(message: string): string | undefined {
	const transition = new RegExp(
		`^(Started|Stopped|Starting|Stopping|Reloaded|Reloading|Failed to start|Deactivated) (${UNIT})(?:$| |\\.)`,
	).exec(message);
	if (transition?.[1] && transition[2])
		return `${transition[1]} ${unitName(transition[2])}`;
	const unit = new RegExp(`^(${UNIT}): (.{1,400})$`).exec(message);
	if (!unit?.[1] || unit[2] === undefined) return undefined;
	const name = unitName(unit[1]);
	const rest = unit[2];
	const exited =
		/^Main process exited, code=(exited|killed|dumped), status=(\d{1,3})(?:\/([A-Z0-9_]{2,32}))?$/.exec(
			rest,
		);
	if (exited) {
		const status =
			exited[3] && EXIT_STATUS_NAMES.has(exited[3]) ? `/${exited[3]}` : "";
		return `${name}: Main process exited, code=${exited[1]}, status=${exited[2]}${status}`;
	}
	const result = /^Failed with result '([^'\n]{1,64})'\.$/.exec(rest);
	if (result?.[1])
		return `${name}: Failed with result '${SERVICE_RESULTS.has(result[1]) ? result[1] : "[result]"}'.`;
	const killing =
		/^Killing process (\d{1,10}) \(([^()\n]{1,16})\) with signal (SIG[A-Z0-9]{2,8})\.$/.exec(
			rest,
		);
	if (killing)
		return `${name}: Killing process ${killing[1]} (${KNOWN_PROCESSES.has(killing[2] ?? "") ? killing[2] : "[process]"}) with signal ${SIGNALS.has(killing[3] ?? "") ? killing[3] : "[signal]"}.`;
	const consumed = new RegExp(`^Consumed (${DURATION}) CPU time\\b`).exec(rest);
	if (consumed?.[1]) return `${name}: Consumed ${consumed[1].trim()} CPU time.`;
	const restart =
		/^Scheduled restart job, restart counter is at (\d{1,6})\.$/.exec(rest);
	if (restart)
		return `${name}: Scheduled restart job, restart counter is at ${restart[1]}.`;
	for (const fixed of [
		"A process of this unit has been killed by the OOM killer.",
		"Start request repeated too quickly.",
		"Deactivated successfully.",
		"Failed with result 'exit-code'.",
	])
		if (rest === fixed) return `${name}: ${fixed}`;
	return undefined;
}

/** Procedure paths of the RPC contract ("streaming.start", …). */
function contractPaths(node: unknown, prefix: string, out: Set<string>) {
	if (!node || typeof node !== "object") return;
	if ("~orpc" in node) {
		out.add(prefix);
		return;
	}
	for (const [key, child] of Object.entries(node))
		contractPaths(child, prefix ? `${prefix}.${key}` : key, out);
}
const PROCEDURES: ReadonlySet<string> = (() => {
	const out = new Set<string>();
	contractPaths(appContract, "", out);
	return out;
})();

// Fixed words a message gap may keep besides numbers and interface names.
const MESSAGE_TOKENS: ReadonlySet<string> = new Set([
	...CODES,
	...STATES,
	...MODULES,
	...SIGNALS,
]);

function redactSupportRecord(
	message: string,
	source: "ceralive" | "systemd",
): string {
	if (oversizedSupportLine(message)) return WITHHELD;
	if (source === "systemd") return systemdMessage(message) ?? WITHHELD;
	const trimmed = message.trimStart();
	if (trimmed.startsWith("{")) {
		try {
			const entry = JSON.parse(trimmed);
			const raw = entry?.msg ?? entry?.message;
			if (typeof raw !== "string" || raw.length > 4096) return WITHHELD;
			// Only messages this code writes, every gap [value] unless a token.
			// An RPC trace names a procedure of the RPC contract.
			const rpc =
				/^RPC ([a-zA-Z][a-zA-Z0-9]{0,40}(?:\.[a-zA-Z][a-zA-Z0-9]{0,40}){0,3}) (ok|err)$/.exec(
					raw,
				);
			const procedure = rpc?.[1] && PROCEDURES.has(rpc[1]) ? rpc[1] : undefined;
			const msg = rpc
				? `RPC ${procedure ?? "[procedure]"} ${rpc[2]}`
				: boundedBackendMessage(raw, MESSAGE_TOKENS);
			if (msg === undefined) return WITHHELD;
			const out: Record<string, unknown> = { msg };
			if (
				typeof entry.ts === "string" &&
				/^\d{4}-\d\d-\d\dT[0-9:.]{8,20}Z$/.test(entry.ts)
			)
				out.ts = entry.ts;
			if (
				["error", "warn", "info", "debug", "verbose", "silly"].includes(
					entry.level,
				)
			)
				out.level = entry.level;
			if (typeof entry.module === "string" && MODULES.has(entry.module))
				out.module = entry.module;
			const meta = safeMetadata(
				entry.meta,
				rpc ? (procedure ?? "") : undefined,
			);
			if (Object.keys(meta).length) out.meta = meta;
			return JSON.stringify(out);
		} catch {
			return WITHHELD;
		}
	}
	const exited =
		/^streamloop: ([^\s()]{1,64}) exited \(code=(-?\d{1,3}|null), signal=(SIG[A-Z]{1,10}|null)\)$/.exec(
			message,
		);
	if (!exited?.[1]) return WITHHELD;
	const name = exited[1].replace(/^\/usr\/(?:local\/)?s?bin\//, "");
	const signal =
		exited[3] === "null" || SIGNALS.has(exited[3] ?? "")
			? exited[3]
			: "[signal]";
	return `streamloop: ${KNOWN_PROCESSES.has(name) ? exited[1] : "[process]"} exited (code=${exited[2]}, signal=${signal})`;
}

/** Render one admitted record's message for its trusted source. */
export function renderSourceMessage(source: string, message: string): string {
	if (oversizedSupportLine(message)) return WITHHELD;
	// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are never rendered.
	if (/[\u0000-\u0008\u000a-\u001f\u007f]/.test(message)) return WITHHELD;
	if (isShapeSource(source)) return matchLineShape(source, message) ?? WITHHELD;
	if (source === "ceralive" || source === "systemd")
		return redactSupportRecord(message, source);
	return WITHHELD;
}
