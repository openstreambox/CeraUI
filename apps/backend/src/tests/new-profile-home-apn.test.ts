/**
 * Registration writes a new SIM's profile with its home network's APN only when
 * NetworkManager's Automatic APN would pick a different one, and the wire then
 * says where the APN came from. Driven through `registerModemSafe` with scripted
 * mmcli/nmcli answers, so the NetworkManager write itself is asserted.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import * as runner from "../helpers/run.ts";
import {
	readApnProvenance,
	resolveApnOrigin,
} from "../modules/modems/apn-provenance.ts";
import {
	effectiveCarrierAutomatic,
	newCarrierIntent,
	readCarrierIntent,
	writeCarrierIntent,
} from "../modules/modems/automatic-carrier-intent.ts";
import { resetGsmAutoconfigProbe } from "../modules/modems/gsm-autoconfig.ts";
import { resetGsmConnections } from "../modules/modems/gsm-connections.ts";
import { registerModemSafe } from "../modules/modems/modem-registration.ts";
import {
	fromDbusView,
	fromMmcliModem,
} from "../modules/modems/modem-wire-adapters.ts";
import { withConnectionConfig } from "../modules/modems/modem-wire-producer.ts";
import { resolveWireConfig } from "../modules/modems/modem-wire-projection.ts";
import { defaultModemApplyDeps } from "../modules/modems/modems.ts";
import {
	getModem,
	getModemIds,
	removeModem,
} from "../modules/modems/modems-state.ts";
import { resetProviderDatabaseCache } from "../modules/modems/provider-apn.ts";

const PROVIDERS = `<?xml version="1.0"?>
<serviceproviders format="2.0">
<country code="at">
	<provider>
		<name>Example AT</name>
		<gsm>
			<network-id mcc="232" mnc="17"/>
			<apn value="web"><usage type="internet"/></apn>
		</gsm>
	</provider>
</country>
<country code="de">
	<provider>
		<name>Example DE</name>
		<gsm>
			<network-id mcc="262" mnc="02"/>
			<apn value="web.example.de"><usage type="internet"/></apn>
		</gsm>
	</provider>
</country>
</serviceproviders>`;

const DEVICE_ID = "synthetic-home-apn-device";
const TEMPLATE_UUID = "00000000-0000-4000-8000-0000000000a1";
const NEW_UUID = "00000000-0000-4000-8000-0000000000a2";

let dir = "";
let previousPath: string | undefined;
const STORES = [
	"CERALIVE_AUTOMATIC_CARRIER_STATE_DIR",
	"CERALIVE_APN_PROVENANCE_STATE_DIR",
	"CERALIVE_CELLULAR_PREPARATION_STATE_DIR",
] as const;
const previousStores = new Map<string, string | undefined>();

beforeEach(async () => {
	dir = await mkdtemp(path.join(tmpdir(), "home-apn-"));
	await writeFile(path.join(dir, "serviceproviders.xml"), PROVIDERS);
	previousPath = process.env.CERALIVE_PROVIDER_DATABASE_PATH;
	process.env.CERALIVE_PROVIDER_DATABASE_PATH = path.join(
		dir,
		"serviceproviders.xml",
	);
	for (const name of STORES) {
		previousStores.set(name, process.env[name]);
		process.env[name] = path.join(dir, name.toLowerCase());
	}
	resetProviderDatabaseCache();
	resetGsmConnections();
	resetGsmAutoconfigProbe();
	for (const id of getModemIds()) removeModem(id);
});

afterEach(async () => {
	for (const name of STORES) {
		const previous = previousStores.get(name);
		if (previous === undefined) delete process.env[name];
		else process.env[name] = previous;
	}
	spyOn(runner, "run").mockRestore();
	if (previousPath === undefined)
		delete process.env.CERALIVE_PROVIDER_DATABASE_PATH;
	else process.env.CERALIVE_PROVIDER_DATABASE_PATH = previousPath;
	resetProviderDatabaseCache();
	resetGsmConnections();
	resetGsmAutoconfigProbe();
	for (const id of getModemIds()) removeModem(id);
	await rm(dir, { recursive: true, force: true });
});

type ScriptedModem = {
	simHome: string;
	serving: string;
	model?: string;
	firmware?: string;
	deviceId?: string;
	iccid?: string;
};

/** Every profile the scripted NetworkManager holds, by uuid. */
let saved: Record<string, Record<string, string>> = {};
/** The records CeraUI held for a planned uuid when nmcli was asked to add it. */
let atAdd: Array<{ intent: unknown; provenance: unknown }> = [];

