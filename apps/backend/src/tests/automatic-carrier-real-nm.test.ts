import { expect, test } from "bun:test";
import { readlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runTestCommand } from "./helpers/run-test-command.ts";

const child = process.env.CERALIVE_NM_PROFILE_CHILD === "1";
const binaries = ["unshare", "mount", "NetworkManager", "nmcli", "dbus-daemon"];
const missing = binaries.filter((binary) => !Bun.which(binary));
const probe =
	child || missing.length
		? undefined
		: await runTestCommand(["unshare", "-Urnm", "true"]);
const unavailable =
	missing.length > 0 || (probe !== undefined && probe.code !== 0);
if (!child && unavailable && process.env.CERALIVE_REQUIRE_REAL_NM === "1")
	throw new Error("Required real-NM namespace capability unavailable");

(unavailable ? test.skip : test)(
	unavailable
		? "automatic carrier real-NM fixture: unavailable namespace/runtime"
		: "automatic carrier intent survives real NM writes and an explicit manual save",
	async () => {
		if (!child) {
			const result = await runTestCommand(
				[
					"unshare",
					"-Urnm",
					"bash",
					fileURLToPath(
						new URL("./fixtures/cellular-profile-netns.sh", import.meta.url),
					),
					fileURLToPath(import.meta.url),
				],
				{
					env: {
						CELLULAR_HOST_NETNS: readlinkSync("/proc/self/ns/net"),
						CELLULAR_HOST_MNTNS: readlinkSync("/proc/self/ns/mnt"),
						CELLULAR_BUN: process.execPath,
					},
				},
			);
			expect(result.code, result.stdout + result.stderr).toBe(0);
			return;
		}
		const { defaultCarrierProfileDeps, reconcileAutomaticCarrierProfile } =
			await import("../modules/modems/automatic-carrier-profile.ts");
		const { readCarrierIntent } = await import(
			"../modules/modems/automatic-carrier-intent.ts"
		);
		const { defaultModemApplyDeps } = await import(
			"../modules/modems/modems.ts"
		);
		const { getGsmConnections, resetGsmConnections } = await import(
			"../modules/modems/gsm-connections.ts"
		);
		const { resetLifecycleInterlock } = await import(
			"../modules/streaming/lifecycle-admission.ts"
		);
		const { resetRecoveryBarrier } = await import(
			"../modules/streaming/recovery-barrier.ts"
		);
		const { setMutationJournalDeps, readMutationEntry } = await import(
			"../modules/modems/mutation-journal.ts"
		);
		const { beginModemMutation, withJournaledModemMutation } = await import(
			"../modules/modems/mutation-lease.ts"
		);
		const { selectSubscription } = await import(
			"../modules/modems/subscription-policy.ts"
		);
		resetLifecycleInterlock();
		resetRecoveryBarrier();
		setMutationJournalDeps({ dir: "/run/cellular-profile-fixture/journal" });
		process.env.CERALIVE_AUTOMATIC_CARRIER_STATE_DIR =
			"/run/cellular-profile-fixture/intent";
		process.env.CERALIVE_CELLULAR_PREPARATION_STATE_DIR =
			"/run/cellular-profile-fixture/preparation";
		const uuid = process.env.CERALIVE_PROFILE_UUID;
		if (!uuid) throw new Error("Missing synthetic profile");
		const identity = {
			uuid,
			deviceId: "0000000000000000000000000000000000000000",
			simId: "89000000000000000000",
		};
		const key = "platform-synthetic-usb-0:1";
		const choice = selectSubscription({ homePlmn: "310410", gid1: "20FF" });
		if (choice.state !== "recognized")
			throw new Error("Invalid policy fixture");
		const deps = {
			...defaultCarrierProfileDeps,
			pairPresent: async () => true,
		};
		const baseline = await deps.readFields(uuid, [
			"gsm.device-id",
			"gsm.sim-id",
			"gsm.apn",
			"gsm.auto-config",
			"ipv4.method",
			"ipv6.method",
			"ipv6.never-default",
			"ipv6.ip6-privacy",
			"ipv6.ignore-auto-dns",
		]);
		expect(baseline?.length).toBe(9);
		expect(baseline?.slice(0, 2)).toEqual([identity.deviceId, identity.simId]);
		// NetworkManager clears an explicit APN when automatic configuration is on.
		expect(baseline?.[2]).toBe("");
		expect(baseline?.[3]).toBe("yes");
		const admission = beginModemMutation(key);
		expect(admission.ok).toBe(true);
		if (admission.ok) admission.lease.release();

		expect(
			await reconcileAutomaticCarrierProfile(
				key,
				identity,
				choice.policy,
				async () => true,
				deps,
			),
		).toBe("updated");
		expect((await readCarrierIntent(identity))?.phase).toBe("applied");
		expect(await readMutationEntry(key)).toBeUndefined();
		resetGsmConnections();
		expect((await getGsmConnections())?.byUuid[uuid]).toMatchObject({
			autoconfig: true,
			apn: "ereseller",
		});
		const manual = await withJournaledModemMutation(
			key,
			"modem-config",
			{},
			async (mutation) => {
				await mutation.markExecuting();
				const written = await defaultModemApplyDeps.writeConnection(uuid, {
					autoconfig: false,
					// Keeping the APN must still retire automatic intent.
					apn: "ereseller",
					username: "",
					password: "",
					roaming: true,
					network: "",
				});
				return { confirmed: written, value: written };
			},
		);
		expect(manual).toMatchObject({ ok: true, value: true });
		resetGsmConnections();
		expect((await getGsmConnections())?.byUuid[uuid]).toMatchObject({
			autoconfig: false,
			apn: "ereseller",
		});
		expect((await readCarrierIntent(identity))?.mode).toBe("manual");
		expect(
			await reconcileAutomaticCarrierProfile(
				key,
				identity,
				choice.policy,
				async () => true,
				deps,
			),
		).toBe("preserved");
		expect(await readMutationEntry(key)).toBeUndefined();
		const {
			createDisarmedProfile,
			restoreCreatedProfile,
			defaultProfileCreationDeps,
		} = await import("../modules/modems/automatic-profile-creation.ts");
		const { bearerIpFamilyFields } = await import(
			"../modules/modems/bearer-ip-family.ts"
		);
		const creationDeps = {
			...defaultProfileCreationDeps,
			pairPresent: async () => true,
		};
		const newPair = {
			deviceId: "0000000000000000000000000000000000000001",
			simId: "89000000000000000001",
		};
		const created = await createDisarmedProfile(
			"platform-synthetic-usb-0:2",
			newPair,
			{
				type: "gsm",
				ifname: "",
				autoconnect: "yes",
				"connection.autoconnect-retries": 2,
				...bearerIpFamilyFields("ipv4v6"),
				"gsm.device-id": newPair.deviceId,
				"gsm.sim-id": newPair.simId,
				"gsm.apn": "synthetic.invalid",
				"gsm.auto-config": "no",
				"gsm.username": "",
				"gsm.password": "",
				"gsm.password-flags": "4",
				"gsm.home-only": "no",
				"gsm.network-id": "",
			},
			async () => true,
			creationDeps,
		);
		expect(created.state).toBe("created");
		if (created.state !== "created")
			throw new Error("Synthetic profile creation failed");
		expect(
			await creationDeps.fields(created.uuid, [
				"connection.autoconnect",
			] as const),
		).toEqual(["no"]);
		const { prepareCellularActivation, defaultCellularPreparationDeps } =
			await import("../modules/modems/cellular-preparation.ts");
		const target = {
			id: 77,
			key: "platform-synthetic-usb-0:2",
			...newPair,
			equipment: "000000000000001",
			subscriber: "000000000000001",
			ifname: "synthetic0",
			netDevice: "synthetic-net",
			ifindex: "77",
			usbDevice: "synthetic-usb",
			generation: "synthetic-epoch",
			identity: {
				model: "DW5821e Snapdragon X20 LTE",
				firmware: "T77W968.F1.0.0.4.2.GC.010\n026",
				mode: "mbim" as const,
			},
			sim: {
				modemInfo: {} as never,
				simInfo: { "sim.properties.iccid": newPair.simId },
			},
		};
		expect(
			await prepareCellularActivation(
				created.uuid,
				target,
				undefined,
				async () => true,
				{ ...defaultCellularPreparationDeps, present: async () => true },
			),
		).toBe("ready");
		expect(
			await creationDeps.fields(created.uuid, [
				"gsm.auto-config",
				"gsm.apn",
				"connection.autoconnect",
			] as const),
		).toEqual(["yes", "", "no"]);

		expect(
			(await readCarrierIntent({ ...newPair, uuid: created.uuid }))?.mode,
		).toBe("automatic");

		resetGsmConnections();
		const savedManual = await withJournaledModemMutation(
			target.key,
			"modem-config",
			{},
			async (mutation) => {
				await mutation.markExecuting();
				const written = await defaultModemApplyDeps.writeConnection(
					created.uuid,
					{
						autoconfig: false,
						apn: "manual.invalid",
						username: "",
						password: "",
						roaming: true,
						network: "",
					},
				);
				return { confirmed: written, value: written };
			},
		);
		expect(savedManual).toMatchObject({ ok: true, value: true });
		expect(
			await creationDeps.fields(created.uuid, [
				"connection.autoconnect",
			] as const),
		).toEqual(["yes"]);
		expect(
			await restoreCreatedProfile(
				target.key,
				{
					format: "automatic-profile-creation-v1",
					uuid: created.uuid,
					...newPair,
				},
				creationDeps,
			),
		).toBe("failed");
		const savedAutomatic = await withJournaledModemMutation(
			target.key,
			"modem-config",
			{},
			async (mutation) => {
				await mutation.markExecuting();
				const written = await defaultModemApplyDeps.writeConnection(
					created.uuid,
					{
						autoconfig: true,
						apn: "",
						username: "",
						password: "",
						roaming: true,
						network: "",
					},
				);
				return { confirmed: written, value: written };
			},
		);
		expect(savedAutomatic).toMatchObject({ ok: true, value: true });
		expect(
			await creationDeps.fields(created.uuid, [
				"connection.autoconnect",
			] as const),
		).toEqual(["no"]);
		expect(
			await restoreCreatedProfile(
				"platform-synthetic-usb-0:2",
				{
					format: "automatic-profile-creation-v1",
					uuid: created.uuid,
					...newPair,
				},
				creationDeps,
			),
		).toBe("restored");
		expect(
			await creationDeps.fields(created.uuid, ["connection.id"] as const),
		).toBeUndefined();
		resetGsmConnections();
		expect((await getGsmConnections())?.byUuid[uuid]?.autoconfig).toBe(false);
	},
	30_000,
);
