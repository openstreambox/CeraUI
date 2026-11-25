/*
    CeraUI - web UI for the CeraLive project
    Copyright (C) 2024-2025 CeraLive project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.
    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

/**
 * Restart modem: qualification, guards, the method chain, and finding the modem
 * again under a new ModemManager index. The device side is a scripted roster:
 * each test says which modems are listed at which simulated second, the way the
 * bench saw them (old index gone, then a new index on the same port).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
	MODEM_RESTART_COOLDOWN_SECONDS,
	modemRestartQualification,
	type RestartModemInput,
} from "@ceraui/rpc/schemas";

import {
	type ModemRestartDeps,
	resetModemRestartDeps,
	restartModem,
	usbDeviceForInterface,
} from "../modules/modems/modem-restart.ts";
import type { Modem } from "../modules/modems/modems-state.ts";
import {
	resetLifecycleInterlock,
	tryAcquireLifecycle,
	tryAcquireModemJournalKey,
} from "../modules/streaming/lifecycle-admission.ts";
import { resetRecoveryBarrier } from "../modules/streaming/recovery-barrier.ts";

const DELL_KEY = "platform-fc800000.usb-usb-0:1.4";
const RM520_KEY = "platform-xhci-hcd.10.auto-usb-0:1";

function modem(model: string, ifname: string, connection = "connected"): Modem {
	return {
		ifname,
		name: model,
		sim_network: "",
		model,
		network_type: { supported: {}, active: null },
		status: { connection, network_type: "4g", signal: 60, roaming: false },
	} as Modem;
}

type Roster = Record<number, Modem>;

/**
 * A simulated clock and a roster that changes at given seconds after the first
 * command. `keys` maps ModemManager index to stable key, as the ID_PATH map does.
 */
function scripted(opts: {
	before: Roster;
	after?: Array<[number, Roster]>;
	keys: Record<number, string>;
	mmReset?: boolean;
	usbRebind?: boolean;
	streaming?: boolean;
	otherLinkLive?: boolean | undefined;
}) {
	let now = 1_000_000;
	let commandAt: number | undefined;
	const calls: string[] = [];
	const roster = (): Roster => {
		if (commandAt === undefined) return opts.before;
		const t = (now - commandAt) / 1000;
		let current = opts.before;
		for (const [at, r] of opts.after ?? []) if (t >= at) current = r;
		return current;
	};
	const deps: ModemRestartDeps = {
		modems: roster,
		stableKeyForId: (id) => opts.keys[id],
		mmReset: async (id) => {
			calls.push(`mm-reset ${id}`);
			commandAt ??= now;
			return opts.mmReset ?? true;
		},
		usbRebind: async (ifname) => {
			calls.push(`usb-rebind ${ifname}`);
			commandAt ??= now;
			return opts.usbRebind ?? true;
		},
		isStreaming: () => opts.streaming ?? false,
		otherLinkLive: () => ("otherLinkLive" in opts ? opts.otherLinkLive : true),
		now: () => now,
		sleep: async (ms) => {
			now += ms;
		},
		pollMs: 2_000,
	};
	return {
		deps,
		calls,
		advance: (s: number) => {
			now += s * 1000;
		},
	};
}

const INPUT: RestartModemInput = { device: "4", confirm: true };

beforeEach(() => {
	resetModemRestartDeps();
	resetLifecycleInterlock();
	resetRecoveryBarrier();
});
afterEach(() => {
	resetModemRestartDeps();
	resetLifecycleInterlock();
	resetRecoveryBarrier();
});

describe("qualification", () => {
	test("the DW5821e and RM520N-GL are qualified, with their measured costs", () => {
		expect(modemRestartQualification("DW5821e Snapdragon X20 LTE")).toEqual({
			family: "dw5821e",
			expectedSeconds: 35,
			boundSeconds: 120,
		});
		expect(modemRestartQualification("RM520N-GL")?.family).toBe("rm520n-gl");
	});

	test("the FM350, EM7455 and anything unlisted are not", () => {
		for (const model of [
			"FM350-GL",
			"EM7455",
			"RM500Q-GL",
			"SIM7600G-H",
			"",
			undefined,
		])
			expect(modemRestartQualification(model)).toBeUndefined();
	});

	test("an unqualified modem is refused before anything runs", async () => {
		const s = scripted({
			before: { 4: modem("FM350-GL", "enx1") },
			keys: { 4: "k" },
		});
		expect(await restartModem(INPUT, s.deps)).toEqual({
			started: false,
			refusal: "not_qualified",
		});
		expect(s.calls).toEqual([]);
	});

	test("an unknown selector is refused", async () => {
		const s = scripted({ before: {}, keys: {} });
		expect((await restartModem(INPUT, s.deps)).refusal).toBe("unknown_modem");
		expect(
			(await restartModem({ device: "-m 4", confirm: true }, s.deps)).refusal,
		).toBe("unknown_modem");
	});

	test("a modem without a stable key is refused", async () => {
		const s = scripted({
			before: { 4: modem("RM520N-GL", "wwu1i4") },
			keys: {},
		});
		expect((await restartModem(INPUT, s.deps)).refusal).toBe(
			"identity_unresolved",
		);
		expect(s.calls).toEqual([]);
	});
});

