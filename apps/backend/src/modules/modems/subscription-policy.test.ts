import { describe, expect, test } from "bun:test";
import { requiresClat, selectSubscription } from "./subscription-policy.ts";
import {
	decideInitialEps,
	parseInternalIpv4Grant,
	parseQmapAutoConnect,
	resolveTransportQuirk,
	selectSerialEndpoint,
} from "./transport-policy.ts";

describe("subscription policy", () => {
	test("home wins over serving and unknown home is preserved", () => {
		expect(
			selectSubscription({ homePlmn: "310410", servingPlmn: "310260" }),
		).toMatchObject({
			state: "recognized",
			policy: { key: "att" },
			evidence: "home",
		});
		expect(
			selectSubscription({ homePlmn: "00101", servingPlmn: "310260" }),
		).toEqual({ state: "unknown" });
		expect(
			selectSubscription({ homePlmn: "invalid", servingPlmn: "310260" }),
		).toEqual({ state: "unknown" });
	});
	test("missing home permits explicit serving fallback", () => {
		for (const homePlmn of [undefined, "", "--"]) {
			expect(
				selectSubscription({
					...(homePlmn === undefined ? {} : { homePlmn }),
					servingPlmn: "310260",
				}),
			).toMatchObject({
				evidence: "serving-fallback",
				policy: { key: "t-mobile" },
			});
		}
		expect(selectSubscription({})).toEqual({ state: "unknown" });
	});
	test("reseller GID and exact normalized SPN precede direct carrier", () => {
		expect(
			selectSubscription({ homePlmn: "310410", gid1: "20ff00" }),
		).toMatchObject({ policy: { apn: "ereseller" } });
		expect(
			selectSubscription({ homePlmn: "310410", spn: "US Mobile" }),
		).toMatchObject({ policy: { apn: "ereseller" } });
		expect(
			selectSubscription({ homePlmn: "310410", spn: "not US Mobile" }),
		).toMatchObject({ policy: { apn: "broadband" } });
		expect(
			selectSubscription({ homePlmn: "310260", gid1: "6910" }),
		).toMatchObject({ policy: { key: "us-mobile-tmo" } });
	});
	test("moving either SIM among transports cannot alter carrier selection", () => {
		const layouts = [
			["310260", "310410"],
			["310410", "310260"],
		];
		for (const layout of layouts) {
			for (const homePlmn of layout) {
				for (const mode of ["qmi", "mbim", "rndis"] as const) {
					resolveTransportQuirk({
						model: "unknown",
						firmware: "unknown",
						mode,
					});
					expect(selectSubscription({ homePlmn })).toMatchObject({
						policy: { key: homePlmn === "310260" ? "t-mobile" : "att" },
					});
				}
			}
		}
	});
	test("Verizon recognition is explicitly unqualified", () => {
		for (const homePlmn of ["310590", "310890", "311270", "311480", "312770"]) {
			expect(selectSubscription({ homePlmn })).toMatchObject({
				state: "not-qualified",
				policy: { qualified: false },
			});
		}
	});
	test("only observed IPv6-only grants require translation", () => {
		for (const grant of ["none", "ipv4", "ipv4v6"] as const)
			expect(requiresClat(grant)).toBe(false);
		expect(requiresClat("ipv6")).toBe(true);
	});
});

