import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	mkdir,
	mkdtemp,
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
import {
	HELPER_ACTION_COOLDOWN_MS,
	HELPER_REARM_MAX,
	resetHelperActionGuardForTest,
	setHelperActionDepsForTest,
	TYPEC_UNIT,
} from "./usb-helper-actions.ts";
import { helperUnitArgv } from "./usb-helper-start.ts";

const TYPEC_REL = "etc/systemd/system/ceralive-typec-recheck.service";
const USB2_REL = "etc/systemd/system/ceralive-modem-usbspeed@.service";

let root = "";
let now = 1_000;
const started: string[] = [];
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

async function plant(rel: string, body = "# unit\n"): Promise<void> {
	const path = join(root, rel);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, body);
}

function useDeps(extra?: {
	readonly liveStream?: () => boolean;
	readonly admit?: (
		key: string,
	) => { ok: true; release: () => void } | { ok: false; refusal: string };
	readonly portForKey?: (key: string) => string | undefined;
	readonly startUnit?: (unit: string) => Promise<void>;
}): void {
	setHelperActionDepsForTest({
		root,
		now: () => now,
		publish: async () => {
			published += 1;
		},
		startUnit:
			extra?.startUnit ??
			(async (unit) => {
				started.push(unit);
			}),
		liveStream: extra?.liveStream ?? (() => false),
		admit:
			extra?.admit ??
			(() => ({
				ok: true as const,
				release() {
					return undefined;
				},
			})),
		portForKey: extra?.portForKey ?? (() => undefined),
	});
}

async function fresh(): Promise<void> {
	root = await mkdtemp(join(tmpdir(), "ceraui-helper-action-"));
	now = 1_000;
	started.length = 0;
	published = 0;
	resetLifecycleInterlock();
	useDeps();
}

afterEach(async () => {
	resetHelperActionGuardForTest();
	resetLifecycleInterlock();
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
		useDeps({ portForKey: () => "2-1.4" });
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
		const crashed = [
			{
				id: "gone",
				action: "retry-port",
				unit: TYPEC_UNIT,
				phase: "started",
				process: "dead-process",
				at: 1,
			},
		];
		await plant("proc/device-tree/compatible", "radxa,rock-5b-plus\0");
		await plant("run/ceralive/devices-actions.json", JSON.stringify(crashed));
		const result = await call(
			helperRetryPortProcedure,
			{ confirmed: true },
			{ context: callerContext() },
		);
		expect(result).toEqual({ ok: false, refusal: "unit_absent" });
		expect(started).toEqual([]);
		const entries = JSON.parse(
			await readFile(join(root, "run/ceralive/devices-actions.json"), "utf8"),
		);
		expect(entries).toEqual([
			{
				id: "gone",
				action: "retry-port",
				unit: TYPEC_UNIT,
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
			admit: (key) => {
				const admission = tryAcquireModemMutation(key);
				if (!admission.admitted) {
					return { ok: false, refusal: admission.refusal };
				}
				return { ok: true, release: admission.lease.release };
			},
			startUnit: async (unit) => {
				const mid = JSON.parse(
					await readFile(
						join(root, "run/ceralive/devices-actions.json"),
						"utf8",
					),
				);
				expect(mid).toHaveLength(1);
				expect(mid[0].phase).toBe("started");
				expect(mid[0].unit).toBe(TYPEC_UNIT);
				expect(heldModemMutations()).toContain("rock-5b-plus:typec:port0");
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
		const done = JSON.parse(
			await readFile(join(root, "run/ceralive/devices-actions.json"), "utf8"),
		);
		expect(done[0].phase).toBe("finished");
	});

	test("starts the usb2 instance for the remembered port and does not inhibit ModemManager", async () => {
		await fresh();
		await plant(USB2_REL);
		useDeps({
			portForKey: (key) => (key === "modem" ? "2-1.4" : undefined),
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
});
