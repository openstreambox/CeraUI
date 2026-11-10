import { expect, test } from "bun:test";
import type { run } from "../helpers/run.ts";
import type { PreparedSteeringState } from "../modules/network/uplink-steering/applier.ts";
import { verifySteeringState } from "../modules/network/uplink-steering/verify.ts";

const state: PreparedSteeringState = {
	clientZones: [{ ifname: "wlan93", ipv4Cidr: "10.42.0.0/24" }],
	uplinks: [],
	routes: [
		{
			identity: "wired",
			ifname: "eth93",
			sourceAddress: "192.0.2.2",
			mark: 0xca000100,
			table: "30001",
			managed: true,
			sourceRulePriority: 100,
		},
	],
};
const rules =
	"100: from 192.0.2.2 lookup 30001\n110: from all fwmark 0xca000100/0xffffff00 lookup 30001\n";
test.each(["rules", "route", "zone"])(
	"refuses readiness when %s readback is missing",
	async (missing) => {
		const execute: typeof run = async (cmd, args) => {
			if (cmd === "nft")
				return missing === "zone"
					? "table inet ceralive_share {}"
					: 'iifname "wlan93"';
			if (args[0] === "rule") return missing === "rules" ? "" : rules;
			return missing === "route" ? "default dev foreign0" : "default dev eth93";
		};
		await expect(verifySteeringState(state, execute)).rejects.toThrow(
			"readback failed",
		);
	},
);
test("accepts complete kernel readback", async () => {
	const execute: typeof run = async (cmd, args) =>
		cmd === "nft"
			? 'iifname "wlan93"'
			: args[0] === "rule"
				? rules
				: "default dev eth93";
	await verifySteeringState(state, execute);
});

test("hotspot readiness starts pending and only admits a verified zone", async () => {
	const {
		hotspotSteeringPending,
		publishSteeringReadiness,
		enableSteeringReadiness,
	} = await import("../modules/network/uplink-steering/readiness.ts");
	enableSteeringReadiness();
	expect(hotspotSteeringPending("wlan93")).toBe(true);
	publishSteeringReadiness(state.clientZones);
	expect(hotspotSteeringPending("wlan93")).toBe(false);
	expect(hotspotSteeringPending("wlan94")).toBe(true);
	publishSteeringReadiness([]);
	expect(hotspotSteeringPending("wlan93")).toBe(true);
});

test("unchanged desired state is read back and repaired before readiness", async () => {
	const { UplinkSteeringCoordinator } = await import(
		"../modules/network/uplink-steering/coordinator.ts"
	);
	let installed = true;
	let applies = 0;
	let checks = 0;
	const availability: boolean[] = [];
	const coordinator = new UplinkSteeringCoordinator({
		readDesiredState: async () => state,
		apply: async () => {
			applies++;
			installed = true;
		},
		verifyApplied: async () => {
			checks++;
			if (!installed) throw new Error("missing kernel state");
		},
		publishAvailability: (status) => {
			availability.push(status.available);
		},
		waitBeforeRetry: async () => {},
	});
	await coordinator.requestReconcile();
	installed = false;
	await coordinator.requestReconcile();
	expect(applies).toBe(2);
	expect(checks).toBe(3);
	expect(availability).toEqual([true, false, true]);
});
