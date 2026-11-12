import { afterEach, expect, test } from "bun:test";
import {
	cellularDefaultEligible,
	cellularHiddenInterface,
	cellularSourceBinding,
	cellularSourceIpv4,
	cellularSourceReady,
	claimCellularSource,
	releaseCellularSource,
	resetCellularSourcesForTest,
	setCellularSourceBinding,
	setCellularSourceReady,
	withdrawCellularSource,
} from "./cellular-source-state.ts";

const owner = "1".repeat(64),
	other = "2".repeat(64),
	iface = "wwan0";
const binding = {
	source: "198.18.255.1",
	device: "cclat1",
	translated: true,
	generation: "bearer-one",
};
afterEach(resetCellularSourcesForTest);
test("a claimed uplink is unpublished until the exact bearer has traffic readiness", () => {
	claimCellularSource(owner, "usb-one", iface);
	expect(cellularSourceReady(iface, "198.51.100.2")).toBe(false);
	expect(setCellularSourceBinding(owner, "usb-one", iface, binding)).toBe(true);
	expect(
		setCellularSourceReady(owner, "usb-one", iface, "old-bearer", true),
	).toBe(false);
	expect(cellularSourceIpv4(iface, undefined)).toBeUndefined();
	expect(
		setCellularSourceReady(owner, "usb-one", iface, "bearer-one", true),
	).toBe(true);
	expect(cellularSourceIpv4(iface, undefined)).toBe(binding.source);
	expect(cellularSourceReady(iface, binding.source)).toBe(true);
	expect(cellularDefaultEligible(iface, binding.source)).toBe(false);
	expect(cellularHiddenInterface("cclat1")).toBe(true);
});
test("SIM/USB replacement invalidates the source and stale callbacks cannot release its successor", () => {
	claimCellularSource(owner, "usb-one", iface);
	setCellularSourceBinding(owner, "usb-one", iface, binding);
	setCellularSourceReady(owner, "usb-one", iface, binding.generation, true);
	claimCellularSource(other, "usb-two", iface);
	expect(cellularSourceBinding(iface)).toBeUndefined();
	releaseCellularSource(owner, "usb-one", iface);
	expect(cellularSourceReady(iface, binding.source)).toBe(false);
	expect(
		setCellularSourceReady(owner, "usb-one", iface, binding.generation, true),
	).toBe(false);
});
test("renumbering or a new native grant cannot inherit translated readiness", () => {
	claimCellularSource(owner, "usb-one", iface);
	setCellularSourceBinding(owner, "usb-one", iface, binding);
	setCellularSourceReady(owner, "usb-one", iface, binding.generation, true);
	const native = "198.51.100.2";
	expect(cellularSourceIpv4(iface, native)).toBe(native);
	expect(cellularSourceReady(iface, native)).toBe(false);
	withdrawCellularSource(owner, "usb-one", iface);
	expect(cellularSourceBinding(iface)).toBeUndefined();
	expect(cellularSourceReady(iface, binding.source)).toBe(false);
	expect(cellularSourceReady("eth0", native)).toBe(true);
});
