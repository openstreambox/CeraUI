import { uptime } from "node:os";
import {
	connectionStatusSchema,
	type DeviceEvent,
	LIFECYCLE_STATES,
	type LogBootInfo,
	simLockRequiredSchema,
} from "@ceraui/rpc/schemas";
import { shouldUseMocks } from "../../mocks/mock-service.ts";
import { getModems } from "../modems/modems-state.ts";
import {
	getNetworkInterfaces,
	NETIF_ERR_DUPIPV4,
	NETIF_ERR_HOTSPOT,
	NETIF_ERR_NOSIM,
	NETIF_ERR_SHAREDLAN,
} from "../network/network-interfaces.ts";
import { getEngineBitrateStatus } from "../streaming/engine-bitrate-status.ts";
import { getStreamLifecycleState } from "../streaming/stream-lifecycle-status.ts";
import { isRealDevice } from "../system/device-detection.ts";
import { getDeviceStatsSnapshot } from "../system/device-stats-snapshot.ts";
import {
	type RootSlotStatus,
	readRootSlots,
} from "../system/update-orchestrator/slot-status.ts";
import { classifyFinishedBoot } from "./classified-boots.ts";
import { buildRedactor } from "./redaction.ts";

/**
 * The support bundle's device state record, written into the settings section.
 *
 * Every string is a member of a closed vocabulary or an anonymous label;
 * nothing free-form from a modem, the OS, RAUC or a package database is copied.
 * Version strings are left out: the bundle's versions section already carries
 * the running image, CeraUI, engine and sender versions, and no format check
 * can tell a version part from a short identifier. Interfaces are labelled by
 * kind and ordinal, never by name. Before the record is returned each value
 * is screened with the bundle's own redactor and the held secrets
 * (`screenState`): a value it would act on becomes `null`, and a key it would
 * act on drops the whole record.
 */
export interface BundleDeviceState {
	readonly uptimeSeconds: number | null;
	readonly memory: {
		readonly totalBytes: number | null;
		readonly availableBytes: number | null;
	} | null;
	readonly boots: readonly BundleBootEnding[];
	readonly slots: readonly BundleSlot[] | null;
	readonly bootAttempts: {
		readonly order: readonly ("A" | "B")[];
		readonly left: { readonly A: number; readonly B: number };
	} | null;
	readonly modems: readonly BundleModem[];
	readonly interfaces: readonly BundleInterface[];
	readonly stream: {
		readonly lifecycle: string;
		readonly bitrateKbps: number | null;
		readonly ceilingKbps: number | null;
	};
}

export interface BundleBootEnding {
	readonly bootId: string;
	readonly current: boolean;
	readonly firstTs: number | null;
	readonly lastTs: number | null;
	readonly shutdown: LogBootInfo["shutdown"];
	readonly evidence: readonly string[];
}

interface BundleSlot {
	readonly slot: "A" | "B" | null;
	readonly state: string;
	readonly bootStatus: string | null;
}

interface BundleModem {
	readonly modem: number;
	readonly connection: string;
	readonly mode: string | null;
	readonly accessTechnology: string | null;
	readonly signal: number | null;
	readonly roaming: boolean | null;
	readonly sim: string;
	readonly simLock: string | null;
	readonly apnConfigured: boolean;
	readonly dataConnectionFailed: boolean;
}

interface BundleInterface {
	readonly label: string;
	readonly usb: boolean;
	readonly bonded: boolean;
	readonly ipv4: boolean;
	readonly flags: readonly string[];
	readonly txKbps: number | null;
	readonly rxKbps: number | null;
}

type Secrets = Parameters<typeof buildRedactor>[0];

/** A record after screening: any leaf except a boot id may have become null. */
export type Screened<T> = T extends string | number | boolean
	? T | null
	: T extends readonly (infer U)[]
		? readonly Screened<U>[]
		: T extends object
			? { readonly [K in keyof T]: K extends "bootId" ? T[K] : Screened<T[K]> }
			: T;

export type BundleStateRecord = Screened<BundleDeviceState>;

export interface BundleStateDeps {
	/** Only a real device reads RAUC and the device files; dev hosts and CI never do. */
	readonly device: () => Promise<boolean>;
	readonly readText: (path: string, maxBytes: number) => Promise<string>;
	readonly readSlots: () => Promise<RootSlotStatus[]>;
	readonly uptimeSeconds: () => number;
	readonly classify: typeof classifyFinishedBoot;
}

