/**
 * The Ethernet port role — `uplink` (today's behaviour) vs `shared-lan`.
 *
 * The suite drives the REAL `processIfconfigOutput`, the REAL `genSrtlaBondEntries`
 * and the REAL `configureNetworkInterfaceProcedure`, because every defect here
 * lives in the WIRING: a test aimed at a pure predicate passes on a tree where
 * nothing ever stamps the flag, and a test aimed at `handleNetif` alone passes on
 * a tree where the procedure discards its answer.
 */
import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	mock,
	spyOn,
	test,
} from "bun:test";
import { readFileSync } from "node:fs";

import { call } from "@orpc/server";
import { runtimeConfigSchema } from "../helpers/config-schemas.ts";

import {
	getConfig,
	getConfigFilePath,
	setConfigFilePath,
} from "../modules/config.ts";
import {
	eligibleProbeCandidates,
	probeExclusionReason,
} from "../modules/network/connectivity-candidates.ts";
import {
	ETHERNET_ROLE_DEFAULT,
	getEthernetRole,
	getSharedEthernetProfile,
	isEthernetRoleCandidate,
	isSharedLanPort,
	persistEthernetRole,
	reserveSharedEthernetProfile,
	restoreEthernetRole,
} from "../modules/network/ethernet-role.ts";
import {
	type EthernetRoleTransitionDeps,
	reconcileEthernetRoles,
	setEthernetRole,
} from "../modules/network/ethernet-role-transition.ts";
import {
	applySharedLanBondGate,
	getNetifErrorMsg,
	getNetworkInterfaces,
	isBondCandidate,
	NETIF_ERR_SHAREDLAN,
	type NetworkInterface,
	netIfBuildMsg,
	processIfconfigOutput,
	resetBondOptOut,
	setNetifDupIpSuppression,
	setQueueUpdateGwHook,
} from "../modules/network/network-interfaces.ts";
import { createEthernetNm } from "../modules/network/network-manager.ts";
import { setNetifState } from "../modules/network/state/netif-state.ts";
import { genSrtlaBondEntries } from "../modules/streaming/srtla.ts";
import { configureNetworkInterfaceProcedure } from "../rpc/procedures/network.procedure.ts";
import type { AppWebSocket, RPCContext } from "../rpc/types.ts";

const SHARED_PORT = "eth1";
const UPLINK_PORT = "eth0";
const UPLINK_IP = "192.168.78.132";
const SHARED_IP = "10.42.0.1";
const OWNED_UUID = "00000000-0000-4000-8000-000000000001";
const OTHER_UUID = "00000000-0000-4000-8000-000000000002";
const FOREIGN_UUID = "00000000-0000-4000-8000-000000000003";
const LETTER_UUID = "abcdefab-cdef-4abc-8def-abcdefabcdef";

function ifconfigStanza(name: string, ip: string, mac: string): string {
	return [
		`${name}: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500`,
		`        inet ${ip}  netmask 255.255.255.0  broadcast ${ip.replace(/\.\d+$/, ".255")}`,
		`        ether ${mac}  txqueuelen 1000  (Ethernet)`,
		"        RX packets 200  bytes 20000 (20.0 KB)",
		"        TX packets 100  bytes 1000 (1.0 KB)",
	].join("\n");
}

function twoPortTopology(): string {
	return [
		ifconfigStanza(UPLINK_PORT, UPLINK_IP, "aa:bb:cc:dd:ee:01"),
		ifconfigStanza(SHARED_PORT, SHARED_IP, "aa:bb:cc:dd:ee:02"),
	].join("\n\n");
}

function iface(over: Partial<NetworkInterface> = {}): NetworkInterface {
	return {
		ip: SHARED_IP,
		netmask: "255.255.255.0",
		txb: 0,
		rxb: 0,
		tp: 0,
		enabled: true,
		error: 0,
		...over,
	} as NetworkInterface;
}

function makeContext(): RPCContext {
	const ws = {
		send: () => {},
		data: { isAuthenticated: true, lastActive: Date.now() },
	} as unknown as AppWebSocket;
	return {
		ws,
		isAuthenticated: () => true,
		authenticate: () => {},
		deauthenticate: () => {},
		markActive: () => {},
		getLastActive: () => 0,
		setSenderId: () => {},
		getSenderId: () => undefined,
		clearSenderId: () => {},
	};
}

/**
 * A transition harness whose NM surface is fully injected, so the persist /
 * rollback / frame ordering is provable with no nmcli on the host.
 */
