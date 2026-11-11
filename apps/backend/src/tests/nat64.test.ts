/**
 * NAT64 address synthesis (RFC 6052) and prefix discovery (RFC 7050).
 */
import { describe, expect, test } from "bun:test";
import {
	buildIpv4OnlyArpaQuery,
	formatIpv6,
	formatNat64Prefix,
	parseAaaaResponse,
	parseIpv6,
	parseNat64Prefix,
	pref64FromIpv4OnlyArpa,
	synthesizeNat64,
} from "../modules/network/nat64.ts";

function synth(prefix: string, ipv4: string): string | undefined {
	const parsed = parseNat64Prefix(prefix);
	return parsed && synthesizeNat64(parsed, ipv4);
}

describe("address text", () => {
	test.each([
		["::", "::"],
		["::1", "::1"],
		["2001:DB8:0:0:1:0:0:1", "2001:db8::1:0:0:1"],
		["2001:db8:0:1:1:1:1:1", "2001:db8:0:1:1:1:1:1"],
		["64:ff9b::192.0.2.33", "64:ff9b::c000:221"],
		["fe80::1%wwan0", "fe80::1"],
	])("%s reads back as %s", (input, output) => {
		const bytes = parseIpv6(input);
		expect(bytes && formatIpv6(bytes)).toBe(output);
	});

	test.each(["", "1::2::3", "12345::", "1:2:3:4:5:6:7", "::g", "1.2.3.4"])(
		"%p is not an IPv6 address",
		(input) => {
			expect(parseIpv6(input)).toBeUndefined();
		},
	);
});

describe("synthesis follows the RFC 6052 section 2.4 table", () => {
	test.each([
		["2001:db8::/32", "2001:db8:c000:221::"],
		["2001:db8:100::/40", "2001:db8:1c0:2:21::"],
		["2001:db8:122::/48", "2001:db8:122:c000:2:2100::"],
		["2001:db8:122:300::/56", "2001:db8:122:3c0:0:221::"],
		// The RFC prints a trailing "::" here; RFC 5952 does not compress one group.
		["2001:db8:122:344::/64", "2001:db8:122:344:c0:2:2100:0"],
		["2001:db8:122:344::/96", "2001:db8:122:344::c000:221"],
		["64:ff9b::/96", "64:ff9b::c000:221"],
	])("192.0.2.33 in %s is %s", (prefix, expected) => {
		expect(synth(prefix, "192.0.2.33")).toBe(expected);
	});

	test("a prefix length NAT64 does not define is refused", () => {
		expect(parseNat64Prefix("2001:db8::/80")).toBeUndefined();
		expect(parseNat64Prefix("2001:db8::")).toBeUndefined();
	});

	test("something that is not an IPv4 address is refused", () => {
		expect(synth("64:ff9b::/96", "192.0.2")).toBeUndefined();
		expect(synth("64:ff9b::/96", "192.0.2.256")).toBeUndefined();
		expect(synth("64:ff9b::/96", "example.net")).toBeUndefined();
	});
});

describe("the prefix is read back out of a DNS64 answer", () => {
	test.each([
		"2001:db8::/32",
		"2001:db8:100::/40",
		"2001:db8:122::/48",
		"2001:db8:122:300::/56",
		"2001:db8:122:344::/64",
		"64:ff9b::/96",
	])("%s", (prefix) => {
		const answers = ["192.0.0.170", "192.0.0.171"].map(
			(v4) => synth(prefix, v4) ?? "",
		);
		const found = pref64FromIpv4OnlyArpa(answers);
		expect(found && formatNat64Prefix(found)).toBe(prefix);
	});

	test("no AAAA answer means no NAT64 on this uplink", () => {
		expect(pref64FromIpv4OnlyArpa([])).toBeUndefined();
	});

	test("a native address is not mistaken for a synthesis", () => {
		expect(pref64FromIpv4OnlyArpa(["2001:db8::1"])).toBeUndefined();
	});

	test("answers naming two prefixes are not guessed between", () => {
		expect(
			pref64FromIpv4OnlyArpa(["64:ff9b::c000:aa", "2001:db8:64::c000:ab"]),
		).toBeUndefined();
	});
});

describe("the discovery question and its answer on the wire", () => {
	const ID = 0x1234;

	function response(over: { id?: number; flags?: number } = {}): Uint8Array {
		const query = buildIpv4OnlyArpaQuery(ID);
		const record = [
			0xc0,
			0x0c,
			0x00,
			0x1c,
			0x00,
			0x01,
			0x00,
			0x00,
			0x00,
			0x3c,
			0x00,
			0x10,
			...(parseIpv6("64:ff9b::c000:aa") ?? []),
		];
		const message = new Uint8Array(query.length + record.length);
		message.set(query);
		const view = new DataView(message.buffer);
		view.setUint16(0, over.id ?? ID);
		view.setUint16(2, over.flags ?? 0x8180);
		view.setUint16(6, 1);
		message.set(record, query.length);
		return message;
	}

	test("the query asks for AAAA ipv4only.arpa with recursion", () => {
		const query = buildIpv4OnlyArpaQuery(ID);
		expect(Array.from(query.subarray(0, 6))).toEqual([
			0x12, 0x34, 0x01, 0x00, 0x00, 0x01,
		]);
		expect(new TextDecoder().decode(query.subarray(13, 21))).toBe("ipv4only");
		expect(Array.from(query.subarray(-4))).toEqual([0x00, 0x1c, 0x00, 0x01]);
	});

	test("AAAA records are extracted from a matching response", () => {
		expect(parseAaaaResponse(response(), ID)).toEqual(["64:ff9b::c000:aa"]);
	});

	test("another query's response is not accepted", () => {
		expect(parseAaaaResponse(response({ id: ID + 1 }), ID)).toBeUndefined();
	});

	test("a query, an error or a truncated response is not an answer", () => {
		expect(parseAaaaResponse(buildIpv4OnlyArpaQuery(ID), ID)).toBeUndefined();
		expect(parseAaaaResponse(response({ flags: 0x8183 }), ID)).toBeUndefined();
		expect(parseAaaaResponse(response({ flags: 0x8380 }), ID)).toBeUndefined();
		expect(parseAaaaResponse(response().subarray(0, 40), ID)).toBeUndefined();
	});
	test("matching id cannot substitute a different name, type or class", () => {
		const wrongName = response();
		wrongName[13] = 0x78;
		expect(parseAaaaResponse(wrongName, ID)).toBeUndefined();
		const wrongType = response();
		wrongType[buildIpv4OnlyArpaQuery(ID).length - 3] = 1;
		expect(parseAaaaResponse(wrongType, ID)).toBeUndefined();
		const wrongClass = response();
		wrongClass[buildIpv4OnlyArpaQuery(ID).length + 5] = 3;
		expect(parseAaaaResponse(wrongClass, ID)).toBeUndefined();
		const truncated = response().subarray(0, 20);
		new DataView(
			truncated.buffer,
			truncated.byteOffset,
			truncated.byteLength,
		).setUint16(6, 0);
		expect(parseAaaaResponse(truncated, ID)).toBeUndefined();
	});
	test("echoed DNS name is case-insensitive", () => {
		const upper = response();
		upper[13] = 0x49;
		expect(parseAaaaResponse(upper, ID)).toEqual(["64:ff9b::c000:aa"]);
	});
});
