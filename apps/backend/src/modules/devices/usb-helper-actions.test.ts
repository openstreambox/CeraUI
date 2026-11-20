import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { call } from "@orpc/server";
import {
	helperOfferProcedure,
	helperRetryPortProcedure,
	helperUsb2Procedure,
} from "../../rpc/procedures/devices.procedure.ts";
import type { AppWebSocket, RPCContext } from "../../rpc/types.ts";
import {
	heldModemMutations,
	resetLifecycleInterlock,
	tryAcquireModemMutation,
} from "../streaming/lifecycle-admission.ts";
import { updateStatus } from "../streaming/streaming.ts";
import {
	bindUsb2Target,
	captureHelperSeen,
	HELPER_ACTION_COOLDOWN_MS,
	HELPER_REARM_MAX,
	pollHelperInterlock,
	resetHelperActionGuardForTest,
	setHelperActionDepsForTest,
	TYPEC_SUBJECT,
	TYPEC_UNIT,
	type Usb2Bound,
} from "./usb-helper-actions.ts";
import { helperUnitArgv } from "./usb-helper-start.ts";
import { readUsbTree } from "./usb-tree.ts";

const TYPEC_REL = "etc/systemd/system/ceralive-typec-recheck.service";
const USB2_REL = "etc/systemd/system/ceralive-modem-usbspeed@.service";

const ONESHOT = "[Service]\nType=oneshot\nExecStart=/bin/true\n";
const USB2_BOUND: Usb2Bound = {
	unit: "ceralive-modem-usbspeed@2-1.4.service",
	leaseKey: "platform-fc800000.usb-usb-0:1.4",
	scope: "socket:M2B",
};
const CRASH_ID = "11111111-1111-4111-8111-111111111111";

let root = "";
let now = 1_000;
const started: string[] = [];
const logs: string[] = [];
let published = 0;

function callerContext(options?: {
	readonly authenticated?: boolean;
	readonly senderId?: string;
	readonly remoteAddress?: string;
}): RPCContext {
	const authenticated = options?.authenticated ?? true;
	const senderId = options?.senderId;
	const ws = {
		remoteAddress: options?.remoteAddress ?? "127.0.0.1",
	} as AppWebSocket;
	return {
		ws,
		isAuthenticated: () => authenticated,
		authenticate: () => undefined,
		deauthenticate: () => undefined,
		markActive: () => undefined,
		getLastActive: () => 0,
		setSenderId: () => undefined,
		getSenderId: () => senderId,
		clearSenderId: () => undefined,
	};
}

async function plant(rel: string, body = ONESHOT): Promise<void> {
	const path = join(root, rel);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, body);
}

async function readEntries(): Promise<Array<Record<string, unknown>>> {
	const dir = join(root, "run/ceralive/devices-actions");
	const names = await readdir(dir);
	const entries: Array<Record<string, unknown>> = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		entries.push(
			JSON.parse(await readFile(join(dir, name), "utf8")) as Record<
				string,
				unknown
			>,
		);
	}
	return entries;
}

function realAdmit(key: string) {
	const admission = tryAcquireModemMutation(key);
	if (!admission.admitted) {
		return { ok: false as const, refusal: admission.refusal };
	}
	return { ok: true as const, release: admission.lease.release };
}

function useDeps(extra?: {
	readonly liveStream?: () => boolean | Promise<boolean>;
	readonly admit?: (
		key: string,
	) => { ok: true; release: () => void } | { ok: false; refusal: string };
	readonly startUnit?: (unit: string) => Promise<void>;
	readonly beforeLease?: () => Promise<void>;
	readonly unitActive?: (unit: string) => Promise<boolean>;
	readonly unitWaitMs?: number;
	readonly resolveUsb2?: (key: string) => Promise<Usb2Bound | null>;
	readonly stableKey?: (ifname: string) => string | undefined;
	readonly sleep?: () => Promise<void>;
}): void {
	setHelperActionDepsForTest({
		root,
		now: () => now,
		watch: false,
		unitWaitMs: extra?.unitWaitMs ?? 0,
		pollMs: 1,
		sleep: extra?.sleep ?? (async () => undefined),
		publish: async () => {
			published += 1;
		},
		startUnit:
			extra?.startUnit ??
			(async (unit) => {
				started.push(unit);
			}),
		liveStream: extra?.liveStream ?? (() => false),
		admit: extra?.admit ?? (() => ({ ok: true as const, release() {} })),
		unitActive: extra?.unitActive ?? (async () => false),
		log: (message, fields) => {
			logs.push(JSON.stringify({ message, fields }));
		},
		...(extra?.beforeLease === undefined
			? {}
			: { beforeLease: extra.beforeLease }),
		...(extra?.resolveUsb2 === undefined
			? {}
			: { resolveUsb2: extra.resolveUsb2 }),
		...(extra?.stableKey === undefined ? {} : { stableKey: extra.stableKey }),
	});
}