describe("a restart that comes back", () => {
	test("found again under a new index on the same port, connected", async () => {
		// Bench shape (Dell): gone at 7 s, listed as m5 at 30 s, connected at 33 s.
		const s = scripted({
			before: { 4: modem("DW5821e Snapdragon X20 LTE", "wwu1u4c2") },
			after: [
				[7, {}],
				[
					30,
					{ 5: modem("DW5821e Snapdragon X20 LTE", "wwu1u4c2", "registered") },
				],
				[33, { 5: modem("DW5821e Snapdragon X20 LTE", "wwu1u4c2") }],
			],
			keys: { 4: DELL_KEY, 5: DELL_KEY },
		});
		const result = await restartModem(INPUT, s.deps);
		expect(result).toMatchObject({
			started: true,
			outcome: "back_connected",
			method: "mm-reset",
			device: "5",
		});
		expect(result.elapsedSeconds).toBeGreaterThanOrEqual(33);
		expect(result.elapsedSeconds).toBeLessThanOrEqual(36);
		expect(s.calls).toEqual(["mm-reset 4"]);
	});

	test("an index change alone counts as having left (the roster never saw a gap)", async () => {
		const s = scripted({
			before: { 2: modem("RM520N-GL", "wwu1i4") },
			after: [[24, { 6: modem("RM520N-GL", "wwu1i4") }]],
			keys: { 2: RM520_KEY, 6: RM520_KEY },
		});
		const result = await restartModem({ device: "2", confirm: true }, s.deps);
		expect(result).toMatchObject({ outcome: "back_connected", device: "6" });
	});

	test("the other modem is never mistaken for the restarted one", async () => {
		const other = modem("RM520N-GL", "wwu1i4");
		const s = scripted({
			before: { 4: modem("DW5821e", "wwu1u4c2"), 2: other },
			after: [[7, { 2: other }]],
			keys: { 4: DELL_KEY, 2: RM520_KEY },
		});
		const result = await restartModem(INPUT, s.deps);
		expect(result.outcome).toBe("not_back");
		expect(result.elapsedSeconds).toBeGreaterThanOrEqual(120);
	});

	test("back but not connected within the bound reports the state it is in", async () => {
		const s = scripted({
			before: { 4: modem("DW5821e", "wwu1u4c2") },
			after: [
				[7, {}],
				[30, { 5: modem("DW5821e", "wwu1u4c2", "registered") }],
			],
			keys: { 4: DELL_KEY, 5: DELL_KEY },
		});
		expect(await restartModem(INPUT, s.deps)).toMatchObject({
			outcome: "back_not_connected",
			device: "5",
			connection: "registered",
		});
	});

	test("a modem that never left is 'unchanged', never a success", async () => {
		const s = scripted({
			before: { 4: modem("DW5821e", "wwu1u4c2") },
			keys: { 4: DELL_KEY },
		});
		expect((await restartModem(INPUT, s.deps)).outcome).toBe("unchanged");
	});
});

describe("method chain, no retries", () => {
	test("a refused reset falls back to one USB rebind", async () => {
		const s = scripted({
			before: { 4: modem("DW5821e", "wwu1u4c2") },
			after: [[13, { 9: modem("DW5821e", "wwu1u4c2") }]],
			keys: { 4: DELL_KEY, 9: DELL_KEY },
			mmReset: false,
		});
		expect(await restartModem(INPUT, s.deps)).toMatchObject({
			outcome: "back_connected",
			method: "usb-rebind",
		});
		expect(s.calls).toEqual(["mm-reset 4", "usb-rebind wwu1u4c2"]);
	});

	test("when both are refused it fails without a third try", async () => {
		const s = scripted({
			before: { 4: modem("DW5821e", "wwu1u4c2") },
			keys: { 4: DELL_KEY },
			mmReset: false,
			usbRebind: false,
		});
		expect(await restartModem(INPUT, s.deps)).toMatchObject({
			started: true,
			outcome: "failed",
			method: "usb-rebind",
		});
		expect(s.calls).toEqual(["mm-reset 4", "usb-rebind wwu1u4c2"]);
	});

	test("an accepted reset that never comes back gets no second action", async () => {
		const s = scripted({
			before: { 4: modem("DW5821e", "wwu1u4c2") },
			after: [[7, {}]],
			keys: { 4: DELL_KEY },
		});
		expect((await restartModem(INPUT, s.deps)).outcome).toBe("not_back");
		expect(s.calls).toEqual(["mm-reset 4"]);
	});
});

