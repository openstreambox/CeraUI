import { describe, expect, test } from "bun:test";
import {
	databaseApnIntent,
	newApnProvenance,
	parseApnProvenanceSlot,
	resolveApnOrigin,
} from "./apn-provenance.ts";
import {
	type CarrierIntent,
	carrierIntentKey,
	effectiveCarrierAutomatic,
	newCarrierIntent,
	newPendingCarrierIntent,
} from "./automatic-carrier-intent.ts";
import {
	type CarrierProfileDeps,
	reconcileAutomaticCarrierProfile,
	restoreAutomaticCarrierProfile,
} from "./automatic-carrier-profile.ts";
import { selectSubscription } from "./subscription-policy.ts";

const identity = {
	uuid: "synthetic-profile",
	deviceId: "synthetic-device",
	simId: "89000000000000000000",
};
const record = newApnProvenance(identity, "web", "23217");

describe("who chose a profile's APN", () => {
	test("the provider database, while the pending intent expects its APN", () => {
		const intent = databaseApnIntent(identity, "web");
		expect(intent).toMatchObject({ mode: "automatic", phase: "pending" });
		// Automatic to every backend, including one that never reads the record.
		expect(effectiveCarrierAutomatic(intent, false, "web")).toBe(true);
		expect(resolveApnOrigin(intent, record, false, "web")).toEqual({
			origin: "provider-database",
			network: "23217",
		});
	});

	test("nobody's, once NetworkManager holds another APN or looks it up itself", () => {
		const intent = databaseApnIntent(identity, "web");
		expect(resolveApnOrigin(intent, record, false, "other")).toBeUndefined();
		expect(resolveApnOrigin(intent, record, true, "")).toBeUndefined();
	});

	test("not the database's without a record bound to that APN", () => {
		const intent = databaseApnIntent(identity, "web");
		expect(resolveApnOrigin(intent, undefined, false, "web")).toBeUndefined();
		const other = newApnProvenance(identity, "other", "23217");
		expect(resolveApnOrigin(intent, other, false, "web")).toBeUndefined();
		// A save with Automatic APN on before this record existed.
		expect(
			resolveApnOrigin(
				newPendingCarrierIntent(identity, ""),
				record,
				false,
				"",
			),
		).toBeUndefined();
	});

	test("the carrier table for an applied intent, the operator for a manual one", () => {
		const applied = newCarrierIntent(identity, "automatic", "web");
		expect(resolveApnOrigin(applied, record, false, "web")).toEqual({
			origin: "carrier-table",
		});
		expect(
			resolveApnOrigin(
				newCarrierIntent(identity, "manual"),
				record,
				false,
				"web",
			),
		).toEqual({ origin: "user" });
	});

	test("the record grammar is closed", () => {
		const key = carrierIntentKey(identity);
		expect(parseApnProvenanceSlot({ ...record }, key)).toEqual(record);
		for (const bad of [
			{ ...record, network: undefined },
			{ ...record, origin: "carrier-table" },
			{ ...record, apn: "" },
			{ ...record, apn: "web@odd" },
			{ ...record, extra: true },
			{ ...record, key: "0".repeat(64) },
		])
			expect(() => parseApnProvenanceSlot(bad, key)).toThrow(
				"Invalid APN provenance",
			);
	});
});

test("a carrier row overrides a database APN, and its rollback gives it back", async () => {
	const choice = selectSubscription({ homePlmn: "310410", gid1: "20FF" });
	if (choice.state !== "recognized") throw new Error("Invalid policy fixture");
	let fields: Record<string, string> = {
		"gsm.apn": "web",
		"gsm.auto-config": "no",
		"ipv4.method": "auto",
		"ipv6.method": "ignore",
		"ipv6.never-default": "yes",
		"ipv6.ip6-privacy": "0",
		"ipv6.ignore-auto-dns": "no",
	};
	let intent: CarrierIntent | undefined = databaseApnIntent(identity, "web");
	let inverse: Readonly<Record<string, unknown>> = {};
	const deps: CarrierProfileDeps = {
		readFields: async (_uuid, names) =>
			names.map((name) =>
				name === "gsm.device-id"
					? identity.deviceId
					: name === "gsm.sim-id"
						? identity.simId
						: fields[name],
			),
		writeFields: async (_uuid, next) => {
			fields = { ...fields, ...next };
			return true;
		},
		pairPresent: async () => true,
		readIntent: async () => intent,
		writeIntent: async (_identity, next) => {
			intent = next;
		},
		journal: async (_key, _kind, before, work) => {
			inverse = before;
			const result = await work({
				entry: {} as never,
				markExecuting: async () => {},
				markFailed: async () => {},
			});
			return { ok: true, value: result.value };
		},
	};
	expect(
		await reconcileAutomaticCarrierProfile(
			"key",
			identity,
			choice.policy,
			async () => true,
			deps,
		),
	).toBe("updated");
	const carrierApn = fields["gsm.apn"] ?? "";
	expect(carrierApn).not.toBe("web");
	// The database record is still on disk but no longer describes the intent.
	expect(resolveApnOrigin(intent, record, false, carrierApn)).toEqual({
		origin: "carrier-table",
	});
	// A restart before the journal completes rolls the profile back: the same
	// record then describes it again, with nothing else to restore.
	expect(await restoreAutomaticCarrierProfile("key", inverse, deps)).toBe(
		"restored",
	);
	expect(fields["gsm.apn"]).toBe("web");
	expect(resolveApnOrigin(intent, record, false, "web")).toEqual({
		origin: "provider-database",
		network: "23217",
	});
});
