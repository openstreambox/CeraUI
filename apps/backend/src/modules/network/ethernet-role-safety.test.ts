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
	ethernetRoleOfSummary,
	ethernetRolePlan,
	NETWORK_CHANGE_SAFETY_ENV,
	networkChangeSafetyEnabled,
} from "./ethernet-role-safety.ts";
import {
	type EthernetRoleTransitionDeps,
	reapplyEthernetRoleNotice,
	reconcileEthernetRoles,
	setEthernetRole,
} from "./ethernet-role-transition.ts";
import { markFrontDoorListening } from "./front-door-state.ts";
import {
	fakeReachability,
	harness,
	session,
} from "./network-change-test-fakes.ts";
import type { SettledEvent } from "./network-checkpoint.ts";

const UNDO = "undo-automatically" as const;
const KEEP = "keep-change" as const;

/** A box with eth0 on its uplink profile, plus the role store. */
function box(
	options: {
		role?: EthernetRole;
		owned?: boolean;
		settleMs?: number;
		reachability?: ReturnType<typeof fakeReachability>["deps"];
	} = {},
) {
	const roles: Record<string, EthernetRole> = {};
	if (options.role) roles.eth0 = options.role;
	const reservations: Record<string, string> = {};
	const frames: Array<EthernetRoleOutcome & { name: string }> = [];
	const writes: string[] = [];
	let handler: ((event: SettledEvent) => void) | undefined;
	let settleFailures = 0;
	const h = harness({
		settleMs: options.settleMs ?? 15_000,
		...(options.reachability ? { reachability: options.reachability } : {}),
		onSettled: (event) => {
			if (settleFailures > 0) {
				settleFailures--;
				throw new Error("config write failed");
			}
			handler?.(event);
		},
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
			// Like `nmcli connection modify` without --temporary: on disk.
			const profile = h.fake.profiles.get(uuid);
			if (profile) {
				Object.assign(profile.settings, fields);
				profile.storage = "disk";
			}
			return true;
		},
		activate: async (uuid) => {
			writes.push(`activate:${uuid}`);
			if (h.fake.profiles.has(uuid)) h.fake.active.set("eth0", uuid);
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
		networkChangeTouches: (ifname) => h.owner.touches(ifname),
	};
	handler = createEthernetRoleSettledHandler(deps);
	const safety = (
		s: ReturnType<typeof session>,
		answer?: typeof UNDO | typeof KEEP | "keep-if-reachable",
	) => ({
		owner: h.owner,
		session: s,
		answer,
	});
	return {
		...h,
		deps,
		roles,
		reservations,
		frames,
		writes,
		wired,
		safety,
		failNextSettles: (count: number) => {
			settleFailures = count;
		},
	};
}

/** A remote operator whose session rides the wired uplink. */
const overEth = session("remote", "eth0", 500);
const laterOverEth = session("reconnected", "eth0", 1_001);

describe("the flag", () => {
	it("is off unless set to exactly 1", () => {
		const frontDoor = () => true;
		expect(networkChangeSafetyEnabled({}, frontDoor)).toBe(false);
		for (const value of ["", "0", "true", "yes", " 1"])
			expect(
				networkChangeSafetyEnabled(
					{ [NETWORK_CHANGE_SAFETY_ENV]: value },
					frontDoor,
				),
			).toBe(false);
		expect(
			networkChangeSafetyEnabled(
				{ [NETWORK_CHANGE_SAFETY_ENV]: "1" },
				frontDoor,
			),
		).toBe(true);
	});

	it("needs the front door: without it no session has arrival evidence", () => {
		expect(
			networkChangeSafetyEnabled(
				{ [NETWORK_CHANGE_SAFETY_ENV]: "1" },
				() => false,
			),
		).toBe(false);
		// The default asks whether the listener actually started, not whether
		// its directory exists.
		const env = { [NETWORK_CHANGE_SAFETY_ENV]: "1" };
		markFrontDoorListening(false);
		expect(networkChangeSafetyEnabled(env)).toBe(false);
		markFrontDoorListening(true);
		expect(networkChangeSafetyEnabled(env)).toBe(true);
		markFrontDoorListening(false);
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

describe("crash and restart paths keep the role and NetworkManager in step", () => {
	it("a change resumed after a backend restart is left alone by the role reconciler", async () => {
		const b = box({ role: "shared-lan" });
		const laptop = session("laptop", "eth0", 500);
		const result = await setEthernetRole(
			"eth0",
			"uplink",
			b.deps,
			"op1",
			b.safety(laptop, UNDO),
		);
		expect(result.changeSafety?.kind).toBe("pending");
		const candidate = b.fake.active.get("eth0") as string;
		expect(await b.restartBackend().reconcile("backend-start")).toBe("resumed");
		await reconcileEthernetRoles(b.deps, () => b.roles);
		expect(b.writes).toEqual([]);
		expect(b.fake.active.get("eth0")).toBe(candidate);
		expect(b.fake.profiles.get(candidate)).toMatchObject({
			storage: "memory",
			settings: { "ipv4.method": "auto" },
		});
	});

	it("a legacy role write to a port with a change in flight is refused", async () => {
		const b = box({ role: "shared-lan" });
		await setEthernetRole(
			"eth0",
			"uplink",
			b.deps,
			undefined,
			b.safety(session("laptop", "eth0", 500), UNDO),
		);
		const restated = await setEthernetRole("eth0", "shared-lan", b.deps, "op2");
		// Refused with its own reason, so the UI can say why.
		expect(restated).toEqual({ success: false, error: "change_in_flight" });
		expect(b.frames.at(-1)).toMatchObject({
			name: "eth0",
			error: "change_in_flight",
		});
		expect(b.writes).toEqual([]);
		expect(b.roles.eth0).toBe("shared-lan");
	});

	it("the reconciler acts on the port again once the change settled", async () => {
		const b = box({ role: "shared-lan" });
		await setEthernetRole(
			"eth0",
			"uplink",
			b.deps,
			undefined,
			b.safety(session("laptop", "eth0", 500), UNDO),
		);
		await b.fake.expireAll();
		b.at(91_001);
		await b.owner.tick();
		expect(await b.owner.touches("eth0")).toBe(false);
		await reconcileEthernetRoles(b.deps, () => b.roles);
		expect(b.writes.some((w) => w.startsWith(`set:${b.wired}`))).toBe(true);
	});

	it("a kept change whose role write failed is settled by the tick", async () => {
		const b = box();
		b.failNextSettles(1);
		const result = await setEthernetRole(
			"eth0",
			"shared-lan",
			b.deps,
			undefined,
			b.safety(session("remote", undefined, 500), KEEP),
		);
		// The change is live and kept; only saving it is unfinished, so the
		// caller hears "kept, saving" and a pending frame, not a failure.
		expect(result).toMatchObject({
			success: true,
			applied: "shared-lan",
			changeSafety: { kind: "kept", saving: true },
		});
		expect(b.frames.at(-1)).toMatchObject({
			pending: true,
			role: "shared-lan",
		});
		expect((await b.owner.status()).commitIncomplete).toBe(true);
		expect(await b.owner.touches("eth0")).toBe(true);
		expect(await b.owner.tick()).toBe(true);
		expect(b.roles.eth0).toBe("shared-lan");
		const status = await b.owner.status();
		expect(status.commitIncomplete).toBe(false);
		expect(status.kept).not.toBeNull();
		expect(await b.owner.touches("eth0")).toBe(false);
	});

	it("a kept change whose role write failed is settled at the next backend start", async () => {
		const b = box();
		b.failNextSettles(1);
		await setEthernetRole(
			"eth0",
			"shared-lan",
			b.deps,
			undefined,
			b.safety(session("remote", undefined, 500), KEEP),
		);
		expect(await b.restartBackend().reconcile("backend-start")).toBe("kept");
		expect(b.roles.eth0).toBe("shared-lan");
		expect(
			b.fake.profiles.get(b.fake.active.get("eth0") as string),
		).toMatchObject({
			storage: "disk",
			settings: { "ipv4.method": "shared" },
		});
	});

	it("a kept change lost to a reboot before it reached disk is undone and reported", async () => {
		const b = box();
		b.fake.fail.add("persist");
		await setEthernetRole(
			"eth0",
			"shared-lan",
			b.deps,
			undefined,
			b.safety(session("remote", undefined, 500), KEEP),
		);
		b.fake.fail.delete("persist");
		b.fake.reboot();
		b.newBoot();
		expect(await b.restartBackend().reconcile("backend-start")).toBe("undone");
		expect(b.fake.active.get("eth0")).toBe(b.wired);
		expect(b.roles.eth0).toBeUndefined();
		// Kept, then lost before reaching disk: not "restarted before you
		// confirmed".
		expect((await b.owner.status()).notice?.reason).toBe("unsaved");
	});

	it("a confirmation whose profile write failed is retried by the tick and shown meanwhile", async () => {
		const b = box();
		const result = await setEthernetRole(
			"eth0",
			"shared-lan",
			b.deps,
			undefined,
			b.safety(overEth, UNDO),
		);
		const id = (result.changeSafety as { id: string }).id;
		b.fake.fail.add("persist");
		await expect(b.owner.confirm(id, laterOverEth)).rejects.toThrow();
		expect((await b.owner.status()).commitIncomplete).toBe(true);
		await expect(b.owner.tick()).rejects.toThrow();
		b.fake.fail.delete("persist");
		expect(await b.owner.tick()).toBe(true);
		expect(b.roles.eth0).toBe("shared-lan");
		expect((await b.journal.read()).tx).toBeNull();
	});

	it("a reboot between the confirmation's checkpoint destroy and the profile write undoes the change", async () => {
		const b = box();
		const result = await setEthernetRole(
			"eth0",
			"shared-lan",
			b.deps,
			undefined,
			b.safety(overEth, UNDO),
		);
		const id = (result.changeSafety as { id: string }).id;
		b.fake.fail.add("persist");
		await expect(b.owner.confirm(id, laterOverEth)).rejects.toThrow();
		b.fake.fail.delete("persist");
		b.fake.reboot();
		b.newBoot();
		const owner = b.restartBackend();
		expect(await owner.reconcile("backend-start")).toBe("undone");
		expect(b.fake.active.get("eth0")).toBe(b.wired);
		expect(b.roles.eth0).toBeUndefined();
		const status = await owner.status();
		expect(status).toMatchObject({
			pending: null,
			commitIncomplete: false,
			undoIncomplete: false,
		});
		// The person did confirm: the notice says the save was lost.
		expect(status.notice?.reason).toBe("unsaved");
		// Not wedged: the next protected change goes through.
		await owner.leaveUndone(status.notice?.id as string, overEth);
		const again = await setEthernetRole(
			"eth0",
			"shared-lan",
			b.deps,
			undefined,
			{
				owner,
				session: session("remote2", "eth0", 9_000),
				answer: UNDO,
			},
		);
		expect(again.changeSafety?.kind).toBe("pending");
	});
});

describe("a remote owner whose session the change cuts", () => {
	/** A tailnet session: no arrival evidence, routed over eth0. */
	const remoteOverEth = session("tailnet", undefined, 500, {
		carriers: ["eth0"],
		tunnel: true,
		tailnetPeer: "100.101.102.103",
	});

	it("is told up front that the change cuts them, and offered keep-if-reachable", async () => {
		const probe = fakeReachability();
		const b = box({ reachability: probe.deps });
		const result = await setEthernetRole(
			"eth0",
			"shared-lan",
			b.deps,
			"op1",
			b.safety(remoteOverEth),
		);
		expect(result.success).toBe(false);
		expect(result.changeSafety).toMatchObject({
			kind: "ask-before",
			cut: "cuts",
			via: "eth0",
			canConfirm: false,
			primary: { answer: "keep-if-reachable" },
			alternative: { answer: "undo-automatically" },
			deliberate: { answer: "keep-change" },
		});
		// Nothing applied, nothing persisted, no frame.
		expect(b.fake.calls).toEqual([]);
		expect(b.roles.eth0).toBeUndefined();
		expect(b.frames).toEqual([]);
	});

	it("keep-if-reachable commits the role once the box still reaches the internet", async () => {
		const probe = fakeReachability();
		const b = box({ reachability: probe.deps });
		const result = await setEthernetRole(
			"eth0",
			"shared-lan",
			b.deps,
			"op1",
			b.safety(remoteOverEth, "keep-if-reachable"),
		);
		expect(result).toMatchObject({
			success: true,
			changeSafety: { kind: "pending" },
		});
		expect(b.frames.at(-1)).toMatchObject({ pending: true, op: "op1" });
		expect((await b.owner.status()).pending?.confirmBy).toBe("reachability");
		// Nothing is probed or persisted inside the settle time.
		b.at(10_000);
		expect(await b.owner.tick()).toBe(false);
		expect(probe.state.probes).toBe(0);
		b.at(16_001);
		expect(await b.owner.tick()).toBe(false);
		b.at(21_001);
		expect(await b.owner.tick()).toBe(true);
		expect(probe.state.probes).toBe(2);
		expect(b.roles.eth0).toBe("shared-lan");
		expect(b.frames.at(-1)).toMatchObject({
			success: true,
			role: "shared-lan",
			op: "op1",
		});
		expect(
			b.fake.profiles.get(b.fake.active.get("eth0") as string),
		).toMatchObject({ storage: "disk", settings: { "ipv4.method": "shared" } });
		expect((await b.journal.read()).tx).toBeNull();
	});

	it("keep-if-reachable is undone when the box loses the internet, with its own notice", async () => {
		const probe = fakeReachability(false);
		const b = box({ reachability: probe.deps });
		await setEthernetRole(
			"eth0",
			"shared-lan",
			b.deps,
			"op1",
			b.safety(remoteOverEth, "keep-if-reachable"),
		);
		for (let t = 16_001; t < 90_000; t += 5_000) {
			b.at(t);
			expect(await b.owner.tick()).toBe(false);
		}
		expect(probe.state.probes).toBeGreaterThan(5);
		await b.fake.expireAll();
		b.at(91_001);
		expect(await b.owner.tick()).toBe(true);
		expect(b.fake.active.get("eth0")).toBe(b.wired);
		expect(b.roles.eth0).toBeUndefined();
		expect(b.frames.at(-1)).toMatchObject({
			error: "apply_failed",
			op: "op1",
		});
		expect((await b.owner.status()).notice?.reason).toBe("unreachable");
	});

	it("a laptop on the port itself is never offered keep-if-reachable", async () => {
		const probe = fakeReachability();
		const b = box({ reachability: probe.deps });
		const laptop = session("laptop", "eth0", 500);
		const ask = await setEthernetRole(
			"eth0",
			"shared-lan",
			b.deps,
			undefined,
			b.safety(laptop),
		);
		expect(ask.changeSafety).toMatchObject({
			kind: "ask-before",
			canConfirm: true,
			primary: { answer: "undo-automatically" },
		});
		expect(ask.changeSafety).not.toHaveProperty("alternative");
		const refused = await setEthernetRole(
			"eth0",
			"shared-lan",
			b.deps,
			undefined,
			b.safety(laptop, "keep-if-reachable"),
		);
		expect(refused).toEqual({ success: false, error: "apply_failed" });
		expect(b.fake.calls).toEqual([]);
	});
});

describe("re-applying from a notice plans the role change again", () => {
	it("reads the role change back from the notice summary only", () => {
		const plan = ethernetRolePlan({
			ifname: "eth0",
			role: "shared-lan",
			previous: undefined,
			activeUuid: "00000000-0000-4000-8000-000000000001",
			owned: false,
			op: "op9",
		});
		expect(ethernetRoleOfSummary(plan.summary)).toEqual({
			ifname: "eth0",
			role: "shared-lan",
			previous: undefined,
			op: "op9",
		});
		expect(
			ethernetRoleOfSummary({ key: "network.changeSafety.summary.other" }),
		).toBeUndefined();
	});

	it("a deliberate re-plan asks before again, against the port's profile now", async () => {
		const b = box();
		// The profile on the port changed since the stored plan was made.
		const replaced = b.fake.add("Wired connection 2", {
			"ipv4.method": "auto",
		});
		b.fake.active.set("eth0", replaced);
		const other = session("phone", "wlan0", 500);
		const ask = await setEthernetRole("eth0", "shared-lan", b.deps, undefined, {
			...b.safety(other),
			deliberate: true,
		});
		expect(ask.changeSafety?.kind).toBe("ask-before");
		const pending = await setEthernetRole(
			"eth0",
			"shared-lan",
			b.deps,
			undefined,
			{ ...b.safety(other, UNDO), deliberate: true },
		);
		expect(pending.changeSafety?.kind).toBe("pending");
		// The candidate is a clone of the profile running now, not the stale one.
		expect(b.fake.calls).toContain("clone:Wired connection 2");
	});
});

describe("'Make the change' on a role notice, as the RPC runs it", () => {
	async function undoneChange() {
		const b = box();
		await setEthernetRole(
			"eth0",
			"shared-lan",
			b.deps,
			"op1",
			b.safety(session("laptop", "eth0", 500), UNDO),
		);
		await b.fake.expireAll();
		b.at(91_001);
		await b.owner.tick();
		const notice = (await b.owner.status()).notice;
		if (!notice) throw new Error("expected notice");
		return { b, notice };
	}
	const phone = session("phone", "wlan0", 95_000);

	it("plans against the port's profile now and consumes the notice in the same apply", async () => {
		const { b, notice } = await undoneChange();
		const replaced = b.fake.add("Wired connection 2", {
			"ipv4.method": "auto",
		});
		b.fake.active.set("eth0", replaced);
		const ask = await reapplyEthernetRoleNotice(
			notice,
			b.safety(phone),
			b.deps,
		);
		expect(ask?.changeSafety?.kind).toBe("ask-before");
		expect((await b.owner.status()).notice?.id).toBe(notice.id);
		const result = await reapplyEthernetRoleNotice(
			notice,
			b.safety(phone, UNDO),
			b.deps,
		);
		expect(result?.changeSafety?.kind).toBe("pending");
		expect(b.fake.calls.at(-3)).toBe("clone:Wired connection 2");
		expect((await b.owner.status()).notice).toBeNull();
	});

	it("a notice someone answered meanwhile refuses the re-apply before anything changes", async () => {
		const { b, notice } = await undoneChange();
		await b.owner.leaveUndone(notice.id, phone);
		const before = b.fake.calls.length;
		const result = await reapplyEthernetRoleNotice(
			notice,
			b.safety(phone, UNDO),
			b.deps,
		);
		expect(result?.success).toBe(false);
		expect(b.fake.calls.slice(before)).toEqual([]);
	});

	it("with no active profile on the port it refuses instead of changing the role unasked", async () => {
		const { b, notice } = await undoneChange();
		b.fake.active.delete("eth0");
		const result = await reapplyEthernetRoleNotice(
			notice,
			b.safety(phone, UNDO),
			b.deps,
		);
		expect(result).toEqual({ success: false, error: "no_connection" });
		expect(b.writes).toEqual([]);
		expect(b.roles.eth0).toBeUndefined();
	});

	it("is not for other notices", async () => {
		const b = box();
		expect(
			await reapplyEthernetRoleNotice(
				{ id: "n", summary: { key: "network.changeSafety.summary.other" } },
				b.safety(phone),
				b.deps,
			),
		).toBeUndefined();
	});

	it("a session lookup runs inside the port's queue, after earlier requests", async () => {
		const b = box();
		const order: string[] = [];
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const first = setEthernetRole("eth0", "shared-lan", b.deps, "op1", {
			owner: b.owner,
			session: async () => {
				order.push("lookup-1");
				await gate;
				return session("laptop", "eth0", 500);
			},
		});
		const second = setEthernetRole("eth0", "shared-lan", b.deps, "op2", {
			owner: b.owner,
			session: async () => {
				order.push("lookup-2");
				return session("laptop", "eth0", 500);
			},
		});
		await Promise.resolve();
		release();
		await first;
		await second;
		expect(order).toEqual(["lookup-1", "lookup-2"]);
	});
});
