/** Bound backend `msg` text to the messages this code writes.
 *
 * A backend message reaches the support download only when it matches one of
 * the generated templates: the literal text of a logger call, with a gap
 * wherever the code interpolates a value. A gap keeps a short token from a
 * fixed set (a number, a state or error code, an interface name) and is
 * otherwise replaced with [value]. Winston appends an error's message after a
 * space; that tail is [value] too.
 */
import {
	START_FAILURE_CAPTURE_CAUSES,
	START_FAILURE_CLASSES,
	START_FAILURE_PHASES,
} from "@ceraui/rpc/schemas";
import { SUPPORT_LOG_TEMPLATES } from "./support-log-messages.generated.ts";

export const VALUE = "[value]";
const MAX_GAP = 300;

const exact = new Set<string>();
const buckets = new Map<string, (readonly string[])[]>();
for (const template of SUPPORT_LOG_TEMPLATES) {
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

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pattern(template: readonly string[]): RegExp {
	let regex = compiled.get(template);
	if (!regex) {
		regex = new RegExp(
			`^${template.map(escapeRegExp).join(`([\\s\\S]{1,${MAX_GAP}}?)`)}$`,
		);
		compiled.set(template, regex);
	}
	return regex;
}

const TOKENS = new Set<string>([
	...START_FAILURE_CLASSES,
	...START_FAILURE_PHASES,
	...START_FAILURE_CAPTURE_CAUSES,
	"true",
	"false",
	"null",
	"undefined",
]);

/** A gap value kept as written: numbers, interface names, fixed tokens. */
function boundedGap(value: string, extraTokens: ReadonlySet<string>): string {
	if (/^-?\d{1,10}(?:\.\d{1,6})?$/.test(value)) return value;
	if (TOKENS.has(value) || extraTokens.has(value)) return value;
	if (
		/^(?:wlan|wwan|eth|usb|cdc-wdm|rmnet|ppp)\d{1,3}$|^(?:en|wl|ww)(?:x[0-9a-f]{12}|[psod]\d[0-9a-z]{0,10})$/.test(
			value,
		)
	)
		return value;
	// The processes the backend supervises, by name or installed path.
	if (
		/^(?:\/usr\/(?:local\/)?s?bin\/)?(?:srtla_send|srtla_rec|cerastream|ceracoder|belacoder)$/.test(
			value,
		)
	)
		return value;
	return VALUE;
}

/** Cheap pre-check: the fixed parts occur in order and the last one ends it. */
function inOrder(msg: string, template: readonly string[]): boolean {
	let at = 0;
	for (const part of template) {
		const found = msg.indexOf(part, at);
		if (found < 0) return false;
		at = found + part.length;
	}
	return msg.endsWith(template.at(-1) ?? "");
}

function fill(
	template: readonly string[],
	gaps: readonly string[],
	extraTokens: ReadonlySet<string>,
): string {
	let out = template[0] ?? "";
	for (let i = 1; i < template.length; i++)
		out += boundedGap(gaps[i - 1] ?? "", extraTokens) + (template[i] ?? "");
	return out;
}

function matchWhole(
	msg: string,
	extraTokens: ReadonlySet<string>,
): string | undefined {
	if (exact.has(msg)) return msg;
	for (const key of [msg.slice(0, 2), ""])
		for (const template of buckets.get(key) ?? []) {
			if (!msg.startsWith(template[0] ?? "") || !inOrder(msg, template))
				continue;
			const match = pattern(template).exec(msg);
			if (match) return fill(template, match.slice(1), extraTokens);
		}
	return undefined;
}

/** The message as the export shows it, or undefined when the code never
 * writes it.
 */
export function boundedBackendMessage(
	msg: string,
	extraTokens: ReadonlySet<string> = new Set(),
): string | undefined {
	if (msg.length > 4096) return undefined;
	const whole = matchWhole(msg, extraTokens);
	if (whole !== undefined) return whole;
	// "<code's message> <appended error text>", split at a space.
	for (
		let cut = msg.lastIndexOf(" ", 400);
		cut > 0;
		cut = msg.lastIndexOf(" ", cut - 1)
	) {
		const head = matchWhole(msg.slice(0, cut), extraTokens);
		if (head !== undefined) return `${head} ${VALUE}`;
	}
	return undefined;
}
