/** Bound backend text to the texts this code writes.
 *
 * A backend message, error message or reason reaches the support download only
 * when it matches one of the generated templates: the literal text of a logger
 * call, a thrown error or a `reason` value, with a gap wherever the code
 * interpolates a value. Every gap is [value] unless its text is a member of a
 * fixed token set (start-failure classes and phases, known states and codes).
 * Numbers and names inside a message never pass: values reach the download only
 * as typed metadata fields. The output therefore depends on the template, not
 * on the runtime string, whichever call produced it. Winston appends an
 * error's message to a log message after a space; that tail is [value] too.
 */
import {
	START_FAILURE_CAPTURE_CAUSES,
	START_FAILURE_CLASSES,
	START_FAILURE_PHASES,
} from "@ceraui/rpc/schemas";
import { errno } from "./support-errno.ts";
import {
	SUPPORT_ERROR_TEMPLATES,
	SUPPORT_LOG_TEMPLATES,
	SUPPORT_REASON_TEMPLATES,
} from "./support-log-messages.generated.ts";

export const VALUE = "[value]";
const MAX_GAP = 300;

const TOKENS = new Set<string>([
	...START_FAILURE_CLASSES,
	...START_FAILURE_PHASES,
	...START_FAILURE_CAPTURE_CAUSES,
	"true",
	"false",
	"null",
	"undefined",
]);

/** A gap keeps only a member of a fixed token set; anything else is [value]. */
function boundedGap(value: string, extraTokens: ReadonlySet<string>): string {
	return TOKENS.has(value) || extraTokens.has(value) ? value : VALUE;
}

// The processes the backend supervises, by name or installed path.
const SUPERVISED =
	/^(?:\/usr\/(?:local\/)?s?bin\/)?(?:srtla_send|srtla_rec|cerastream|ceracoder|belacoder)$/;

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Cheap pre-check: the fixed parts occur in order and the last one ends it. */
function inOrder(text: string, template: readonly string[]): boolean {
	let at = 0;
	for (const part of template) {
		const found = text.indexOf(part, at);
		if (found < 0) return false;
		at = found + part.length;
	}
	return text.endsWith(template.at(-1) ?? "");
}

interface Matcher {
	whole(text: string, extraTokens: ReadonlySet<string>): string | undefined;
}

function matcher(templates: readonly (readonly string[])[]): Matcher {
	const exact = new Set<string>();
	const buckets = new Map<string, (readonly string[])[]>();
	for (const template of templates) {
		if (template.length === 1) {
			exact.add(template[0] ?? "");
			continue;
		}
		const key = (template[0] ?? "").slice(0, 2);
		const list = buckets.get(key) ?? [];
		list.push(template);
		buckets.set(key, list);
	}
	const compiled = new Map<readonly string[], RegExp>();
	const pattern = (template: readonly string[]): RegExp => {
		let regex = compiled.get(template);
		if (!regex) {
			regex = new RegExp(
				`^${template.map(escapeRegExp).join(`([\\s\\S]{1,${MAX_GAP}}?)`)}$`,
			);
			compiled.set(template, regex);
		}
		return regex;
	};
	return {
		whole(text, extraTokens) {
			if (exact.has(text)) return text;
			for (const key of [text.slice(0, 2), ""])
				for (const template of buckets.get(key) ?? []) {
					if (!text.startsWith(template[0] ?? "") || !inOrder(text, template))
						continue;
					const match = pattern(template).exec(text);
					if (!match) continue;
					let out = template[0] ?? "";
					for (let i = 1; i < template.length; i++)
						out +=
							boundedGap(match[i] ?? "", extraTokens) + (template[i] ?? "");
					return out;
				}
			return undefined;
		},
	};
}

const LOGS = matcher(SUPPORT_LOG_TEMPLATES);
const ERRORS = matcher(SUPPORT_ERROR_TEMPLATES);
const REASONS = matcher(SUPPORT_REASON_TEMPLATES);

