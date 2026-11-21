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
		{ profiles: Set<string>; active: Map<string, string> }
	>();
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
			const path = `/checkpoint/${++checkpointCounter}`;
			checkpoints.set(path, {
				profiles: new Set(profiles.keys()),
				active: new Map(active),
			});
			return path;
		},
		async live(path) {
			return checkpoints.has(path);
		},
		async destroy(path) {
			guard("destroy");
			if (!checkpoints.delete(path)) throw new Error("expired");
			calls.push("destroy");
		},
		async rollback(path) {
			calls.push("rollback");
			const snapshot = checkpoints.get(path);
			if (!snapshot) throw new Error("expired");
			checkpoints.delete(path);
			// DELETE_NEW_CONNECTIONS, as measured on NM 1.52.1: global.
			for (const uuid of [...profiles.keys()])
				if (!snapshot.profiles.has(uuid)) profiles.delete(uuid);
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
			for (const path of [...checkpoints.keys()]) await nm.rollback(path);
		},
		/** Daemon restart: checkpoints are lost, /run profiles are reloaded. */
		restart() {
			checkpoints.clear();
		},
		/** Reboot: /run is gone; autoconnect brings disk profiles back. */
		reboot() {
			checkpoints.clear();
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
): NetworkChangeSession {
	return { id, openedAt, authenticated: true, ingress };
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
	} = {},
) {
	let now = 1000;
	let boot = "boot-1";
	const fake = createFakeNm();
	const effects = createFakeEffects();
	const journal = createMemoryJournalStore();
	let changes = 0;
	const make = () =>
		createNetworkChangeOwner({
			now: () => now,
			bootId: async () => boot,
			nm: fake.nm,
			effects: effects.registry,
			journal,
			settleMs: options.settleMs ?? 15_000,
			...(options.onSettled ? { onSettled: options.onSettled } : {}),
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
		at(value: number) {
			now = value;
		},
		now: () => now,
		newBoot() {
			boot = `boot-${Math.random()}`;
		},
	};
}