export const defaultBundleStateDeps: BundleStateDeps = {
	device: async () => !shouldUseMocks() && (await isRealDevice()),
	async readText(path, maxBytes) {
		const file = Bun.file(path);
		if (file.size > maxBytes) throw new Error("file too large");
		return file.text();
	},
	readSlots: () => readRootSlots(),
	uptimeSeconds: uptime,
	classify: classifyFinishedBoot,
};

const MAX_MODEMS = 16;
const MAX_INTERFACES = 32;
const OTHER = "other";

/** The shutdown classifier's evidence codes, plus this collector's own. */
const EVIDENCE = new Set([
	"shutdown_target",
	"journal_stopped",
	"next_boot_unclean_journal",
	"no_shutdown_markers",
	"shutdown_requested_event",
	"no_entries",
	"too_few_entries",
	"read_failed",
]);
const SHUTDOWN = new Set(["clean", "unclean", "unknown", "current"]);
const CONNECTION = new Set<string>(connectionStatusSchema.options);
const SIM_LOCK = new Set<string>(simLockRequiredSchema.options);
const SIM_PRESENCE = new Set(["present", "absent", "unknown"]);
const LIFECYCLE = new Set<string>(LIFECYCLE_STATES);
const ACCESS_TECHNOLOGY = new Set(["2G", "3G", "3G+", "4G", "5G"]);
const SLOT_STATE = new Set(["booted", "active", "inactive"]);
const SLOT_BOOT_STATUS = new Set(["good", "bad"]);
// The allowed-mode label mmcli parsing builds: generations, newest first, no repeats.
const MODE = /^(?=.)(5g)?(4g)?(3g)?(2g)?$/;
// The boot-state helper's default attempt budget (CERALIVE_BOOT_ATTEMPTS).
const BOOT_ATTEMPTS = 3;

function member(set: ReadonlySet<string>, value: unknown): string | null {
	if (typeof value !== "string" || value === "") return null;
	return set.has(value) ? value : OTHER;
}

function count(value: unknown, max: number): number | null {
	return typeof value === "number" &&
		Number.isFinite(value) &&
		value >= 0 &&
		value <= max
		? Math.round(value)
		: null;
}

function kbps(bitsPerSecond: unknown): number | null {
	const value = count(bitsPerSecond, 100e9);
	return value === null ? null : Math.round(value / 1000);
}

async function optional<T>(read: () => Promise<T>, fallback: T): Promise<T> {
	try {
		return await read();
	} catch {
		// One unreadable source leaves the rest of the record intact.
		return fallback;
	}
}

/** POSIX `cksum`'s CRC, which the boot-state helper stores as BOOT_CRC. */
export function posixCksum(text: string): number {
	const bytes = new TextEncoder().encode(text);
	let crc = 0;
	const step = (byte: number) => {
		crc ^= byte << 24;
		for (let bit = 0; bit < 8; bit++)
			crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
		crc >>>= 0;
	};
	for (const byte of bytes) step(byte);
	for (let length = bytes.length; length > 0; length = Math.floor(length / 256))
		step(length & 0xff);
	return ~crc >>> 0;
}

/**
 * The boot-state file as the image's helper would accept it: BOOT_ORDER a
 * non-empty sequence of A and B without repeats, both counters present and
 * within the attempt budget, each key once, and BOOT_CRC (when present) equal
 * to the checksum of the canonical payload. Anything else is unavailable.
 */
