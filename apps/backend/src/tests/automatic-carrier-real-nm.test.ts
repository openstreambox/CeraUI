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
	},
	30_000,
);
