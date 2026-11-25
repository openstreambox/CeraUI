/**
 * What the Radio health panel says, derived from one cached `RadioHealth`
 * record. Pure so the wording rules are testable without rendering.
 *
 * The backend reports one of three findings or `unknown`. `unknown` is not a
 * verdict on its own: with a fresh registration and no finding the panel says
 * no problems were found, without one it says the check could not run. Signal
 * level is shown as a reading, never as a diagnosis.
 */
import type { RadioHealth, RadioMetric } from "@ceraui/rpc/schemas";

export type RadioStatusKind =
	| "ok"
	| "sim-account"
	| "data-path"
	| "disturbed"
	| "no-sim"
	| "not-registered"
	| "unchecked";

export type RadioTone = "success" | "warning" | "error" | "neutral";

export const RADIO_STATUS_TONE: Readonly<Record<RadioStatusKind, RadioTone>> = {
	ok: "success",
	"sim-account": "error",
	"data-path": "error",
	disturbed: "warning",
	"no-sim": "warning",
	"not-registered": "warning",
	unchecked: "neutral",
};

/** Registration states the backend's own data-path rule treats as registered. */
export function isRegistered(value: RadioMetric["value"]): boolean {
	if (typeof value !== "string") return false;
	return (
		value.startsWith("home") ||
		value.startsWith("roaming") ||
		value === "registered" ||
		value === "connected"
	);
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
	if (value.startsWith("home")) return "home";
	if (value.startsWith("roaming")) return "roaming";
	if (value === "registered" || value === "connected") return "registered";
	if (value === "searching") return "searching";
	if (value === "idle") return "idle";
	if (value === "denied") return "denied";
	return "other";
}

export function radioStatus(
	radio: RadioHealth,
	noSim: boolean,
): RadioStatusKind {
	const kind = radio.finding.kind;
	if (kind !== "unknown") return kind;
	if (noSim) return "no-sim";
	const reg = radio.registration.value;
	if (reg === null) return "unchecked";
	if (isRegistered(reg)) return "ok";
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

export type SignalLevel = "high" | "medium" | "low";

/**
 * A rough guide on RSRP in dBm, the same for LTE and NR. It colours a reading
 * and picks its bars; it never produces a finding.
 */
export function signalLevel(dbm: number): SignalLevel {
	if (dbm >= -90) return "high";
	if (dbm >= -105) return "medium";
	return "low";
}

export interface SignalReading {
	tech: "lte" | "nr" | "other";
	dbm: number;
	level: SignalLevel;
}

/** RSRP per layer, preferring the serving-cell read over ModemManager's. */
export function signalReadings(radio: RadioHealth): SignalReading[] {
	const pick = (...keys: string[]): number | undefined => {
		for (const key of keys) {
			const metric = radio.metrics[key];
			if (metric && typeof metric.value === "number" && metric.unit === "dBm")
				return metric.value;
		}
		return undefined;
	};
	const out: SignalReading[] = [];
	const lte = pick("lte.rsrp");
	const nr = pick("nr.rsrp");
	if (lte !== undefined)
		out.push({ tech: "lte", dbm: lte, level: signalLevel(lte) });
	if (nr !== undefined)
		out.push({ tech: "nr", dbm: nr, level: signalLevel(nr) });
	if (out.length === 0) {
		const any = pick("mm.rsrp", "rsrp");
		if (any !== undefined)
			out.push({ tech: "other", dbm: any, level: signalLevel(any) });
	}
	return out;
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