export function parseBootAttempts(
	text: string,
): BundleDeviceState["bootAttempts"] {
	const fields = new Map<string, string>();
	for (const raw of text.split("\n")) {
		const line = raw.replace(/\r$/, "");
		const match = /^(BOOT_ORDER|BOOT_A_LEFT|BOOT_B_LEFT|BOOT_CRC)=(.*)$/.exec(
			line,
		);
		if (!match?.[1]) continue;
		if (fields.has(match[1])) return null;
		fields.set(match[1], match[2] ?? "");
	}
	const order = fields.get("BOOT_ORDER");
	const a = fields.get("BOOT_A_LEFT");
	const b = fields.get("BOOT_B_LEFT");
	if (order === undefined || a === undefined || b === undefined) return null;
	const slots = order.split(" ").filter(Boolean);
	if (
		slots.length === 0 ||
		!slots.every((slot) => slot === "A" || slot === "B") ||
		new Set(slots).size !== slots.length ||
		!/^\d+$/.test(a) ||
		!/^\d+$/.test(b) ||
		Number(a) > BOOT_ATTEMPTS ||
		Number(b) > BOOT_ATTEMPTS
	)
		return null;
	const crc = fields.get("BOOT_CRC");
	if (
		crc !== undefined &&
		crc !==
			String(
				posixCksum(`BOOT_ORDER=${order}\nBOOT_A_LEFT=${a}\nBOOT_B_LEFT=${b}\n`),
			)
	)
		return null;
	return {
		order: slots as ("A" | "B")[],
		left: { A: Number(a), B: Number(b) },
	};
}

function slot(status: RootSlotStatus): BundleSlot {
	return {
		slot:
			status.bootname === "A" || status.bootname === "B"
				? status.bootname
				: null,
		state: member(SLOT_STATE, status.state) ?? OTHER,
		bootStatus: member(SLOT_BOOT_STATUS, status.bootStatus),
	};
}

function modems(): BundleModem[] {
	return Object.values(getModems())
		.filter((modem) => !modem.removed)
		.slice(0, MAX_MODEMS)
		.map((modem, index) => {
			const mode = modem.network_type?.active;
			return {
				modem: index + 1,
				connection: member(CONNECTION, modem.status?.connection) ?? "unknown",
				mode:
					typeof mode === "string" && mode !== ""
						? MODE.test(mode)
							? mode
							: OTHER
						: null,
				accessTechnology: member(ACCESS_TECHNOLOGY, modem.status?.network_type),
				signal: count(modem.status?.signal, 100),
				roaming:
					typeof modem.status?.roaming === "boolean"
						? modem.status.roaming
						: null,
				sim: member(SIM_PRESENCE, modem.sim_presence) ?? "unknown",
				simLock: member(SIM_LOCK, modem.sim_lock?.required),
				apnConfigured: Boolean(modem.config?.apn),
				dataConnectionFailed: modem.data_connection_failed === true,
			};
		});
}

const NETIF_FLAGS: ReadonlyArray<readonly [number, string]> = [
	[NETIF_ERR_DUPIPV4, "duplicate_ipv4"],
	[NETIF_ERR_HOTSPOT, "hotspot"],
	[NETIF_ERR_NOSIM, "no_sim"],
	[NETIF_ERR_SHAREDLAN, "shared_lan"],
];

/** The kind an interface name's kernel prefix stands for; custom names are `other`. */
function interfaceKind(name: string): string {
	if (/^(wwan|rmnet|mhi_hwip)/.test(name)) return "cellular";
	if (/^wl/.test(name)) return "wifi";
	if (/^(eth|en|usb)/.test(name)) return "ethernet";
	return OTHER;
}

function interfaces(): BundleInterface[] {
	const ordinals = new Map<string, number>();
	return Object.entries(getNetworkInterfaces())
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.slice(0, MAX_INTERFACES)
		.map(([name, netif]) => {
			const kind = interfaceKind(name);
			const ordinal = (ordinals.get(kind) ?? 0) + 1;
			ordinals.set(kind, ordinal);
			return {
				label: `${kind}-${ordinal}`,
				usb: netif.usb === true,
				bonded: netif.enabled === true,
				ipv4: Boolean(netif.ip),
				flags: NETIF_FLAGS.flatMap(([bit, flag]) =>
					(netif.error ?? 0) & bit ? [flag] : [],
				),
				txKbps: kbps(netif.tx_bps),
				rxKbps: kbps(netif.rx_bps),
			};
		});
}

