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
/** `nft list` output for an applied state without a selectable uplink. */
const dropTable = `table inet ceralive_share {
	chain forward {
		iifname "wlan93" ip saddr 10.42.0.0/24 ct state new meta mark != 0xcb000100 drop comment "no selectable client uplink"
	}
}`;
test.each(["rules", "route", "zone"])(
	"refuses readiness when %s readback is missing",
	async (missing) => {
		const execute: typeof run = async (cmd, args) => {
			if (cmd === "nft")
				return missing === "zone" ? "table inet ceralive_share {}" : dropTable;
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
			? dropTable
			: args[0] === "rule"
				? rules
				: "default dev eth93";
	await verifySteeringState(state, execute);
});

test("refuses readiness when the live selection differs from the plan", async () => {
	// `nft list` output for a table whose selection chain marks cellular.
	const selecting = (mark: string) => `table inet ceralive_share {
	chain select_0 {
		meta mark set meta mark & 0x000000ff | ${mark}
		ct mark set ct mark & 0x000000ff | ${mark}
		return
	}
	chain prerouting {
		iifname "wlan93" ip saddr 10.42.0.0/24 ct state established,related ct mark & 0xffffff00 == 0xca000100 meta mark set meta mark & 0x000000ff | 0xca000100 comment "restore client flow"
	}
}`;
	const wired = { ...state.routes[0], mark: 0xca000100 };
	const selected: PreparedSteeringState = {
		...state,
		uplinks: [
			{
				identity: "wired",
				ifname: "eth93",
				mark: wired.mark,
				selectable: true,
				weight: 100,
			},
		],
	};
	const execute =
		(table: string): typeof run =>
		async (cmd, args) =>
			cmd === "nft" ? table : args[0] === "rule" ? rules : "default dev eth93";
	await verifySteeringState(selected, execute(selecting("0xca000100")));
	// A restore rule for the planned mark is not a selection of it.
	await expect(
		verifySteeringState(selected, execute(selecting("0xca000200"))),
	).rejects.toThrow("selection readback failed");
	await expect(
		verifySteeringState(selected, execute(dropTable)),
	).rejects.toThrow("selection readback failed");
	// The plan selects nothing, but the kernel still selects an uplink.
	await expect(
		verifySteeringState(state, execute(selecting("0xca000100"))),
	).rejects.toThrow("selection readback failed");
});

test("hotspot readiness starts pending and only admits a verified zone", async () => {
	const {
		beginSteeringVerification,
		hotspotSteeringPending,
		publishSteeringReadiness,
		enableSteeringReadiness,
	} = await import("../modules/network/uplink-steering/readiness.ts");
	const lifetime = (ifname: string) => (ifname === "wlan93" ? 3 : 4);
	enableSteeringReadiness();
	expect(hotspotSteeringPending("wlan93", 3)).toBe(true);
	publishSteeringReadiness(
		state.clientZones,
		beginSteeringVerification(["wlan93", "wlan94"], lifetime),
		lifetime,
	);
	expect(hotspotSteeringPending("wlan93", 3)).toBe(false);
	expect(hotspotSteeringPending("wlan94", 4)).toBe(true);
	publishSteeringReadiness([]);
	expect(hotspotSteeringPending("wlan93", 3)).toBe(true);
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