async function fresh(): Promise<void> {
	root = await mkdtemp(join(tmpdir(), "ceraui-helper-action-"));
	now = 1_000;
	started.length = 0;
	logs.length = 0;
	published = 0;
	resetLifecycleInterlock();
	updateStatus(false);
	useDeps();
}

async function plantJournal(entry: Record<string, unknown>): Promise<void> {
	await plant(
		`run/ceralive/devices-actions/${String(entry.id)}.json`,
		JSON.stringify(entry),
	);
}

afterEach(async () => {
	resetHelperActionGuardForTest();
	resetLifecycleInterlock();
	updateStatus(false);
	if (root !== "") await rm(root, { recursive: true, force: true });
	root = "";
});

describe("helper action RPCs", () => {
	test("refuses a local session that is not signed in", async () => {
		await fresh();
		await plant(TYPEC_REL);
		const result = await call(
			helperRetryPortProcedure,
			{ confirmed: true },
			{ context: callerContext({ authenticated: false }) },
		);
		expect(result).toEqual({ ok: false, refusal: "not_helper" });
		expect(started).toEqual([]);
	});

	test("refuses the cloud control channel", async () => {
		await fresh();
		await plant(TYPEC_REL);
		const result = await call(
			helperRetryPortProcedure,
			{ confirmed: true },
			{
				context: callerContext({
					authenticated: true,
					remoteAddress: "control-channel",
				}),
			},
		);
		expect(result).toEqual({ ok: false, refusal: "remote_channel" });
		const signedOut = await call(
			helperRetryPortProcedure,
			{ confirmed: true },
			{
				context: callerContext({
					authenticated: false,
					remoteAddress: "control-channel",
				}),
			},
		);
		expect(signedOut).toEqual({ ok: false, refusal: "remote_channel" });
		expect(started).toEqual([]);
	});

	test("refuses a relayed sender on a local socket", async () => {
		await fresh();
		await plant(TYPEC_REL);
		const result = await call(
			helperUsb2Procedure,
			{ confirmed: true, key: "modem" },
			{ context: callerContext({ senderId: "relay-1" }) },
		);
		expect(result).toEqual({ ok: false, refusal: "remote_channel" });
		expect(started).toEqual([]);
	});

	test("refuses a live stream even when the operator confirmed", async () => {
		await fresh();
		await plant(TYPEC_REL);
		await plant("proc/device-tree/compatible", "radxa,rock-5b-plus\0");
		await plant("run/ceralive-typec/rearm", "1\n");
		useDeps({ liveStream: () => true });
		const result = await call(
			helperRetryPortProcedure,
			{ confirmed: true },
			{ context: callerContext() },
		);
		expect(result).toEqual({ ok: false, refusal: "streaming_active" });
		expect(started).toEqual([]);
		expect(published).toBe(0);
	});

	test("refuses the streaming admission lease even when the operator confirmed", async () => {
		await fresh();
		await plant(TYPEC_REL);
		await plant("proc/device-tree/compatible", "radxa,rock-5b-plus\0");
		await plant("run/ceralive-typec/rearm", "0\n");
		useDeps({
			liveStream: () => false,
			admit: () => ({ ok: false, refusal: "streaming_active" }),
		});
		const result = await call(
			helperRetryPortProcedure,
			{ confirmed: true },
			{ context: callerContext() },
		);
		expect(result).toEqual({ ok: false, refusal: "streaming_active" });
		expect(started).toEqual([]);
	});

	test("rejects an override field instead of starting", async () => {
		await fresh();
		await plant(TYPEC_REL);
		await plant("proc/device-tree/compatible", "radxa,rock-5b-plus\0");
		await expect(
			call(
				helperRetryPortProcedure,
				{ confirmed: true, override: true } as { confirmed: boolean },
				{ context: callerContext() },
			),
		).rejects.toThrow();
		expect(started).toEqual([]);
	});

	test("hides the offer and refuses the RPC when the typec unit is absent", async () => {
		await fresh();
		await plant("proc/device-tree/compatible", "radxa,rock-5b-plus\0");
		const offer = await call(helperOfferProcedure, undefined, {
			context: callerContext(),
		});
		expect(offer).toEqual({
			ok: true,
			retryPort: false,
			rearmExhausted: false,
			usb2: false,
		});
		const result = await call(
			helperRetryPortProcedure,
			{ confirmed: true },
			{ context: callerContext() },
		);
		expect(result).toEqual({ ok: false, refusal: "unit_absent" });
		expect(started).toEqual([]);
	});

	test("hides the offer and refuses the RPC when the usb2 unit is absent", async () => {
		await fresh();
		await plant("proc/device-tree/compatible", "radxa,rock-5b-plus\0");
		useDeps({ resolveUsb2: async () => USB2_BOUND });
		const offer = await call(helperOfferProcedure, undefined, {
			context: callerContext(),
		});
		expect(offer.ok).toBe(true);
		if (offer.ok) expect(offer.usb2).toBe(false);
		const result = await call(
			helperUsb2Procedure,
			{ confirmed: true, key: "modem" },
			{ context: callerContext() },
		);
		expect(result).toEqual({ ok: false, refusal: "unit_absent" });
		expect(started).toEqual([]);
	});

	test("treats a symlink unit as absent", async () => {
		await fresh();
		const path = join(root, TYPEC_REL);
		await mkdir(dirname(path), { recursive: true });
		await symlink("/etc/hostname", path);
		await plant("proc/device-tree/compatible", "radxa,rock-5b-plus\0");
		const offer = await call(helperOfferProcedure, undefined, {
			context: callerContext(),
		});
		expect(offer).toMatchObject({ retryPort: false, rearmExhausted: false });
		const result = await call(
			helperRetryPortProcedure,
			{ confirmed: true },
			{ context: callerContext() },
		);
		expect(result).toEqual({ ok: false, refusal: "unit_absent" });
		expect(started).toEqual([]);
	});

	test("refuses when the re-arm budget is spent and does not rewrite it", async () => {
		await fresh();
		await plant(TYPEC_REL);
		await plant("proc/device-tree/compatible", "radxa,rock-5b-plus\0");
		await plant("run/ceralive-typec/rearm", "3\n");
		const before = await readFile(
			join(root, "run/ceralive-typec/rearm"),
			"utf8",
		);
		const offer = await call(helperOfferProcedure, undefined, {
			context: callerContext(),
		});
		expect(offer).toMatchObject({
			retryPort: false,
			rearmExhausted: true,
		});
		const result = await call(
			helperRetryPortProcedure,
			{ confirmed: true },
			{ context: callerContext() },
		);
		expect(result).toEqual({ ok: false, refusal: "budget_exhausted" });
		expect(started).toEqual([]);
		expect(await readFile(join(root, "run/ceralive-typec/rearm"), "utf8")).toBe(
			before,
		);
		expect(HELPER_REARM_MAX).toBe(3);
	});

	test("a second tap while the first is running does not start a second unit", async () => {
		await fresh();
		await plant(TYPEC_REL);
		await plant("proc/device-tree/compatible", "radxa,rock-5b-plus\0");
		await plant("run/ceralive-typec/rearm", "1\n");
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let entered!: () => void;
		const enteredGate = new Promise<void>((resolve) => {
			entered = resolve;
		});
		useDeps({
			startUnit: async (unit) => {
				started.push(unit);
				entered();
				await gate;
			},
		});
		const first = call(
			helperRetryPortProcedure,
			{ confirmed: true },
			{ context: callerContext() },
		);
		await enteredGate;
		const second = await call(
			helperRetryPortProcedure,
			{ confirmed: true },
			{ context: callerContext() },
		);
		expect(second).toEqual({ ok: false, refusal: "action_in_progress" });
		expect(started).toEqual([TYPEC_UNIT]);
		release();
		expect(await first).toEqual({ ok: true });
		expect(started).toEqual([TYPEC_UNIT]);
	});

	test("a second tap inside the cooldown does not start a second unit", async () => {
		await fresh();
		await plant(TYPEC_REL);
		await plant("proc/device-tree/compatible", "radxa,rock-5b-plus\0");
		await plant("run/ceralive-typec/rearm", "1\n");
		expect(
			await call(
				helperRetryPortProcedure,
				{ confirmed: true },
				{ context: callerContext() },
			),
		).toEqual({ ok: true });
		now += HELPER_ACTION_COOLDOWN_MS - 1;
		const second = await call(
			helperRetryPortProcedure,
			{ confirmed: true },
			{ context: callerContext() },
		);
		expect(second).toEqual({ ok: false, refusal: "cooldown" });
		expect(started).toEqual([TYPEC_UNIT]);
	});

	test("a crash between journal start and end is not a success", async () => {
		await fresh();
		await plant("proc/device-tree/compatible", "radxa,rock-5b-plus\0");
		await plantJournal({
			id: CRASH_ID,
			action: "retry-port",
			unit: TYPEC_UNIT,
			scope: "socket:C",
			leaseKey: TYPEC_SUBJECT,
			phase: "started",
			process: "dead-process",
			at: 1,
		});
		const result = await call(
			helperRetryPortProcedure,
			{ confirmed: true },
			{ context: callerContext() },
		);
		expect(result).toEqual({ ok: false, refusal: "unit_absent" });
		expect(started).toEqual([]);
		const entries = await readEntries();
		expect(entries).toEqual([
			{
				id: CRASH_ID,
				action: "retry-port",
				unit: TYPEC_UNIT,
				scope: "socket:C",
				leaseKey: TYPEC_SUBJECT,
				phase: "failed",
				process: "dead-process",
				at: now,
				detail: "interrupted",
			},
		]);
	});

	test("starts the typec unit, journals both ends, and leaves the re-arm file alone", async () => {
		await fresh();
		await plant(TYPEC_REL);
		await plant("proc/device-tree/compatible", "radxa,rock-5b-plus\0");
		await plant("run/ceralive-typec/rearm", "1\n");
		useDeps({
			admit: realAdmit,
			startUnit: async (unit) => {
				const mid = await readEntries();
				expect(mid).toHaveLength(1);
				expect(mid[0]?.phase).toBe("started");
				expect(mid[0]?.unit).toBe(TYPEC_UNIT);
				expect(heldModemMutations()).toContain(TYPEC_SUBJECT);
				started.push(unit);
			},
		});
		const result = await call(
			helperRetryPortProcedure,
			{ confirmed: true },
			{ context: callerContext() },
		);
		expect(result).toEqual({ ok: true });
		expect(started).toEqual([TYPEC_UNIT]);
		expect(published).toBe(1);
		expect(heldModemMutations()).toEqual([]);
		expect(await readFile(join(root, "run/ceralive-typec/rearm"), "utf8")).toBe(
			"1\n",
		);
		const done = await readEntries();
		expect(done[0]?.phase).toBe("finished");
	});

	test("starts the usb2 instance for the remembered port and does not inhibit ModemManager", async () => {
		await fresh();
		await plant(USB2_REL);
		await plant("proc/device-tree/compatible", "radxa,rock-5b-plus\0");
		useDeps({
			resolveUsb2: async (key) => (key === "modem" ? USB2_BOUND : null),
			startUnit: async (unit) => {
				started.push(unit);
			},
		});
		const offer = await call(helperOfferProcedure, undefined, {
			context: callerContext(),
		});
		expect(offer).toMatchObject({ usb2: true });
		const result = await call(
			helperUsb2Procedure,
			{ confirmed: true, key: "modem" },
			{ context: callerContext() },
		);
		expect(result).toEqual({ ok: true });
		expect(started).toEqual(["ceralive-modem-usbspeed@2-1.4.service"]);
		expect(published).toBe(1);
		const missing = await call(
			helperUsb2Procedure,
			{ confirmed: true, key: "other" },
			{ context: callerContext() },
		);
		expect(missing).toEqual({ ok: false, refusal: "identity_unresolved" });
		expect(helperUnitArgv("ceralive-modem-usbspeed@2-1.4.service")).toEqual([
			"systemctl",
			"start",
			"ceralive-modem-usbspeed@2-1.4.service",
		]);
		expect(helperUnitArgv("ceralive-modem-usbspeed@$(id).service")).toBeNull();
		const starter = readFileSync(
			new URL("./usb-helper-start.ts", import.meta.url),
			"utf8",
		);
		expect(starter).not.toContain("mmcli");
		expect(starter).not.toContain("inhibit");
		const actions = readFileSync(
			new URL("./usb-helper-actions.ts", import.meta.url),
			"utf8",
		);
		expect(actions).toContain("does not call mmcli");
	});

	test("refuses when the operator has not confirmed", async () => {
		await fresh();
		await plant(TYPEC_REL);
		await plant("proc/device-tree/compatible", "radxa,rock-5b-plus\0");
		await plant("run/ceralive-typec/rearm", "0\n");
		const result = await call(
			helperRetryPortProcedure,
			{ confirmed: false },
			{ context: callerContext() },
		);
		expect(result).toEqual({ ok: false, refusal: "not_confirmed" });
		expect(started).toEqual([]);
	});

	test("refuses when a stream goes live before the lease is held", async () => {
		await fresh();
		await plant(TYPEC_REL);
		await plant("proc/device-tree/compatible", "radxa,rock-5b-plus\0");
		await plant("run/ceralive-typec/rearm", "0\n");
		useDeps({
			admit: realAdmit,
			beforeLease: async () => {
				updateStatus(true);
			},
			liveStream: async () => {
				const { getIsStreaming } = await import("../streaming/streaming.ts");
				return getIsStreaming();
			},
		});
		const result = await call(
			helperRetryPortProcedure,
			{ confirmed: true },
			{ context: callerContext() },
		);
		expect(result).toEqual({ ok: false, refusal: "streaming_active" });
		expect(started).toEqual([]);
		expect(heldModemMutations()).toEqual([]);
	});

	test("keeps the lease when the client times out and the unit is still active", async () => {
		await fresh();
		await plant(TYPEC_REL);
		await plant("proc/device-tree/compatible", "radxa,rock-5b-plus\0");
		await plant("run/ceralive-typec/rearm", "0\n");
		useDeps({
			admit: realAdmit,
			unitActive: async () => true,
			startUnit: async (unit) => {
				started.push(unit);
				throw new Error(
					"Spawn timed out: systemctl start ceralive-modem-usbspeed@2-1.4.service",
				);
			},
		});
		const result = await call(
			helperRetryPortProcedure,
			{ confirmed: true },
			{ context: callerContext() },
		);
		expect(result).toEqual({ ok: false, refusal: "start_failed" });
		expect(heldModemMutations().length).toBeGreaterThan(0);
		expect(logs.join("\n")).not.toContain("2-1.4");
		expect(logs.join("\n")).not.toContain("systemctl");
		expect((await readEntries())[0]?.phase).toBe("started");
		await pollHelperInterlock();
		expect(heldModemMutations().length).toBeGreaterThan(0);
		expect((await readEntries())[0]?.phase).toBe("started");
		const second = await call(
			helperRetryPortProcedure,
			{ confirmed: true },
			{ context: callerContext() },
		);
		expect(second).toEqual({ ok: false, refusal: "action_in_progress" });
		expect(started).toEqual([TYPEC_UNIT]);
	});

	test("a restart recovers a unit left running at the deadline", async () => {
		await fresh();
		await plant(TYPEC_REL);
		await plant("proc/device-tree/compatible", "radxa,rock-5b-plus\0");
		await plant("run/ceralive-typec/rearm", "0\n");
		useDeps({
			admit: realAdmit,
			unitActive: async () => true,
			startUnit: async (unit) => {
				started.push(unit);
				throw new Error("helper unit failed");
			},
		});
		expect(
			await call(
				helperRetryPortProcedure,
				{ confirmed: true },
				{ context: callerContext() },
			),
		).toEqual({ ok: false, refusal: "start_failed" });
		const running = await readEntries();
		expect(running[0]?.phase).toBe("started");
		const id = String(running[0]?.id);
		await plant(
			`run/ceralive/devices-actions/${id}.json`,
			JSON.stringify({ ...running[0], process: "dead-process" }),
		);
		resetHelperActionGuardForTest();
		resetLifecycleInterlock();
		useDeps({
			admit: realAdmit,
			unitActive: async () => true,
		});
		const again = await call(
			helperRetryPortProcedure,
			{ confirmed: true },
			{ context: callerContext() },
		);
		expect(again).toEqual({ ok: false, refusal: "action_in_progress" });
		expect(started).toEqual([TYPEC_UNIT]);
		expect(heldModemMutations()).toContain(TYPEC_SUBJECT);
		expect((await readEntries())[0]?.phase).toBe("started");
	});

	test("a missed journal read keeps the lease of a unit that is still active", async () => {
		await fresh();
		await plant(TYPEC_REL);
		await plant("proc/device-tree/compatible", "radxa,rock-5b-plus\0");
		await plant("run/ceralive-typec/rearm", "0\n");
		useDeps({
			admit: realAdmit,
			unitActive: async () => true,
			startUnit: async () => {
				throw new Error("helper unit failed");
			},
		});
		expect(
			await call(
				helperRetryPortProcedure,
				{ confirmed: true },
				{ context: callerContext() },
			),
		).toEqual({ ok: false, refusal: "start_failed" });
		await rm(join(root, "run/ceralive/devices-actions"), {
			recursive: true,
			force: true,
		});
		await pollHelperInterlock();
		expect(heldModemMutations().length).toBeGreaterThan(0);
	});

	test("a restart treats a still-active unit as busy", async () => {
		await fresh();
		await plant(TYPEC_REL);
		await plant("proc/device-tree/compatible", "radxa,rock-5b-plus\0");
		await plant("run/ceralive-typec/rearm", "0\n");
		await plantJournal({
			id: CRASH_ID,
			action: "retry-port",
			unit: TYPEC_UNIT,
			scope: "socket:C",
			leaseKey: TYPEC_SUBJECT,
			phase: "started",
			process: "dead-process",
			at: 1,
		});
		let active = true;
		useDeps({
			admit: realAdmit,
			unitActive: async () => active,
		});
		const blocked = await call(
			helperRetryPortProcedure,
			{ confirmed: true },
			{ context: callerContext() },
		);
		expect(blocked).toEqual({ ok: false, refusal: "action_in_progress" });
		expect(heldModemMutations()).toContain(TYPEC_SUBJECT);
		expect(started).toEqual([]);
		active = false;
		await pollHelperInterlock();
		expect(heldModemMutations()).not.toContain(TYPEC_SUBJECT);
	});

	test("refuses USB 2 on a board that is not the ROCK 5B+", async () => {
		await fresh();
		await plant(USB2_REL);
		await plant("proc/device-tree/compatible", "radxa,rock-5b\0");
		useDeps({ resolveUsb2: async () => USB2_BOUND });
		const offer = await call(helperOfferProcedure, undefined, {
			context: callerContext(),
		});
		expect(offer).toMatchObject({ usb2: false, retryPort: false });
		const result = await call(
			helperUsb2Procedure,
			{ confirmed: true, key: "modem" },
			{ context: callerContext() },
		);
		expect(result).toEqual({ ok: false, refusal: "not_this_board" });
		expect(started).toEqual([]);
	});

	test("refuses a replacement and a device with no identity", () => {
		const seen = {
			devnum: "4",
			stableKey: USB2_BOUND.leaseKey,
			scope: USB2_BOUND.scope,
			kernelName: "2-1.4",
		};
		expect(
			bindUsb2Target(seen, {
				devnum: "5",
				stableKey: seen.stableKey,
				scope: seen.scope,
				kernelName: seen.kernelName,
			}),
		).toBeNull();
		expect(
			bindUsb2Target(undefined, {
				devnum: "4",
				stableKey: seen.stableKey,
				scope: seen.scope,
				kernelName: seen.kernelName,
			}),
		).toBeNull();
		expect(
			bindUsb2Target(seen, {
				devnum: null,
				stableKey: null,
				scope: seen.scope,
				kernelName: seen.kernelName,
			}),
		).toBeNull();
		expect(
			bindUsb2Target(seen, {
				devnum: "4",
				stableKey: seen.stableKey,
				scope: seen.scope,
				kernelName: "2-1.4",
			})?.unit,
		).toBe(USB2_BOUND.unit);
	});

	test("does not start USB 2 when the enumeration changes before the unit", async () => {
		await fresh();
		await plant(USB2_REL);
		await plant("proc/device-tree/compatible", "radxa,rock-5b-plus\0");
		let reads = 0;
		useDeps({
			resolveUsb2: async () => {
				reads += 1;
				return reads < 3 ? USB2_BOUND : null;
			},
		});
		const result = await call(
			helperUsb2Procedure,
			{ confirmed: true, key: "modem" },
			{ context: callerContext() },
		);
		expect(result).toEqual({ ok: false, refusal: "identity_unresolved" });
		expect(started).toEqual([]);
		const entries = await readEntries();
		expect(entries[0]?.phase).toBe("failed");
		expect(entries[0]?.detail).toBe("identity-changed");
	});

	test("refuses a same-port replacement on a fresh tree walk", async () => {
		await fresh();
		await plant(USB2_REL);
		await plant("proc/device-tree/compatible", "radxa,rock-5b-plus\0");
		await plantModem("4");
		useDeps({
			stableKey: (ifname) =>
				ifname === "wwan0" ? USB2_BOUND.leaseKey : undefined,
		});
		const tree = await readUsbTree({ sysfsRoot: root });
		await captureHelperSeen(tree.roots, root);
		const matched = await call(
			helperUsb2Procedure,
			{ confirmed: true, key: "fc800000.usb:usb2:1.4" },
			{ context: callerContext() },
		);
		expect(matched).toEqual({ ok: true });
		expect(started).toEqual([USB2_BOUND.unit]);
		await plantModem("9");
		const result = await call(
			helperUsb2Procedure,
			{ confirmed: true, key: "fc800000.usb:usb2:1.4" },
			{ context: callerContext() },
		);
		expect(result).toEqual({ ok: false, refusal: "identity_unresolved" });
		expect(started).toEqual([USB2_BOUND.unit]);
	});

	test("concurrent actions keep both journal records finished", async () => {
		await fresh();
		await plant(USB2_REL);
		await plant("proc/device-tree/compatible", "radxa,rock-5b-plus\0");
		let releaseA!: () => void;
		let releaseB!: () => void;
		const gateA = new Promise<void>((resolve) => {
			releaseA = resolve;
		});
		const gateB = new Promise<void>((resolve) => {
			releaseB = resolve;
		});
		let enteredA!: () => void;
		let enteredB!: () => void;
		const readyA = new Promise<void>((resolve) => {
			enteredA = resolve;
		});
		const readyB = new Promise<void>((resolve) => {
			enteredB = resolve;
		});
		useDeps({
			resolveUsb2: async (key) => {
				if (key === "a") {
					return {
						unit: "ceralive-modem-usbspeed@2-1.4.service",
						leaseKey: "platform-a",
						scope: "socket:A3-bot",
					};
				}
				if (key === "b") {
					return {
						unit: "ceralive-modem-usbspeed@2-1.3.service",
						leaseKey: "platform-b",
						scope: "socket:A3-top",
					};
				}
				return null;
			},
			startUnit: async (unit) => {
				started.push(unit);
				if (unit.endsWith("@2-1.4.service")) {
					enteredA();
					await gateA;
					return;
				}
				enteredB();
				await gateB;
			},
		});
		const first = call(
			helperUsb2Procedure,
			{ confirmed: true, key: "a" },
			{ context: callerContext() },
		);
		const second = call(
			helperUsb2Procedure,
			{ confirmed: true, key: "b" },
			{ context: callerContext() },
		);
		await readyA;
		await readyB;
		releaseA();
		releaseB();
		expect(await first).toEqual({ ok: true });
		expect(await second).toEqual({ ok: true });
		const entries = await readEntries();
		expect(entries).toHaveLength(2);
		expect(entries.map((entry) => entry.phase).sort()).toEqual([
			"finished",
			"finished",
		]);
	});

	test("a companion row and the USB-C socket share one cooldown", async () => {
		await fresh();
		await plant(USB2_REL);
		await plant(TYPEC_REL);
		await plant("proc/device-tree/compatible", "radxa,rock-5b-plus\0");
		await plant("run/ceralive-typec/rearm", "0\n");
		useDeps({
			resolveUsb2: async (key) =>
				key === "usb3" || key === "usb2" || key === "j11"
					? {
							unit: USB2_BOUND.unit,
							leaseKey: USB2_BOUND.leaseKey,
							scope: key === "j11" ? "socket:C" : "socket:A3-bot",
						}
					: null,
		});
		expect(
			await call(
				helperUsb2Procedure,
				{ confirmed: true, key: "usb3" },
				{ context: callerContext() },
			),
		).toEqual({ ok: true });
		const companion = await call(
			helperUsb2Procedure,
			{ confirmed: true, key: "usb2" },
			{ context: callerContext() },
		);
		expect(companion).toEqual({ ok: false, refusal: "cooldown" });
		expect(
			await call(
				helperRetryPortProcedure,
				{ confirmed: true },
				{ context: callerContext() },
			),
		).toEqual({ ok: true });
		const onTypec = await call(
			helperUsb2Procedure,
			{ confirmed: true, key: "j11" },
			{ context: callerContext() },
		);
		expect(onTypec).toEqual({ ok: false, refusal: "cooldown" });
		expect(started).toEqual([USB2_BOUND.unit, TYPEC_UNIT]);
	});

	test("a fresh process keeps the cooldown recorded in the journal", async () => {
		await fresh();
		await plant(TYPEC_REL);
		await plant("proc/device-tree/compatible", "radxa,rock-5b-plus\0");
		await plant("run/ceralive-typec/rearm", "0\n");
		await plantJournal({
			id: CRASH_ID,
			action: "retry-port",
			unit: TYPEC_UNIT,
			scope: "socket:C",
			leaseKey: TYPEC_SUBJECT,
			phase: "finished",
			process: "dead-process",
			at: 1,
			cooldownUntil: now + HELPER_ACTION_COOLDOWN_MS,
		});
		const result = await call(
			helperRetryPortProcedure,
			{ confirmed: true },
			{ context: callerContext() },
		);
		expect(result).toEqual({ ok: false, refusal: "cooldown" });
		expect(started).toEqual([]);
	});

	test("a masked unit file is not started", async () => {
		await fresh();
		const real = join(
			root,
			"usr/lib/systemd/system/ceralive-typec-recheck.service",
		);
		await plant("usr/lib/systemd/system/ceralive-typec-recheck.service");
		const path = join(root, TYPEC_REL);
		await mkdir(dirname(path), { recursive: true });
		await symlink(real, path);
		await plant("proc/device-tree/compatible", "radxa,rock-5b-plus\0");
		await plant("run/ceralive-typec/rearm", "0\n");
		const result = await call(
			helperRetryPortProcedure,
			{ confirmed: true },
			{ context: callerContext() },
		);
		expect(result).toEqual({ ok: false, refusal: "unit_absent" });
		expect(started).toEqual([]);
	});

	test("a unit name with client characters never reaches the starter", async () => {
		await fresh();
		await plant(USB2_REL);
		await plant("proc/device-tree/compatible", "radxa,rock-5b-plus\0");
		useDeps({
			resolveUsb2: async () => ({
				unit: "ceralive-modem-usbspeed@$(id).service",
				leaseKey: "platform-a",
				scope: "socket:M2B",
			}),
		});
		const result = await call(
			helperUsb2Procedure,
			{ confirmed: true, key: "modem" },
			{ context: callerContext() },
		);
		expect(result).toEqual({ ok: false, refusal: "unit_absent" });
		expect(started).toEqual([]);
		expect(helperUnitArgv("ceralive-modem-usbspeed@$(id).service")).toBeNull();
	});

	test("a re-arm path that cannot be read is spent, not zero", async () => {
		await fresh();
		await plant(TYPEC_REL);
		await plant("proc/device-tree/compatible", "radxa,rock-5b-plus\0");
		await plant("run/ceralive-typec", "not-a-directory");
		const offer = await call(helperOfferProcedure, undefined, {
			context: callerContext(),
		});
		expect(offer).toMatchObject({
			retryPort: false,
			rearmExhausted: true,
		});
		const result = await call(
			helperRetryPortProcedure,
			{ confirmed: true },
			{ context: callerContext() },
		);
		expect(result).toEqual({ ok: false, refusal: "budget_exhausted" });
		expect(started).toEqual([]);
	});
});

