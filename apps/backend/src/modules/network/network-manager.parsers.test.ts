/*
 * S2 hardening — named, fail-loud nmcli result parsers.
 *
 * Happy-path AND malformed-input (output-drift) cases for every extracted
 * parser. The stderr+exitCode surfacing of the consuming call sites is covered
 * centrally by cli-parse.test.ts (describeCliError). Bun 1.4.4 intercepts ESM
 * re-export spies; run()/execFileP is kept as an explicit injection seam.
 */

import { describe, expect, it } from "bun:test";

import { isParseError } from "../system/cli-parse.ts";
import {
	nmConnect,
	parseNmConnActivated,
	parseNmConnAddUuid,
	parseNmConnDeactivated,
	parseNmConnDeleted,
	parseNmHotspotUuid,
} from "./network-manager.ts";

describe("parseNmConnAddUuid", () => {
	it("extracts the UUID from a successful add", () => {
		const r = parseNmConnAddUuid(
			"Connection 'modem-0' (1c2d3e4f-aaaa-bbbb-cccc-1234567890ab) successfully added.\n",
		);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.value).toBe("1c2d3e4f-aaaa-bbbb-cccc-1234567890ab");
	});

	it("fails loud when the confirmation line is absent (drift)", () => {
		const r = parseNmConnAddUuid("Error: connection add failed: bad property");
		expect(isParseError(r)).toBe(true);
		if (!r.ok) expect(r.reason).toContain("successfully added");
	});
});

describe("parseNmHotspotUuid", () => {
	it("extracts the hotspot UUID on success", () => {
		const r = parseNmHotspotUuid(
			"Device 'wlan0' successfully activated with 'abc-123'.\n",
		);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.value).toBe("abc-123");
	});

	it("fails loud when no activation line is present (drift)", () => {
		const r = parseNmHotspotUuid(
			"Error: Failed to add/activate new connection",
		);
		expect(isParseError(r)).toBe(true);
	});
});

describe("nmcli boolean result parsers", () => {
	it("activation's client deadline allows the requested NM wait to finish", async () => {
		for (const seconds of [5, 45, 90]) {
			let dispatched = false;
			expect(
				await nmConnect(
					"synthetic-profile",
					seconds,
					async (binary, args, options) => {
						dispatched = true;
						expect(binary).toBe("nmcli");
						expect(args.slice(0, 2)).toEqual(["-w", String(seconds)]);
						expect(options?.timeout).toBeGreaterThan(seconds * 1000);
						return "Connection successfully activated (synthetic)";
					},
				),
			).toBe(true);
			expect(dispatched).toBe(true);
		}
	});
	it("activation without a requested wait preserves the generic command deadline", async () => {
		let dispatched = false;
		expect(
			await nmConnect(
				"synthetic-profile",
				undefined,
				async (_binary, args, options) => {
					dispatched = true;
					expect(args).not.toContain("-w");
					expect(options?.timeout).toBeUndefined();
					return "Connection successfully activated (synthetic)";
				},
			),
		).toBe(true);
		expect(dispatched).toBe(true);
	});
	it("parseNmConnDeleted matches the deletion confirmation", () => {
		expect(
			parseNmConnDeleted("Connection 'x' (uuid) successfully deleted."),
		).toBe(true);
		expect(parseNmConnDeleted("Error: unknown connection")).toBe(false);
	});

	it("parseNmConnActivated matches the activation confirmation", () => {
		expect(
			parseNmConnActivated("Connection successfully activated (D-Bus ...)"),
		).toBe(true);
		expect(parseNmConnActivated("Error: timeout")).toBe(false);
	});

	it("parseNmConnDeactivated matches the deactivation confirmation", () => {
		expect(
			parseNmConnDeactivated("Connection 'x' successfully deactivated (...)"),
		).toBe(true);
		expect(parseNmConnDeactivated("Error: not active")).toBe(false);
	});
});