/**
 * Script mmcli and nmcli for modems 0, 1, ... (one SIM each); returns the
 * fields of each `connection add`. `connection add` honours `connection.uuid`
 * as nmcli does, unless `ignoreUuid` makes it pick its own.
 */
function scriptBoard(
	opts: ScriptedModem & {
		profiles?: Record<string, Record<string, string>>;
		more?: ScriptedModem[];
		ignoreUuid?: boolean;
		/** nmcli's reply is lost, after committing the profile or before. */
		lostReply?: "committed" | "not-committed";
	},
): Array<Record<string, string>> {
	saved = { ...(opts.profiles ?? {}) };
	atAdd = [];
	const modems = [opts, ...(opts.more ?? [])];
	const added: Array<Record<string, string>> = [];
	spyOn(runner, "run").mockImplementation(async (binary, args) => {
		const modem = modems[Number(args[2])];
		if (binary === "mmcli" && args[0] === "-K" && modem) {
			const index = args[2];
			if (args[1] === "-i")
				return `sim.properties.iccid : ${modem.iccid ?? "sim-new"}
sim.properties.operator-code : ${modem.simHome}`;
			if (args[1] === "-m")
				return `modem.generic.model : ${modem.model ?? "Example modem"}
modem.generic.revision : ${modem.firmware ?? "1.0"}
modem.generic.state : registered
modem.generic.device-identifier : ${modem.deviceId ?? DEVICE_ID}
modem.generic.sim : /org/freedesktop/ModemManager1/SIM/${index}
modem.3gpp.operator-code : ${modem.serving}
modem.generic.ports.length : 1
modem.generic.ports.value[1] : wwan${index} (net)`;
		}
		if (binary === "nmcli") {
			if (args.join(" ") === "--terse --fields uuid,type,state connection show")
				return Object.keys(saved)
					.map((uuid) => `${uuid}:gsm:`)
					.join("\n");
			if (args.join(" ") === "--terse --fields uuid connection show")
				return Object.keys(saved).join("\n");
			if (args[0] === "connection" && args[1] === "add") {
				const fields: Record<string, string> = {};
				for (let i = 2; i < args.length; i += 2) {
					const field = args[i];
					const value = args[i + 1];
					if (field !== undefined && value !== undefined) fields[field] = value;
				}
				added.push(fields);
				if (opts.lostReply === "not-committed")
					throw new Error("nmcli timed out");
				const planned = fields["connection.uuid"];
				if (planned)
					atAdd.push(
						await records(
							planned,
							fields["gsm.device-id"],
							fields["gsm.sim-id"],
						),
					);
				const uuid =
					(!opts.ignoreUuid && fields["connection.uuid"]) ||
					(added.length === 1 ? NEW_UUID : `${NEW_UUID}-${added.length}`);
				saved[uuid] = {
					"gsm.sim-operator-id": "",
					"gsm.username": "",
					"gsm.password": "",
					"gsm.home-only": "no",
					"gsm.network-id": "",
					"gsm.auto-config": "no",
					"connection.autoconnect": "yes",
					"connection.timestamp": "0",
					...fields,
				};
				if (opts.lostReply === "committed") throw new Error("nmcli timed out");
				return `Connection 'gsm' (${uuid}) successfully added.`;
			}
			if (args[0] === "con" && args[1] === "modify") {
				const profile = args[2] === undefined ? undefined : saved[args[2]];
				if (profile) {
					for (let i = 3; i < args.length; i += 2) {
						const field = args[i];
						const value = args[i + 1];
						if (field !== undefined && value !== undefined)
							profile[field] = value;
					}
					return "";
				}
			}
			const uuid = args.at(-1);
			const profile = uuid === undefined ? undefined : saved[uuid];
			if (
				profile &&
				args.slice(0, 5).join(" ") ===
					"--terse --escape no --show-secrets --get-values"
			) {
				const fields = args[5]?.split(",");
				if (fields?.every((field) => field in profile))
					return fields.map((field) => profile[field]).join("\n");
			}
		}
		throw new Error(`Unexpected command: ${binary} ${args.join(" ")}`);
	});
	return added;
}

