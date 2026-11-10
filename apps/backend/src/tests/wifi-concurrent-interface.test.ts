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

	test("removes a stale interface, recreates it as AP, and waits for NetworkManager", async () => {
		const calls: string[][] = [];
		setConcurrentInterfaceDepsForTest(
			async (_command, args) => {
				calls.push(args);
				if (args.join(" ") === "dev clap-wlan0 info") return "type managed";
				return "";
			},
			async () => true,
		);

		expect(await ensureConcurrentApInterface("wlan0")).toEqual({
			ifname: "clap-wlan0",
			created: true,
			type: "AP",
		});
		expect(calls).toEqual([
			["dev", "clap-wlan0", "info"],
			["dev", "clap-wlan0", "del"],
			["dev", "wlan0", "interface", "add", "clap-wlan0", "type", "__ap"],
			["device", "set", "clap-wlan0", "managed", "yes"],
		]);
	});

	test("removes the virtual interface explicitly", async () => {
		const calls: string[][] = [];
		setConcurrentInterfaceDepsForTest(
			async (_command, args) => {
				calls.push(args);
				return "";
			},
			async () => true,
		);
		await releaseConcurrentApInterface("clap-wlan0");
		expect(calls).toEqual([["dev", "clap-wlan0", "del"]]);
	});
});

test("unavailable managed sibling is replaced by AP before NM readiness and activation", async () => {
	const calls: string[] = [];
	let ap = false;
	setConcurrentInterfaceDepsForTest(async (cmd, args) => {
		calls.push(`${cmd} ${args.join(" ")}`);
		if (args.at(-1) === "info") return "type managed";
		if (args.includes("__ap")) ap = true;
		if (args.includes("GENERAL.STATE"))
			return ap ? "30 (disconnected)" : "20 (unavailable)";
		return "";
	}, null);
	expect(await ensureConcurrentApInterface("wlan0")).toMatchObject({
		type: "AP",
	});
	expect(calls).toContain("iw dev wlan0 interface add clap-wlan0 type __ap");
	expect(calls.at(-1)).toBe("nmcli -g GENERAL.STATE device show clap-wlan0");
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
