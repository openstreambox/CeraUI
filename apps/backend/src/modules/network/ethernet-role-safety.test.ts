/**
 * An Ethernet role change through the network-change owner.
 *
 * Drives the REAL `setEthernetRole` and the REAL owner over the NetworkManager
 * model in network-change-test-fakes.ts, with an in-memory role store. The
 * property under test: a role change nobody confirmed leaves nothing behind,
 * neither in NetworkManager nor in the persisted intent the boot reconciler
 * would re-apply.
 */
import { describe, expect, it } from "bun:test";
import type { EthernetRole } from "@ceraui/rpc/schemas";
import { ETHERNET_ROLE_DEFAULT } from "./ethernet-role.ts";
import type { EthernetRoleOutcome } from "./ethernet-role-outcome.ts";
import {
	createEthernetRoleSettledHandler,
	DEFAULT_ROLE,
	ETHERNET_ROLE_SUMMARY_KEY,
	ethernetRoleFromPlan,
	ethernetRolePlan,
	NETWORK_CHANGE_SAFETY_ENV,
	networkChangeSafetyEnabled,
} from "./ethernet-role-safety.ts";
import {
	type EthernetRoleTransitionDeps,
	reconcileEthernetRoles,
	setEthernetRole,
} from "./ethernet-role-transition.ts";
import { harness, session } from "./network-change-test-fakes.ts";
import type { SettledEvent } from "./network-checkpoint.ts";

const UNDO = "undo-automatically" as const;
const KEEP = "keep-change" as const;

/** A box with eth0 on its uplink profile, plus the role store. */
function box(
	options: { role?: EthernetRole; owned?: boolean; settleMs?: number } = {},
) {
	const roles: Record<string, EthernetRole> = {};
	if (options.role) roles.eth0 = options.role;
	const reservations: Record<string, string> = {};
	const frames: Array<EthernetRoleOutcome & { name: string }> = [];
	const writes: string[] = [];
	let handler: ((event: SettledEvent) => void) | undefined;
	const h = harness({
		settleMs: options.settleMs ?? 15_000,
		onSettled: (event) => handler?.(event),
	});
	const method = options.role === "shared-lan" ? "shared" : "auto";
	const wired = h.fake.add(
		options.owned ? "ceralive-shared-eth0" : "Wired connection 1",
		{ "ipv4.method": method },
		!options.owned || options.role !== "shared-lan",
	);
	h.fake.active.set("eth0", wired);
	if (options.owned) reservations.eth0 = wired;
	const deps: EthernetRoleTransitionDeps = {
		listInterfaces: () => ({ eth0: {}, wlan0: {} }),
		resolveConnection: async (ifname) => {
			const uuid = h.fake.active.get(ifname);
			return uuid ? { kind: "active", uuid } : { kind: "absent" };
		},
		readProfile: async (uuid) =>
			h.fake.profiles.has(uuid) ? { kind: "present" } : { kind: "absent" },
		addConnection: async () => {
			writes.push("add");
			return true;
		},
		readOwnedProfile: (ifname) => reservations[ifname],
		reserveProfile: (ifname, uuid) => {
			reservations[ifname] = uuid;
		},
		newUuid: () => "11111111-1111-4111-8111-111111111111",
		setFields: async (uuid, fields) => {
			writes.push(`set:${uuid}:${JSON.stringify(fields)}`);
			return true;
		},
		activate: async (uuid) => {
			writes.push(`activate:${uuid}`);
			return true;
		},
		persistRole: (ifname, role) => {
			roles[ifname] = role;
		},
		restoreRole: (ifname, previous) => {
			if (previous === undefined) delete roles[ifname];
			else roles[ifname] = previous;
		},
		readPersistedRole: (ifname) => roles[ifname],
		publishOutcome: (name, outcome) => frames.push({ name, ...outcome }),
		refreshInterfaces: () => {},
	};
	handler = createEthernetRoleSettledHandler(deps);
	const safety = (
		s: ReturnType<typeof session>,
		answer?: typeof UNDO | typeof KEEP,
	) => ({
		owner: h.owner,
		session: s,
		answer,
	});
	return { ...h, deps, roles, reservations, frames, writes, wired, safety };
}

/** A remote operator whose session rides the wired uplink. */
const overEth = session("remote", "eth0", 500);
const laterOverEth = session("reconnected", "eth0", 1_001);

describe("the flag", () => {
	it("is off unless set to exactly 1", () => {
		expect(networkChangeSafetyEnabled({})).toBe(false);
		for (const value of ["", "0", "true", "yes", " 1"])
			expect(
				networkChangeSafetyEnabled({ [NETWORK_CHANGE_SAFETY_ENV]: value }),
			).toBe(false);
		expect(
			networkChangeSafetyEnabled({ [NETWORK_CHANGE_SAFETY_ENV]: "1" }),
		).toBe(true);
	});

	it("leaves the existing path unchanged when no safety is passed", async () => {
		const b = box();
		const result = await setEthernetRole("eth0", "shared-lan", b.deps, "op1");
		expect(result).toEqual({ success: true, applied: "shared-lan" });
		expect(b.roles.eth0).toBe("shared-lan");
		expect(b.writes[0]).toContain('"ipv4.method":"shared"');
		expect(b.fake.calls).toEqual([]);
	});
});