/** The carrier intent and provenance CeraUI holds for a profile. */
async function records(uuid: string, deviceId = DEVICE_ID, simId = "sim-new") {
	const identity = { uuid, deviceId, simId };
	const intent = await readCarrierIntent(identity);
	const provenance = await readApnProvenance(identity);
	return { intent, provenance };
}

const RM520 = { model: "RM520N-GL", firmware: "RM520NGLAAR01A08M4G" };

test("a roaming SIM's new profile gets its home APN, recorded as the database's", async () => {
	const added = scriptBoard({ simHome: "23217", serving: "26202" });

	await registerModemSafe(0);

	expect(added).toHaveLength(1);
	expect(added[0]).toMatchObject({
		"gsm.apn": "web",
		"gsm.auto-config": "no",
		"gsm.sim-operator-id": "23217",
	});
	const modem = getModem(0);
	// Automatic to CeraUI, with the APN CeraUI applied.
	expect(modem?.config).toMatchObject({ autoconfig: true, apn: "web" });
	const uuid = modem?.config?.conn ?? "";
	expect(added[0]?.["connection.uuid"]).toBe(uuid);
	const { intent, provenance } = await records(uuid);
	// Automatic, nothing applied by a carrier row, NetworkManager holding "web".
	expect(intent).toMatchObject({
		mode: "automatic",
		phase: "pending",
		pendingApn: "web",
	});
	expect(provenance).toMatchObject({
		origin: "provider-database",
		apn: "web",
		network: "23217",
	});
	// Both were on disk before NetworkManager had the profile.
	expect(atAdd).toEqual([{ intent, provenance }]);
	expect(effectiveCarrierAutomatic(intent, false, "web")).toBe(true);
	const source = modem && fromMmcliModem(0, modem).config;
	expect(source && resolveWireConfig(source, true)).toMatchObject({
		autoconfig: true,
		apn_source: "provider-database",
	});
	// A restart reads the same story back from the records.
	resetGsmConnections();
	removeModem(0);
	await registerModemSafe(0);
	expect(added).toHaveLength(1);
	const again = getModem(0);
	expect(again?.config).toMatchObject({ conn: uuid, autoconfig: true });
	const reread = again && fromMmcliModem(0, again).config;
	expect(reread && resolveWireConfig(reread, true).apn_source).toBe(
		"provider-database",
	);
});

test("a SIM on its home network gets the same profile as before", async () => {
	const added = scriptBoard({ simHome: "26202", serving: "26202" });

	await registerModemSafe(0);

	expect(added).toHaveLength(1);
	// Unprobed board: Automatic APN is not claimed, so the old default is written.
	expect(added[0]).toMatchObject({
		"gsm.apn": "internet",
		"gsm.auto-config": "no",
	});
	const modem = getModem(0);
	const source = modem && fromMmcliModem(0, modem).config;
	expect(source && "apn_source" in resolveWireConfig(source, true)).toBe(false);
});

test("an automatic template for the same operator does not hand over the wrong choice", async () => {
	const added = scriptBoard({
		simHome: "23217",
		serving: "26202",
		profiles: {
			[TEMPLATE_UUID]: {
				"gsm.device-id": "another-device",
				"gsm.sim-id": "sim-old",
				"gsm.sim-operator-id": "23217",
				"gsm.apn": "",
				"gsm.username": "",
				"gsm.password": "",
				"gsm.home-only": "no",
				"gsm.network-id": "",
				"gsm.auto-config": "yes",
				"connection.autoconnect": "yes",
				"connection.timestamp": "0",
			},
		},
	});

	await registerModemSafe(0);

	expect(added).toHaveLength(1);
	expect(added[0]).toMatchObject({
		"gsm.apn": "web",
		"gsm.auto-config": "no",
	});
});

