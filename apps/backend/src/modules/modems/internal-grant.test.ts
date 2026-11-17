import { expect, test } from "bun:test";
import {
	parseInternalContextActive,
	parseInternalContextDns,
	parseInternalGrant,
	parseInternalRegistration,
} from "./transport-policy.ts";

test("the requested context alone supplies a strict native or IPv6-only grant", () => {
	expect(parseInternalGrant('+CGPADDR: 1,"198.51.100.2"\r\nOK\r\n', 1)).toEqual(
		{ family: "ipv4", ipv4: "198.51.100.2" },
	);
	expect(
		parseInternalGrant(
			'+CGPADDR: 3,"0.0.0.0","32.1.13.184.0.0.0.0.0.0.0.0.0.0.0.2"',
			3,
		),
	).toEqual({ family: "ipv6", ipv6: "2001:db8:0:0:0:0:0:2" });
	expect(
		parseInternalGrant(
			'+CGPADDR: 1,"198.51.100.2"\n+CGPADDR: 3,"2001:db8::2"',
			3,
		),
	).toEqual({ family: "ipv6", ipv6: "2001:db8::2" });
});
test("partial quads, malformed CSV, conflicting/duplicate contexts and unusable native addresses fail closed", () => {
	for (const reply of [
		'+CGPADDR: 3,"32.1.13.184.0.0.0.0.0.0.0.0.0.0.0.999"',
		'+CGPADDR: 3,"198.51.100.2',
		'+CGPADDR: 3,"198.51.100.2"\n+CGPADDR: 3,"198.51.100.3"',
		"+CGPADDR: 3,127.0.0.1",
		"+CGPADDR: 3,224.0.0.1",
	])
		expect(parseInternalGrant(reply, 3)).toBeUndefined();
	expect(parseInternalGrant('+CGPADDR: 3,"0.0.0.0"', 3)).toEqual({
		family: "none",
	});
});
test("registration requires one full query response and distinguishes roaming", () => {
	expect(
		parseInternalRegistration('+CEREG: 2,1,"0000","00000000",7\r\nOK\r\n'),
	).toBe("home");
	expect(parseInternalRegistration("+CEREG: 0,5\r\nOK\r\n")).toBe("roaming");
	expect(parseInternalRegistration("+CEREG: 0,2")).toBe("not-registered");
	for (const reply of ["+CEREG: 1", "+CEREG: 0,1\n+CEREG: 0,2", "+CEREG: 0,99"])
		expect(parseInternalRegistration(reply)).toBe("unknown");
});
test("context status and DNS never borrow another context's fields", () => {
	expect(parseInternalContextActive("+CGACT: 1,1\n+CGACT: 3,0", 3)).toBe(false);
	expect(
		parseInternalContextActive("+CGACT: 3,1\n+CGACT: 3,0", 3),
	).toBeUndefined();
	expect(
		parseInternalContextDns(
			'+CGCONTRDP: 3,5,"synthetic.invalid","198.51.100.2","198.51.100.1","2001:db8::53","198.51.100.53"',
			3,
		),
	).toEqual(["2001:db8::53", "198.51.100.53"]);
	expect(
		parseInternalContextDns(
			'+CGCONTRDP: 1,5,"synthetic.invalid","198.51.100.2","198.51.100.1","198.51.100.53",""',
			3,
		),
	).toBeUndefined();
});

test("context definitions retain the whole understood baseline, including an empty APN", async () => {
	const { parseInternalContext, internalContextCommand } = await import(
		"./transport-policy.ts"
	);
	const context = parseInternalContext(
		'+CGDCONT: 1,"IPV4V6","","0.0.0.0",0,0,0,0,0,0',
		1,
	);
	expect(context).toEqual({
		apn: "",
		family: "ipv4v6",
		settings: ["0.0.0.0", "0", "0", "0", "0", "0", "0"],
	});
	if (!context) throw new Error("Missing context");
	expect(
		internalContextCommand(1, context.apn, context.family, context.settings),
	).toBe('AT+CGDCONT=1,"IPV4V6","","0.0.0.0",0,0,0,0,0,0');
	expect(
		parseInternalContext('+CGDCONT: 1,"IPV4V6","example","invalid",0', 1),
	).toBeUndefined();
	expect(() =>
		internalContextCommand(1, "example", "ipv4v6", ["0.0.0.0", "0;AT+CFUN=1"]),
	).toThrow();
});

test("IPv6 zone identifiers cannot redirect a grant; every unspecified spelling means no address", () => {
	for (const address of [
		"::",
		"0:0:0:0:0:0:0:0",
		"::0.0.0.0",
		"0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0",
	])
		expect(parseInternalGrant(`+CGPADDR: 3,"${address}"`, 3)).toEqual({
			family: "none",
		});
	for (const address of ["2001:db8::2%lo", "fe80::2%wwan1"])
		expect(parseInternalGrant(`+CGPADDR: 3,"${address}"`, 3)).toBeUndefined();
	expect(
		parseInternalContextDns(
			'+CGCONTRDP: 3,5,"synthetic.invalid","2001:db8::2","fe80::1","2001:db8::53%lo",""',
			3,
		),
	).toBeUndefined();
});
