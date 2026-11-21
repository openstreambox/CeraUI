import { uptime } from "node:os";
import type {
	DeviceEvent,
	LifecycleState,
	LogBootInfo,
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

/**
 * The support bundle's `state` record: what the device looks like at export
 * time, built field by field from closed vocabularies, bounded numbers and
 * validated version strings. Nothing is copied from a source object wholesale,
 * so subscriber, SIM and device identifiers, phone numbers, operator and
 * network names, addresses and credentials have no field to arrive in.
 */
export interface BundleDeviceState {
	readonly uptimeSeconds: number | null;
	readonly memory: {
		readonly totalBytes: number;
		readonly availableBytes: number;
	} | null;
	readonly boots: readonly BundleBootEnding[];
	readonly slots: readonly BundleSlot[] | null;
	readonly bootAttempts: {
		readonly order: readonly string[];
		readonly left: Readonly<Record<string, number>>;
	} | null;
	readonly packages: ReadonlyArray<{
		readonly name: string;
		readonly version: string;
	}>;
	readonly modems: readonly BundleModem[];
	readonly interfaces: readonly BundleInterface[];
	readonly stream: {
		readonly lifecycle: LifecycleState;
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
	readonly name: string;
	readonly bootname: string | null;
	readonly state: string;
	readonly bootStatus: string | null;
	readonly version: string | null;
}

interface BundleModem {
	readonly modem: number;
	readonly manufacturer: string | null;
	readonly model: string | null;
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
	readonly name: string;
	readonly usb: boolean;
	readonly bonded: boolean;
	readonly ipv4: boolean;
	readonly flags: readonly string[];
	readonly txKbps: number | null;
	readonly rxKbps: number | null;
}

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

/** First-party and modem/network stack packages whose versions support asks for. */
const PACKAGE_PREFIXES = [
	"ceralive",
	"cerastream",
	"srtla",
	"linux-image-",
	"modemmanager",
	"network-manager",
	"rauc",
	"libqmi-glib",
	"libmbim-glib",
];
const MAX_PACKAGES = 32;
const MAX_MODEMS = 16;
const MAX_INTERFACES = 32;
const UNKNOWN = "[value]";

const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+~:_-]{0,63}$/;
const PACKAGE = /^[a-z0-9][a-z0-9+.-]{1,63}$/;
const WORD = /^[a-z0-9][a-z0-9_-]{0,23}$/;
// Product names, not device names: letters, digits and the punctuation vendors use.
const PRODUCT = /^[A-Za-z][A-Za-z0-9 ._+/-]{0,39}$/;
// Kernel interface names; MAC-derived names (enx0a1b…) and anything longer are masked.
const IFNAME = /^[a-z][a-z0-9_.-]{0,14}$/;

function token(value: unknown, pattern: RegExp): string | null {
	if (typeof value !== "string" || value === "") return null;
	return pattern.test(value) ? value : UNKNOWN;
}

/** A product string survives only without a long digit run (serials, IMEIs). */
function product(value: unknown): string | null {
	const text = token(value, PRODUCT);
	return text !== null && /\d{6}/.test(text) ? UNKNOWN : text;
}

function interfaceName(value: string): string {
	return IFNAME.test(value) && !/[0-9a-f]{8}/.test(value)
		? value
		: "[interface]";
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

export function parseBootAttempts(
	text: string,
): BundleDeviceState["bootAttempts"] {
	let order: string[] | undefined;
	const left: Record<string, number> = {};
	for (const line of text.split("\n")) {
		const match = /^(BOOT_ORDER|BOOT_([AB])_LEFT)=(.*)$/.exec(line.trim());
		if (!match) continue;
		const [, key, slot, value = ""] = match;
		if (key === "BOOT_ORDER") {
			const slots = value.trim().split(/\s+/).filter(Boolean);
			if (slots.every((name) => name === "A" || name === "B"))
				order = slots.slice(0, 2);
		} else if (slot && /^\d{1,2}$/.test(value.trim()))
			left[slot] = Number(value.trim());
	}
	return order === undefined ? null : { order, left };
}

export function parseInstalledPackages(
	text: string,
): BundleDeviceState["packages"] {
	const found: Array<{ name: string; version: string }> = [];
	for (const stanza of text.split(/\n\s*\n/)) {
		const fields = new Map<string, string>();
		for (const line of stanza.split("\n")) {
			const match = /^(Package|Status|Version): (.*)$/.exec(line);
			if (match?.[1] && match[2] !== undefined)
				fields.set(match[1], match[2].trim());
		}
		const name = fields.get("Package");
		if (
			!name ||
			!PACKAGE.test(name) ||
			fields.get("Status") !== "install ok installed" ||
			!PACKAGE_PREFIXES.some((prefix) => name.startsWith(prefix))
		)
			continue;
		found.push({ name, version: token(fields.get("Version"), VERSION) ?? "" });
	}
	return found
		.sort((a, b) => a.name.localeCompare(b.name))
		.slice(0, MAX_PACKAGES);
}

function slot(status: RootSlotStatus): BundleSlot {
	return {
		name: token(status.name, /^[a-z0-9._-]{1,24}$/) ?? UNKNOWN,
		bootname: token(status.bootname, /^[A-Za-z0-9_-]{1,8}$/),
		state: token(status.state, WORD) ?? UNKNOWN,
		bootStatus: token(status.bootStatus, WORD),
		version: token(status.version, VERSION),
	};
}

function modems(): BundleModem[] {
	return Object.values(getModems())
		.filter((modem) => !modem.removed)
		.slice(0, MAX_MODEMS)
		.map((modem, index) => ({
			modem: index + 1,
			manufacturer: product(modem.manufacturer),
			model: product(modem.model),
			connection: token(modem.status?.connection, WORD) ?? "unknown",
			mode: token(modem.network_type?.active, WORD),
			accessTechnology: token(modem.status?.network_type, WORD),
			signal: count(modem.status?.signal, 100),
			roaming:
				typeof modem.status?.roaming === "boolean"
					? modem.status.roaming
					: null,
			sim: token(modem.sim_presence, WORD) ?? "unknown",
			simLock: token(modem.sim_lock?.required, WORD),
			apnConfigured: Boolean(modem.config?.apn),
			dataConnectionFailed: modem.data_connection_failed === true,
		}));
}

const NETIF_FLAGS: ReadonlyArray<readonly [number, string]> = [
	[NETIF_ERR_DUPIPV4, "duplicate_ipv4"],
	[NETIF_ERR_HOTSPOT, "hotspot"],
	[NETIF_ERR_NOSIM, "no_sim"],
	[NETIF_ERR_SHAREDLAN, "shared_lan"],
];

function interfaces(): BundleInterface[] {
	return Object.entries(getNetworkInterfaces())
		.sort(([a], [b]) => a.localeCompare(b))
		.slice(0, MAX_INTERFACES)
		.map(([name, netif]) => ({
			name: interfaceName(name),
			usb: netif.usb === true,
			bonded: netif.enabled === true,
			ipv4: Boolean(netif.ip),
			flags: NETIF_FLAGS.flatMap(([bit, flag]) =>
				(netif.error ?? 0) & bit ? [flag] : [],
			),
			txKbps: kbps(netif.tx_bps),
			rxKbps: kbps(netif.rx_bps),
		}));
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
			shutdown: ending.shutdown,
			evidence: ending.evidence.filter((code) => WORD.test(code)),
		});
	}
	return result;
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
	}: {
		readonly boots: readonly LogBootInfo[];
		readonly journalBoots: readonly string[];
		readonly events: readonly DeviceEvent[];
	},
	overrides: Partial<BundleStateDeps> = {},
): Promise<BundleDeviceState> {
	const deps = { ...defaultBundleStateDeps, ...overrides };
	const device = await optional(deps.device, false);
	const stats = getDeviceStatsSnapshot();
	const memory =
		count(stats?.memTotalBytes, Number.MAX_SAFE_INTEGER) !== null &&
		count(stats?.memAvailableBytes, Number.MAX_SAFE_INTEGER) !== null
			? {
					totalBytes: Math.round(stats?.memTotalBytes ?? 0),
					availableBytes: Math.round(stats?.memAvailableBytes ?? 0),
				}
			: null;
	const bitrate = getEngineBitrateStatus();
	const [endings, slots, bootAttempts, packages] = await Promise.all([
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
		device
			? optional(
					async () =>
						parseInstalledPackages(
							await deps.readText("/var/lib/dpkg/status", 32 * 1024 * 1024),
						),
					[],
				)
			: [],
	]);
	return {
		uptimeSeconds: count(deps.uptimeSeconds(), 10 * 365 * 24 * 3600),
		memory,
		boots: endings,
		slots,
		bootAttempts,
		packages,
		modems: modems(),
		interfaces: interfaces(),
		stream: {
			lifecycle: getStreamLifecycleState(),
			bitrateKbps: count(bitrate?.applied_kbps, 1e6),
			ceilingKbps: count(bitrate?.ceiling_kbps, 1e6),
		},
	};
}