test("a manual template for the same operator is still copied", async () => {
	const added = scriptBoard({
		simHome: "23217",
		serving: "26202",
		profiles: {
			[TEMPLATE_UUID]: {
				"gsm.device-id": "another-device",
				"gsm.sim-id": "sim-old",
				"gsm.sim-operator-id": "23217",
				"gsm.apn": "typed.by.someone",
				"gsm.username": "",
				"gsm.password": "",
				"gsm.home-only": "no",
				"gsm.network-id": "",
				"gsm.auto-config": "no",
				"connection.autoconnect": "yes",
				"connection.timestamp": "0",
			},
		},
	});

	await registerModemSafe(0);

	expect(added).toHaveLength(1);
	expect(added[0]).toMatchObject({ "gsm.apn": "typed.by.someone" });
});

test("the D-Bus row picks the hint up from the registered modem", async () => {
	const added = scriptBoard({ simHome: "23217", serving: "26202" });
	await registerModemSafe(0);
	expect(added).toHaveLength(1);

	// The live D-Bus row arrives without a config; the producer joins the
	// mmcli-side profile by runtime id, hint included.
	const joined = withConnectionConfig({
		runtimeId: 0,
		ifname: "wwan0",
		mmState: "registered",
		registration: { status: "roaming", activeRats: new Set<string>() },
		signal: 70,
		supportedNetworkTypes: ["4g"],
		activeNetworkType: "4g",
	});
	const source = fromDbusView(joined);
	expect(
		source.config && resolveWireConfig(source.config, true).apn_source,
	).toBe("provider-database");
});

test("a template pinned to another network is judged by that network", async () => {
	// Registered on its home network, but the template pins 26202: NetworkManager
	// would look up 26202 and send its APN, so the home APN is written.
	const added = scriptBoard({
		simHome: "23217",
		serving: "23217",
		profiles: {
			[TEMPLATE_UUID]: {
				"gsm.device-id": "another-device",
				"gsm.sim-id": "sim-old",
				"gsm.sim-operator-id": "23217",
				"gsm.apn": "",
				"gsm.username": "",
				"gsm.password": "",
				"gsm.home-only": "no",
				"gsm.network-id": "26202",
				"gsm.auto-config": "yes",
				"connection.autoconnect": "yes",
				"connection.timestamp": "0",
			},
		},
	});

	await registerModemSafe(0);

	expect(added[0]).toMatchObject({ "gsm.apn": "web", "gsm.auto-config": "no" });
});

test("a modem admitted for transport preparation gets the home APN and stays automatic", async () => {
	const added = scriptBoard({ simHome: "23217", serving: "26202", ...RM520 });

	await registerModemSafe(0);

	expect(added).toHaveLength(1);
	expect(added[0]).toMatchObject({ "gsm.apn": "web", "gsm.auto-config": "no" });
	const uuid = getModem(0)?.config?.conn ?? "";
	// Preparation runs for profiles automatic to CeraUI (`cellular-preparation.ts`
	// reads exactly these two records), so this one keeps it.
	expect(getModem(0)?.config?.autoconfig).toBe(true);
	const { intent, provenance } = await records(uuid);
	expect(effectiveCarrierAutomatic(intent, false, "web")).toBe(true);
	expect(resolveApnOrigin(intent, provenance, false, "web")).toEqual({
		origin: "provider-database",
		network: "23217",
	});
});