async function plantModem(devnum: string): Promise<void> {
	const physical = join(
		root,
		"sys/devices/platform/fc800000.usb/xhci-hcd.0.auto/usb2/2-1/2-1.4",
	);
	await mkdir(physical, { recursive: true });
	await writeFile(join(physical, "speed"), "480\n");
	await writeFile(join(physical, "version"), " 2.00\n");
	await writeFile(join(physical, "bDeviceClass"), "00\n");
	await writeFile(join(physical, "idVendor"), "2c7c\n");
	await writeFile(join(physical, "idProduct"), "0801\n");
	await writeFile(join(physical, "product"), "RM520N-GL\n");
	await writeFile(join(physical, "devnum"), `${devnum}\n`);
	const iface = join(physical, "2-1.4:1.2");
	await mkdir(join(iface, "net/wwan0"), { recursive: true });
	const driver = join(root, "sys/bus/usb/drivers/option");
	await mkdir(driver, { recursive: true });
	await rm(join(iface, "driver"), { force: true });
	await symlink(driver, join(iface, "driver"));
	const flat = join(root, "sys/bus/usb/devices");
	await mkdir(flat, { recursive: true });
	await rm(join(flat, "2-1.4"), { force: true });
	await symlink(physical, join(flat, "2-1.4"));
}
