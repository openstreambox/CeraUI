import { z } from "zod";
import { getms } from "../../helpers/time.ts";

export const POWER_STATE_PATH = "/run/ceralive/power/supervisor.json";
const temperature = z.object({
	celsius: z.number().finite().nullable(),
	quality: z.enum(["reported", "na", "uncal", "unknown"]),
});
const snapshot = z.object({
	schema_version: z.literal(1),
	link: z.enum(["ok", "absent", "silent", "bootloader", "unknown_version"]),
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
export function unavailablePower(): PowerState {
	return {
		available: false,
		summary: "Power data not available",
		sensors: {},
		notices: [],
	};
}

/** Read a published snapshot only. Events never establish current power state. */
export async function readPowerState(
	path = POWER_STATE_PATH,
	now = getms(),
): Promise<PowerState> {
	try {
		const file = Bun.file(path);
		if (file.size > 65536) return unavailablePower();
		const parsed = snapshot.safeParse(JSON.parse(await file.text()));
		if (!parsed.success) return unavailablePower();
		const s = parsed.data;
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
			message: string,
			type: PowerNotice["type"] = "warning",
		) => notices.push({ id, message, type });
		// These are power-feed claims, never claims about delivery to viewers.
		const feed = f.sbc === "run" ? " The box remains powered." : "";
		if (f.power === "low")
			add("supply", `Power is weak. Check the banks.${feed}`);
		if (f.power === "holdup")
			add("supply", "Power lost. Running on reserve for a few seconds.");
		if (f.redundant === "0" && f.power !== "holdup")
			add(
				"redundancy",
				`Power has no confirmed backup bank. Check both banks.${feed}`,
				"info",
			);
		const heat = {
			warm: "The power board reports warmth. Give the box more airflow.",
			hot: "The power board reports heat. Improve airflow; let the reserve cool before charging.",
			critical:
				"The power board reports high heat. Check the banks and reserve pack now.",
			shutdown:
				"The reserve pack is over its heat limit. The box is shutting down.",
		};
		const level = f.thermal;
		const targets = f.hot?.split(",") ?? [];
		if (
			targets.length &&
			targets.every((target) => ["a", "b", "pack"].includes(target))
		) {
			const describe = (stage: "warm" | "hot" | "critical") =>
				targets
					.map((target) => {
						if (target === "pack") {
							if (stage === "critical")
								return "Pack very hot. The box will switch off above 65 °C.";
							return stage === "warm"
								? "The reserve pack is warm. Give it more airflow."
								: "The reserve pack is hot. Improve airflow. Let it cool before charging.";
						}
						return stage === "warm"
							? `Bank ${target.toUpperCase()} is warm. Give it more airflow.`
							: `Bank ${target.toUpperCase()} is ${stage === "critical" ? "very hot" : "hot"}. Improve airflow or swap it for a cool bank. Connect the replacement before removing the only bank.`;
					})
					.join(" ");
			for (const stage of ["warm", "hot", "critical"] as const)
				heat[stage] = describe(stage);
		}
		if (level && Object.hasOwn(heat, level))
			add(
				"heat",
				`${heat[level as keyof typeof heat]}${level === "shutdown" ? "" : feed}`,
				level === "warm" ? "info" : "warning",
			);
		for (const bank of ["a", "b"] as const) {
			const peer = bank === "a" ? "b" : "a";
			const reason = f[bank]?.split("/")[0];
			if (reason?.startsWith("stood_down:")) {
				const supplying = f[peer]?.startsWith("healthy/")
					? ` Bank ${peer.toUpperCase()} supplies power.`
					: feed;
				add(
					`bank-${bank}`,
					`Bank ${bank.toUpperCase()} is ${reason === "stood_down:thermal" ? "hot" : "weak"} and resting.${supplying}`,
				);
			}
		}
		if (f.armed === "0")
			add(
				"bench",
				"Power protection is in bench mode: it only reports.",
				"info",
			);
		if (
			[f.gaps, f.gaps2].some(
				(v) =>
					v !== undefined &&
					(!/^[0-9a-fA-F]{4}$/.test(v) || Number.parseInt(v, 16) !== 0),
			)
		)
			add(
				"protection",
				`The power board reports reduced protection. Check the power sensors.${feed}`,
			);
		if (f.pack_cal === "none")
			add(
				"calibration",
				`The reserve pack has no heat protection: its sensor is not set up.${feed}`,
			);
		if (f.sbc?.startsWith("shutdown_requested:"))
			add(
				"shutdown",
				"The power board has requested a box shutdown. Power remains on until the shutdown completes.",
			);
		const sensors: Record<string, string> = {};
		for (const [key, label] of [
			["a", "Bank A"],
			["b", "Bank B"],
			["pack", "Reserve pack"],
		] as const) {
			const t = s.temperatures[key];
			sensors[label] =
				t.quality === "reported" && t.celsius !== null
					? `${t.celsius.toFixed(1)} °C${key === "pack" && f.pack_cal === "datasheet" ? " (estimate)" : ""}`
					: "Temperature unavailable";
		}
		return {
			available: true,
			summary:
				notices.map((n) => n.message).join(" ") || "Power data available",
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