describe("a second SIM of the same operator", () => {
	const first = { simHome: "23217", serving: "26202", iccid: "sim-first" };
	const second = {
		simHome: "23217",
		deviceId: "synthetic-second-device",
		iccid: "sim-second",
		...RM520,
	};

	test("roaming on an admitted modem gets its own lookup, not a copy", async () => {
		// Sol r4 P1: the first SIM's database APN on a generic modem, then a
		// second SIM of the same operator on an RM520N-GL in QMI mode.
		const added = scriptBoard({
			...first,
			more: [{ ...second, serving: "26202" }],
		});
		await registerModemSafe(0);
		resetGsmConnections();
		await registerModemSafe(1);

		expect(added).toHaveLength(2);
		// The base and r4 copied a manual profile here, which preparation skips.
		const config = getModem(1)?.config;
		expect(config?.autoconfig).toBe(true);
		const secondUuid = config?.conn ?? "";
		expect(secondUuid).not.toBe(getModem(0)?.config?.conn);
		expect(added[1]).toMatchObject({
			"gsm.apn": "web",
			"gsm.auto-config": "no",
		});
		const own = await records(secondUuid, second.deviceId, second.iccid);
		expect(own.intent).toMatchObject({ mode: "automatic", pendingApn: "web" });
		expect(resolveApnOrigin(own.intent, own.provenance, false, "web")).toEqual({
			origin: "provider-database",
			network: "23217",
		});
	});

	test("on its home network gets Automatic APN, not the first SIM's APN", async () => {
		const added = scriptBoard({
			...first,
			more: [{ ...second, serving: "23217" }],
		});
		await registerModemSafe(0);
		resetGsmConnections();
		await registerModemSafe(1);

		expect(added).toHaveLength(2);
		// NetworkManager's own pick is right at home, so nothing is written for it.
		expect(added[1]).toMatchObject({ "gsm.auto-config": "yes", "gsm.apn": "" });
		expect(getModem(1)?.config?.autoconfig).toBe(true);
		const own = await records(
			getModem(1)?.config?.conn ?? "",
			second.deviceId,
			second.iccid,
		);
		expect(own.intent).toBeUndefined();
	});

	test("copies an APN the operator saved, even one equal to the database's", async () => {
		const added = scriptBoard({
			...first,
			more: [{ ...second, serving: "23217" }],
		});
		await registerModemSafe(0);
		const uuid = getModem(0)?.config?.conn ?? "";
		resetGsmConnections();
		// The operator turns Automatic APN off and keeps "web".
		expect(
			await defaultModemApplyDeps.writeConnection(uuid, {
				autoconfig: false,
				apn: "web",
				username: "",
				password: "",
				roaming: true,
				network: "",
			}),
		).toBe(true);
		const mine = await records(uuid, DEVICE_ID, first.iccid);
		expect(mine.intent?.mode).toBe("manual");
		expect(mine.provenance).toBeUndefined();
		// No cache reset here: the save itself must drop the stale origin.
		await registerModemSafe(1);

		expect(added[1]).toMatchObject({
			"gsm.apn": "web",
			"gsm.auto-config": "no",
		});
		expect(getModem(1)?.config?.autoconfig).toBe(false);
		const modem = getModem(1);
		const source = modem && fromMmcliModem(1, modem).config;
		// Typed by someone: no claim that the database chose it.
		expect(source && "apn_source" in resolveWireConfig(source, true)).toBe(
			false,
		);
	});

	test("copies an APN the carrier table applied as an automatic profile", async () => {
		const template = {
			"gsm.device-id": "another-device",
			"gsm.sim-id": "sim-old",
			"gsm.sim-operator-id": "23217",
			"gsm.apn": "carrier.example",
			"gsm.username": "",
			"gsm.password": "",
			"gsm.home-only": "no",
			"gsm.network-id": "",
			"gsm.auto-config": "no",
			"connection.autoconnect": "yes",
			"connection.timestamp": "0",
		};
		const identity = {
			uuid: TEMPLATE_UUID,
			deviceId: "another-device",
			simId: "sim-old",
		};
		await writeCarrierIntent(
			identity,
			newCarrierIntent(identity, "automatic", "carrier.example"),
		);
		const added = scriptBoard({
			...second,
			serving: "23217",
			profiles: { [TEMPLATE_UUID]: template },
		});
		await registerModemSafe(0);

		// As before #266: an automatic copy, for the carrier table to apply again.
		expect(added[0]).toMatchObject({ "gsm.auto-config": "yes", "gsm.apn": "" });
		expect(getModem(0)?.config?.autoconfig).toBe(true);
	});
});