describe("transport policy", () => {
	test("unknown firmware and wrong composition are never admitted", () => {
		expect(
			resolveTransportQuirk({
				model: "RM520N-GL",
				firmware: "unknown",
				mode: "qmi",
			}),
		).toBeUndefined();
		expect(
			resolveTransportQuirk({
				model: "RM520N-GL",
				firmware: "RM520NGLAAR01A08M4G",
				mode: "rndis",
			}),
		).toBeUndefined();
		expect(
			resolveTransportQuirk({
				model: "RM520N-GL",
				firmware: "RM520NGLAAR01A08M4G",
				mode: "qmi",
			}),
		).toMatchObject({ rawIpBeforeCall: true, qmapReadback: true });
	});
	test("AT endpoint follows USB interface, device and generation", () => {
		const identity = {
			usbDevice: "device-a",
			usbInterface: "interface-3",
			generation: "epoch-2",
		};
		const endpoint = { ...identity, port: "/dev/ttyUSB42" };
		expect(
			selectSerialEndpoint(
				[
					{ ...identity, usbDevice: "device-b", port: "/dev/ttyUSB0" },
					endpoint,
				],
				identity,
			),
		).toEqual(endpoint);
		expect(
			selectSerialEndpoint([endpoint], { ...identity, generation: "epoch-1" }),
		).toBeUndefined();
		expect(
			selectSerialEndpoint(
				[endpoint, { ...endpoint, port: "/dev/ttyUSB43" }],
				identity,
			),
		).toBeUndefined();
	});
	test("strict IPv4 grant rejects dotted IPv6, zero, wrong context and conflicts", () => {
		expect(parseInternalIpv4Grant('+CGPADDR: 1,"192.0.2.2"', 1)).toBe(
			"192.0.2.2",
		);
		for (const value of [
			"0.0.0.0",
			"32.1.13.184.0.0.0.0.0.0.0.0.0.0.0.1",
			"192.0.2.2garbage",
			"999.0.0.1",
		]) {
			expect(
				parseInternalIpv4Grant(`+CGPADDR: 1,"${value}"`, 1),
			).toBeUndefined();
		}
		expect(
			parseInternalIpv4Grant('+CGPADDR: 2,"192.0.2.2"', 1),
		).toBeUndefined();
		expect(
			parseInternalIpv4Grant('+CGPADDR: 1,"192.0.2.2","192.0.2.3"', 1),
		).toBeUndefined();
	});
	test("QMAP readback must be unambiguous and target rule zero", () => {
		expect(parseQmapAutoConnect('+QMAP: "auto_connect",0,1\n')).toBe(1);
		expect(parseQmapAutoConnect('+QMAP: "auto_connect",0,0\n')).toBe(0);
		expect(parseQmapAutoConnect('+QMAP: "auto_connect",1,0\n')).toBeUndefined();
		expect(parseQmapAutoConnect("OK")).toBeUndefined();
		expect(
			parseQmapAutoConnect(
				'+QMAP: "auto_connect",0,0\n+QMAP: "auto_connect",0,1',
			),
		).toBeUndefined();
	});
	test("foreign EPS baseline permits one attempt and a failed verification blocks", () => {
		const desired = { apn: "example", family: "ipv4v6" } as const;
		const foreign = { apn: "foreign", family: "ipv4" } as const;
		expect(decideInitialEps(foreign, desired, false, true)).toBe(
			"baseline-and-attempt",
		);
		expect(decideInitialEps(foreign, desired, true, true)).toBe("blocked");
		expect(decideInitialEps(undefined, desired, true, true)).toBe("blocked");
		expect(decideInitialEps(desired, desired, true, false)).toBe("aligned");
		expect(
			decideInitialEps({ ...desired, family: "ipv6" }, desired, true, true),
		).toBe("aligned");
		expect(
			decideInitialEps({ ...desired, family: "ipv6" }, desired, true, false),
		).toBe("blocked");
	});
});

test("admitted MBIM and internal-call compositions remain distinct", () => {
	expect(
		resolveTransportQuirk({
			model: "DW5821e Snapdragon X20 LTE",
			firmware: "T77W968.F1.0.0.4.2.GC.010\n026",
			mode: "mbim",
		}),
	).toEqual({
		owner: "network-manager",
		qmapReadback: false,
		rawIpBeforeCall: false,
	});
	expect(
		resolveTransportQuirk({
			model: "FM350-GL",
			firmware: "81600.0000.00.29.18.01",
			mode: "rndis",
		}),
	).toEqual({
		owner: "internal-call",
		qmapReadback: false,
		rawIpBeforeCall: false,
	});
	expect(
		parseQmapAutoConnect('\r\n+QMAP: "auto_connect",0,0\r\n\r\nOK\r\n'),
	).toBe(0);
	expect(
		parseInternalIpv4Grant('+CGPADDR: 1,"192.0.2.2",broken"', 1),
	).toBeUndefined();
});
