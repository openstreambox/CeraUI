import { expect, test } from "bun:test";
import {
	type InternalCallBaseline,
	type InternalCallDeps,
	InternalCallOwner,
} from "./internal-call-owner.ts";
import type { CellularControl, CellularControlTarget } from "./modems.ts";
import { CARRIER_POLICIES } from "./subscription-policy.ts";
import type {
	InternalContext,
	InternalGrant,
	InternalRegistration,
} from "./transport-policy.ts";

function fixture(policyKey = "att") {
	const policy = CARRIER_POLICIES.find((row) => row.key === policyKey);
	if (!policy) throw new Error("Missing policy fixture");
	const events: string[] = [];
	let now = 0,
		current = true,
		sameSubscriber = true,
		valid = true,
		allowMutation = true,
		cleanup = true;
	let registration: InternalRegistration = "home";
	let context: InternalContext = { apn: "old.example", family: "ipv4" },
		active = false;
	let grant: InternalGrant = { family: "ipv4", ipv4: "192.0.2.10" };
	let revoked: () => void = () => {};
	let baseline: InternalCallBaseline | undefined;
	const control: CellularControl = {
		valid: async () => valid,
		verifySubscriber: async () => sameSubscriber,
		onRevoked: (callback) => {
			revoked = callback;
			return () => {
				revoked = () => {};
			};
		},
		registration: async () => registration === "home",
		registrationState: async () => {
			events.push("CEREG-read");
			return registration;
		},
		readContext: async () => context,
		contextActive: async () => active,
		defineContext: async (cid, apn, family, settings) => {
			events.push(`define-${cid}`);
			context = {
				apn,
				family,
				...(settings ? { settings: [...settings] } : {}),
			};
		},
		activateContext: async (cid, value) => {
			events.push(`active-${cid}-${value}`);
			active = value;
		},
		readGrant: async () => grant,
		readContextDns: async () => ["192.0.2.53"],
		readIpv4Grant: async () => grant.ipv4,
		readAutoConnect: async () => undefined,
		disableAutoConnect: async () => false,
		reset: async () => {
			throw new Error("No radio resets allowed");
		},
		close: async () => {
			events.push("release-MM");
		},
	};
	const deps: InternalCallDeps = {
		acquire: async () => {
			events.push("inhibit-ack");
			return control;
		},
		current: async () => current,
		now: () => now,
		baseline: async (value) => {
			events.push("durable-baseline");
			baseline = value;
		},
		mutate: async (operation, effect) => {
			if (!allowMutation) return false;
			events.push(`lease+journal-${operation}`);
			await effect();
			events.push(`confirmed-${operation}`);
			return true;
		},
		host: {
			withdraw: () => {
				events.push("withdraw");
			},
			prepare: async () => {
				events.push("RA-guard");
			},
			prepareCall: async () => {
				events.push("link-up");
			},
			grant: async () => {
				events.push("install-grant-not-ready");
			},
			clearGrant: async () => {
				events.push("clear-grant");
				return cleanup;
			},
			cleanup: async () => {
				events.push("cleanup");
				return cleanup;
			},
		},
	};
	const owner = new InternalCallOwner(
		{
			identity: {
				model: "FM350-GL",
				firmware: "81600.0000.00.29.18.01",
				mode: "rndis",
			},
		} as CellularControlTarget,
		policy,
		false,
		deps,
	);
	return {
		owner,
		events,
		control,
		deps,
		baseline: () => baseline,
		set: (values: {
			current?: boolean;
			sameSubscriber?: boolean;
			valid?: boolean;
			allowMutation?: boolean;
			registration?: InternalRegistration;
			cleanup?: boolean;
			context?: InternalContext;
			active?: boolean;
			grant?: InternalGrant;
		}) => {
			if (values.current !== undefined) current = values.current;
			if (values.sameSubscriber !== undefined)
				sameSubscriber = values.sameSubscriber;
			if (values.valid !== undefined) valid = values.valid;
			if (values.allowMutation !== undefined)
				allowMutation = values.allowMutation;
			if (values.registration !== undefined) registration = values.registration;
			if (values.cleanup !== undefined) cleanup = values.cleanup;
			if (values.context !== undefined) context = values.context;
			if (values.active !== undefined) active = values.active;
			if (values.grant !== undefined) grant = values.grant;
		},
		tick: async () => {
			now += 1_000;
			await owner.observe();
		},
		revoke: () => {
			valid = false;
			revoked();
		},
	};
}

