import { realpath } from "node:fs/promises";
import type { RadioHealth } from "@ceraui/rpc/schemas";
import { run } from "../../helpers/run.ts";
import { getUplinkHealthEngine } from "../network/uplink-health/state.ts";
import { type FreeAtResult, freeAtPorts } from "./free-at-port.ts";
import {
	getRadioRegistrationObservation,
	readRadioNas,
} from "./modem-registration.ts";
import type { WireModemEntry } from "./modem-wire-projection.ts";
import { getModem } from "./modems-state.ts";
import {
	diagnoseRadio,
	emptyRadio,
	metric,
	parseQeng,
	parseQmiSignal,
	type RadioEvidence,
} from "./radio-health.ts";

/** The serving-cell read, on the RM520's released AT port only. */
const readServingCell = (id: number): Promise<FreeAtResult> =>
	freeAtPorts.read(id, 'AT+QENG="servingcell"');

const defaults: {
	enabled: () => Promise<boolean>;
	readNas: typeof readRadioNas;
	readServing?: (id: number) => Promise<FreeAtResult>;
	registration: typeof getRadioRegistrationObservation;
	readText: (path: string) => Promise<string>;
	realpath: typeof realpath;
	run: typeof run;
	health: (
		iface: string,
	) => ReturnType<ReturnType<typeof getUplinkHealthEngine>["get"]>;
	modem: typeof getModem;
} = {
	readServing: readServingCell,
	enabled: async () =>
		!(await Bun.file("/run/ceralive/radio-health-disabled").exists()),
	readNas: readRadioNas,
	registration: getRadioRegistrationObservation,
	readText: (path: string) => Bun.file(path).text(),
	realpath,
	run,
	health: (iface: string) => getUplinkHealthEngine().get(iface),
	modem: getModem,
};
export function resetRadioHealthForTest(): void {
	records = {};
	previous.clear();
	lastAt = 0;
}
let records: Record<string, RadioHealth> = {};
const previous = new Map<
	string,
	{ key: string; bytes: number | null; evidence: RadioEvidence }
