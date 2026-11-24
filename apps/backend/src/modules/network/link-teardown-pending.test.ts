import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resolvePhysicalDevice } from "../modems/physical-identity.ts";
import { setBondIdentityResolverForTest } from "../streaming/bond-entry.ts";
import {
	resetClatTranslationStateForTest,
	setClatTranslationsForTest,
} from "./clat-translation.ts";
import {
	isLinkTeardownPending,
	onLinkTeardownPendingChange,
	resetLinkTeardownPendingForTest,
	setLinkTeardownPending,
} from "./link-teardown-pending.ts";
import {
	isBondCandidate,
	type NetworkInterface,
} from "./network-interfaces.ts";
import { resetUsbNetMarkers } from "./router-cellular-scan.ts";

const iface = (ip: string): NetworkInterface =>
	({ ip, txb: 0, rxb: 0, tp: 0, enabled: true, error: 0 }) as NetworkInterface;

describe("a link whose teardown has not settled is kept out of the bond", () => {
	beforeEach(() => {
		// A USB replacement hold another file left on the same name would
		// keep these links out of the bond for a different reason.
		resetUsbNetMarkers();
		setBondIdentityResolverForTest((ifname) =>
			resolvePhysicalDevice({ ifname, idPath: "platform-synthetic-usb-0:1" }),
		);
	});
	afterEach(() => {
		setBondIdentityResolverForTest(null);
		resetLinkTeardownPendingForTest();
		resetClatTranslationStateForTest();
	});

	test("the modem interface is refused while marked and offered again after", () => {
		expect(isBondCandidate("wwan0", iface("10.64.0.2"))).toBe(true);
		setLinkTeardownPending(["wwan0"], true);
		expect(isLinkTeardownPending("wwan0")).toBe(true);
		expect(isBondCandidate("wwan0", iface("10.64.0.2"))).toBe(false);
		setLinkTeardownPending(["wwan0"], false);
		expect(isBondCandidate("wwan0", iface("10.64.0.2"))).toBe(true);
	});

	test("the modem's CLAT translator is refused with it", () => {
		setClatTranslationsForTest(
			new Map([
				["clat3", { parent: "wwan0", tun: "clat3", ipv4: "10.254.0.3" }],
			]),
		);
		expect(isBondCandidate("clat3", iface("10.254.0.3"))).toBe(true);
		setLinkTeardownPending(["wwan0"], true);
		expect(isBondCandidate("clat3", iface("10.254.0.3"))).toBe(false);
	});

	test("listeners hear only real changes", () => {
		let heard = 0;
		const off = onLinkTeardownPendingChange(() => heard++);
		setLinkTeardownPending(["wwan0"], true);
		setLinkTeardownPending(["wwan0"], true);
		setLinkTeardownPending(["wwan0"], false);
		setLinkTeardownPending(["wwan1"], false);
		off();
		expect(heard).toBe(2);
	});
});
