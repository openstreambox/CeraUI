import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call } from "@orpc/server";

import {
	getConfig,
	loadConfig,
	saveConfig,
	setConfigFilePath,
} from "../modules/config.ts";
import { mintLinkId } from "../modules/modems/physical-identity.ts";
import { resolveModemPhysicalIdentity } from "../modules/modems/physical-identity-source.ts";
import {
	isBondOptedOut,
	setPersistentBondOptOut,
} from "../modules/network/bond-preference.ts";
import {
	getNetworkInterfaces,
	isBondCandidate,
	netIfBuildMsg,
	resetBondOptOutSession,
} from "../modules/network/network-interfaces.ts";
import {
	refreshUsbNetMarkers,
	resetUsbNetMarkers,
} from "../modules/network/router-cellular-scan.ts";
import { setBondIdentityResolverForTest } from "../modules/streaming/bond-entry.ts";
import { configureNetworkInterfaceProcedure } from "../rpc/procedures/network.procedure.ts";
import {
	attachHuaweiTwins,
	clearBondNetworkFixture,
	HUAWEI_PORT_IDENTITIES,
	HUAWEI_TWIN_IP,
	installHuaweiIdentityResolver,
	makeRpcContext,
	physicalRecord,
	resetBondFixture,
} from "./helpers/bond-toggle-fixture.ts";
import {
	constructedTwinDeps,
	constructedTwins,
} from "./helpers/constructed-usb-twins.ts";

describe("operator bond opt-out — config.json restart persistence", () => {
	let configPath = "";

	beforeEach(async () => {
		resetBondFixture();
		configPath = join(
			mkdtempSync(join(tmpdir(), "bond-opt-out-")),
			"config.json",
		);
		writeFileSync(configPath, "{}");
		setConfigFilePath(configPath);
		await loadConfig();
		installHuaweiIdentityResolver();
		attachHuaweiTwins();
	});

	afterEach(() => {
		resetBondFixture();
		resetUsbNetMarkers();
		setConfigFilePath("config.json");
	});

	test("does not carry an old preference under an invalid factory serial", async () => {
		clearBondNetworkFixture();
		setBondIdentityResolverForTest(null);
		await refreshUsbNetMarkers(
			constructedTwins.map((d) => d.ifname),
			constructedTwinDeps(),
		);
		attachHuaweiTwins("wwu1u4c2", "wwu1c2");
		const legacy = mintLinkId("usb-serial:413c:0123456789ABCDEF");
		getConfig().bond_opt_out = { [legacy]: true };
		saveConfig();
		expect(isBondOptedOut("wwu1u4c2")).toBe(false);
		expect(isBondOptedOut("wwu1c2")).toBe(false);
		setPersistentBondOptOut("wwu1u4c2", false);
		expect(getConfig().bond_opt_out?.[legacy]).toBe(true);
	});

	test.each(["fixture ABC123", "fixture_ABC123"])(
		"uses only the current primary preference when toggling after a collision",
		async (savedSerial) => {
			clearBondNetworkFixture();
			setBondIdentityResolverForTest(null);
			const devices = constructedTwins.map((d) => ({
				...d,
				serial: "fixture ABC123",
			}));
			const [first, second] = constructedTwins.map((d) => d.ifname);
			if (first === undefined || second === undefined)
				throw new Error("missing fixtures");
			const names = [first, second];
			const deps = constructedTwinDeps(devices);
			await refreshUsbNetMarkers([first], deps);
			const canonical = mintLinkId("usb-serial:413c:fixture_ABC123");
			const saved = mintLinkId(`usb-serial:413c:${savedSerial}`);
			expect(resolveModemPhysicalIdentity(first).linkId).toBe(canonical);
			getConfig().bond_opt_out = { [saved]: true };
			saveConfig();
			expect(isBondOptedOut(first)).toBe(saved === canonical);

			await refreshUsbNetMarkers(names, deps);
			expect(isBondOptedOut(first)).toBe(false);
			expect(isBondOptedOut(second)).toBe(false);
			const port = setPersistentBondOptOut(first, true);
			if (port === undefined) throw new Error("missing port");
			expect(getConfig().bond_opt_out?.[port]).toBe(true);
			expect(isBondOptedOut(first)).toBe(true);
			setPersistentBondOptOut(first, false);
			expect(getConfig().bond_opt_out?.[port]).toBeUndefined();
			expect(isBondOptedOut(first)).toBe(false);
			expect(isBondOptedOut(second)).toBe(false);
			expect(getConfig().bond_opt_out?.[saved]).toBe(true);
		},
	);

	test("a port toggle cannot delete a valid device's primary opt-out through an invalid serial", async () => {
		clearBondNetworkFixture();
		setBondIdentityResolverForTest(null);
		const [first, second] = constructedTwins;
		if (first === undefined || second === undefined)
			throw new Error("missing fixtures");
		const devices = [
			{ ...first, serial: "\tfixtureABC123" },
			{ ...second, serial: "fixtureABC123" },
		];
		await refreshUsbNetMarkers(
			devices.map((d) => d.ifname),
			constructedTwinDeps(devices),
		);
		const valid = resolveModemPhysicalIdentity(second.ifname).linkId;
		getConfig().bond_opt_out = { [valid]: true };
		setPersistentBondOptOut(first.ifname, false);
		expect(isBondOptedOut(second.ifname)).toBe(true);
		expect(getConfig().bond_opt_out?.[valid]).toBe(true);
		expect(
			resolveModemPhysicalIdentity(first.ifname).legacyLinkId,
		).toBeUndefined();
	});

	test("an opt-out survives a simulated backend restart and follows the physical port", async () => {
		// Given the operator excludes the first Huawei while it is called eth1.
		const result = await call(
			configureNetworkInterfaceProcedure,
			{ name: "eth1", ip: HUAWEI_TWIN_IP, enabled: false },
			{ context: makeRpcContext() },
		);
		expect(result.success).toBe(true);
		const persisted = readFileSync(configPath, "utf8");
		expect(persisted).toContain(
			physicalRecord("eth1", HUAWEI_PORT_IDENTITIES.eth1).linkId,
		);
		expect(persisted).not.toContain('"eth1":true');

		// When process memory is replaced from config.json and the same physical
		// port re-enumerates under a different interface name.
		resetBondOptOutSession();
		await loadConfig();
		clearBondNetworkFixture();
		installHuaweiIdentityResolver({
			usbHuaweiA: HUAWEI_PORT_IDENTITIES.eth1,
			usbHuaweiB: HUAWEI_PORT_IDENTITIES.enx0c5b8f279a64,
		});
		attachHuaweiTwins("usbHuaweiA", "usbHuaweiB");
		const wire = netIfBuildMsg();
		const current = wire.usbHuaweiA;

		// Then the durable physical identity, not the retired ifname, keeps it out.
		expect(current?.enabled).toBe(false);
		const raw = getNetworkInterfaces();
		expect(raw.usbHuaweiA).toBeDefined();
		expect(
			raw.usbHuaweiA === undefined
				? true
				: isBondCandidate("usbHuaweiA", raw.usbHuaweiA),
		).toBe(false);
	});
});
