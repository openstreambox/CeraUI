/**
 * Test doubles for the network-change owner: a small NetworkManager model with
 * the semantics the real-daemon contract measured, and recorded-undo drivers
 * for hotspot teardown and modem radio mode. Nothing here touches a device.
 */
import {
	createEffectRegistry,
	type EffectDriver,
	HOTSPOT_INTERFACE_EFFECT,
	type JsonValue,
	MODEM_RADIO_MODE_EFFECT,
} from "./network-change-effects.ts";
import {
	createMemoryJournalStore,
	type NetworkChangePlan,
} from "./network-change-journal.ts";
import {
	createNetworkChangeOwner,
	type NetworkChangeDeps,
	type NetworkChangeSession,
	type NmChangeDeps,
	sha256Hex,
} from "./network-checkpoint.ts";

export interface FakeProfile {
	id: string;
	autoconnect: boolean;
	settings: Record<string, string>;
	/** "disk" survives a reboot; "memory" (a /run keyfile) survives only a daemon restart. */
	storage: "disk" | "memory";
}

let counter = 0;
function fakeUuid() {
	counter++;
	return `00000000-0000-4000-8000-${counter.toString(16).padStart(12, "0")}`;
}

export function createFakeNm() {
	const profiles = new Map<string, FakeProfile>();
	const active = new Map<string, string>();
	const checkpoints = new Map<
		string,
		{ profiles: Set<string>; active: Map<string, string>; created: string }
	>();
	let createdCounter = 0;
	let generation = 1;
	let busGeneration = 1;
	const owner = () => `:1.${generation}`;
	const bus = () => busGeneration.toString(16).padStart(32, "0");
	const calls: string[] = [];
	const fail = new Set<string>();
	let checkpointCounter = 0;

	function guard(op: string) {
		if (fail.has(op)) throw new Error(`${op} failed`);
	}

	const nm: NmChangeDeps = {
		async create(devices, timeout) {
			guard("create");
			calls.push(`create:${devices.join(",")}:${timeout}`);
			const path = `/org/freedesktop/NetworkManager/Checkpoint/${++checkpointCounter}`;
			const created = String(++createdCounter * 1000);
			checkpoints.set(path, {
				profiles: new Set(profiles.keys()),
				active: new Map(active),
				created,
			});
			return { path, owner: owner(), created, bus: bus() };
		},
		async live(ref) {
			// Like the adapter: an incomplete reference is refused, not "gone".
			if (!ref.bus || !ref.owner || !ref.created)
				throw new Error("Invalid network checkpoint");
			return (
				ref.bus === bus() &&
				ref.owner === owner() &&
				checkpoints.get(ref.path)?.created === ref.created
			);
		},
		async destroy(ref) {
			guard("destroy");
			// Like a call to a unique bus name that no longer exists.
			if (ref.bus !== bus()) throw new Error("another bus instance");
			if (ref.owner !== owner()) throw new Error("unknown bus name");
			if (!checkpoints.delete(ref.path)) throw new Error("expired");
			calls.push("destroy");
		},
		async rollback(ref) {
			if (ref.bus !== bus()) throw new Error("another bus instance");
			if (ref.owner !== owner()) throw new Error("unknown bus name");
			calls.push("rollback");
			const snapshot = checkpoints.get(ref.path);
			if (!snapshot) throw new Error("expired");
			checkpoints.delete(ref.path);
			// Created without DELETE_NEW_CONNECTIONS: profiles added during the
			// window stay (the owner removes its own candidates). Each listed
			// device gets its snapshot's connection back.
			active.clear();
			for (const [device, uuid] of snapshot.active)
				if (profiles.has(uuid)) active.set(device, uuid);
		},
		async describe(uuid) {
			const p = profiles.get(uuid);
			if (!p) throw new Error("unknown profile");
			return { id: p.id, autoconnect: p.autoconnect };
		},
		async cloneCandidate(uuid, name) {
			guard("clone");
			const p = profiles.get(uuid);
			if (!p) throw new Error("unknown profile");
			const clone = fakeUuid();
			profiles.set(clone, {
				...structuredClone(p),
				id: name,
				storage: "memory",
			});
			calls.push(`clone:${p.id}`);
			return clone;
		},
		async modifyInMemory(uuid, set) {
			const p = profiles.get(uuid);
			if (!p) throw new Error("unknown profile");
			for (const [key, value] of set) {
				if (key === "connection.autoconnect") p.autoconnect = value === "yes";
				else p.settings[key] = value;
			}
			p.storage = "memory";
			calls.push(`modify:${p.id}`);
		},
		async activate(uuid, device) {
			guard("activate");
			if (!profiles.has(uuid)) throw new Error("unknown profile");
			active.set(device, uuid);
			calls.push(`activate:${profiles.get(uuid)?.id}@${device}`);
		},
		async activeOn(device) {
			return active.get(device);
		},
		async persist(uuid, id, autoconnect) {
			guard("persist");
			const p = profiles.get(uuid);
			if (!p) throw new Error("unknown profile");
			p.id = id;
			p.autoconnect = autoconnect;
			p.storage = "disk";
			calls.push(`persist:${id}`);
		},
		async remove(uuid) {
			guard("remove");
			if (!profiles.has(uuid)) return;
			calls.push(`remove:${profiles.get(uuid)?.id}`);
			profiles.delete(uuid);
			for (const [device, current] of active)
				if (current === uuid) active.delete(device);
		},
		async exists(uuid) {
			guard("exists");
			return profiles.has(uuid);
		},
		async listByPrefix(prefix) {
			return [...profiles]
				.filter(([, p]) => p.id.startsWith(prefix))
				.map(([uuid]) => uuid);
		},
	};

	return {
		nm,
		profiles,
		active,
		calls,
		fail,
		add(id: string, settings: Record<string, string>, autoconnect = true) {
			const uuid = fakeUuid();
			profiles.set(uuid, { id, autoconnect, settings, storage: "disk" });
			return uuid;
		},
		/** The daemon's timer fired: it rolls the checkpoint back by itself. */
		async expireAll() {
			for (const [path, { created }] of [...checkpoints])
				await nm.rollback({ path, owner: owner(), created, bus: bus() });
		},
		/**
		 * Daemon restart: checkpoints are lost, /run profiles are reloaded, and
		 * the daemon gets a new unique bus name.
		 */
		restart() {
			checkpoints.clear();
			generation++;
		},
		/**
		 * The system bus restarted and NetworkManager came back with the same
		 * unique name (a fresh bus may hand names out again).
		 */
		restartBusReusingName() {
			checkpoints.clear();
			busGeneration++;
		},
		/**
		 * After a daemon restart, someone else creates a checkpoint that gets a
		 * path the owner already journaled (NetworkManager numbers from 1 again).
		 */
		foreignCheckpointAt(path: string) {
			checkpoints.set(path, {
				profiles: new Set(profiles.keys()),
				active: new Map(active),
				created: String(++createdCounter * 1000 + 7),
			});
		},
		hasCheckpoint(path: string) {
			return checkpoints.has(path);
		},
		/** Reboot: /run is gone; autoconnect brings disk profiles back. */
		reboot() {
			checkpoints.clear();
			generation++;
			for (const [uuid, p] of [...profiles])
				if (p.storage === "memory") profiles.delete(uuid);
			for (const [device, uuid] of [...active])
				if (!profiles.has(uuid)) active.delete(device);
		},
		byId(id: string) {
			return [...profiles].filter(([, p]) => p.id === id);
		},
	};
}

