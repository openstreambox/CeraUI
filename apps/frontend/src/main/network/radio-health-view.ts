/**
 * What the Radio health panel says, derived from one cached `RadioHealth`
 * record. Pure so the wording rules are testable without rendering.
 *
 * The backend reports one of three findings or `unknown`. `unknown` is not a
 * verdict on its own: only a registered modem whose row is connected reads OK,
 * a registered one without a data connection reads as registered, and a
 * missing or unknown registration says the check could not run. A missing SIM
 * outranks any cached finding. Signal is never a diagnosis here.
 */
import type { RadioHealth, RadioMetric } from "@ceraui/rpc/schemas";

export type RadioStatusKind =
	| "ok"
	| "registered"
	| "sim-account"
	| "data-path"
	| "disturbed"
	| "no-sim"
	| "not-registered"
	| "unchecked";

export type RadioTone = "success" | "warning" | "error" | "neutral";

export const RADIO_STATUS_TONE: Readonly<Record<RadioStatusKind, RadioTone>> = {
	ok: "success",
	registered: "neutral",
	"sim-account": "error",
	"data-path": "error",
	disturbed: "warning",
	"no-sim": "warning",
	"not-registered": "warning",
	unchecked: "neutral",
};

/** Exactly the states the backend's own data-path rule treats as registered. */
const REGISTERED = new Set(["home", "roaming", "registered", "connected"]);

export function isRegistered(value: RadioMetric["value"]): boolean {
	return typeof value === "string" && REGISTERED.has(value);
}

export type RegistrationWord =
	| "home"
	| "roaming"
	| "registered"
	| "searching"
	| "idle"
	| "denied"
	| "other";

export function registrationWord(
	value: RadioMetric["value"],
): RegistrationWord {
	if (typeof value !== "string") return "other";
	if (value === "home") return "home";
	if (value === "roaming") return "roaming";
	if (value === "registered" || value === "connected") return "registered";
	if (value === "searching") return "searching";
	if (value === "idle") return "idle";
	if (value === "denied") return "denied";
	return "other";
}

export function radioStatus(
	radio: RadioHealth,
	row: { noSim: boolean; connected: boolean },
): RadioStatusKind {
	if (row.noSim) return "no-sim";
	const kind = radio.finding.kind;
	if (kind !== "unknown") return kind;
	const reg = radio.registration.value;
	if (reg === null || reg === "unknown") return "unchecked";
	if (isRegistered(reg)) return row.connected ? "ok" : "registered";
	return "not-registered";
}

/** "LTE + NR (NSA)" → "5G NSA"; unrecognised values pass through. */
export function networkType(value: RadioMetric["value"]): string | null {
	if (value === null) return null;
	const text = String(value);
	if (/NR \(SA\)|NR5G-SA/i.test(text)) return "5G SA";
	if (/NSA/i.test(text)) return "5G NSA";
	if (/^lte$/i.test(text)) return "LTE";
	if (/^(5gnr|nr)$/i.test(text)) return "5G";
	return text;
}

/** "LTE B3 + NR n78" → "B3 + n78": the band letter already names the layer. */
export function bandLabel(value: RadioMetric["value"]): string | null {
	if (value === null) return null;
	return String(value)
		.replace(/\bLTE\s+(?=B\d)/g, "")
		.replace(/\bNR\s+(?=n\d)/g, "");
}

/** "lte.rsrp" → "LTE RSRP", "nr.sinr" → "5G SINR", "lteTxPower" → "LTE TX". */
export function metricLabel(key: string): string {
	if (key === "lteTxPower") return "LTE TX";
	const [prefix, name] = key.includes(".") ? key.split(".", 2) : ["", key];
	const layer = prefix === "lte" ? "LTE " : prefix === "nr" ? "5G " : "";
	return `${layer}${(name ?? key).toUpperCase()}`;
}

export function formatValue(metric: RadioMetric): string | null {
	if (metric.value === null) return null;
	if (metric.unit === "raw") return `${metric.value} (raw)`;
	if (typeof metric.value === "number" && metric.unit && metric.unit !== "band")
		return `${metric.value} ${metric.unit}`;
	return String(metric.value);
}