function makeDeps(
	over: Partial<EthernetRoleTransitionDeps> = {},
): EthernetRoleTransitionDeps & {
	frames: Array<{ name: string; outcome: unknown }>;
	writes: Array<{ uuid: string; fields: Record<string, string> }>;
} {
	const frames: Array<{ name: string; outcome: unknown }> = [];
	const writes: Array<{ uuid: string; fields: Record<string, string> }> = [];
	return {
		frames,
		writes,
		listInterfaces: () => getNetworkInterfaces(),
		resolveConnection: async () => ({ kind: "active", uuid: "uuid-eth1" }),
		readProfile: async () => ({ kind: "present" }),
		addConnection: async () => true,
		readOwnedProfile: getSharedEthernetProfile,
		reserveProfile: reserveSharedEthernetProfile,
		newUuid: () => OWNED_UUID,
		setFields: async (uuid, fields) => {
			writes.push({ uuid, fields });
			return true;
		},
		activate: async () => true,
		persistRole: persistEthernetRole,
		restoreRole: restoreEthernetRole,
		readPersistedRole: (ifname) => getConfig().eth_roles?.[ifname],
		publishOutcome: (name, outcome) => {
			frames.push({ name, outcome });
		},
		refreshInterfaces: () => {
			applySharedLanBondGate(getNetworkInterfaces());
		},
		...over,
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

/** The actual NM adapter/argv/parser runs; only its bounded command runner is injected. */
function freshPort(
	database = {
		profiles: new Map<string, { ifname: string; type: string }>(),
		active: new Map<string, string>(),
	},
) {
	const controls: {
		loseAddReply: boolean;
		beforeAdd?: (ifname: string) => Promise<void>;
	} = { loseAddReply: false };
	const runner = mock(async (bin: string, args: string[]) => {
		expect(bin).toBe("nmcli");
		if (args[0] === "connection") {
			const ifname = args[5] ?? "";
			const uuid = args[9] ?? "";
			expect(args).toEqual([
				"connection",
				"add",
				"type",
				"ethernet",
				"ifname",
				ifname,
				"con-name",
				`Shared LAN ${ifname}`,
				"connection.uuid",
				uuid,
				"connection.autoconnect",
				"no",
				"ipv4.method",
				"shared",
			]);
			// The real temp-config write must precede the actual typed add argv.
			const saved = JSON.parse(readFileSync(TEST_CONFIG_FILE, "utf8"));
			expect(saved.eth_shared_profiles[ifname]).toBe(uuid);
			await controls.beforeAdd?.(ifname);
			expect(database.profiles.has(uuid)).toBe(false);
			database.profiles.set(uuid, { ifname, type: "802-3-ethernet" });
			if (controls.loseAddReply) throw new Error("lost add reply");
			return `Connection 'Shared LAN ${ifname}' (${uuid}) successfully added.\n`;
		}
		expect(args.slice(0, 4)).toEqual([
			"--terse",
			"--escape",
			"no",
			"--get-values",
		]);
		if (args[4] === "GENERAL.CON-UUID") {
			expect(args.slice(5, 7)).toEqual(["device", "show"]);
			return `${database.active.get(args[7] ?? "") ?? ""}\n`;
		}
		if (args[4] === "UUID") {
			expect(args.slice(5)).toEqual(["connection", "show"]);
			return [...database.profiles.keys()].join("\n");
		}
		expect(args[4]).toBe(
			"connection.uuid,connection.type,connection.interface-name",
		);
		expect(args.slice(5, 7)).toEqual(["connection", "show"]);
		const uuid = args[7] ?? "";
		const profile = database.profiles.get(uuid);
		if (!profile) throw new Error("profile disappeared");
		return `${uuid}\n${profile.type}\n${profile.ifname}\n`;
	});
	const adapter = createEthernetNm(runner);
	const activate = mock(async (uuid: string) => {
		const profile = database.profiles.get(uuid);
		if (!profile) return false;
		database.active.set(profile.ifname, uuid);
		return true;
	});
	const newUuid = mock(() => OWNED_UUID);
	const deps = makeDeps({
		resolveConnection: adapter.active,
		readProfile: adapter.profile,
		addConnection: adapter.addShared,
		activate,
		newUuid,
	});
	return {
		deps,
		database,
		controls,
		runner,
		adapter,
		activate,
		newUuid,
		adds: () =>
			runner.mock.calls.filter(([, args]) => args[0] === "connection"),
	};
}

const TEST_CONFIG_FILE = `${process.env.TMPDIR ?? "/tmp"}/ceraui-eth-role-${process.pid}.json`;

const nativeCall = mock(() => {
	throw new Error("native command forbidden in Ethernet tests");
});
const nativeGuards = [
	spyOn(Bun, "spawn").mockImplementation(nativeCall),
	spyOn(Bun, "spawnSync").mockImplementation(nativeCall),
];
let previousConfigFile = "";

beforeEach(() => {
	// `persistEthernetRole` performs a REAL synchronous write, so the repo's own
	// config.json is what it hits without this redirect.
	previousConfigFile = getConfigFilePath();
	setConfigFilePath(TEST_CONFIG_FILE);
	const config = getConfig();
	config.eth_roles = {};
	config.eth_shared_profiles = undefined;

	const netif = getNetworkInterfaces();
	for (const name of Object.keys(netif)) delete netif[name];
	setNetifState({});
	for (const name of [UPLINK_PORT, SHARED_PORT]) {
		setNetifDupIpSuppression(name, false);
	}
	resetBondOptOut();
	setQueueUpdateGwHook(null);
});

afterEach(() => {
	expect(nativeCall).not.toHaveBeenCalled();
	getConfig().eth_roles = {};
	getConfig().eth_shared_profiles = undefined;
	setConfigFilePath(previousConfigFile);
});

afterAll(async () => {
	for (const guard of nativeGuards) guard.mockRestore();
	await Bun.file(TEST_CONFIG_FILE)
		.delete()
		.catch(() => {});
});

describe("the persisted role defaults to uplink", () => {
	test("an untouched port reads `uplink` and is not shared", () => {
		expect(getEthernetRole(UPLINK_PORT)).toBe(ETHERNET_ROLE_DEFAULT);
		expect(ETHERNET_ROLE_DEFAULT).toBe("uplink");
		expect(isSharedLanPort(UPLINK_PORT)).toBe(false);
	});

	test("only wired ports may be given a role", () => {
		for (const name of ["eth0", "eth1", "enx0c5b8f279a64", "enp3s0"]) {
			expect(isEthernetRoleCandidate(name)).toBe(true);
		}
		for (const name of ["wlan0", "usb0", "wwan0", "lo", "clap-wlan0"]) {
			expect(isEthernetRoleCandidate(name)).toBe(false);
		}
	});

	test("restoring `undefined` DELETES the key rather than writing the default", () => {
		persistEthernetRole(SHARED_PORT, "shared-lan");
		expect(getConfig().eth_roles?.[SHARED_PORT]).toBe("shared-lan");

		restoreEthernetRole(SHARED_PORT, undefined);

		expect(getConfig().eth_roles).not.toHaveProperty(SHARED_PORT);
		expect(getEthernetRole(SHARED_PORT)).toBe("uplink");
	});
});

describe("a shared-lan port leaves every candidate set", () => {
	test("the flip stamps 0x08 and drops the port from bond AND connectivity", () => {
		processIfconfigOutput(twoPortTopology());
		// Non-vacuity: both ports bond before the flip.
		expect(
			genSrtlaBondEntries()
				.map((e) => e.ip)
				.sort(),
		).toEqual([SHARED_IP, UPLINK_IP]);

		persistEthernetRole(SHARED_PORT, "shared-lan");
		processIfconfigOutput(twoPortTopology());

		const entry = getNetworkInterfaces()[SHARED_PORT];
		expect((entry?.error ?? 0) & NETIF_ERR_SHAREDLAN).toBe(NETIF_ERR_SHAREDLAN);
		expect(entry?.enabled).toBe(false);

		// The flag is what the wire, the probe rules and the grouping pass all
		// already read, so each inherits the exclusion.
		expect(getNetifErrorMsg(entry as NetworkInterface)).toBe("shared LAN");
		expect(netIfBuildMsg()[SHARED_PORT]?.error).toBe("shared LAN");
		expect(probeExclusionReason(entry)).toBe("shared LAN");
		expect(
			eligibleProbeCandidates(getNetworkInterfaces()).map((c) => c.name),
		).toEqual([UPLINK_PORT]);

		// SRTLA regression: the shared port's address never reaches the bond list.
		const bonded = genSrtlaBondEntries();
		expect(bonded.map((e) => e.ip)).toEqual([UPLINK_IP]);
		expect(bonded.map((e) => e.iface)).not.toContain(SHARED_PORT);
	});

	test("`isBondCandidate` refuses it structurally, even error-free", () => {
		persistEthernetRole(SHARED_PORT, "shared-lan");

		expect(isBondCandidate(SHARED_PORT, iface())).toBe(false);
		// Non-vacuity: the identical entry on an uplink port IS a candidate.
		expect(isBondCandidate(UPLINK_PORT, iface())).toBe(true);
	});

	test("the gate re-applies on a pass where NOTHING about the topology moved", () => {
		persistEthernetRole(SHARED_PORT, "shared-lan");
		processIfconfigOutput(twoPortTopology());

		const entry = getNetworkInterfaces()[SHARED_PORT] as NetworkInterface;
		entry.error = 0;
		entry.enabled = true;

		processIfconfigOutput(twoPortTopology());

		expect(
			(getNetworkInterfaces()[SHARED_PORT]?.error ?? 0) & NETIF_ERR_SHAREDLAN,
		).toBe(NETIF_ERR_SHAREDLAN);
		expect(genSrtlaBondEntries().map((e) => e.ip)).toEqual([UPLINK_IP]);
	});

	test("the uplink port beside it is untouched", () => {
		persistEthernetRole(SHARED_PORT, "shared-lan");
		processIfconfigOutput(twoPortTopology());

		const uplink = getNetworkInterfaces()[UPLINK_PORT];
		expect(uplink?.error).toBe(0);
		expect(uplink?.enabled).toBe(true);
		expect(netIfBuildMsg()[UPLINK_PORT]?.ethRole).toBe("uplink");
	});
});

describe("flipping back to uplink restores candidacy", () => {
	test("the flag clears AND the port bonds again", () => {
		persistEthernetRole(SHARED_PORT, "shared-lan");
		processIfconfigOutput(twoPortTopology());
		expect(genSrtlaBondEntries().map((e) => e.ip)).toEqual([UPLINK_IP]);

		persistEthernetRole(SHARED_PORT, "uplink");
		processIfconfigOutput(twoPortTopology());

		const entry = getNetworkInterfaces()[SHARED_PORT];
		expect((entry?.error ?? 0) & NETIF_ERR_SHAREDLAN).toBe(0);
		expect(entry?.enabled).toBe(true);
		expect(getNetifErrorMsg(entry as NetworkInterface)).toBeUndefined();
		expect(
			genSrtlaBondEntries()
				.map((e) => e.ip)
				.sort(),
		).toEqual([SHARED_IP, UPLINK_IP]);
		expect(
			eligibleProbeCandidates(getNetworkInterfaces())
				.map((c) => c.name)
				.sort(),
		).toEqual([UPLINK_PORT, SHARED_PORT].sort());
	});

	test("releasing the flag honours a separate operator bond opt-out", () => {
		const interfaces: Record<string, NetworkInterface> = {
			[SHARED_PORT]: iface({ error: NETIF_ERR_SHAREDLAN, enabled: false }),
		};

		applySharedLanBondGate(interfaces, () => false);

		expect(interfaces[SHARED_PORT]?.error).toBe(0);
		expect(interfaces[SHARED_PORT]?.enabled).toBe(true);
	});

	test("a port carrying ANOTHER error stays down when the role is released", () => {
		const interfaces: Record<string, NetworkInterface> = {
			[SHARED_PORT]: iface({
				error: NETIF_ERR_SHAREDLAN | 0x01,
				enabled: false,
			}),
		};

		applySharedLanBondGate(interfaces, () => false);

		expect(interfaces[SHARED_PORT]?.error).toBe(0x01);
		expect(interfaces[SHARED_PORT]?.enabled).toBe(false);
	});
});

describe("the role transition", () => {
	test("manual Shared LAN provisions a RUNNING addressless port without an active profile", async () => {
		const addressless = ifconfigStanza(
			SHARED_PORT,
			SHARED_IP,
			"aa:bb:cc:dd:ee:02",
		)
			.split("\n")
			.filter((line) => !line.includes("inet "))
			.join("\n");
		processIfconfigOutput(
			[
				ifconfigStanza(UPLINK_PORT, UPLINK_IP, "aa:bb:cc:dd:ee:01"),
				addressless,
			].join("\n\n"),
		);
		expect(netIfBuildMsg()[SHARED_PORT]).toBeDefined();
		expect(netIfBuildMsg()[SHARED_PORT]?.ip).toBeUndefined();
		const fresh = freshPort();
		const deps = fresh.deps;

		expect(await setEthernetRole(SHARED_PORT, "shared-lan", deps)).toEqual({
			success: true,
			applied: "shared-lan",
		});
		expect(fresh.adds()).toHaveLength(1);
	});

	test("persisted Shared LAN without a current profile cannot bypass provisioning", async () => {
		processIfconfigOutput(twoPortTopology());
		persistEthernetRole(SHARED_PORT, "shared-lan");
		const fresh = freshPort();
		const deps = fresh.deps;

		expect(await setEthernetRole(SHARED_PORT, "shared-lan", deps)).toEqual({
			success: true,
			applied: "shared-lan",
		});
		expect(fresh.adds()).toHaveLength(1);
	});

	test("persists, writes `ipv4.method shared`, and emits pending then terminal", async () => {
		processIfconfigOutput(twoPortTopology());
		const deps = makeDeps();

		const result = await setEthernetRole(SHARED_PORT, "shared-lan", deps);

		expect(result).toEqual({ success: true, applied: "shared-lan" });
		expect(deps.writes).toEqual([
			{ uuid: "uuid-eth1", fields: { "ipv4.method": "shared" } },
		]);
		expect(deps.frames.map((f) => f.outcome)).toEqual([
			{ pending: true, role: "shared-lan" },
			{ success: true, role: "shared-lan" },
		]);
		expect(getEthernetRole(SHARED_PORT)).toBe("shared-lan");
	});

	test("flipping back writes `ipv4.method auto`", async () => {
		processIfconfigOutput(twoPortTopology());
		persistEthernetRole(SHARED_PORT, "shared-lan");
		const deps = makeDeps();

		await setEthernetRole(SHARED_PORT, "uplink", deps);

		expect(deps.writes).toEqual([
			{ uuid: "uuid-eth1", fields: { "ipv4.method": "auto" } },
		]);
		expect(getEthernetRole(SHARED_PORT)).toBe("uplink");
	});

	test("a NON-ethernet interface is refused before anything is written", async () => {
		processIfconfigOutput(twoPortTopology());
		const deps = makeDeps();

		const result = await setEthernetRole("wlan0", "shared-lan", deps);

		expect(result).toEqual({ success: false, error: "not_ethernet" });
		expect(deps.writes).toEqual([]);
		expect(getConfig().eth_roles).toEqual({});
	});

	test("an absent interface is refused before anything is written", async () => {
		const deps = makeDeps();

		const result = await setEthernetRole(SHARED_PORT, "shared-lan", deps);

		expect(result).toEqual({ success: false, error: "unknown_interface" });
		expect(deps.writes).toEqual([]);
	});

	test("an unavailable active-profile read is refused without provisioning", async () => {
		processIfconfigOutput(twoPortTopology());
		const deps = makeDeps({
			resolveConnection: async () => ({ kind: "unavailable" }),
		});

		const result = await setEthernetRole(SHARED_PORT, "shared-lan", deps);

		expect(result).toEqual({ success: false, error: "no_connection" });
		expect(getConfig().eth_roles).not.toHaveProperty(SHARED_PORT);
	});

	test("a persisted Shared LAN choice is reasserted through NetworkManager", async () => {
		processIfconfigOutput(twoPortTopology());
		persistEthernetRole(SHARED_PORT, "shared-lan");
		const deps = makeDeps();

		const result = await setEthernetRole(SHARED_PORT, "shared-lan", deps);

		expect(result).toEqual({ success: true, applied: "shared-lan" });
		expect(deps.writes).toEqual([
			{ uuid: "uuid-eth1", fields: { "ipv4.method": "shared" } },
		]);
		expect(deps.frames.map((f) => f.outcome)).toEqual([
			{ pending: true, role: "shared-lan" },
			{ success: true, role: "shared-lan" },
		]);
	});
});

describe("an NM failure restores role intent and bond flags", () => {
	test("the role reverts, a typed failure frame lands, and the netif flags are unchanged", async () => {
		processIfconfigOutput(twoPortTopology());
		const before = { ...getNetworkInterfaces()[SHARED_PORT] };

		const deps = makeDeps({ setFields: async () => false });
		const result = await setEthernetRole(SHARED_PORT, "shared-lan", deps);

		expect(result).toEqual({ success: false, error: "apply_failed" });
		expect(getConfig().eth_roles).not.toHaveProperty(SHARED_PORT);
		expect(getEthernetRole(SHARED_PORT)).toBe("uplink");

		expect(deps.frames.map((f) => f.outcome)).toEqual([
			{ pending: true, role: "shared-lan" },
			{ success: false, error: "apply_failed" },
		]);

		// The netif flags never moved: the gate reads the (restored) role, so a
		// refused flip cannot leave the port excluded from the bond.
		const after = getNetworkInterfaces()[SHARED_PORT];
		expect(after?.error).toBe(before.error ?? 0);
		expect(after?.enabled).toBe(before.enabled);
		expect((after?.error ?? 0) & NETIF_ERR_SHAREDLAN).toBe(0);

		processIfconfigOutput(twoPortTopology());
		expect(
			genSrtlaBondEntries()
				.map((e) => e.ip)
				.sort(),
		).toEqual([SHARED_IP, UPLINK_IP]);
	});

	test("a failed activation restores intent just as a failed write does", async () => {
		processIfconfigOutput(twoPortTopology());
		const deps = makeDeps({ activate: async () => false });

		const result = await setEthernetRole(SHARED_PORT, "shared-lan", deps);

		expect(result).toEqual({ success: false, error: "apply_failed" });
		expect(getConfig().eth_roles).not.toHaveProperty(SHARED_PORT);
	});

	test("a rollback restores a PREVIOUS role rather than deleting it", async () => {
		processIfconfigOutput(twoPortTopology());
		persistEthernetRole(SHARED_PORT, "shared-lan");
		const deps = makeDeps({ setFields: async () => false });

		await setEthernetRole(SHARED_PORT, "uplink", deps);

		expect(getEthernetRole(SHARED_PORT)).toBe("shared-lan");
	});
});

describe("boot reconciliation", () => {
	test("re-applies a stated shared-lan role", async () => {
		processIfconfigOutput(twoPortTopology());
		persistEthernetRole(SHARED_PORT, "shared-lan");
		const deps = makeDeps();

		await reconcileEthernetRoles(deps);

		expect(deps.writes).toEqual([
			{ uuid: "uuid-eth1", fields: { "ipv4.method": "shared" } },
		]);
	});

	test("is IDEMPOTENT — a second run re-asserts the same value and nothing else", async () => {
		processIfconfigOutput(twoPortTopology());
		persistEthernetRole(SHARED_PORT, "shared-lan");
		const deps = makeDeps();

		await reconcileEthernetRoles(deps);
		await reconcileEthernetRoles(deps);

		expect(deps.writes).toEqual([
			{ uuid: "uuid-eth1", fields: { "ipv4.method": "shared" } },
			{ uuid: "uuid-eth1", fields: { "ipv4.method": "shared" } },
		]);
		expect(getEthernetRole(SHARED_PORT)).toBe("shared-lan");
		expect(
			(getNetworkInterfaces()[SHARED_PORT]?.error ?? 0) & NETIF_ERR_SHAREDLAN,
		).toBe(NETIF_ERR_SHAREDLAN);
	});

	test("an `uplink` entry is never re-applied — the default touches no profile", async () => {
		processIfconfigOutput(twoPortTopology());
		persistEthernetRole(UPLINK_PORT, "uplink");
		const deps = makeDeps();

		await reconcileEthernetRoles(deps);

		expect(deps.writes).toEqual([]);
	});

	test("a device with no stated role does nothing at all", async () => {
		processIfconfigOutput(twoPortTopology());
		const deps = makeDeps();

		await reconcileEthernetRoles(deps);

		expect(deps.writes).toEqual([]);
	});

	test("FAIL-SOFT — a throwing NM read never rejects and never clears the role", async () => {
		processIfconfigOutput(twoPortTopology());
		persistEthernetRole(SHARED_PORT, "shared-lan");
		const deps = makeDeps({
			resolveConnection: async () => {
				throw new Error("nmcli exploded");
			},
		});

		await expect(reconcileEthernetRoles(deps)).resolves.toBeUndefined();
		expect(getEthernetRole(SHARED_PORT)).toBe("shared-lan");
	});

	test("FAIL-SOFT — an absent port leaves its role pending rather than discarded", async () => {
		persistEthernetRole(SHARED_PORT, "shared-lan");
		const deps = makeDeps();

		await expect(reconcileEthernetRoles(deps)).resolves.toBeUndefined();

		expect(deps.writes).toEqual([]);
		expect(getEthernetRole(SHARED_PORT)).toBe("shared-lan");
	});

	test("one port that throws does not cost another its reconciliation", async () => {
		processIfconfigOutput(twoPortTopology());
		persistEthernetRole(SHARED_PORT, "shared-lan");
		persistEthernetRole(UPLINK_PORT, "shared-lan");
		const deps = makeDeps({
			resolveConnection: async (ifname) => {
				if (ifname === SHARED_PORT) throw new Error("nmcli exploded");
				return { kind: "active", uuid: "uuid-eth0" };
			},
		});

		await reconcileEthernetRoles(deps);

		expect(deps.writes).toEqual([
			{ uuid: "uuid-eth0", fields: { "ipv4.method": "shared" } },
		]);
	});
});

describe("network.configure answers honestly when handleNetif rejects", () => {
	test("a stale address is `success:false` with a typed reason, NEVER `success:true`", async () => {
		processIfconfigOutput(twoPortTopology());

		const result = await call(
			configureNetworkInterfaceProcedure,
			// The echoed address is not the one the device observes, so the
			// concurrency guard discards the whole request — including the bond
			// toggle it carries.
			{ name: UPLINK_PORT, ip: "10.9.9.9", enabled: false },
			{ context: makeContext() },
		);

		expect(result.success).toBe(false);
		expect(result.error).toBe("stale_address");
		// And the guard really did discard it: the toggle did not apply.
		expect(getNetworkInterfaces()[UPLINK_PORT]?.enabled).toBe(true);
	});

	test("an unknown interface is `success:false` with its own reason", async () => {
		processIfconfigOutput(twoPortTopology());

		const result = await call(
			configureNetworkInterfaceProcedure,
			{ name: "eth9", enabled: false },
			{ context: makeContext() },
		);

		expect(result.success).toBe(false);
		expect(result.error).toBe("unknown_interface");
	});

	test("enabling a port the device refuses is `success:false`", async () => {
		persistEthernetRole(SHARED_PORT, "shared-lan");
		processIfconfigOutput(twoPortTopology());

		const result = await call(
			configureNetworkInterfaceProcedure,
			{ name: SHARED_PORT, ip: SHARED_IP, enabled: true },
			{ context: makeContext() },
		);

		expect(result.success).toBe(false);
		expect(result.error).toBe("enable_refused");
	});

	test("an APPLIED toggle still answers `success:true` with its applied fields", async () => {
		processIfconfigOutput(twoPortTopology());

		const result = await call(
			configureNetworkInterfaceProcedure,
			{ name: UPLINK_PORT, ip: UPLINK_IP, enabled: false },
			{ context: makeContext() },
		);

		expect(result.success).toBe(true);
		expect(result.error).toBeUndefined();
		expect(result.applied).toEqual({
			name: UPLINK_PORT,
			ip: UPLINK_IP,
			enabled: false,
		});
		expect(getNetworkInterfaces()[UPLINK_PORT]?.enabled).toBe(false);
	});
});

describe("the wire carries the role in BOTH directions", () => {
	test("every ethernet row states its role explicitly, `uplink` included", () => {
		processIfconfigOutput(twoPortTopology());

		expect(netIfBuildMsg()[UPLINK_PORT]?.ethRole).toBe("uplink");
		expect(netIfBuildMsg()[SHARED_PORT]?.ethRole).toBe("uplink");
	});

	test("a flip is published, and the flip BACK retracts it explicitly", () => {
		persistEthernetRole(SHARED_PORT, "shared-lan");
		processIfconfigOutput(twoPortTopology());
		expect(netIfBuildMsg()[SHARED_PORT]?.ethRole).toBe("shared-lan");

		persistEthernetRole(SHARED_PORT, "uplink");
		processIfconfigOutput(twoPortTopology());

		// Explicit, never omitted — the consumer merge preserves an absent field,
		// so a retraction by omission could never lower the claim.
		expect(netIfBuildMsg()[SHARED_PORT]).toHaveProperty("ethRole");
		expect(netIfBuildMsg()[SHARED_PORT]?.ethRole).toBe("uplink");
	});

	test("a NON-ethernet row makes no role claim at all", () => {
		processIfconfigOutput(
			[
				ifconfigStanza(UPLINK_PORT, UPLINK_IP, "aa:bb:cc:dd:ee:01"),
				ifconfigStanza("wlan0", "192.168.1.50", "aa:bb:cc:dd:ee:03"),
			].join("\n\n"),
		);

		expect(netIfBuildMsg().wlan0).not.toHaveProperty("ethRole");
	});
});

describe("the wire shape round-trips through the published schema", () => {
	test("a role-bearing netif payload parses", async () => {
		const { netifMessageSchema, setEthernetRoleInputSchema } = await import(
			"@ceraui/rpc/schemas"
		);
		persistEthernetRole(SHARED_PORT, "shared-lan");
		processIfconfigOutput(twoPortTopology());

		const parsed = netifMessageSchema.safeParse(netIfBuildMsg());
		expect(parsed.success).toBe(true);
		expect(parsed.data?.[SHARED_PORT]?.ethRole).toBe("shared-lan");

		expect(
			setEthernetRoleInputSchema.safeParse({
				name: SHARED_PORT,
				role: "shared-lan",
			}).success,
		).toBe(true);
		// `.strict()`: an unknown extra key on a control that re-points a wired
		// port at the LAN must be REJECTED, never ignored.
		expect(
			setEthernetRoleInputSchema.safeParse({
				name: SHARED_PORT,
				role: "shared-lan",
				extra: true,
			}).success,
		).toBe(false);
		expect(
			setEthernetRoleInputSchema.safeParse({ name: SHARED_PORT, role: "wan" })
				.success,
		).toBe(false);
	});

	test("the outcome frame parses in all three shapes", async () => {
		const { ethernetRoleMessageSchema } = await import("@ceraui/rpc/schemas");

		for (const frame of [
			{ eth_role: { name: SHARED_PORT, role: "shared-lan", pending: true } },
			{ eth_role: { name: SHARED_PORT, role: "shared-lan", success: true } },
			{ eth_role: { name: SHARED_PORT, error: "apply_failed" } },
		]) {
			expect(ethernetRoleMessageSchema.safeParse(frame).success).toBe(true);
		}
	});
});

describe("owned Shared LAN profile lifecycle", () => {
	test("optional UUID reservation survives strict config parsing, without changing old absence", () => {
		expect(runtimeConfigSchema.parse({}).eth_shared_profiles).toBeUndefined();
		expect(
			runtimeConfigSchema.parse({ eth_shared_profiles: { eth1: OWNED_UUID } })
				.eth_shared_profiles,
		).toEqual({ eth1: OWNED_UUID });
		expect(
			runtimeConfigSchema.safeParse({
				eth_shared_profiles: { eth1: "not-a-uuid" },
			}).success,
		).toBe(false);
	});

	test("lost add reply retains the reservation; explicit retry after config reload reuses the same profile", async () => {
		processIfconfigOutput(twoPortTopology());
		const f = freshPort();
		f.database.profiles.set(FOREIGN_UUID, {
			ifname: "eth9",
			type: "802-3-ethernet",
		});
		f.controls.loseAddReply = true;
		expect(await setEthernetRole(SHARED_PORT, "shared-lan", f.deps)).toEqual({
			success: false,
			error: "apply_failed",
		});
		expect(f.adds()).toHaveLength(1);
		expect(f.activate).not.toHaveBeenCalled();
		expect(getConfig().eth_roles).not.toHaveProperty(SHARED_PORT);
		const saved = runtimeConfigSchema.parse(
			JSON.parse(readFileSync(TEST_CONFIG_FILE, "utf8")),
		);
		expect(saved.eth_shared_profiles?.[SHARED_PORT]).toBe(OWNED_UUID);
		getConfig().eth_roles = saved.eth_roles;
		getConfig().eth_shared_profiles = saved.eth_shared_profiles;
		const restarted = freshPort(f.database);
		restarted.newUuid.mockImplementation(() => {
			throw new Error("must reuse reservation");
		});
		expect(
			await setEthernetRole(SHARED_PORT, "shared-lan", restarted.deps),
		).toEqual({ success: true, applied: "shared-lan" });
		expect(restarted.adds()).toHaveLength(0);
		expect(restarted.newUuid).not.toHaveBeenCalled();
		expect(restarted.activate).toHaveBeenCalledWith(OWNED_UUID);
		expect(f.database.profiles.get(FOREIGN_UUID)).toEqual({
			ifname: "eth9",
			type: "802-3-ethernet",
		});
	});

	test("an explicit retry may add only the reserved UUID after a successful absence read", async () => {
		processIfconfigOutput(twoPortTopology());
		reserveSharedEthernetProfile(SHARED_PORT, OWNED_UUID);
		const f = freshPort();
		f.newUuid.mockImplementation(() => {
			throw new Error("must not allocate");
		});
		expect(await setEthernetRole(SHARED_PORT, "shared-lan", f.deps)).toEqual({
			success: true,
			applied: "shared-lan",
		});
		expect(f.adds()).toHaveLength(1);
		expect(f.adds()[0]?.[1][9]).toBe(OWNED_UUID);
	});

	test("boot reuses a valid inactive owned profile, but never allocates or adds a missing one", async () => {
		processIfconfigOutput(twoPortTopology());
		persistEthernetRole(SHARED_PORT, "shared-lan");
		reserveSharedEthernetProfile(SHARED_PORT, OWNED_UUID);
		const f = freshPort();
		await reconcileEthernetRoles(f.deps);
		expect(f.adds()).toHaveLength(0);
		expect(f.newUuid).not.toHaveBeenCalled();
		expect(f.activate).not.toHaveBeenCalled();
		f.database.profiles.set(OWNED_UUID, {
			ifname: SHARED_PORT,
			type: "802-3-ethernet",
		});
		await reconcileEthernetRoles(f.deps);
		expect(f.activate).toHaveBeenCalledWith(OWNED_UUID);
		expect(f.adds()).toHaveLength(0);
		expect(getEthernetRole(SHARED_PORT)).toBe("shared-lan");
	});

	test("boot with no reservation cannot invent one", async () => {
		processIfconfigOutput(twoPortTopology());
		persistEthernetRole(SHARED_PORT, "shared-lan");
		const f = freshPort();
		await reconcileEthernetRoles(f.deps);
		expect(f.newUuid).not.toHaveBeenCalled();
		expect(f.adds()).toHaveLength(0);
		expect(getSharedEthernetProfile(SHARED_PORT)).toBeUndefined();
	});

	test("unavailable or malformed reads and mismatched owned profiles never authorize add", async () => {
		processIfconfigOutput(twoPortTopology());
		for (const fault of [
			"active",
			"list",
			"uuid",
			"type",
			"interface",
		] as const) {
			getConfig().eth_roles = {};
			getConfig().eth_shared_profiles = {};
			reserveSharedEthernetProfile(SHARED_PORT, OWNED_UUID);
			const runner = mock(async (_bin: string, args: string[]) => {
				if (args[4] === "GENERAL.CON-UUID")
					return fault === "active" ? "--" : "";
				if (args[4] === "UUID")
					return fault === "list" ? "not-a-uuid" : OWNED_UUID;
				return `${fault === "uuid" ? OTHER_UUID : OWNED_UUID}\n${fault === "type" ? "802-11-wireless" : "802-3-ethernet"}\n${fault === "interface" ? "eth0" : SHARED_PORT}`;
			});
			const adapter = createEthernetNm(runner);
			const add = mock(adapter.addShared),
				activate = mock(async () => true);
			const deps = makeDeps({
				resolveConnection: adapter.active,
				readProfile: adapter.profile,
				addConnection: add,
				activate,
			});
			expect(
				(await setEthernetRole(SHARED_PORT, "shared-lan", deps)).success,
			).toBe(false);
			expect(add).not.toHaveBeenCalled();
			expect(deps.writes).toEqual([]);
			expect(activate).not.toHaveBeenCalled();
		}
	});

	test("failure to persist the reservation makes no NM mutation", async () => {
		processIfconfigOutput(twoPortTopology());
		const f = freshPort();
		const deps = {
			...f.deps,
			reserveProfile: () => {
				throw new Error("storage unavailable");
			},
		};
		expect(
			(await setEthernetRole(SHARED_PORT, "shared-lan", deps)).success,
		).toBe(false);
		expect(f.adds()).toHaveLength(0);
		expect(f.deps.writes).toEqual([]);
		expect(f.activate).not.toHaveBeenCalled();
		expect(getConfig().eth_roles).not.toHaveProperty(SHARED_PORT);
	});

	test("real synchronous config-write failure restores in-memory intent and dispatches nothing", async () => {
		processIfconfigOutput(twoPortTopology());
		const f = freshPort();
		setConfigFilePath(`${TEST_CONFIG_FILE}/missing/config.json`);
		expect(
			(await setEthernetRole(SHARED_PORT, "shared-lan", f.deps)).success,
		).toBe(false);
		expect(getConfig().eth_roles).not.toHaveProperty(SHARED_PORT);
		expect(getSharedEthernetProfile(SHARED_PORT)).toBeUndefined();
		expect(f.runner).not.toHaveBeenCalled();
		setConfigFilePath(TEST_CONFIG_FILE);
		expect(() =>
			reserveSharedEthernetProfile(SHARED_PORT, OWNED_UUID),
		).not.toThrow();
		setConfigFilePath(`${TEST_CONFIG_FILE}/missing/config.json`);
		expect(() =>
			reserveSharedEthernetProfile(SHARED_PORT, OTHER_UUID),
		).toThrow();
		expect(getSharedEthernetProfile(SHARED_PORT)).toBe(OWNED_UUID);
	});

	test("a port disappearing during add prevents activation, retaining the uncertain profile", async () => {
		processIfconfigOutput(twoPortTopology());
		const f = freshPort();
		f.controls.beforeAdd = async () => {
			delete getNetworkInterfaces()[SHARED_PORT];
		};
		expect(
			(await setEthernetRole(SHARED_PORT, "shared-lan", f.deps)).success,
		).toBe(false);
		expect(f.activate).not.toHaveBeenCalled();
		expect(f.deps.writes).toEqual([]);
		expect(getSharedEthernetProfile(SHARED_PORT)).toBe(OWNED_UUID);
		expect(f.database.profiles.has(OWNED_UUID)).toBe(true);
	});

	test("a lost activation reply cannot claim success or erase its owned profile", async () => {
		processIfconfigOutput(twoPortTopology());
		const f = freshPort();
		const deps = {
			...f.deps,
			activate: async (uuid: string) => {
				await f.activate(uuid);
				return false;
			},
		};
		expect(
			(await setEthernetRole(SHARED_PORT, "shared-lan", deps)).success,
		).toBe(false);
		expect(f.database.active.get(SHARED_PORT)).toBe(OWNED_UUID);
		expect(getSharedEthernetProfile(SHARED_PORT)).toBe(OWNED_UUID);
		expect(f.adds()).toHaveLength(1);
		expect(f.deps.frames.at(-1)?.outcome).toEqual({
			success: false,
			error: "apply_failed",
		});
	});

	test("an acknowledged activation without current active UUID is not success", async () => {
		processIfconfigOutput(twoPortTopology());
		const f = freshPort();
		const deps = { ...f.deps, activate: async () => true };
		expect(
			(await setEthernetRole(SHARED_PORT, "shared-lan", deps)).success,
		).toBe(false);
		expect(getSharedEthernetProfile(SHARED_PORT)).toBe(OWNED_UUID);
	});

	test("profile rebinding before activation is refused without touching the other port", async () => {
		processIfconfigOutput(twoPortTopology());
		const f = freshPort();
		const deps = {
			...f.deps,
			setFields: async () => {
				const profile = f.database.profiles.get(OWNED_UUID);
				if (profile) profile.ifname = UPLINK_PORT;
				return true;
			},
		};
		expect(
			(await setEthernetRole(SHARED_PORT, "shared-lan", deps)).success,
		).toBe(false);
		expect(f.activate).not.toHaveBeenCalled();
		expect(f.database.active.size).toBe(0);
		expect(getSharedEthernetProfile(SHARED_PORT)).toBe(OWNED_UUID);
	});

	test("queued Uplink can recover an uncertain add using its existing inactive reservation", async () => {
		processIfconfigOutput(twoPortTopology());
		const f = freshPort();
		f.controls.loseAddReply = true;
		const shared = setEthernetRole(SHARED_PORT, "shared-lan", f.deps);
		const uplink = setEthernetRole(SHARED_PORT, "uplink", f.deps);
		expect((await shared).success).toBe(false);
		expect(await uplink).toEqual({ success: true, applied: "uplink" });
		expect(f.adds()).toHaveLength(1);
		expect(f.newUuid).toHaveBeenCalledTimes(1);
		expect(f.deps.writes).toEqual([
			{
				uuid: OWNED_UUID,
				fields: {
					"ipv4.method": "auto",
					"connection.autoconnect": "yes",
				},
			},
		]);
		expect(f.database.active.get(SHARED_PORT)).toBe(OWNED_UUID);
	});

	test("same-port requests serialize, create once, and a queued Uplink remains authoritative", async () => {
		processIfconfigOutput(twoPortTopology());
		const f = freshPort(),
			entered = deferred<void>(),
			release = deferred<void>();
		f.controls.beforeAdd = async () => {
			entered.resolve();
			await release.promise;
		};
		const a = setEthernetRole(SHARED_PORT, "shared-lan", f.deps);
		await entered.promise;
		const b = setEthernetRole(SHARED_PORT, "shared-lan", f.deps);
		const c = setEthernetRole(SHARED_PORT, "uplink", f.deps);
		const boot = reconcileEthernetRoles(f.deps);
		expect(f.adds()).toHaveLength(1);
		expect(f.activate).not.toHaveBeenCalled();
		release.resolve();
		expect((await a).success).toBe(true);
		expect((await b).success).toBe(true);
		expect((await c).applied).toBe("uplink");
		await boot;
		expect(f.adds()).toHaveLength(1);
		expect(f.newUuid).toHaveBeenCalledTimes(1);
		expect(f.deps.writes.map((w) => w.fields)).toEqual([
			{ "ipv4.method": "shared", "connection.autoconnect": "no" },
			{ "ipv4.method": "shared", "connection.autoconnect": "no" },
			{ "ipv4.method": "auto", "connection.autoconnect": "yes" },
		]);
		expect(getEthernetRole(SHARED_PORT)).toBe("uplink");
	});

	test("a blocked port does not hold up an independent port or alter its reservation", async () => {
		processIfconfigOutput(twoPortTopology());
		const f = freshPort(),
			entered = deferred<void>(),
			release = deferred<void>();
		f.newUuid.mockReturnValueOnce(OWNED_UUID).mockReturnValueOnce(OTHER_UUID);
		f.controls.beforeAdd = async (ifname) => {
			if (ifname === SHARED_PORT) {
				entered.resolve();
				await release.promise;
			}
		};
		const a = setEthernetRole(SHARED_PORT, "shared-lan", f.deps);
		await entered.promise;
		expect(
			(await setEthernetRole(UPLINK_PORT, "shared-lan", f.deps)).success,
		).toBe(true);
		expect(f.database.active.get(UPLINK_PORT)).toBe(OTHER_UUID);
		expect(f.database.active.has(SHARED_PORT)).toBe(false);
		release.resolve();
		await a;
		expect(getConfig().eth_shared_profiles).toEqual({
			[SHARED_PORT]: OWNED_UUID,
			[UPLINK_PORT]: OTHER_UUID,
		});
	});

	test("untouched Uplink neither queries nor creates a profile", async () => {
		processIfconfigOutput(twoPortTopology());
		const f = freshPort();
		expect(await setEthernetRole(SHARED_PORT, "uplink", f.deps)).toEqual({
			success: true,
			applied: "uplink",
		});
		expect(f.runner).not.toHaveBeenCalled();
		expect(f.newUuid).not.toHaveBeenCalled();
	});
});

describe("strict Ethernet NetworkManager command contract", () => {
	test("uppercase enumeration and readback identify the same reserved UUID", async () => {
		const upper = LETTER_UUID.toUpperCase();
		const nm = createEthernetNm(async (_bin, args) =>
			args[4] === "UUID" ? upper : `${upper}\n802-3-ethernet\n${SHARED_PORT}`,
		);
		expect(await nm.profile(LETTER_UUID, SHARED_PORT)).toEqual({
			kind: "present",
		});
	});

	test("a case-variant duplicate UUID is unavailable rather than positive absence or presence", async () => {
		const nm = createEthernetNm(async (_bin, args) =>
			args[4] === "UUID"
				? `${LETTER_UUID}\n${LETTER_UUID.toUpperCase()}`
				: `${LETTER_UUID}\n802-3-ethernet\n${SHARED_PORT}`,
		);
		expect(await nm.profile(LETTER_UUID, SHARED_PORT)).toEqual({
			kind: "unavailable",
		});
	});

	test("active UUIDs use canonical identity", async () => {
		const upper = LETTER_UUID.toUpperCase();
		const nm = createEthernetNm(async () => upper);
		expect(await nm.active(SHARED_PORT)).toEqual({
			kind: "active",
			uuid: LETTER_UUID,
		});
	});

	test("add acknowledgements use canonical identity", async () => {
		const upper = LETTER_UUID.toUpperCase();
		const nm = createEthernetNm(
			async () => `Connection 'Shared LAN eth1' (${upper}) successfully added.`,
		);
		expect(await nm.addShared({ ifname: SHARED_PORT, uuid: LETTER_UUID })).toBe(
			true,
		);
	});

	test("uppercase NM identity reuses the existing reserved profile without an add attempt", async () => {
		processIfconfigOutput(twoPortTopology());
		reserveSharedEthernetProfile(SHARED_PORT, LETTER_UUID);
		const f = freshPort();
		f.database.profiles.set(LETTER_UUID, {
			ifname: SHARED_PORT,
			type: "802-3-ethernet",
		});
		const nm = createEthernetNm(async (bin, args) =>
			(await f.runner(bin, args)).replaceAll(
				LETTER_UUID,
				LETTER_UUID.toUpperCase(),
			),
		);
		const deps = {
			...f.deps,
			resolveConnection: nm.active,
			readProfile: nm.profile,
			addConnection: nm.addShared,
		};
		expect(await setEthernetRole(SHARED_PORT, "shared-lan", deps)).toEqual({
			success: true,
			applied: "shared-lan",
		});
		expect(f.adds()).toHaveLength(0);
		expect(f.newUuid).not.toHaveBeenCalled();
		expect(f.activate).toHaveBeenCalledWith(LETTER_UUID);
	});

	test("an uppercase stored reservation is read and persisted in canonical form", () => {
		getConfig().eth_shared_profiles = {
			[SHARED_PORT]: LETTER_UUID.toUpperCase(),
		};
		expect(getSharedEthernetProfile(SHARED_PORT)).toBe(LETTER_UUID);
		reserveSharedEthernetProfile(SHARED_PORT, LETTER_UUID.toUpperCase());
		expect(
			JSON.parse(readFileSync(TEST_CONFIG_FILE, "utf8")).eth_shared_profiles[
				SHARED_PORT
			],
		).toBe(LETTER_UUID);
	});

	test("empty active UUID is known absence; malformed, multi-row and failed reads are unavailable", async () => {
		for (const output of [
			"",
			"\n",
			`${OWNED_UUID}\n`,
			"--",
			"invalid",
			`${OWNED_UUID}\n${OTHER_UUID}`,
		]) {
			const runner = mock(async (_bin: string, _args: string[]) => output),
				nm = createEthernetNm(runner);
			expect(await nm.active(SHARED_PORT)).toEqual(
				output.trim() === ""
					? { kind: "absent" }
					: output.trim() === OWNED_UUID
						? { kind: "active", uuid: OWNED_UUID }
						: { kind: "unavailable" },
			);
			expect(runner.mock.calls[0]).toEqual([
				"nmcli",
				[
					"--terse",
					"--escape",
					"no",
					"--get-values",
					"GENERAL.CON-UUID",
					"device",
					"show",
					SHARED_PORT,
				],
			]);
		}
		const nm = createEthernetNm(async () => {
			throw new Error("read failed");
		});
		expect(await nm.active(SHARED_PORT)).toEqual({ kind: "unavailable" });
		expect(await nm.profile(OWNED_UUID, SHARED_PORT)).toEqual({
			kind: "unavailable",
		});
	});

	test("successful empty enumeration is required for absence; duplicates and malformed fields refuse", async () => {
		for (const output of [
			"",
			"\n",
			"UUID",
			"--",
			`${OWNED_UUID}\n${OWNED_UUID}`,
			`${OTHER_UUID}\n`,
		]) {
			const nm = createEthernetNm(async () => output);
			expect(await nm.profile(OWNED_UUID, SHARED_PORT)).toEqual({
				kind:
					output.trim() === "" || output.trim() === OTHER_UUID
						? "absent"
						: "unavailable",
			});
		}
	});

	test("typed add requires an exact acknowledged UUID, with no fallback after failure", async () => {
		for (const reply of [
			`Connection 'Shared LAN eth1' (${OWNED_UUID}) successfully added.`,
			`Connection 'Shared LAN eth1' (${OTHER_UUID}) successfully added.`,
			"",
			"unexpected output",
		]) {
			const runner = mock(async (_bin: string, _args: string[]) => reply),
				nm = createEthernetNm(runner);
			expect(
				await nm.addShared({ ifname: SHARED_PORT, uuid: OWNED_UUID }),
			).toBe(reply.includes(OWNED_UUID));
			expect(runner).toHaveBeenCalledTimes(1);
			expect(runner.mock.calls[0]).toEqual([
				"nmcli",
				[
					"connection",
					"add",
					"type",
					"ethernet",
					"ifname",
					SHARED_PORT,
					"con-name",
					"Shared LAN eth1",
					"connection.uuid",
					OWNED_UUID,
					"connection.autoconnect",
					"no",
					"ipv4.method",
					"shared",
				],
			]);
		}
	});

	test("unsafe or option-shaped interface and UUID inputs reach no runner", async () => {
		const runner = mock(async (_bin: string, _args: string[]) => ""),
			nm = createEthernetNm(runner);
		for (const ifname of ["-eth1", "eth1;id", "eth1\neth0", "x".repeat(16)]) {
			expect(await nm.active(ifname)).toEqual({ kind: "unavailable" });
			expect(await nm.profile(OWNED_UUID, ifname)).toEqual({
				kind: "unavailable",
			});
			expect(await nm.addShared({ ifname, uuid: OWNED_UUID })).toBe(false);
		}
		for (const uuid of ["--help", "invalid", `${OWNED_UUID}\n`]) {
			expect(await nm.profile(uuid, SHARED_PORT)).toEqual({
				kind: "unavailable",
			});
			expect(await nm.addShared({ ifname: SHARED_PORT, uuid })).toBe(false);
		}
		expect(runner).not.toHaveBeenCalled();
	});
});
