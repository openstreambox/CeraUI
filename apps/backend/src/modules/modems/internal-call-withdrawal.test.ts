import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	readPrivateJson,
	writePrivateJson,
} from "../../helpers/private-json-state.ts";
import {
	type CellularHandoffIO,
	CellularHostHandoff,
} from "../network/cellular-host-handoff.ts";
import { resetRecoveryBarrier } from "../streaming/recovery-barrier.ts";
import {
	accessInternalCallAuthority,
	internalCallAuthorityKey,
	parseInternalCallAuthority,
} from "./internal-call-authority.ts";
import { InternalCallAuthoritySession } from "./internal-call-authority-session.ts";
import {
	type InternalCallWithdrawalDeps,
	withdrawInternalCall,
} from "./internal-call-withdrawal.ts";
import { internalContextAuthorityKey } from "./internal-context-authority.ts";

async function fixture(
	run: (value: Awaited<ReturnType<typeof state>>) => Promise<void>,
) {
	const dir = await mkdtemp(join(tmpdir(), "internal-withdrawal-")),
		saved = process.env.CERALIVE_CELLULAR_INTERNAL_OWNER_STATE_DIR;
	process.env.CERALIVE_CELLULAR_INTERNAL_OWNER_STATE_DIR = dir;
	resetRecoveryBarrier();
	try {
		await run(await state(dir));
	} finally {
		if (saved === undefined)
			delete process.env.CERALIVE_CELLULAR_INTERNAL_OWNER_STATE_DIR;
		else process.env.CERALIVE_CELLULAR_INTERNAL_OWNER_STATE_DIR = saved;
		resetRecoveryBarrier();
		await rm(dir, { recursive: true, force: true });
	}
}
async function state(dir: string) {
	const unit = "a".repeat(64),
		owner = "b".repeat(64),
		epoch = "c".repeat(64),
		key = internalCallAuthorityKey(unit),
		bootId = "11111111-1111-4111-8111-111111111111",
		physical = {
			ifname: "wwan0",
			ifindex: "17",
			usbDevice: "synthetic-usb",
			netDevice: "synthetic-net",
			generation: "one",
		};
	const initial = parseInternalCallAuthority(
		{
			version: 1,
			key,
			unit,
			owner,
			epoch,
			bootId,
			stableKey: "synthetic-key",
			physical,
			identity: {
				model: "FM350-GL",
				firmware: "81600.0000.00.29.18.01",
				mode: "rndis",
			},
			subscription: "d".repeat(64),
			cid: 1,
			contextKey: internalContextAuthorityKey(unit, 1),
			contextExpected: false,
			contextReleased: false,
			phase: "holding",
			handoff: null,
		},
		key,
	);
	let held = true,
		withdrawn = false,
		releases = 0,
		ctxAllowed = true,
		removeReplyLost = false,
		closeReplyLost = false,
		ctxCalls = 0,
		closeCalls = 0;
	let ra: "0" | "1" = "1",
		up = false,
		managed = true;
	const events: string[] = [];
	const session = new InternalCallAuthoritySession(initial, {
		owned: () => held,
		withdrawn: () => withdrawn,
		release: () => {
			held = false;
			releases++;
		},
		access: (selectedUnit, operation) =>
			accessInternalCallAuthority(selectedUnit, async (value, write) =>
				operation(value, async (next) => {
					await write(next);
					if (!next && removeReplyLost) {
						removeReplyLost = false;
						throw new Error("Removal acknowledgement lost");
					}
				}),
			),
	});
	expect(await session.create()).toBe(true);
	const device = {
		path: "/org/freedesktop/NetworkManager/Devices/1",
		udi: "synthetic-net",
		iface: "wwan0",
		ipIface: "",
		managed: true,
	};
	const io: CellularHandoffIO = {
		present: async () => true,
		resourceState: async () => "present",
		nmRestored: async () => false,
		readRaDefault: async () => ra,
		setRaDefault: async (_old, next) => {
			ra = next;
			events.push(`ra-${next}`);
			return true;
		},
		readUp: async () => up,
		setUp: async (_old, next) => {
			up = next;
			events.push(`up-${next}`);
			return true;
		},
		nm: {
			owner: ":1.17",
			devices: [device],
			valid: () => true,
			onRevoked: () => () => {},
			close: async () => {},
			read: async () => ({ ...device, managed }),
			setManaged: async (_device, _old, next) => {
				managed = next;
				events.push(`nm-${next}`);
				return true;
			},
		},
	};
	const handoff = new CellularHostHandoff(owner, epoch, physical, io, {
		bootId,
		read: () => session.readHandoff(),
		write: (value) => session.writeHandoff(value),
		current: async () => session.holding(),
		withdraw: () => {
			events.push("withdraw");
		},
		fence: async () => {},
		consumersReleased: async () => withdrawn,
	});
	await handoff.prepare();
	await handoff.prepareCall();
	events.length = 0;
	const deps = {
		retirement: session.retirement,
		withdraw: () => {
			events.push("withdraw");
		},
		clearGrant: async () => {
			withdrawn = true;
			return true;
		},
		context: async () => {
			if (!ctxAllowed) return false;
			ctxCalls++;
			events.push("context-released");
			return true;
		},
		host: () => handoff.cleanup(),
		control: async () => {
			closeCalls++;
			events.push("control-close");
			if (closeReplyLost) {
				closeReplyLost = false;
				throw new Error("Control acknowledgement lost");
			}
		},
	} satisfies InternalCallWithdrawalDeps;
	return {
		session,
		deps,
		events,
		initial,
		key,
		dir,
		state: () => ({
			held,
			withdrawn,
			releases,
			ra,
			managed,
			up,
			ctxCalls,
			closeCalls,
		}),
		read: () => readPrivateJson({ dir }, key),
		write: (value: unknown) => writePrivateJson({ dir }, key, value),
		set: (next: {
			ctxAllowed?: boolean;
			removeReplyLost?: boolean;
			closeReplyLost?: boolean;
			withdrawn?: boolean;
		}) => {
			if (next.ctxAllowed !== undefined) ctxAllowed = next.ctxAllowed;
			if (next.removeReplyLost !== undefined)
				removeReplyLost = next.removeReplyLost;
			if (next.closeReplyLost !== undefined)
				closeReplyLost = next.closeReplyLost;
			if (next.withdrawn !== undefined) withdrawn = next.withdrawn;
		},
	};
}

