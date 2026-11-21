/**
 * Which IP family a modem profile requests, and how a stored profile gets there.
 *
 * NetworkManager turns `ipv4.method` / `ipv6.method` into the bearer's IP type.
 * A profile with `ipv6.method ignore` asks for IPv4 only, which a carrier whose
 * data network is IPv6-only cannot serve: the modem registers and never
 * connects. These tests pin the two halves of the remedy against a fake
 * NetworkManager — the request changes ONLY on evidence, and an existing
 * profile is rewritten in place without touching its activation.
 */
import { describe, expect, test } from "bun:test";
import {
	type BearerIpFamilyConvergeDeps,
	bearerIpFamilyFields,
	convergeBearerIpFamily,
	resolveBearerIpFamily,
} from "../modules/modems/bearer-ip-family.ts";
import {
	type GsmProfileAudit,
	reconcileDuplicateGsmProfiles,
} from "../modules/modems/gsm-duplicate-reconcile.ts";
import { parseModemInfo } from "../modules/modems/mmcli.ts";

const UUID = "091ca73b-9f75-42bd-a737-2c447ca44533";

/** A NetworkManager that stores profile settings and records every command. */
function fakeNetworkManager(stored: Record<string, string>) {
	const commands: string[] = [];
	const deps: BearerIpFamilyConvergeDeps = {
		getFields: async (uuid, fields) => {
			commands.push(`show ${uuid}`);
			return fields.map((field) => stored[field] ?? "");
		},
		setFields: async (uuid, fields) => {
			commands.push(`modify ${uuid} ${Object.keys(fields).join(",")}`);
			Object.assign(stored, fields);
			return true;
		},
	};
	return { stored, commands, deps };
}

const LEGACY_PROFILE = {
	"ipv4.method": "auto",
	"ipv6.method": "ignore",
	"ipv6.never-default": "no",
	"ipv6.ip6-privacy": "-1",
};

describe("the request changes only on evidence", () => {
	test("an unknown carrier keeps the IPv4-only request", () => {
		expect(
			resolveBearerIpFamily({
				simOperatorCode: "26203",
				networkOperatorCode: "26203",
				attachIpType: "ipv4v6",
			}),
		).toEqual({ family: "ipv4", source: "default" });
		expect(resolveBearerIpFamily({})).toEqual({
			family: "ipv4",
			source: "default",
		});
	});

	test("a SIM of an IPv6-only carrier asks for dual-stack", () => {
		expect(resolveBearerIpFamily({ simOperatorCode: "310260" })).toEqual({
			family: "ipv4v6",
			source: "operator",
		});
	});

	test("a SIM that publishes no operator code is recognised by its network", () => {
		expect(
			resolveBearerIpFamily({
				simOperatorCode: undefined,
				networkOperatorCode: " 310260 ",
				attachIpType: "ipv4v6",
			}),
		).toEqual({ family: "ipv4v6", source: "operator" });
	});

	test("an attach bearer the network granted as IPv6 alone is evidence", () => {
		expect(
			resolveBearerIpFamily({
				simOperatorCode: "99999",
				attachIpType: "IPv6",
			}),
		).toEqual({ family: "ipv4v6", source: "attach-bearer" });
	});

	test("a dual-stack attach bearer is not: IPv4 carriers report it too", () => {
		expect(resolveBearerIpFamily({ attachIpType: "ipv4v6" }).source).toBe(
			"default",
		);
	});

	test("the modem reading carries the serving network and attach family", () => {
		const parsed = parseModemInfo({
			"modem.generic.sim": "/org/freedesktop/ModemManager1/SIM/1",
			"modem.generic.state": "registered",
			"modem.generic.model": "Example",
			"modem.generic.current-modes": "allowed: 4g, 5g; preferred: 5g",
			"modem.generic.equipment-identifier": "000000000000000",
			"modem.generic.device-identifier": "0".repeat(40),
			"modem.generic.signal-quality.value": "50",
			"modem.3gpp.operator-code": "310260",
			"modem.3gpp.eps.initial-bearer.settings.ip-type": "ipv4v6",
		});
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.value["modem.3gpp.operator-code"]).toBe("310260");
		expect(parsed.value["modem.3gpp.eps.initial-bearer.settings.ip-type"]).toBe(
			"ipv4v6",
		);
	});
});