export function createFakeEffects() {
	const interfaces = new Set<string>(["ap0"]);
	const radio = new Map<string, string>([["modem0", "4g|5g"]]);
	const log: string[] = [];
	const failUndo = new Set<string>();
	const hotspot: EffectDriver = {
		kind: HOTSPOT_INTERFACE_EFFECT,
		async prepare(spec) {
			const ifname = (spec as { ifname: string }).ifname;
			return { ifname, existed: interfaces.has(ifname) };
		},
		async apply(spec) {
			const ifname = (spec as { ifname: string }).ifname;
			interfaces.delete(ifname);
			log.push(`teardown:${ifname}`);
		},
		async undo(recorded) {
			if (failUndo.has("hotspot")) throw new Error("interface busy");
			const { ifname, existed } = recorded as {
				ifname: string;
				existed: boolean;
			};
			if (existed && !interfaces.has(ifname)) interfaces.add(ifname);
			log.push(`restore:${ifname}`);
		},
	};
	const modem: EffectDriver = {
		kind: MODEM_RADIO_MODE_EFFECT,
		async prepare(spec) {
			const id = (spec as { modem: string }).modem;
			return { modem: id, mode: radio.get(id) ?? null } as JsonValue;
		},
		async apply(spec) {
			const { modem: id, mode } = spec as { modem: string; mode: string };
			radio.set(id, mode);
			log.push(`mode:${id}=${mode}`);
		},
		async undo(recorded) {
			const { modem: id, mode } = recorded as { modem: string; mode: string };
			radio.set(id, mode);
			log.push(`mode-undo:${id}=${mode}`);
		},
	};
	return {
		registry: createEffectRegistry([hotspot, modem]),
		interfaces,
		radio,
		log,
		failUndo,
	};
}