test("a durable context-release cursor precedes host restoration and survives uncertain uninhibition", async () =>
	fixture(async (f) => {
		f.set({ ctxAllowed: false });
		expect(await withdrawInternalCall(f.deps)).toBe(false);
		expect(f.state()).toMatchObject({
			held: true,
			releases: 0,
			ra: "0",
			managed: false,
			up: true,
		});
		expect(
			parseInternalCallAuthority(await f.read(), f.key).contextReleased,
		).toBe(false);
		f.set({ ctxAllowed: true, closeReplyLost: true });
		await expect(withdrawInternalCall(f.deps)).rejects.toThrow(
			"Control acknowledgement lost",
		);
		expect(f.state()).toMatchObject({
			held: true,
			releases: 0,
			ra: "1",
			managed: true,
			up: false,
			ctxCalls: 1,
		});
		const cursor = parseInternalCallAuthority(await f.read(), f.key);
		expect(cursor.contextReleased).toBe(true);
		expect(cursor.handoff).toBeNull();
		f.deps.context = async () => {
			throw new Error("Context must not repeat after host restoration");
		};
		expect(await withdrawInternalCall(f.deps)).toBe(true);
		expect(f.state()).toMatchObject({
			held: false,
			releases: 1,
			ctxCalls: 1,
			closeCalls: 2,
		});
		expect(await f.read()).toBeUndefined();
	}));

test("an unacknowledged file removal retries only its retirement tail and keeps the physical lease", async () =>
	fixture(async (f) => {
		f.set({ removeReplyLost: true });
		await expect(withdrawInternalCall(f.deps)).rejects.toThrow(
			"Removal acknowledgement lost",
		);
		expect(await f.read()).toBeUndefined();
		expect(f.state()).toMatchObject({
			held: true,
			releases: 0,
			ctxCalls: 1,
			closeCalls: 1,
		});
		const forbidden = async () => {
			throw new Error("Retirement tail cannot repeat hardware effects");
		};
		f.deps.context = forbidden;
		f.deps.host = forbidden;
		f.deps.control = forbidden;
		expect(await withdrawInternalCall(f.deps)).toBe(true);
		expect(f.state()).toMatchObject({
			held: false,
			releases: 1,
			ctxCalls: 1,
			closeCalls: 1,
		});
		expect(await f.read()).toBeUndefined();
	}));

test("a replacement authority after a lost removal acknowledgement is never deleted by the old tail", async () =>
	fixture(async (f) => {
		f.set({ removeReplyLost: true });
		await expect(withdrawInternalCall(f.deps)).rejects.toThrow(
			"Removal acknowledgement lost",
		);
		const foreign = {
			...f.initial,
			owner: "e".repeat(64),
			epoch: "f".repeat(64),
		};
		await f.write(foreign);
		await expect(withdrawInternalCall(f.deps)).rejects.toThrow("replaced");
		expect(await f.read()).toEqual(foreign);
		expect(f.state()).toMatchObject({ held: true, releases: 0 });
	}));

test("host inverse state cannot be replaced, erased early or withdrawn before its context", async () =>
	fixture(async (f) => {
		const value = await f.session.readHandoff();
		if (!value) throw new Error("Synthetic handoff missing");
		await expect(f.session.writeHandoff(undefined)).rejects.toThrow(
			"forgotten",
		);
		const changed = {
			...value,
			plan: {
				...value.plan,
				device: { ...value.plan.device, udi: "other-unit" },
			},
		};
		await expect(f.session.writeHandoff(changed)).rejects.toThrow("replaced");
		await f.session.retirement.begin();
		await expect(
			f.session.writeHandoff({ ...value, phase: "withdrawing" }),
		).rejects.toThrow("context release");
		expect(f.state()).toMatchObject({ held: true, ra: "0", managed: false });
		expect(await withdrawInternalCall(f.deps)).toBe(true);
	}));

test("a known handoff cannot disappear or change its baseline through a foreign file rewrite", async () =>
	fixture(async (f) => {
		const original = parseInternalCallAuthority(await f.read(), f.key);
		if (!original.handoff) throw new Error("Synthetic handoff unavailable");
		await f.write({ ...original, handoff: null });
		await expect(f.session.load()).rejects.toThrow("replaced");
		await f.write({
			...original,
			handoff: {
				...original.handoff,
				plan: { ...original.handoff.plan, raDefault: "0" },
				steps: ["nm-unmanaged", "link-up"],
				cursor: 2,
			},
		});
		await expect(f.session.load()).rejects.toThrow("replaced");
		await f.write(original);
		expect(await withdrawInternalCall(f.deps)).toBe(true);
	}));
