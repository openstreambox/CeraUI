import { type PowerCopyKey, powerText } from "@ceraui/i18n/formatters";
import { z } from "zod";
import { monotonicMs } from "../../helpers/monotonic-clock.ts";

export const POWER_STATE_PATH = "/run/ceralive/power/supervisor.json";
const temperature = z.object({
	celsius: z.number().finite().nullable(),
	quality: z.enum(["reported", "na", "uncal", "unknown"]),
});
const snapshot = z.object({
	schema_version: z.literal(1),
	link: z.enum([
		"ok",
		"absent",
		"silent",
		"bootloader",
		"unknown_version",
		"error",
		"stopped",
	]),
	open_error: z.number().int().nonnegative().optional(),
	persist_error: z.boolean().optional(),
	restarts: z.number().int().nonnegative().optional(),
	stale: z.boolean(),
	expected: z.boolean(),
	ambiguous: z.boolean(),
	published_mono_ms: z.number().finite().int().nonnegative(),
	rx_mono_ms: z.number().int().nonnegative().nullable(),
	fields: z.record(z.string().max(31), z.string().max(159)),
	temperatures: z.object({ a: temperature, b: temperature, pack: temperature }),
});
export interface PowerNotice {
	id: string;
	type: "info" | "warning";
	message: string;
}
/** The supervisor's own words, for diagnostics. Missing or malformed means unknown (null). */
export interface SupervisorFields {
	/** `pack_cal`: `bench`, `datasheet`, `none`, or a newer firmware's word as reported. */
	packCalibration: string | null;
	/** `start`: `on`, `off`, or why the box's feed is not on yet. */
	start: string | null;
	/** As the power service reads it: unknown unless both gap halves are valid. */
	protection: "reduced" | "no_reported_gaps" | "unknown";
	/** Names of the set `gaps`/`gaps2` bits, unknown bits as `bit<n>`; null unless both halves are valid. */
	gaps: string[] | null;
}
export interface PowerState {
	available: boolean;
	summary: string;
	sensors: Record<string, string>;
	notices: PowerNotice[];
	boot?: string;
	supervisor?: SupervisorFields;
}
/** Bit n of the combined mask: `gaps` holds bits 0-15, `gaps2` bits 16-31. */
const GAP_NAMES = [
	"unarmed",
	"pack_uncal",
	"pack_est",
	"pack_probe",
	"a_probe",
	"b_probe",
	"blind",
	"no_alive",
	"shdn",
	"nvs",
	"wdt",
	"skip",
	"loop",
	"blind_start",
	"pack_flaky",
	"sink",
	"supply_unproven",
	"pack_jump",
	"a_rest_lost",
	"b_rest_lost",
] as const;
/** Each gap's own notice; null is either harmless or said in another notice. */
const GAP_COPY: (PowerCopyKey | null)[] = [
	null,
	"calibration",
	null,
	"packProbe",
	"aProbe",
	"bProbe",
	"blind",
	"noAlive",
	"shdn",
	"nvs",
	"wdt",
	"skip",
	"loop",
	"blindStart",
	"flaky",
	"sink",
	"unproven",
	"jump",
	// a_rest_lost / b_rest_lost replace that bank's own notice
	null,
	null,
];
const REST_LOST = { a: 2 ** 18, b: 2 ** 19 } as const;
const supervisorWord = (value: string | undefined) =>
	value !== undefined && /^[a-z][a-z0-9_]{0,30}$/.test(value) ? value : null;
export function unavailablePower(visible = true): PowerState {
	return {
		available: false,
		summary: visible ? powerText("unavailable") : "",
		sensors: {},
		notices: [],
	};
}