async function bootEndings(
	boots: readonly LogBootInfo[],
	journalBoots: readonly string[],
	events: readonly DeviceEvent[],
	deps: BundleStateDeps,
): Promise<BundleBootEnding[]> {
	const result: BundleBootEnding[] = [];
	for (const bootId of journalBoots) {
		const boot = boots.find((row) => row.bootId === bootId);
		if (!boot) continue;
		const span = {
			bootId,
			current: boot.current,
			firstTs: count(boot.firstTs, Number.MAX_SAFE_INTEGER),
			lastTs: count(boot.lastTs, Number.MAX_SAFE_INTEGER),
		};
		if (boot.current) {
			result.push({ ...span, shutdown: "current", evidence: [] });
			continue;
		}
		// The boot that followed: the nearest later boot that still has a journal.
		const next = boots
			.filter((row) => row.logsAvailable && row.index > boot.index)
			.sort((a, b) => a.index - b.index)[0];
		const ending = await optional(() => deps.classify(boot, next, events), {
			shutdown: "unknown" as const,
			evidence: ["read_failed"],
		});
		result.push({
			...span,
			shutdown: SHUTDOWN.has(ending.shutdown) ? ending.shutdown : "unknown",
			evidence: ending.evidence.filter((code) => EVIDENCE.has(code)),
		});
	}
	return result;
}

/**
 * Drop every value the bundle's redactor would act on: a string that holds a
 * held secret or an identifier pattern, or a number or boolean whose digits
 * hold a secret, becomes `null` (a null is never inspected). Boot ids keep the
 * bundle's own boot-field handling. A key the redactor would act on cannot be
 * renamed, so it drops the whole record (`null`); the bundle then leaves the
 * record out rather than refuse.
 */
export function screenState<T>(value: T, secrets: Secrets): Screened<T> | null {
	let redactor: ReturnType<typeof buildRedactor>;
	try {
		redactor = buildRedactor(secrets);
	} catch {
		return null;
	}
	const clean = (text: string) => {
		try {
			redactor.structured(text);
			return redactor.text(text).redactions === 0;
		} catch {
			return false;
		}
	};
	let keysClean = true;
	const visit = (node: unknown, key?: string): unknown => {
		if (key === "bootId") return node;
		if (typeof node === "string") return clean(node) ? node : null;
		if (typeof node === "number" || typeof node === "boolean")
			return clean(String(node)) ? node : null;
		if (Array.isArray(node)) return node.map((item) => visit(item));
		if (node && typeof node === "object")
			return Object.fromEntries(
				Object.entries(node).map(([name, inner]) => {
					if (!clean(name)) keysClean = false;
					return [name, visit(inner, name)];
				}),
			);
		return node;
	};
	const screened = visit(value) as Screened<T>;
	return keysClean ? screened : null;
}

/**
 * Collect the allowlisted device state. Each source is optional: a failed read
 * leaves its field null or empty rather than refusing the bundle.
 */
export async function collectBundleState(
	{
		boots,
		journalBoots,
		events,
		secrets,
	}: {
		readonly boots: readonly LogBootInfo[];
		readonly journalBoots: readonly string[];
		readonly events: readonly DeviceEvent[];
		readonly secrets: Secrets;
	},
	overrides: Partial<BundleStateDeps> = {},
): Promise<BundleStateRecord | null> {
	const deps = { ...defaultBundleStateDeps, ...overrides };
	const device = await optional(deps.device, false);
	const stats = getDeviceStatsSnapshot();
	const totalBytes = count(stats?.memTotalBytes, Number.MAX_SAFE_INTEGER);
	const availableBytes = count(
		stats?.memAvailableBytes,
		Number.MAX_SAFE_INTEGER,
	);
	const bitrate = getEngineBitrateStatus();
	const [endings, slots, bootAttempts] = await Promise.all([
		bootEndings(boots, journalBoots, events, deps),
		device
			? optional(async () => (await deps.readSlots()).map(slot), null)
			: null,
		device
			? optional(
					async () =>
						parseBootAttempts(
							await deps.readText("/boot/boot_state.txt", 4096),
						),
					null,
				)
			: null,
	]);
	return screenState(
		{
			uptimeSeconds: count(deps.uptimeSeconds(), 10 * 365 * 24 * 3600),
			memory:
				totalBytes === null && availableBytes === null
					? null
					: { totalBytes, availableBytes },
			boots: endings,
			slots,
			bootAttempts,
			modems: modems(),
			interfaces: interfaces(),
			stream: {
				lifecycle: member(LIFECYCLE, getStreamLifecycleState()) ?? OTHER,
				bitrateKbps: count(bitrate?.applied_kbps, 1e6),
				ceilingKbps: count(bitrate?.ceiling_kbps, 1e6),
			},
		},
		secrets,
	);
}