/** A log message as the export shows it, or undefined when the code never
 * writes it.
 */
export function boundedBackendMessage(
	msg: string,
	extraTokens: ReadonlySet<string> = new Set(),
): string | undefined {
	if (msg.length > 4096) return undefined;
	const whole = LOGS.whole(msg, extraTokens);
	if (whole !== undefined) return whole;
	// "<code's message> <appended error text>", split at a space.
	for (
		let cut = msg.lastIndexOf(" ", 400);
		cut > 0;
		cut = msg.lastIndexOf(" ", cut - 1)
	) {
		const head = LOGS.whole(msg.slice(0, cut), extraTokens);
		if (head !== undefined) return `${head} ${VALUE}`;
	}
	return undefined;
}

// System calls Node and Bun name in their error messages.
const SYSCALLS = new Set([
	"accept",
	"access",
	"bind",
	"chmod",
	"chown",
	"close",
	"connect",
	"copyfile",
	"fsync",
	"ftruncate",
	"getaddrinfo",
	"getnameinfo",
	"ioctl",
	"kill",
	"link",
	"listen",
	"lstat",
	"mkdir",
	"mkdtemp",
	"open",
	"opendir",
	"posix_spawn",
	"queryA",
	"queryAaaa",
	"read",
	"readdir",
	"readlink",
	"realpath",
	"recv",
	"recvmsg",
	"rename",
	"rm",
	"rmdir",
	"scandir",
	"send",
	"sendmsg",
	"shutdown",
	"socket",
	"stat",
	"statfs",
	"symlink",
	"unlink",
	"utime",
	"watch",
	"write",
	"writev",
]);

/** A POSIX errno name or a resolver failure code. */
export function isErrorCode(code: string): boolean {
	return errno.has(code);
}

// Messages Node, Bun and fetch produce themselves, with no runtime value.
const RUNTIME_ERRORS = new Set([
	"fetch failed",
	"socket hang up",
	"The operation was aborted.",
	"The operation timed out.",
	"This operation was aborted",
	"Request timed out",
	"Unable to connect. Is the computer able to access the url?",
	"read ECONNRESET",
	"write EPIPE",
]);

/** An error message as the export shows it: the code's own error text with
 * gaps bounded, a runtime's fixed text, or a system-call error reduced to its
 * call and code. Anything else is [value].
 */
export function boundedErrorMessage(
	message: string,
	extraTokens: ReadonlySet<string> = new Set(),
): string {
	if (message.length > 4096) return VALUE;
	if (extraTokens.has(message) || RUNTIME_ERRORS.has(message)) return message;
	// Node/Bun system errors: "spawn <file> ENOENT", "connect ECONNREFUSED <addr>".
	// The call and the code must be real ones; the file is a supervised process.
	const spawn = /^spawn (\S{1,200}) (E[A-Z0-9_]{2,24})$/.exec(message);
	if (spawn?.[1] && spawn[2])
		return isErrorCode(spawn[2])
			? `spawn ${SUPERVISED.test(spawn[1]) ? spawn[1] : VALUE} ${spawn[2]}`
			: VALUE;
	const syscall =
		/^([a-z_]{2,24}) (E[A-Z0-9_]{2,24})(?: ([^\n]{1,300}))?$/.exec(message);
	if (syscall?.[1] && syscall[2])
		return SYSCALLS.has(syscall[1]) && isErrorCode(syscall[2])
			? `${syscall[1]} ${syscall[2]}${syscall[3] ? ` ${VALUE}` : ""}`
			: VALUE;
	return ERRORS.whole(message, extraTokens) ?? VALUE;
}

/** A reason as the export shows it: a fixed token or one the code assigns. */
export function boundedReason(
	reason: string,
	extraTokens: ReadonlySet<string> = new Set(),
): string | undefined {
	if (reason.length > 300) return undefined;
	if (extraTokens.has(reason)) return reason;
	return REASONS.whole(reason, extraTokens);
}
