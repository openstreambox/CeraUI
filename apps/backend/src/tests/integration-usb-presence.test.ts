// Installed in apps/backend/src/tests by the train's explicit regression step.
import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import {
	listPresentPhysicalDevices,
	resetPhysicalIdentityRegistry,
} from "../modules/modems/physical-identity.ts";
import {
	getUsbPhysicalDescriptor,
	invalidateUsbNetReading,
	onUsbNetReadingInvalidated,
	onUsbNetScanCommitted,
	refreshUsbNetMarkers,
	resetUsbNetMarkers,
	usbNetScanCovers,
	usbNetScanCoversCurrentPresence,
} from "../modules/network/router-cellular-scan.ts";
import { stopWifiUpdateLoopForTest } from "../modules/wifi/wifi-interfaces.ts";
import {
	FIRST_SIGHT_IFACE,
	FIRST_SIGHT_IP,
	firstSightIfconfig,
	firstSightScan,
} from "./helpers/bond-first-sight-fixture.ts";

beforeEach(() => {
	jest.useFakeTimers();
	resetUsbNetMarkers();
	resetPhysicalIdentityRegistry();
});
afterEach(() => {
	jest.restoreAllMocks();
	jest.useRealTimers();
	stopWifiUpdateLoopForTest();
	resetUsbNetMarkers();
	resetPhysicalIdentityRegistry();
});

test("removal retracts committed identity and admission until a scan covers the new presence", async () => {
	const name = FIRST_SIGHT_IFACE;
	const scan = firstSightScan(firstSightIfconfig(name, FIRST_SIGHT_IP), {
		blocked: [],
		buses: { [name]: "usb" },
	});
	let invalidated = 0;
	let committed = 0;
	const offInvalid = onUsbNetReadingInvalidated(() => {
		invalidated++;
	});
	const offCommit = onUsbNetScanCommitted(() => {
		committed++;
	});
	try {
		await scan.settle();
		expect(usbNetScanCovers(name)).toBe(true);
		expect(usbNetScanCoversCurrentPresence(name)).toBe(true);
		expect(getUsbPhysicalDescriptor(name)).toBeDefined();
		expect(listPresentPhysicalDevices().length).toBeGreaterThan(0);
		const before = committed;
		invalidateUsbNetReading(name, 2);
		expect(invalidated).toBe(1);
		expect(usbNetScanCovers(name)).toBe(false);
		expect(usbNetScanCoversCurrentPresence(name)).toBe(false);
		expect(getUsbPhysicalDescriptor(name)).toBeUndefined();
		expect(listPresentPhysicalDevices()).toEqual([]);
		await refreshUsbNetMarkers([]);
		expect(committed).toBe(before);
		await scan.settle();
		expect(usbNetScanCoversCurrentPresence(name)).toBe(true);
		expect(getUsbPhysicalDescriptor(name)).toBeDefined();
		expect(committed).toBeGreaterThan(before);
	} finally {
		scan.release();
		offInvalid();
		offCommit();
	}
});

test("translated IPv4 appears on its physical modem alongside native IPv6", async () => {
	const { resolvePhysicalDevice } = await import(
		"../modules/modems/physical-identity.ts"
	);
	const { setClatTranslationsForTest, resetClatTranslationStateForTest } =
		await import("../modules/network/clat-translation.ts");
	const { netIfBuildMsg, processIfconfigOutput, resetNetifSnapshotForTest } =
		await import("../modules/network/network-interfaces.ts");
	const { setBondIdentityResolverForTest } = await import(
		"../modules/streaming/bond-entry.ts"
	);
	resetNetifSnapshotForTest();
	const record = resolvePhysicalDevice({
		ifname: "wwan0",
		idPath: "platform-synthetic-usb-0:1",
	});
	setBondIdentityResolverForTest(() => record);
	try {
		setClatTranslationsForTest(
			new Map([
				[
					"clat3",
					{
						parent: "wwan0",
						tun: "clat3",
						ipv4: "192.0.2.3",
						generation: "synthetic-activation",
					},
				],
			]),
		);
		processIfconfigOutput(
			[
				"wwan0: flags=4305<UP,POINTOPOINT,RUNNING> mtu 1500\n",
				"clat3: flags=4305<UP,POINTOPOINT,RUNNING> mtu 1480",
				"        inet 192.0.2.3 netmask 255.255.255.255 destination 192.0.2.3",
			].join("\n"),
			new Map([["wwan0", { ipv6: "2001:db8::2" }]]),
		);
		const wire = netIfBuildMsg();
		expect(wire.clat3).toBeUndefined();
		expect(wire.wwan0).toMatchObject({
			ip: "192.0.2.3",
			ipv6: "2001:db8::2",
			addresses: ["192.0.2.3", "2001:db8::2"],
			enabled: true,
		});
	} finally {
		setBondIdentityResolverForTest(null);
		resetClatTranslationStateForTest();
		resetNetifSnapshotForTest();
	}
});