describe("the plan", () => {
	it("uses the role module's default for a port with no stated role", () => {
		expect(DEFAULT_ROLE).toBe(ETHERNET_ROLE_DEFAULT);
	});

	it("edits only ipv4.method on the active profile and re-activates it", () => {
		const plan = ethernetRolePlan({
			ifname: "eth0",
			role: "shared-lan",
			previous: undefined,
			activeUuid: "u",
			owned: false,
			op: "op1",
		});
		expect(plan.devices).toEqual(["eth0"]);
		expect(plan.effects).toEqual([]);
		expect(plan.profiles).toEqual([
			{ uuid: "u", set: [["ipv4.method", "shared"]], activateOn: "eth0" },
		]);
		expect(ethernetRoleFromPlan(plan)).toEqual({
			ifname: "eth0",
			role: "shared-lan",
			previous: undefined,
			op: "op1",
		});
	});

	it("carries the role's autoconnect for the owned profile only", () => {
		const base = {
			ifname: "eth0",
			previous: "shared-lan" as const,
			activeUuid: "u",
		};
		expect(
			ethernetRolePlan({ ...base, role: "uplink", owned: true }).profiles[0]
				?.autoconnect,
		).toBe(true);
		expect(
			ethernetRolePlan({ ...base, role: "uplink", owned: false }).profiles[0],
		).not.toHaveProperty("autoconnect");
	});

	it("does not read back a plan that is not a role change", () => {
		expect(
			ethernetRoleFromPlan({
				summary: { key: "other" },
				devices: [],
				profiles: [],
				effects: [],
			}),
		).toBeUndefined();
		expect(
			ethernetRoleFromPlan({
				summary: {
					key: ETHERNET_ROLE_SUMMARY_KEY,
					params: { ifname: "eth0", role: "router" },
				},
				devices: [],
				profiles: [],
				effects: [],
			}),
		).toBeUndefined();
	});
});

describe("a remote box managed over its wired uplink", () => {
	it("asks before cutting the session's own port, and changes nothing until answered", async () => {
		const b = box();
		const result = await setEthernetRole(
			"eth0",
			"shared-lan",
			b.deps,
			"op1",
			b.safety(overEth),
		);
		expect(result.success).toBe(false);
		expect(result.changeSafety).toMatchObject({
			kind: "ask-before",
			via: "eth0",
			seconds: 90,
		});
		expect(b.fake.calls).toEqual([]);
		expect(b.writes).toEqual([]);
		expect(b.roles.eth0).toBeUndefined();
		expect(b.frames).toEqual([]);
	});

	it("applies on a candidate and persists nothing while pending", async () => {
		const b = box();
		const result = await setEthernetRole(
			"eth0",
			"shared-lan",
			b.deps,
			"op1",
			b.safety(overEth, UNDO),
		);
		expect(result).toMatchObject({
			success: true,
			applied: "shared-lan",
			changeSafety: { kind: "pending" },
		});
		const candidate = b.fake.active.get("eth0") as string;
		expect(candidate).not.toBe(b.wired);
		expect(b.fake.profiles.get(candidate)?.settings["ipv4.method"]).toBe(
			"shared",
		);
		expect(b.fake.profiles.get(b.wired)).toMatchObject({
			storage: "disk",
			settings: { "ipv4.method": "auto" },
		});
		// The existing path's direct profile write never ran.
		expect(b.writes).toEqual([]);
		expect(b.roles.eth0).toBeUndefined();
		expect(b.frames).toEqual([
			{ name: "eth0", pending: true, role: "shared-lan", op: "op1" },
		]);
	});

	it("is undone when nobody confirms, and the boot reconciler finds nothing to re-apply", async () => {
		const b = box();
		await setEthernetRole(
			"eth0",
			"shared-lan",
			b.deps,
			"op1",
			b.safety(overEth, UNDO),
		);
		await b.fake.expireAll();
		b.at(91_001);
		await b.owner.tick();
		expect(b.fake.active.get("eth0")).toBe(b.wired);
		expect(b.fake.profiles.get(b.wired)?.settings["ipv4.method"]).toBe("auto");
		expect(b.roles.eth0).toBeUndefined();
		expect(b.frames.at(-1)).toEqual({
			name: "eth0",
			success: false,
			error: "apply_failed",
			op: "op1",
		});
		expect((await b.owner.status()).notice?.summary).toMatchObject({
			key: ETHERNET_ROLE_SUMMARY_KEY,
			params: { ifname: "eth0", role: "shared-lan" },
		});
		await reconcileEthernetRoles(b.deps, () => b.roles);
		expect(b.writes).toEqual([]);
	});

	it("commits only from a new session over eth0, then persists the role", async () => {
		const b = box();
		const result = await setEthernetRole(
			"eth0",
			"shared-lan",
			b.deps,
			"op1",
			b.safety(overEth, UNDO),
		);
		const id = (result.changeSafety as { id: string }).id;
		await expect(b.owner.confirm(id, overEth)).rejects.toThrow();
		await expect(
			b.owner.confirm(id, session("phone", undefined, 2_000)),
		).rejects.toThrow();
		expect(b.roles.eth0).toBeUndefined();
		const candidate = b.fake.active.get("eth0") as string;
		await b.owner.confirm(id, laterOverEth);
		expect(b.roles.eth0).toBe("shared-lan");
		expect(b.fake.profiles.get(candidate)).toMatchObject({
			id: "Wired connection 1",
			storage: "disk",
			autoconnect: true,
		});
		expect(b.fake.profiles.has(b.wired)).toBe(false);
		expect(b.frames.at(-1)).toEqual({
			name: "eth0",
			success: true,
			role: "shared-lan",
			op: "op1",
		});
	});

	it("is undone by a reboot mid-checkpoint, with the role untouched", async () => {
		const b = box();
		await setEthernetRole(
			"eth0",
			"shared-lan",
			b.deps,
			undefined,
			b.safety(overEth, UNDO),
		);
		b.fake.reboot();
		b.newBoot();
		expect(await b.restartBackend().reconcile("backend-start")).toBe("undone");
		expect(b.fake.active.get("eth0")).toBe(b.wired);
		expect(b.roles.eth0).toBeUndefined();
		expect((await b.owner.status()).notice?.reason).toBe("restart");
	});

	it("persists at once on the deliberate answer, and its undo restores the role", async () => {
		const b = box();
		const result = await setEthernetRole(
			"eth0",
			"shared-lan",
			b.deps,
			undefined,
			b.safety(overEth, KEEP),
		);
		expect(result.changeSafety?.kind).toBe("kept");
		expect(b.roles.eth0).toBe("shared-lan");
		await b.owner.undoKept(
			(result.changeSafety as { id: string }).id,
			session("phone", "wlan0", 5_000),
		);
		expect(b.roles.eth0).toBeUndefined();
		expect(b.fake.active.get("eth0")).toBe(b.wired);
	});
});