describe("saving the dialog", () => {
	test("with Automatic APN on keeps the database APN and its record", async () => {
		scriptBoard({ simHome: "23217", serving: "26202" });
		await registerModemSafe(0);
		const uuid = getModem(0)?.config?.conn ?? "";
		const before = await records(uuid);
		resetGsmConnections();
		const config = {
			autoconfig: true,
			apn: "",
			username: "",
			password: "",
			roaming: false,
			network: "",
		};
		expect(await defaultModemApplyDeps.writeConnection(uuid, config)).toBe(
			true,
		);

		expect(saved[uuid]).toMatchObject({
			"gsm.apn": "web",
			"gsm.auto-config": "no",
			"gsm.home-only": "yes",
		});
		expect(await records(uuid)).toEqual(before);
		// What the caller keeps in memory is the APN in effect, with its note.
		expect(config).toMatchObject({
			apn: "web",
			apn_hint: { source: "provider-database", homeNetwork: "23217" },
		});
	});

	test("with Automatic APN off records the operator's APN as theirs", async () => {
		scriptBoard({ simHome: "23217", serving: "26202" });
		await registerModemSafe(0);
		const uuid = getModem(0)?.config?.conn ?? "";
		resetGsmConnections();
		expect(
			await defaultModemApplyDeps.writeConnection(uuid, {
				autoconfig: false,
				apn: "web",
				username: "",
				password: "",
				roaming: true,
				network: "",
			}),
		).toBe(true);
		const after = await records(uuid);
		expect(
			resolveApnOrigin(after.intent, after.provenance, false, "web"),
		).toEqual({ origin: "user" });
		expect(after.provenance).toBeUndefined();
	});
});

test("a profile nmcli files under another uuid keeps its record", async () => {
	const added = scriptBoard({
		simHome: "23217",
		serving: "26202",
		ignoreUuid: true,
	});
	await registerModemSafe(0);
	const planned = added[0]?.["connection.uuid"] ?? "";
	expect(getModem(0)?.config?.conn).toBe(NEW_UUID);
	expect(await records(NEW_UUID)).toMatchObject({
		intent: { pendingApn: "web" },
		provenance: { origin: "provider-database" },
	});
	expect(await records(planned)).toEqual({
		intent: undefined,
		provenance: undefined,
	});
});

test("a lost nmcli reply adopts the profile it committed", async () => {
	const added = scriptBoard({
		simHome: "23217",
		serving: "26202",
		lostReply: "committed",
	});
	await registerModemSafe(0);
	const planned = added[0]?.["connection.uuid"] ?? "";
	expect(saved[planned]).toBeDefined();
	const modem = getModem(0);
	expect(modem?.config).toMatchObject({ conn: planned, autoconfig: true });
	expect(await records(planned)).toMatchObject({
		intent: { pendingApn: "web" },
		provenance: { origin: "provider-database" },
	});
	const source = modem && fromMmcliModem(0, modem).config;
	expect(source && resolveWireConfig(source, true).apn_source).toBe(
		"provider-database",
	);
});

test("an add that never committed is retried under the same uuid and records", async () => {
	const added = scriptBoard({
		simHome: "23217",
		serving: "26202",
		lostReply: "not-committed",
	});
	await registerModemSafe(0);
	expect(getModem(0)?.config?.conn).toBeUndefined();
	resetGsmConnections();
	removeModem(0);
	await registerModemSafe(0);
	expect(added).toHaveLength(2);
	const planned = added[0]?.["connection.uuid"] ?? "";
	expect(added[1]?.["connection.uuid"]).toBe(planned);
	expect(await records(planned)).toMatchObject({
		intent: { pendingApn: "web" },
		provenance: { origin: "provider-database" },
	});
});