describe("guards", () => {
	const dellBack = () =>
		scripted({
			before: { 4: modem("DW5821e", "wwu1u4c2") },
			after: [
				[7, {}],
				[33, { 5: modem("DW5821e", "wwu1u4c2") }],
			],
			keys: { 4: DELL_KEY, 5: DELL_KEY },
		});

	test("cooldown: the same modem waits three minutes after an attempt", async () => {
		const s = dellBack();
		expect((await restartModem(INPUT, s.deps)).outcome).toBe("back_connected");
		const again = await restartModem({ device: "5", confirm: true }, s.deps);
		expect(again.refusal).toBe("cooldown");
		expect(again.retryAfterSeconds).toBe(MODEM_RESTART_COOLDOWN_SECONDS);
		s.advance(MODEM_RESTART_COOLDOWN_SECONDS);
		const later = await restartModem({ device: "5", confirm: true }, s.deps);
		expect(later.refusal).toBeUndefined();
		expect(later.started).toBe(true);
	});

	test("one at a time: a second modem is refused while the first restarts", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const s = dellBack();
		const slow: ModemRestartDeps = {
			...s.deps,
			mmReset: async (id) => {
				await gate;
				return s.deps.mmReset(id);
			},
		};
		const rm = scripted({
			before: { 2: modem("RM520N-GL", "wwu1i4") },
			keys: { 2: RM520_KEY },
		});
		const first = restartModem(INPUT, slow);
		expect(
			(await restartModem({ device: "2", confirm: true }, rm.deps)).refusal,
		).toBe("restart_in_progress");
		release();
		expect((await first).outcome).toBe("back_connected");
		expect(rm.calls).toEqual([]);
	});

	test("only link carrying a live stream: refused unless confirmed", async () => {
		const s = scripted({
			before: { 4: modem("DW5821e", "wwu1u4c2") },
			after: [
				[7, {}],
				[33, { 5: modem("DW5821e", "wwu1u4c2") }],
			],
			keys: { 4: DELL_KEY, 5: DELL_KEY },
			streaming: true,
			otherLinkLive: false,
		});
		expect(await restartModem(INPUT, s.deps)).toEqual({
			started: false,
			refusal: "only_link_live",
		});
		expect(s.calls).toEqual([]);
		expect(
			(await restartModem({ ...INPUT, onlyLinkConfirmed: true }, s.deps))
				.outcome,
		).toBe("back_connected");
	});

	test("missing link telemetry while streaming counts as the only link", async () => {
		const s = scripted({
			before: { 4: modem("DW5821e", "wwu1u4c2") },
			keys: { 4: DELL_KEY },
			streaming: true,
			otherLinkLive: undefined,
		});
		expect((await restartModem(INPUT, s.deps)).refusal).toBe("only_link_live");
	});

	test("streaming with another live link needs only the normal confirmation", async () => {
		const s = scripted({
			before: { 4: modem("DW5821e", "wwu1u4c2") },
			after: [
				[7, {}],
				[33, { 5: modem("DW5821e", "wwu1u4c2") }],
			],
			keys: { 4: DELL_KEY, 5: DELL_KEY },
			streaming: true,
			otherLinkLive: true,
		});
		expect((await restartModem(INPUT, s.deps)).outcome).toBe("back_connected");
	});

	test("another change on the same modem holds its lease: refused, no cooldown", async () => {
		const held = tryAcquireModemJournalKey(DELL_KEY);
		const s = dellBack();
		expect((await restartModem(INPUT, s.deps)).refusal).toBe(
			"mutation_in_progress",
		);
		expect(s.calls).toEqual([]);
		held?.release();
		expect((await restartModem(INPUT, s.deps)).outcome).toBe("back_connected");
	});

	test("a stream being launched refuses it; a restart never takes the stream lock", async () => {
		const launch = tryAcquireLifecycle("streaming");
		expect(launch.admitted).toBe(true);
		const s = dellBack();
		expect((await restartModem(INPUT, s.deps)).refusal).toBe(
			"streaming_active",
		);
		if (launch.admitted) launch.lease.release();
	});
});

describe("usbDeviceForInterface", () => {
	test("resolves the USB device above the interface", async () => {
		const resolve = async () =>
			"/sys/devices/platform/fc800000.usb/usb2/2-1/2-1.4/2-1.4:1.12";
		expect(await usbDeviceForInterface("wwu1u4c2", resolve)).toBe("2-1.4");
		const j11 = async () =>
			"/sys/devices/platform/fc000000.usb/xhci-hcd.10.auto/usb9/9-1/9-1:1.4";
		expect(await usbDeviceForInterface("wwu1i4", j11)).toBe("9-1");
	});

	test("refuses anything that is not a USB device under /sys/devices", async () => {
		expect(
			await usbDeviceForInterface(
				"eth0",
				async () => "/sys/devices/platform/fe1c0000.ethernet",
			),
		).toBeUndefined();
		expect(
			await usbDeviceForInterface("x", async () => "/tmp/9-1/9-1:1.4"),
		).toBeUndefined();
		expect(
			await usbDeviceForInterface(
				"../../etc",
				async () => "/sys/devices/a/9-1/9-1:1.0",
			),
		).toBeUndefined();
		expect(
			await usbDeviceForInterface("wwan0", async () => {
				throw new Error("ENOENT");
			}),
		).toBeUndefined();
	});
});