describe("the NetworkManager settings behind each request", () => {
	test("IPv4 is the historical profile", () => {
		expect(bearerIpFamilyFields("ipv4")).toEqual({
			"ipv4.method": "auto",
			"ipv6.method": "ignore",
		});
	});

	test("dual-stack enables both families and adds no IPv6 default route", () => {
		expect(bearerIpFamilyFields("ipv4v6")).toEqual({
			"ipv4.method": "auto",
			"ipv6.method": "auto",
			"ipv6.never-default": "yes",
			"ipv6.ip6-privacy": "0",
		});
	});

	test("IPv6-only disables IPv4 instead of leaving it to time out", () => {
		expect(bearerIpFamilyFields("ipv6")).toMatchObject({
			"ipv4.method": "disabled",
			"ipv6.method": "auto",
			"ipv6.never-default": "yes",
		});
	});

	test("no request ever forbids the single-family fallback", () => {
		for (const family of ["ipv4", "ipv4v6", "ipv6"] as const) {
			const fields = Object.keys(bearerIpFamilyFields(family));
			expect(fields).not.toContain("ipv4.may-fail");
			expect(fields).not.toContain("ipv6.may-fail");
		}
	});
});

describe("an existing profile is rewritten in place", () => {
	test("an IPv4-only profile is moved to dual-stack with one modify", async () => {
		const nm = fakeNetworkManager({ ...LEGACY_PROFILE });
		expect(await convergeBearerIpFamily(UUID, "ipv4v6", nm.deps)).toBe(
			"updated",
		);
		expect(nm.stored).toMatchObject({
			"ipv4.method": "auto",
			"ipv6.method": "auto",
			"ipv6.never-default": "yes",
			"ipv6.ip6-privacy": "0",
		});
		// Read, then one write. Nothing brings the connection down or up.
		expect(nm.commands).toEqual([
			`show ${UUID}`,
			`modify ${UUID} ipv4.method,ipv6.method,ipv6.never-default,ipv6.ip6-privacy`,
		]);
	});

	test("a profile already there is not written again", async () => {
		const nm = fakeNetworkManager({ ...LEGACY_PROFILE });
		await convergeBearerIpFamily(UUID, "ipv4v6", nm.deps);
		nm.commands.length = 0;
		expect(await convergeBearerIpFamily(UUID, "ipv4v6", nm.deps)).toBe(
			"unchanged",
		);
		expect(nm.commands).toEqual([`show ${UUID}`]);
	});

	test("a decorated numeric value still compares equal", async () => {
		const nm = fakeNetworkManager({
			"ipv4.method": "auto",
			"ipv6.method": "auto",
			"ipv6.never-default": "yes",
			"ipv6.ip6-privacy": "0 (disabled)",
		});
		expect(await convergeBearerIpFamily(UUID, "ipv4v6", nm.deps)).toBe(
			"unchanged",
		);
	});

	test("a failed read writes nothing", async () => {
		const nm = fakeNetworkManager({ ...LEGACY_PROFILE });
		const outcome = await convergeBearerIpFamily(UUID, "ipv4v6", {
			...nm.deps,
			getFields: async () => undefined,
		});
		expect(outcome).toBe("unreadable");
		expect(nm.stored).toEqual(LEGACY_PROFILE);
	});

	test("a refused write is reported, not assumed", async () => {
		const nm = fakeNetworkManager({ ...LEGACY_PROFILE });
		const outcome = await convergeBearerIpFamily(UUID, "ipv4v6", {
			...nm.deps,
			setFields: async () => false,
		});
		expect(outcome).toBe("failed");
	});

	test("duplicate profiles for the same SIM receive the same request", async () => {
		const duplicate: GsmProfileAudit = {
			uuid: "11ab26e2-7951-433f-97e1-ad8c4a98076f",
			deviceId: "device",
			simId: "sim",
			state: "activating",
			autoconnect: "yes",
			timestamp: "1700000000",
		};
		const writes: Array<Record<string, string>> = [];
		await reconcileDuplicateGsmProfiles(
			"device",
			"sim",
			UUID,
			{
				"gsm.apn": "internet",
				"gsm.username": "",
				"gsm.password": "",
				"gsm.password-flags": "4",
				"gsm.home-only": "yes",
				"gsm.network-id": "",
				"gsm.auto-config": "no",
				...bearerIpFamilyFields("ipv4v6"),
			},
			{
				audit: async () => [duplicate],
				setFields: async (_uuid, fields) => {
					writes.push(fields);
					return true;
				},
				remove: async () => false,
			},
		);
		expect(writes[0]).toMatchObject({
			"gsm.apn": "internet",
			"ipv4.method": "auto",
			"ipv6.method": "auto",
		});
	});
});