test("self-registration is observed without COPS; four stable reads precede a reversible call", async () => {
	const f = fixture();
	expect(await f.owner.start()).toBe(true);
	for (let i = 0; i < 3; i++) await f.tick();
	expect(f.events.some((event) => event.startsWith("define"))).toBe(false);
	await f.tick();
	expect(f.owner.phase).toBe("granted");
	expect(f.events.indexOf("durable-baseline")).toBeLessThan(
		f.events.indexOf("define-1"),
	);
	expect(f.events.indexOf("RA-guard")).toBeLessThan(
		f.events.indexOf("inhibit-ack"),
	);
	expect(f.events.indexOf("RA-guard")).toBeLessThan(
		f.events.indexOf("active-1-true"),
	);
	expect(f.events.indexOf("inhibit-ack")).toBeLessThan(
		f.events.indexOf("link-up"),
	);
	expect(f.events.indexOf("link-up")).toBeLessThan(
		f.events.indexOf("active-1-true"),
	);
	expect(f.events.at(-1)).toBe("install-grant-not-ready");
	expect(f.baseline()?.context.apn).toBe("old.example");
	expect(await f.owner.close()).toBe(true);
	expect(f.events.indexOf("withdraw")).toBeLessThan(
		f.events.indexOf("cleanup"),
	);
	expect(f.events.at(-1)).toBe("release-MM");
	expect(await f.control.readContext(1)).toEqual({
		apn: "old.example",
		family: "ipv4",
	});
});

test("roaming refusal and unknown registration break the consecutive-read sequence", async () => {
	const f = fixture();
	await f.owner.start();
	await f.tick();
	await f.tick();
	f.set({ registration: "roaming" });
	await f.tick();
	f.set({ registration: "home" });
	for (let i = 0; i < 3; i++) await f.tick();
	expect(f.owner.phase).toBe("waiting-registration");
	f.set({ registration: "unknown" });
	await f.tick();
	expect(f.events.includes("active-1-true")).toBe(false);
});

test("lease refusal retries no hardware, and a foreign active context is preserved", async () => {
	const f = fixture();
	f.set({ allowMutation: false });
	expect(await f.owner.start()).toBe(false);
	expect(f.events).toEqual([]);
	f.set({ allowMutation: true, active: true });
	await f.owner.start();
	for (let i = 0; i < 4; i++) await f.tick();
	expect(f.owner.phase).toBe("blocked");
	expect(f.baseline()).toBeUndefined();
	expect(f.events.some((event) => event.startsWith("define"))).toBe(false);
});

test("Verizon remains unqualified, including the pre-registration owner", async () => {
	const f = fixture("verizon");
	expect(f.owner.cid).toBe(3);
	expect(await f.owner.start()).toBe(false);
	expect(f.events).toEqual([]);
});

test("SIM replacement and bus revocation withdraw before cleanup, never publish an old grant", async () => {
	const f = fixture();
	await f.owner.start();
	for (let i = 0; i < 4; i++) await f.tick();
	f.events.length = 0;
	f.set({ sameSubscriber: false });
	await f.tick();
	expect(f.events).toEqual(["withdraw", "cleanup", "release-MM"]);
	expect(await f.owner.close()).toBe(false); // The modem inverse remains unconfirmed.
	const g = fixture();
	await g.owner.start();
	g.events.length = 0;
	g.revoke();
	expect(g.events).toEqual(["withdraw"]);
	await g.tick();
	expect(g.events).toEqual(["withdraw", "withdraw", "cleanup", "release-MM"]);
});

test("health reconnect retains the original baseline; failed consumer withdrawal holds control", async () => {
	const f = fixture();
	await f.owner.start();
	for (let i = 0; i < 4; i++) await f.tick();
	f.set({ cleanup: false });
	expect(await f.owner.reconnect()).toBe(false);
	expect(f.events.includes("active-1-false")).toBe(false);
	expect(await f.owner.close()).toBe(false);
	expect(f.events.includes("release-MM")).toBe(false);
	f.set({ cleanup: true });
	expect(await f.owner.reconnect()).toBe(true);
	for (let i = 0; i < 4; i++) await f.tick();
	expect(f.owner.phase).toBe("granted");
	expect(f.events.filter((event) => event === "durable-baseline")).toHaveLength(
		1,
	);
	expect(await f.owner.close()).toBe(true);
	expect(await f.control.readContext(1)).toEqual({
		apn: "old.example",
		family: "ipv4",
	});
});

test("the complete context baseline is restored and an outside tail-setting edit is preserved", async () => {
	const f = fixture();
	const settings = ["0.0.0.0", "0", "0"];
	f.set({ context: { apn: "", family: "ipv4v6", settings } });
	await f.owner.start();
	for (let i = 0; i < 4; i++) await f.tick();
	expect(f.owner.phase).toBe("granted");
	f.set({
		context: {
			apn: "broadband",
			family: "ipv4v6",
			settings: ["0.0.0.0", "1", "0"],
		},
	});
	await expect(f.owner.close()).rejects.toThrow("outside its owner");
	expect(f.events).not.toContain("active-1-false");
	f.set({ context: { apn: "broadband", family: "ipv4v6", settings } });
	expect(await f.owner.close()).toBe(true);
	expect(await f.control.readContext(1)).toEqual({
		apn: "",
		family: "ipv4v6",
		settings,
	});
});

test("a failed handoff retains inhibition until its partial host state can be reversed", async () => {
	const f = fixture();
	f.set({ sameSubscriber: false, cleanup: false });
	await expect(f.owner.start()).rejects.toThrow("subscription changed");
	expect(f.owner.phase).toBe("blocked");
	expect(f.events).not.toContain("release-MM");
	f.set({ cleanup: true });
	expect(await f.owner.close()).toBe(true);
	expect(f.events.at(-1)).toBe("release-MM");
});