describe("a laptop on the shared LAN switching the port back to uplink", () => {
	it("follows the owned profile's new UUID and autoconnect on commit", async () => {
		const b = box({ role: "shared-lan", owned: true, settleMs: 15_000 });
		// Changed from the hotspot: another path, so no prompt.
		const creator = session("phone", "wlan0", 500);
		const result = await setEthernetRole(
			"eth0",
			"uplink",
			b.deps,
			undefined,
			b.safety(creator),
		);
		expect(result.changeSafety?.kind).toBe("pending");
		const candidate = b.fake.active.get("eth0") as string;
		expect(b.reservations.eth0).toBe(b.wired);
		b.at(1_000 + 16_000);
		await b.owner.confirm((result.changeSafety as { id: string }).id, creator);
		expect(b.roles.eth0).toBe("uplink");
		expect(b.reservations.eth0).toBe(candidate);
		expect(b.fake.profiles.get(candidate)).toMatchObject({
			id: "ceralive-shared-eth0",
			autoconnect: true,
			settings: { "ipv4.method": "auto" },
		});
	});

	it("maps the reservation back when a kept change is undone", async () => {
		const b = box({ role: "shared-lan", owned: true });
		const result = await setEthernetRole(
			"eth0",
			"uplink",
			b.deps,
			undefined,
			b.safety(session("phone", "wlan0", 500), KEEP),
		);
		const candidate = b.fake.active.get("eth0") as string;
		expect(b.reservations.eth0).toBe(candidate);
		await b.owner.undoKept(
			(result.changeSafety as { id: string }).id,
			session("phone2", "wlan0", 5_000),
		);
		expect(b.reservations.eth0).toBe(b.wired);
		expect(b.roles.eth0).toBe("shared-lan");
	});
});

describe("what stays on the existing path", () => {
	it("re-stating the current role", async () => {
		const b = box({ role: "shared-lan" });
		await setEthernetRole(
			"eth0",
			"shared-lan",
			b.deps,
			undefined,
			b.safety(overEth, UNDO),
		);
		expect(b.fake.calls).toEqual([]);
		expect(b.writes.some((w) => w.startsWith("set:"))).toBe(true);
	});

	it("a port with no active connection, which no session can ride", async () => {
		const b = box();
		b.fake.active.delete("eth0");
		await setEthernetRole(
			"eth0",
			"shared-lan",
			b.deps,
			undefined,
			b.safety(overEth, UNDO),
		);
		expect(b.fake.calls).toEqual([]);
		expect(b.writes).toContain("add");
	});

	it("an owner refusal reaches the caller with nothing persisted", async () => {
		const b = box();
		b.fake.fail.add("create");
		const result = await setEthernetRole(
			"eth0",
			"shared-lan",
			b.deps,
			"op1",
			b.safety(overEth, UNDO),
		);
		expect(result).toEqual({ success: false, error: "apply_failed" });
		expect(b.roles.eth0).toBeUndefined();
		expect(b.writes).toEqual([]);
		expect(b.frames).toEqual([]);
	});
});
