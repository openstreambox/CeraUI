import { expect, test } from "bun:test";
import { parseModemInfo, parseSimInfo } from "../modules/modems/mmcli.ts";
import {
	isModemPairAtStableKey,
	type ModemPairReadDeps,
	type ReadyModemSim,
} from "../modules/modems/modem-registration.ts";

function fixture(): { ready: ReadyModemSim; deps: ModemPairReadDeps } {
	const modem = parseModemInfo({
		"modem.generic.model": "Example",
		"modem.generic.state": "registered",
		"modem.generic.ports": ["up0 (net)"],
		"modem.generic.device-identifier": "device-a",
		"modem.generic.equipment-identifier": "000000000000000",
		"modem.generic.signal-quality.value": "50",
	});
	const sim = parseSimInfo({ "sim.properties.iccid": "89000000000000000000" });
	if (!modem.ok || !sim.ok) throw new Error("Invalid fixture");
	const ready = { modemInfo: modem.value, simInfo: sim.value };
	return {
		ready,
		deps: {
			paths: async () =>
				new Map([["up0", "platform-xhci-hcd.0.auto-usb-0:1.4.1:1.4"]]),
			list: async () => [1],
			readSim: async () => ready,
		},
	};
}
const KEY = "platform-xhci-hcd.0.auto-usb-0:1.4.1";
const PAIR = { deviceId: "device-a", simId: "89000000000000000000" };

test("boot recovery resolves physical device+SIM without a hydrated roster", async () => {
	const f = fixture();
	expect(await isModemPairAtStableKey(KEY, PAIR, f.deps)).toBe(true);
	expect(await isModemPairAtStableKey("another-key", PAIR, f.deps)).toBe(false);
	expect(
		await isModemPairAtStableKey(KEY, { ...PAIR, simId: "other-sim" }, f.deps),
	).toBe(false);
});

test("missing, unreadable and ambiguous pair observations fail closed", async () => {
	const f = fixture();
	expect(
		await isModemPairAtStableKey(KEY, PAIR, {
			...f.deps,
			readSim: async () => "unreadable",
		}),
	).toBe(false);
	expect(
		await isModemPairAtStableKey(KEY, PAIR, {
			...f.deps,
			paths: async () => new Map(),
		}),
	).toBe(false);
	expect(
		await isModemPairAtStableKey(KEY, PAIR, {
			...f.deps,
			list: async () => [1, 2],
		}),
	).toBe(false);
	expect(
		await isModemPairAtStableKey(KEY, PAIR, {
			...f.deps,
			list: async () => undefined,
		}),
	).toBe(false);
});