>();
let lastAt = Date.now();
let refreshing = false;
export function getRadioHealth(now = Date.now()): Record<string, RadioHealth> {
	return Object.fromEntries(
		Object.entries(records).map(([id, record]) => [
			id,
			structuredClone(
				now < record.capturedAt || now - record.capturedAt > 65000
					? { ...emptyRadio(now), timeline: record.timeline }
					: record,
			),
		]),
	);
}
/** Called only by the retained modem status poll. No timer, probe or mutation. */
export async function refreshRadioHealth(
	modems: Record<
		string,
		Partial<
			Pick<
				WireModemEntry,
				| "ifname"
				| "stable_key"
				| "status"
				| "cell_info"
				| "signal_detail"
				| "registration_rejection"
				| "packet_service_state"
				| "model"
				| "availability_reason"
			>
		>
	>,
	now = Date.now(),
	deps = defaults,
): Promise<void> {
	if (refreshing) return;
	refreshing = true;
	try {
		if (!(await deps.enabled())) {
			records = {};
			previous.clear();
			lastAt = now;
			return;
		}
		const next: Record<string, RadioHealth> = {};
		const samples = new Map<string, { key: string; bytes: number | null }>();
		const evidence: Record<string, RadioEvidence> = {};
		let kernel:
			| { MESSAGE?: unknown; __REALTIME_TIMESTAMP?: string }[]
			| undefined;
		try {
			const text = await deps.run(
				"journalctl",
				[
					"-k",
					"-b",
					"--since",
					`@${lastAt / 1000}`,
					"--until",
					`@${now / 1000}`,
					"-o",
					"json",
					"--no-pager",
					"-n",
					"512",
				],
				{ timeout: 1500, maxBuffer: 131072 },
			);
			kernel = text
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line));
			if (kernel && kernel.length >= 512) kernel = undefined;
		} catch {
			kernel = undefined;
		}
		for (const [id, modem] of Object.entries(modems)) {
			if (!modem.ifname || !/^[a-zA-Z0-9_.-]+$/.test(modem.ifname)) continue;
			const record = emptyRadio(now);
			if (modem.availability_reason?.startsWith("mm-")) {
				next[id] = record;
				previous.delete(id);
				continue;
			}
			const internal = deps.modem(Number(id));
			const observed = deps.registration?.(internal);
			const registration =
				observed &&
				now >= observed.capturedAt &&
				now - observed.capturedAt <= 65000
					? observed
					: undefined;
			record.registration = metric(
				registration?.value ?? null,
				"ModemManager 3GPP",
				"state",
				"unknown",
				registration?.capturedAt ?? 0,
			);
			const cell = modem.cell_info;
			if (
				cell?.provenance?.observed_at &&
				now >= cell.provenance.observed_at &&
				now - cell.provenance.observed_at < 65000
			) {
				record.layer = metric(
					cell.tech ?? null,
					cell.provenance.source ?? "ModemManager",
					"",
					cell.tech ?? "unknown",
					cell.provenance.observed_at,
				);
				record.band = metric(
					cell.band ?? null,
					cell.provenance.source ?? "ModemManager",
					"band",
					cell.tech ?? "unknown",
					cell.provenance.observed_at,
				);
			}
			const nas: Awaited<ReturnType<typeof readRadioNas>> =
				modem.model === "RM520N-GL"
					? await deps.readNas(Number(id))
					: { signal: "", band: "" };
			Object.assign(record.metrics, parseQmiSignal(nas.signal, now));
			let servingRaw = "";
			if (nas.listed && deps.readServing) {
				const result = await deps.readServing(Number(id));
				if (result.ok) servingRaw = result.raw;
				// Never a silent unknown: the fixed reason is part of the field.
				else
					record.metrics.servingCell = {
						...metric(
							null,
							result.unavailable
								? `QENG servingcell · not available: ${result.reason}`
								: `QENG servingcell · no reading: ${result.reason}`,
							"",
							"unknown",
							result.unavailable ? (result.capturedAt ?? now) : now,
						),
						...(result.unavailable ? { reason: "not-available" as const } : {}),
					};
			}
			const serving = parseQeng(servingRaw, now);
			if (serving) {
				record.layer = serving.layer;
				record.band = serving.band;
				Object.assign(record.metrics, serving.metrics);
			}
			if (nas.tx !== undefined)
				record.metrics.lteTxPower = metric(
					null,
					"QMI NAS tx-rx-info",
					"dBm",
					"lte",
					now,
				);
			const tx = nas.tx?.match(/Tx power:\s*'?(-?\d+(?:\.\d+)?)\s*dBm/i);
			if (tx?.[1])
				record.metrics.lteTxPower = metric(
					Number(tx[1]),
					"QMI NAS tx-rx-info",
					"dBm",
					"lte",
					now,
				);
			const band = nas.band.match(/Active band:\s*'([^']+)'/);
			if (band?.[1] && !serving)
				record.band = metric(
					band[1],
					"QMI NAS rf-band-info",
					"band",
					band[1].includes("LTE") ? "lte" : "unknown",
					now,
				);
			for (const name of ["rsrp", "rsrq", "snr", "sinr"] as const) {
				const value = modem.signal_detail?.[name];
				if (
					value?.state === "known" &&
					modem.signal_detail?.quality_recent.state === "known" &&
					modem.signal_detail.quality_recent.value
				)
					record.metrics[`mm.${name}`] = metric(
						value.value,
						`ModemManager Signal ${name}`,
						name === "rsrp" ? "dBm" : "dB",
						cell?.tech ?? "unknown",
						now,
					);
			}
			let bytes: number | null = null;
			try {
				const n = Number(
					await deps.readText(
						`/sys/class/net/${modem.ifname}/statistics/tx_bytes`,
					),
				);
				if (Number.isSafeInteger(n) && n >= 0) bytes = n;
			} catch {
				/* A failed read remains explicitly unavailable. */
			}
			const key = `${modem.stable_key ?? ""}:${modem.ifname}:${internal?.iccid ?? ""}`;
			samples.set(id, { key, bytes });
			const before = previous.get(id);
			const valid =
				before?.key === key &&
				now > before.evidence.at &&
				now - before.evidence.at <= 65000;
			const transmitting =
				valid && bytes !== null && before.bytes !== null && bytes > before.bytes
					? "yes"
					: "unknown";
			let port: string | undefined;
			try {
				port = (
					await deps.realpath(`/sys/class/net/${modem.ifname}/device`)
				).match(/\/(\d+-\d+(?:\.\d+)*):\d+\.\d+(?:\/|$)/)?.[1];
			} catch {
				/* A failed read remains explicitly unavailable. */
			}
			const events: RadioEvidence["usb"] = [];
			if (port)
				for (const line of kernel ?? []) {
					if (
						typeof line.MESSAGE !== "string" ||
						!line.MESSAGE.startsWith(`usb ${port}:`)
					)
						continue;
					const kind = /reset .*USB device/.test(line.MESSAGE)
						? "reset"
						: /USB disconnect/.test(line.MESSAGE)
							? "disconnect"
							: undefined;
					const at = Number(line.__REALTIME_TIMESTAMP) / 1000;
					if (kind && Number.isFinite(at)) events.push({ at, kind });
				}
			record.usb = {
				available: kernel !== undefined && port !== undefined,
				events: events.slice(-128),
			};
			const health = deps.health(modem.ifname);
			const numeric = Object.entries(record.metrics);
			evidence[id] = {
				at: now,
				intervalStart: valid ? before.evidence.at : now,
				registration: registration?.value ?? "unknown",
				homeNetwork: internal?.home_network,
				rejectedNetwork: modem.registration_rejection?.operator_id,
				refused: !!modem.registration_rejection,
				rejectionCause: modem.registration_rejection?.error,
				granted: modem.packet_service_state === "attached",
				failedProbes:
					health?.reason === "probe_failed" ? health.probes.failures : 0,
				probeAt: health?.signals.activeAt,
				rsrp:
					numeric.find(
						([key, m]) =>
							key.endsWith("rsrp") && m.unit === "dBm" && m.value !== null,
					)?.[1] ?? metric(null, "not-observed", "dBm", "unknown", now),
				quality:
					numeric.find(
						([key, m]) =>
							(key.endsWith("rsrq") || key.endsWith("snr")) &&
							m.unit === "dB" &&
							m.value !== null,
					)?.[1] ?? metric(null, "not-observed", "dB", "unknown", now),
				transmitting,
				usb: events,
			};
			next[id] = record;
		}
		for (const [id, record] of Object.entries(next)) {
			const current = evidence[id];
			if (!current) continue;
			const before = previous.get(id);
			const neighbours = Object.fromEntries(
				Object.entries(evidence).filter(([other]) => other !== id),
			);
			record.finding = diagnoseRadio(
				current,
				before?.key === samples.get(id)?.key ? before?.evidence : undefined,
				neighbours,
			);
			record.neighbours = Object.keys(next)
				.filter((other) => other !== id)
				.map((other) => ({
					id: other,
					band: next[other]?.band ?? emptyRadio(now).band,
					transmitting: neighbours[other]?.transmitting ?? "unknown",
					source: "interface tx_bytes delta; zero payload is not radio silence",
					capturedAt: now,
				}));
			record.timeline = [
				...(before?.key === samples.get(id)?.key
					? (records[id]?.timeline ?? [])
					: []),
				{
					at: now,
					finding: record.finding,
					observation: {
						band: record.band,
						rsrp: current.rsrp,
						quality: current.quality,
						usbEvents: record.usb.events.length,
						neighbours: record.neighbours.map(({ id, band, transmitting }) => ({
							id,
							band,
							transmitting,
						})),
					},
				},
			].slice(-120);
			const sample = samples.get(id);
			if (sample) previous.set(id, { ...sample, evidence: current });
		}
		for (const id of previous.keys()) if (!next[id]) previous.delete(id);
		records = next;
		lastAt = now;
	} finally {
		refreshing = false;
	}
}

/** Explicit unknown replaces cached data on a new device or unavailable owner. */
export function radioForModem(
	id: string,
	row: Pick<WireModemEntry, "ifname" | "stable_key" | "availability_reason">,
	now = Date.now(),
): RadioHealth {
	const internal = getModem(Number(id));
	const key = `${row.stable_key ?? ""}:${row.ifname}:${internal?.iccid ?? ""}`;
	const record = records[id];
	if (
		row.availability_reason?.startsWith("mm-") ||
		previous.get(id)?.key !== key ||
		!record
	)
		return emptyRadio(0);
	return structuredClone(
		now < record.capturedAt || now - record.capturedAt > 65000
			? { ...emptyRadio(0), timeline: record.timeline.slice(-1) }
			: { ...record, timeline: record.timeline.slice(-1) },
	);
}