export function session(
	id: string,
	ingress: string | undefined,
	openedAt = 0,
	route?: NetworkChangeSession["route"],
): NetworkChangeSession {
	return {
		id,
		openedAt,
		authenticated: true,
		ingress,
		...(route ? { route } : {}),
	};
}

/** sha256 of the fake auth token "token-a" and "token-b". */
export const TOKEN_A = sha256Hex("token-a");
export const TOKEN_B = sha256Hex("token-b");
export const ORIGIN = "https://box.example.ts.net";
export const HOST = "box.example.ts.net";
/** A valid one-time code (43 base64url characters) and another one. */
export const CODE = `${"A".repeat(42)}Q`;
export const OTHER_CODE = `${"B".repeat(42)}Q`;

/**
 * A signed-in browser socket: the login (token hash) and the UI address it
 * reached the box at. The harness's boot clock equals its wall clock, so
 * `openedAt` is also the socket's boot-clock stamp unless given.
 */
export function browser(
	id: string,
	options: {
		readonly ingress?: string | undefined;
		readonly openedAt?: number;
		readonly openedClock?: number;
		readonly tokenHash?: string;
		readonly origin?: string;
		readonly host?: string;
		readonly route?: NetworkChangeSession["route"];
	} = {},
): NetworkChangeSession {
	const openedAt = options.openedAt ?? 0;
	return {
		id,
		openedAt,
		authenticated: true,
		ingress: options.ingress,
		tokenHash: options.tokenHash ?? TOKEN_A,
		origin: options.origin ?? ORIGIN,
		host: options.host ?? HOST,
		openedClock: options.openedClock ?? openedAt,
		...(options.route ? { route: options.route } : {}),
	};
}

export function plan(
	partial: Partial<NetworkChangePlan> = {},
): NetworkChangePlan {
	return {
		summary: { key: "network.changeSafety.notice.make" },
		devices: [],
		profiles: [],
		effects: [],
		...partial,
	};
}

export function harness(
	options: {
		settleMs?: number;
		onSettled?: NetworkChangeDeps["onSettled"];
		isStreaming?: NetworkChangeDeps["isStreaming"];
		/** A boot clock apart from the wall clock (default: the same value). */
		separateClock?: boolean;
		/** The boot clock can't be read (until `clockReadable(true)`). */
		clockUnavailable?: boolean;
	} = {},
) {
	let now = 1000;
	let clock = 1000;
	let readable = options.clockUnavailable !== true;
	let boot = "boot-1";
	const fake = createFakeNm();
	const effects = createFakeEffects();
	const journal = createMemoryJournalStore();
	let changes = 0;
	const logs: string[] = [];
	const make = () =>
		createNetworkChangeOwner({
			now: () => now,
			...(options.separateClock || options.clockUnavailable
				? { clock: () => (readable ? clock : undefined) }
				: {}),
			bootId: async () => boot,
			nm: fake.nm,
			effects: effects.registry,
			journal,
			settleMs: options.settleMs ?? 15_000,
			...(options.onSettled ? { onSettled: options.onSettled } : {}),
			...(options.isStreaming ? { isStreaming: options.isStreaming } : {}),
			log: (message) => {
				logs.push(message);
			},
			onChange: () => {
				changes++;
			},
		});
	return {
		fake,
		effects,
		journal,
		owner: make(),
		/** A new backend process reading the same journal. */
		restartBackend() {
			return make();
		},
		changes: () => changes,
		logs,
		/** Move the wall clock (and a separate boot clock by the same amount). */
		at(value: number) {
			clock += value - now;
			now = value;
		},
		/** Step the wall clock only, like NTP: the boot clock keeps going. */
		stepWall(value: number) {
			now = value;
		},
		clock: () => clock,
		clockReadable(value: boolean) {
			readable = value;
		},
		now: () => now,
		newBoot() {
			boot = `boot-${Math.random()}`;
		},
	};
}
