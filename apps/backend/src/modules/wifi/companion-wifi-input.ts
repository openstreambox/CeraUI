import { z } from "zod";

const encoder = new TextEncoder();
const ssid = z
	.string()
	.min(1)
	.max(32)
	.refine(
		(value) =>
			!/[\p{Cc}\p{Cs}]/u.test(value) &&
			encoder.encode(value).length <= 32 &&
			!Object.hasOwn(Object.prototype, value),
	);
const networkSchema = z
	.strictObject({
		ssid,
		security: z.enum(["open", "wpa-psk", "sae"]),
		password: z.string().max(64).optional(),
		hidden: z.boolean().optional(),
	})
	.refine(({ security, password }) => {
		if (security === "open") return password === undefined || password === "";
		if (password === undefined) return false;
		return (
			(password.length >= 8 &&
				password.length <= 63 &&
				!/[^ -~]/.test(password)) ||
			(security === "wpa-psk" && /^[a-f\d]{64}$/i.test(password))
		);
	});

export type CompanionWifiNetwork = z.infer<typeof networkSchema>;

// Decode delimiters in one pass: an escaped backslash must never change how
// the following semicolon is interpreted.
function readWifiQr(qr: string): CompanionWifiNetwork | undefined {
	if (!qr.startsWith("WIFI:")) return;
	const fields = new Map<string, string>();
	let cursor = 5;
	while (cursor < qr.length && qr[cursor] !== ";") {
		const key = qr[cursor++];
		if (key === undefined || !"STPH".includes(key) || fields.has(key)) return;
		if (qr[cursor++] !== ":") return;
		let value = "";
		while (cursor < qr.length && qr[cursor] !== ";") {
			let char = qr[cursor++];
			if (char === "\\") {
				char = qr[cursor++];
				if (char === undefined || !'\\;,:"'.includes(char)) return;
			}
			value += char;
		}
		if (qr[cursor++] !== ";") return;
		fields.set(key, value);
	}
	if (cursor < qr.length && qr.slice(cursor) !== ";") return;

	const type = fields.get("T") ?? "nopass";
	const hidden = fields.get("H");
	if (hidden !== undefined && hidden !== "true" && hidden !== "false") return;
	const security = { nopass: "open", WPA: "wpa-psk", SAE: "sae" } as const;
	if (!Object.hasOwn(security, type)) return;
	const result = networkSchema.safeParse({
		ssid: fields.get("S"),
		security: security[type as keyof typeof security],
		password: fields.get("P"),
		hidden: hidden === "true",
	});
	return result.data;
}

const requestSchema = z.union([
	z.strictObject({ consent: z.literal(true), network: networkSchema }),
	z.strictObject({ consent: z.literal(true), qr: z.string().max(1024) }),
]);

export function parseCompanionWifiInput(
	input: unknown,
): CompanionWifiNetwork | undefined {
	const { data } = requestSchema.safeParse(input);
	if (!data) return;
	return "qr" in data ? readWifiQr(data.qr) : data.network;
}

// Formatting, default-ignorable and non-ASCII space characters render as
// nothing or as a plain space, so a lookalike SSID would read identically.
const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}\p{Z}]/gu;

/**
 * The SSID as a quoted string with every invisible character spelled out as
 * `\u{XXXX}`. JSON escaping runs first, so a literal backslash in the name
 * shows doubled and cannot imitate an escape.
 */
export function visibleSsid(ssid: string): string {
	return JSON.stringify(ssid).replace(INVISIBLE, (char) =>
		char === " "
			? char
			: `\\u{${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}}`,
	);
}

/** The consent question: what is sent, and to which CeraUI. Never the password. */
export function companionConsentPrompt(
	network: CompanionWifiNetwork,
	destination: URL,
): string {
	const shown = visibleSsid(network.ssid);
	const warning =
		shown === JSON.stringify(network.ssid)
			? ""
			: "\nThe name contains invisible characters, shown as \\u{...}. Check that it matches the venue's network.";
	return `Save ${shown} (${network.security}${network.hidden ? ", hidden" : ""}) on the box at ${destination.href}?${warning}\n[y/N] `;
}
