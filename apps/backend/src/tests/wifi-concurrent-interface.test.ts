/*
    CeraUI - web UI for the CeraLive project
    Copyright (C) 2024-2025 CeraLive project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.
*/

import { afterEach, describe, expect, test } from "bun:test";

import {
	concurrentApIfname,
	concurrentStationChannel,
	ensureConcurrentApInterface,
	releaseConcurrentApInterface,
	resetConcurrentInterfaceDepsForTest,
	setConcurrentInterfaceDepsForTest,
} from "../modules/wifi/wifi-concurrent-interface.ts";

afterEach(resetConcurrentInterfaceDepsForTest);

describe("concurrent AP virtual interface", () => {
	test("uses a deterministic Linux-safe interface name", () => {
		expect(concurrentApIfname("wlan0")).toBe("clap-wlan0");
		expect(
			concurrentApIfname("very-long-wireless-name").length,
		).toBeLessThanOrEqual(15);
	});

	test.each(["managed", "AP"])(
		"preserves an unrelated unavailable %s sibling",
		async (type) => {
			const calls: string[][] = [];
			setConcurrentInterfaceDepsForTest(
				async (_command, args) => {
					calls.push(args);
					return `type ${type}`;
				},
				async () => false,
			);
			expect(await ensureConcurrentApInterface("wlan0")).toBeUndefined();
			await releaseConcurrentApInterface("clap-wlan0");
			expect(calls).toEqual([["dev", "clap-wlan0", "info"]]);
		},
	);

	test("only deletes interfaces successfully created by this owner", async () => {
		const calls: string[][] = [];
		setConcurrentInterfaceDepsForTest(
			async (_command, args) => {
				calls.push(args);
				if (args.at(-1) === "info") throw new Error("absent");
				return "";
			},
			async () => true,
		);
		expect(await ensureConcurrentApInterface("wlan1")).toMatchObject({
			created: true,
		});
		await releaseConcurrentApInterface("clap-wlan0");
		await releaseConcurrentApInterface("clap-wlan1");
		expect(calls.filter((args) => args.at(-1) === "del")).toEqual([
			["dev", "clap-wlan1", "del"],
		]);
	});

	test("failed add does not authorize cleanup of a competing interface", async () => {
		const calls: string[][] = [];
		setConcurrentInterfaceDepsForTest(
			async (_command, args) => {
				calls.push(args);
				throw new Error("competing owner");
			},
			async () => true,
		);
		expect(await ensureConcurrentApInterface("wlan0")).toBeUndefined();
		expect(calls.some((args) => args.at(-1) === "del")).toBe(false);
	});
});

test("new AP waits for fake NetworkManager readiness and cleans up only its own failed activation", async () => {
	const calls: string[] = [];
	setConcurrentInterfaceDepsForTest(async (cmd, args) => {
		calls.push(`${cmd} ${args.join(" ")}`);
		if (args.at(-1) === "info") throw new Error("absent");
		if (args.includes("GENERAL.STATE")) return "30 (disconnected)";
		return "";
	}, null);
	expect(await ensureConcurrentApInterface("wlan0")).toMatchObject({
		type: "AP",
		created: true,
	});
	expect(calls.at(-1)).toBe("nmcli -g GENERAL.STATE device show clap-wlan0");
	await releaseConcurrentApInterface("clap-wlan0");
	expect(calls.at(-1)).toBe("iw dev clap-wlan0 del");
});
test("shared channel follows station frequency only if AP legal, and unknown link fails closed", async () => {
	setConcurrentInterfaceDepsForTest(
		async () => "Connected to 02:00:00:00:00:01\n freq: 2437",
		null,
	);
	expect(
		await concurrentStationChannel("wlan0", [
			{ channel: 6, freqMhz: 2437, band: "bg" },
		]),
	).toEqual({ "802-11-wireless.band": "bg", "802-11-wireless.channel": "6" });
	expect(await concurrentStationChannel("wlan0", [])).toBeUndefined();
	setConcurrentInterfaceDepsForTest(async () => "Not connected.", null);
	expect(await concurrentStationChannel("wlan0", [])).toEqual({});
});

test("USB-target cleanup preserves a pre-existing onboard sibling", async () => {
	const calls: string[] = [];
	const usb = "wlx001122334455";
	const usbAp = concurrentApIfname(usb);
	setConcurrentInterfaceDepsForTest(
		async (cmd, args) => {
			calls.push(`${cmd} ${args.join(" ")}`);
			if (args.at(-1) === "info") {
				if (args[1] === "clap-wlan0") return "type managed";
				throw new Error("absent");
			}
			return "";
		},
		async () => true,
	);
	// Discovery scans both radios, then activation/cleanup targets the USB one.
	expect(await ensureConcurrentApInterface("wlan0")).toBeUndefined();
	expect(await ensureConcurrentApInterface(usb)).toEqual({
		ifname: usbAp,
		type: "AP",
		created: true,
	});
	await releaseConcurrentApInterface(usbAp);
	await releaseConcurrentApInterface("clap-wlan0");
	expect(calls.filter((call) => call.endsWith(" del"))).toEqual([
		`iw dev ${usbAp} del`,
	]);
});

test("borrows a ready pre-existing AP without claiming deletion ownership", async () => {
	const calls: string[][] = [];
	setConcurrentInterfaceDepsForTest(
		async (_cmd, args) => {
			calls.push(args);
			return "type AP";
		},
		async () => true,
	);
	expect(await ensureConcurrentApInterface("wlan0")).toEqual({
		ifname: "clap-wlan0",
		type: "AP",
		created: false,
	});
	await releaseConcurrentApInterface("clap-wlan0");
	expect(calls).toEqual([["dev", "clap-wlan0", "info"]]);
});

test("NM failure after creation cleans up the owned AP", async () => {
	const calls: string[][] = [];
	setConcurrentInterfaceDepsForTest(
		async (cmd, args) => {
			calls.push(args);
			if (args.at(-1) === "info" || cmd === "nmcli")
				throw new Error("unavailable");
			return "";
		},
		async () => false,
	);
	expect(await ensureConcurrentApInterface("wlan0")).toBeUndefined();
	expect(calls.at(-1)).toEqual(["dev", "clap-wlan0", "del"]);
});
