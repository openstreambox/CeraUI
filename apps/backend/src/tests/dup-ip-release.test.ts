/**
 * Releasing the duplicate-IP flag undoes only what the flag itself did.
 *
 * Raising `NETIF_ERR_DUPIPV4` forces `enabled` false. When the collision ends,
 * the release restores `enabled` only for a link the flag took down itself, and
 * only while no other gate has wanted it down since. These cases pin the edges
 * around that rule: the SIM-less hold, a row the monitor removed before the
 * poll saw it, the hotspot transition's notice suppression, and a duplicate that
 * could not be mapped while it collided.
 *
 * Driven through the real `processIfconfigOutput` and the real router admin
 * cache, with two tethers on one address beside a unique Ethernet uplink.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { resolveModemPhysicalIdentity } from "../modules/modems/physical-identity-source.ts";
import { probeExclusionReason } from "../modules/network/connectivity-candidates.ts";
import {
	getNetworkInterfaces,
	NETIF_ERR_DUPIPV4,
	NETIF_ERR_NOSIM,
	processIfconfigOutput,
	resetBondOptOut,
	resetNetifSnapshotForTest,
	setNetifDupIpSuppression,
	setQueueUpdateGwHook,
} from "../modules/network/network-interfaces.ts";
import {
	type RouterAdminProbeDeps,
	refreshRouterCellularAdmin,
	resetRouterCellularAdmin,
} from "../modules/network/router-cellular-admin.ts";
import { setNetifState } from "../modules/network/state/netif-state.ts";
import {
	genSrtlaIpList,
	setBondIdentityResolverForTest,
} from "../modules/streaming/srtla.ts";

const SHARED_IP = "192.168.0.169";
const DONGLE = "enx344b50000000";
const TWIN = "eth1";
const UPLINK = "eth0";
const UPLINK_IP = "192.168.78.132";

const NO_SIM = `{"modem_main_state":"modem_sim_undetected","ppp_status":"ppp_disconnected","signalbar":"","apn_name":""}`;
const WITH_SIM = `{"modem_main_state":"modem_init_complete","ppp_status":"ppp_connected","signalbar":"4","apn_name":"internet"}`;

function stanza(name: string, ip: string): string {
	return [
		`${name}: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500`,
		`        inet ${ip}  netmask 255.255.255.0  broadcast 192.168.0.255`,
		"        ether 34:4b:50:00:00:00  txqueuelen 1000  (Ethernet)",
		"        RX packets 200  bytes 20000 (20.0 KB)",
		"        TX packets 100  bytes 1000 (1.0 KB)",
	].join("\n");
}

function scan(...names: string[]): void {
	const ips: Record<string, string> = {
		[DONGLE]: SHARED_IP,
		[TWIN]: SHARED_IP,
		[UPLINK]: UPLINK_IP,
		eth2: "198.51.100.7",
	};
	processIfconfigOutput(
		names.map((name) => stanza(name, ips[name] ?? "")).join("\n\n"),
	);
}

async function seedSim(body: string): Promise<void> {
	const deps: RouterAdminProbeDeps = {
		canManageModems: async () => true,
		runIpRouteShowDefault: async () =>
			`default via 192.168.0.1 dev ${DONGLE} proto dhcp src ${SHARED_IP} metric 103 \n` +
			`default via 192.168.78.1 dev ${UPLINK} proto dhcp src ${UPLINK_IP} metric 101 `,
		fetchViaInterface: async (_ifname, urls) => urls.map(() => body),
		postViaInterface: async () => "",
	};
	await refreshRouterCellularAdmin(new Map([[DONGLE, "19d2:1405"]]), deps);
}

function reset(): void {
	resetNetifSnapshotForTest();
	setNetifState({});
	for (const name of [DONGLE, TWIN, UPLINK, "eth2"])
		setNetifDupIpSuppression(name, false);
	resetBondOptOut();
	resetRouterCellularAdmin();
	setQueueUpdateGwHook(null);
	setBondIdentityResolverForTest(null);
}

beforeEach(reset);
afterEach(reset);

describe("the duplicate-IP release", () => {
	test("a mapped survivor stays bonded when its twin leaves", () => {
		scan(DONGLE, TWIN, UPLINK);
		expect(genSrtlaIpList().filter((ip) => ip === SHARED_IP)).toHaveLength(2);

		scan(DONGLE, UPLINK);

		expect(getNetworkInterfaces()[DONGLE]).toMatchObject({
			error: 0,
			enabled: true,
		});
		expect(genSrtlaIpList().sort()).toEqual([SHARED_IP, UPLINK_IP]);
	});

	test("keeps the SIM-less hold when the SIM came back on an earlier pass", async () => {
		await seedSim(WITH_SIM);
		scan(DONGLE, TWIN, UPLINK);
		await seedSim(NO_SIM);
		scan(DONGLE, TWIN, UPLINK);
		expect(getNetworkInterfaces()[DONGLE]?.error).toBe(
			NETIF_ERR_DUPIPV4 | NETIF_ERR_NOSIM,
		);

		await seedSim(WITH_SIM);
		scan(DONGLE, TWIN, UPLINK);
		scan(DONGLE, UPLINK);

		expect(getNetworkInterfaces()[DONGLE]).toMatchObject({
			error: 0,
			enabled: false,
		});
		expect(genSrtlaIpList()).toEqual([UPLINK_IP]);
	});

	test("keeps the SIM-less hold when the SIM comes back on the release pass", async () => {
		await seedSim(NO_SIM);
		scan(DONGLE, TWIN, UPLINK);

		await seedSim(WITH_SIM);
		scan(DONGLE, UPLINK);

		expect(getNetworkInterfaces()[DONGLE]).toMatchObject({
			error: 0,
			enabled: false,
		});
	});

	test("releases a survivor whose twin's row was deleted before the poll", () => {
		scan(DONGLE, TWIN, UPLINK);
		// The monitor or a USB retirement removes the row outside the poll, so the
		// next poll sees an unchanged interface set.
		delete getNetworkInterfaces()[TWIN];

		scan(DONGLE, UPLINK);

		const survivor = getNetworkInterfaces()[DONGLE];
		expect(survivor).toMatchObject({ error: 0, enabled: true });
		expect(probeExclusionReason(survivor)).toBeUndefined();
	});

	test("hotspot notice suppression does not read as a unique address", () => {
		scan(DONGLE, TWIN, UPLINK);
		setNetifDupIpSuppression(TWIN, true);

		// A topology change while the transition is suppressed.
		scan(DONGLE, TWIN, UPLINK, "eth2");
		for (const name of [DONGLE, TWIN]) {
			expect(getNetworkInterfaces()[name]?.error).toBe(NETIF_ERR_DUPIPV4);
			expect(getNetworkInterfaces()[name]?.enabled).toBe(false);
		}

		// Rolled back, on an unchanged poll: still a collision.
		setNetifDupIpSuppression(TWIN, false);
		scan(DONGLE, TWIN, UPLINK, "eth2");
		for (const name of [DONGLE, TWIN])
			expect(getNetworkInterfaces()[name]?.error).toBe(NETIF_ERR_DUPIPV4);
	});

	test("a duplicate that could not be mapped joins once its address is unique", () => {
		setBondIdentityResolverForTest((ifname) => {
			if (ifname === TWIN) throw new Error("no identity");
			return resolveModemPhysicalIdentity(ifname);
		});
		scan(DONGLE, TWIN, UPLINK);
		expect(genSrtlaIpList().filter((ip) => ip === SHARED_IP)).toHaveLength(1);

		scan(TWIN, UPLINK);

		expect(getNetworkInterfaces()[TWIN]).toMatchObject({
			error: 0,
			enabled: true,
		});
		expect(genSrtlaIpList().sort()).toEqual([SHARED_IP, UPLINK_IP]);
	});
});
