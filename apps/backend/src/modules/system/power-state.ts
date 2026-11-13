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
	]),
	open_error: z.number().int().nonnegative().optional(),
	persist_error: z.boolean().optional(),
	restarts: z.number().int().nonnegative().optional(),
	stale: z.boolean(),
	expected: z.boolean(),
	ambiguous: z.boolean(),
	rx_mono_ms: z.number().int().nonnegative().nullable(),
	fields: z.record(z.string().max(31), z.string().max(159)),
	temperatures: z.object({ a: temperature, b: temperature, pack: temperature }),
});
export interface PowerNotice {
	id: string;
	type: "info" | "warning";
	message: string;
}
export interface PowerState {
	available: boolean;
	summary: string;
	sensors: Record<string, string>;
	notices: PowerNotice[];
	boot?: string;
}
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
		if (f.power === "low") add("supply", "low", "warning", {}, feed);
		if (f.power === "holdup") add("supply", "reserve");
		if (
			f.redundant === "0" &&
			f.power !== "holdup" &&
			!resting("a") &&
			!resting("b")
		)
			add("redundancy", "redundancy", "info", {}, feed);
		const level = f.thermal;
		if (level === "shutdown") add("heat", "shutdownHeat");
		else if (level === "warm" || level === "hot" || level === "critical") {
			const targets = (f.hot ?? "").split(",");
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
				else if (
					(target === "a" || target === "b") &&
					!resting(target) &&
					!f[target]?.startsWith("absent/")
				) {
					texts.push(
						powerText(
							level === "warm"
								? "bankWarm"
								: level === "hot"
									? "bankHot"
									: "bankCritical",
							{ bank: target.toUpperCase() },
						),
					);
					const peer = target === "a" ? "b" : "a";
					if (level !== "warm" && !f[peer]?.startsWith("healthy/"))
						texts.push(powerText("replacement"));
				}
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
		for (const bank of ["a", "b"] as const)
			if (resting(bank)) {
				const peer = bank === "a" ? "b" : "a";
				const cause = f[bank]?.split("/")[0]?.split(":")[1];
				add(
					`bank-${bank}`,
					cause === "thermal"
						? "restingHot"
						: cause === "sag"
							? "restingWeak"
							: "resting",
					"warning",
					{ bank: bank.toUpperCase() },
					f[peer]?.startsWith("healthy/")
						? ` ${powerText("peer", { bank: peer.toUpperCase() })}`
						: feed,
				);
			}
		if (f.armed === "0") add("bench", "bench", "info");
		const keys: (PowerCopyKey | null)[] = [
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
		];
		const names = [
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
		];
		const valid = [f.gaps, f.gaps2].every(
			(v) => v === undefined || /^[0-9a-fA-F]{4}$/.test(v),
		);
		const mask = valid
			? Number.parseInt(f.gaps ?? "0", 16) +
				65536 * Number.parseInt(f.gaps2 ?? "0", 16)
			: 0;
		if (!valid || mask >= 2 ** 18)
			add("protection", "protection", "warning", {}, feed);
		keys.forEach((key, bit) => {
			if (key && mask & (2 ** bit))
				add(`gap-${names[bit]}`, key, "warning", {}, feed);
		});
		if (f.pack_cal === "none" && !(mask & 2))
			add("calibration", "calibration", "warning", {}, feed);
		if (s.persist_error) add("persistence", "persist", "info");
		if (f.sbc?.startsWith("shutdown_requested:")) add("shutdown", "shutdown");
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
		return {
			available: true,
			summary:
				notices.map((n) => n.message).join(" ") || powerText("available"),
			sensors,
			notices,
			...(f.boot ? { boot: f.boot } : {}),
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