/** Read a published snapshot only. Events never establish current power state. */
export async function readPowerState(
	path = POWER_STATE_PATH,
	now?: number,
): Promise<PowerState> {
	try {
		const file = Bun.file(path);
		if (!(await file.exists())) return unavailablePower(false);
		if (file.size > 65536) return unavailablePower();
		const parsed = snapshot.safeParse(JSON.parse(await file.text()));
		if (!parsed.success) return unavailablePower();
		const s = parsed.data;
		now ??= monotonicMs();
		if (
			!Number.isFinite(now) ||
			now < s.published_mono_ms ||
			now - s.published_mono_ms >= 3000 ||
			s.link === "stopped"
		)
			return unavailablePower();
		if (s.link === "absent" && !s.expected && !s.ambiguous)
			return unavailablePower(false);
		if (s.link === "error")
			return {
				...unavailablePower(),
				summary: powerText(
					s.open_error === 13
						? "permission"
						: s.open_error === 16
							? "busy"
							: "openError",
					{ errno: String(s.open_error ?? 0) },
				),
			};
		if (
			s.link !== "ok" ||
			s.stale ||
			s.ambiguous ||
			s.rx_mono_ms === null ||
			now < s.rx_mono_ms ||
			now - s.rx_mono_ms >= 5000
		)
			return unavailablePower();
		const f = s.fields;
		const notices: PowerNotice[] = [];
		const add = (
			id: string,
			key: PowerCopyKey,
			type: PowerNotice["type"] = "warning",
			params: Record<string, string> = {},
			suffix = "",
		) => notices.push({ id, message: powerText(key, params) + suffix, type });
		const feed = f.sbc === "run" ? ` ${powerText("feed")}` : "";
		const resting = (bank: string) =>
			/^(stood_down|standing_down)(:|\/|$)/.test(f[bank] ?? "");
		// Gap bits are this board profile's; another board's protection is unknown.
		const profileKnown =
			f.profile === undefined || f.profile === "dual-input-reserve-v1";
		const half = (value: string | undefined) =>
			profileKnown && value !== undefined && /^[0-9a-fA-F]{4}$/.test(value)
				? Number.parseInt(value, 16)
				: null;
		const low = half(f.gaps);
		const high = half(f.gaps2);
		// Protection needs both halves: a missing or garbled one is unknown, never
		// full protection. A readable half still gives its own warnings.
		const complete = low !== null && high !== null;
		const mask = (low ?? 0) + 65536 * (high ?? 0);
		const restLost = (bank: "a" | "b") => (mask & REST_LOST[bank]) !== 0;
		if (f.power === "low") add("supply", "low", "warning", {}, feed);
		if (f.power === "holdup") add("supply", "reserve");
		if (
			f.redundant === "0" &&
			f.power !== "holdup" &&
			!resting("a") &&
			!resting("b") &&
			!restLost("a") &&
			!restLost("b")
		)
			add("redundancy", "redundancy", "info", {}, feed);
		const level = f.thermal;
		const targets = (f.hot ?? "").split(",");
		/** A plugged bank's heat advice for the current level, if it is among the hottest. */
		const bankHeat = (bank: "a" | "b"): string[] => {
			if (
				(level !== "warm" && level !== "hot" && level !== "critical") ||
				!targets.includes(bank) ||
				f[bank]?.startsWith("absent/")
			)
				return [];
			const texts = [
				powerText(
					level === "warm"
						? "bankWarm"
						: level === "hot"
							? "bankHot"
							: "bankCritical",
					{ bank: bank.toUpperCase() },
				),
			];
			const peer = bank === "a" ? "b" : "a";
			if (level !== "warm" && !f[peer]?.startsWith("healthy/"))
				texts.push(powerText("replacement"));
			return texts;
		};
		if (level === "shutdown") add("heat", "shutdownHeat");
		else if (level === "warm" || level === "hot" || level === "critical") {
			const texts: string[] = [];
			for (const target of targets) {
				if (target === "pack")
					texts.push(
						powerText(
							level === "warm"
								? "packWarm"
								: level === "hot"
									? "packHot"
									: "packCritical",
						),
					);
				// A resting or lost bank's own notice carries its heat.
				else if (
					(target === "a" || target === "b") &&
					!resting(target) &&
					!restLost(target)
				)
					texts.push(...bankHeat(target));
			}
			if (texts.length)
				notices.push({
					id: "heat",
					message: texts.join(" ") + feed,
					type: level === "warm" ? "info" : "warning",
				});
			else if (!targets.every((t) => t === "a" || t === "b" || t === "pack"))
				add("heat", level, level === "warm" ? "info" : "warning", {}, feed);
		}
		for (const bank of ["a", "b"] as const) {
			const peer = bank === "a" ? "b" : "a";
			const peerCarries = f[peer]?.startsWith("healthy/") === true;
			if (restLost(bank))
				// Heat advice first: a hot bank must cool before it is woken or replugged.
				notices.push({
					id: `bank-${bank}`,
					type: "warning",
					message:
						[
							...bankHeat(bank),
							powerText("restLost", { bank: bank.toUpperCase() }),
						].join(" ") +
						(peerCarries
							? ` ${powerText("peer", { bank: peer.toUpperCase() })}`
							: feed),
				});
			else if (resting(bank)) {
				const cause = f[bank]?.split("/")[0]?.split(":")[1];
				add(
					`bank-${bank}`,
					cause === "thermal"
						? "restingHot"
						: cause === "sag"
							? "restingWeak"
							: "resting",
					peerCarries ? "info" : "warning",
					{ bank: bank.toUpperCase() },
					peerCarries
						? ` ${powerText("peer", { bank: peer.toUpperCase() })}`
						: feed,
				);
			}
		}
		if (f.armed === "0") add("bench", "bench", "info");
		// An unknown bit from newer firmware still means reduced protection.
		if (!complete || mask >= 2 ** GAP_NAMES.length)
			add("protection", "protection", "warning", {}, feed);
		GAP_COPY.forEach((key, bit) => {
			if (key && mask & (2 ** bit))
				add(`gap-${GAP_NAMES[bit]}`, key, "warning", {}, feed);
		});
		if (f.pack_cal === "none" && !(mask & 2))
			add("calibration", "calibration", "warning", {}, feed);
		if (s.persist_error) add("persistence", "persist", "info");
		if (/^shutdown_requested(:|$)/.test(f.sbc ?? ""))
			add("shutdown", "shutdown");
		const sensors: Record<string, string> = {};
		for (const [key, label] of [
			["a", "Bank A"],
			["b", "Bank B"],
			["pack", "Reserve pack"],
		] as const) {
			const t = s.temperatures[key];
			const present =
				key === "pack" ||
				/^(present|healthy|sagging|standing_down|stood_down|recovering|fault)(:|\/)/.test(
					f[key] ?? "",
				);
			sensors[label] =
				present && t.quality === "reported" && t.celsius !== null
					? `${t.celsius.toFixed(1)} °C${key === "pack" && f.pack_cal === "datasheet" ? powerText("estimate") : ""}`
					: powerText("temperature");
		}
		const summary = notices
			.map((n) =>
				feed && n.message.endsWith(feed)
					? n.message.slice(0, -feed.length)
					: n.message,
			)
			.join(" ");
		const summaryFeed =
			feed && notices.some((n) => n.message.endsWith(feed)) ? feed : "";
		return {
			available: true,
			summary: summary + summaryFeed || powerText("available"),
			sensors,
			notices,
			...(f.boot ? { boot: f.boot } : {}),
			supervisor: {
				packCalibration: supervisorWord(f.pack_cal),
				start: supervisorWord(f.start),
				protection: !complete
					? "unknown"
					: mask !== 0
						? "reduced"
						: "no_reported_gaps",
				gaps: complete
					? Array.from({ length: 32 }, (_, bit) => bit)
							.filter((bit) => mask & (2 ** bit))
							.map((bit) => GAP_NAMES[bit] ?? `bit${bit}`)
					: null,
			},
		};
	} catch {
		return unavailablePower();
	}
}

/** One standing notice per condition; repeated samples do not re-toast. */
export function createPowerReconciler(
	raise: (notice: PowerNotice) => void,
	remove: (id: string) => void,
) {
	const standing = new Map<string, string>();
	return (state: PowerState) => {
		const current = new Map(state.notices.map((n) => [n.id, n]));
		for (const id of standing.keys())
			if (!current.has(id)) {
				remove(id);
				standing.delete(id);
			}
		for (const [id, notice] of current) {
			const signature = `${notice.type}:${notice.message}`;
			if (standing.get(id) === signature) continue;
			raise(notice);
			standing.set(id, signature);
		}
	};
}
