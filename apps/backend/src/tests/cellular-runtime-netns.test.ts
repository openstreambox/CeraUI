import { expect, test } from "bun:test";
import { readlinkSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	readPrivateJson,
	writePrivateJson,
} from "../helpers/private-json-state.ts";
import { exchangeSourceBoundDatagram } from "../helpers/source-bound-datagram.ts";
import { probeSourceBoundHttps } from "../helpers/source-bound-https.ts";
import type { CellularDataGrant } from "../modules/modems/cellular-grant.ts";
import {
	CellularRuntime,
	type CellularRuntimeObservation,
} from "../modules/modems/cellular-runtime.ts";
import { createCellularRuntimeKernelSession } from "../modules/modems/cellular-runtime-kernel.ts";
import { inventoryCellularHosts } from "../modules/network/cellular-host-inventory.ts";
import {
	cellularNativeHostSteps,
	cellularUplinkSlotKey,
	parseCellularNativeHostPlan,
} from "../modules/network/cellular-native-host-plan.ts";
import { cellularSourceReady } from "../modules/network/cellular-source-state.ts";
import {
	isRecoveryPending,
	resetRecoveryBarrier,
} from "../modules/streaming/recovery-barrier.ts";
import {
	probeSrtlaSenderCapabilities,
	supportsRequiredCellularBinding,
} from "../modules/streaming/srtla-capabilities.ts";
import { prepareUpdateTransportSetup } from "./fixtures/update-transport-setup.ts";
import { runTestCommand } from "./helpers/run-test-command.ts";

const child = process.env.CERALIVE_CELLULAR_RUNTIME_CHILD === "1";
const senderBinary = process.env.CERALIVE_REQUIRED_SENDER_TEST_BINARY;
if (!senderBinary && process.env.CERALIVE_REQUIRE_CELLULAR_SENDER === "1")
	throw new Error("Required strict sender unavailable");
const missing =
	!senderBinary ||
	["unshare", "mount", "nsenter", "ip", "nft", "openssl"].some(
		(name) => !Bun.which(name),
	);
const privilege =
	child || missing
		? undefined
		: await runTestCommand(["unshare", "-Urnm", "true"]);
const unavailable = missing || (!child && privilege?.code !== 0);
if (unavailable && process.env.CERALIVE_REQUIRE_CELLULAR_NETNS === "1")
	throw new Error("Required cellular runtime namespace unavailable");
(unavailable ? test.skip : test)(
	"actual runtime root carries native traffic beside a quarantined peer without borrowing the LAN",
	async () => {
		if (!child) {
			const namespaceRoot = await mkdtemp(
				join(tmpdir(), "cellular-runtime-root-"),
			);
			await mkdir(join(namespaceRoot, "tmp"), { mode: 0o700 });
			try {
				const result = await runTestCommand(
					[
						"unshare",
						"-Urnm",
						"sh",
						"-c",
						'mount --make-rprivate / && mount --bind "$1" /var && exec "$2" test "$3"',
						"cellular-runtime",
						namespaceRoot,
						process.execPath,
						fileURLToPath(import.meta.url),
					],
					{
						cwd: namespaceRoot,
						env: {
							CERALIVE_CELLULAR_RUNTIME_CHILD: "1",
							CELLULAR_HOST_NETNS: readlinkSync("/proc/self/ns/net"),
							CELLULAR_HOST_MNTNS: readlinkSync("/proc/self/ns/mnt"),
							TMPDIR: "/var/tmp",
						},
					},
				);
				expect(result.code, result.stdout + result.stderr).toBe(0);
			} finally {
				await rm(namespaceRoot, { recursive: true, force: true });
			}
			return;
		}
		if (
			!process.env.CELLULAR_HOST_NETNS ||
			readlinkSync("/proc/self/ns/net") === process.env.CELLULAR_HOST_NETNS
		)
			throw new Error("Runtime fixture must be disconnected from the host");
		if (
			!process.env.CELLULAR_HOST_MNTNS ||
			readlinkSync("/proc/self/ns/mnt") === process.env.CELLULAR_HOST_MNTNS
		)
			throw new Error("Runtime fixture must own its mount namespace");
		const command = async (...args: string[]) => {
			const result = await runTestCommand(args);
			if (result.code) throw new Error(result.stderr);
			return result.stdout;
		};
		const directory = await mkdtemp(join(tmpdir(), "cellular-runtime-")),
			cert = join(directory, "certificate.pem"),
			key = join(directory, "key.pem"),
			receipt = join(directory, "provider.json");
		await prepareUpdateTransportSetup(directory);
		const {
			CellularHostRecovery,
			cellularRecoveryReservedSlots,
			isolateCellularHostAuthority,
			retainCellularHostInverse,
		} = await import("../modules/modems/cellular-host-recovery.ts");
		const { initCellularRuntimeAdmission } = await import(
			"../modules/modems/cellular-runtime-host.ts"
		);
		const {
			defaultMutationJournalFs,
			resetMutationJournalDeps,
			setMutationJournalDeps,
		} = await import("../modules/modems/mutation-journal.ts");
		const { initMutationRecovery } = await import(
			"../modules/modems/mutation-replay.ts"
		);

		let provider: ReturnType<typeof Bun.spawn> | undefined,
			root: CellularRuntime | undefined;
		try {
			await command("ip", "link", "set", "lo", "up");
			await command(
				"ip",
				"link",
				"add",
				"wwan0",
				"type",
				"veth",
				"peer",
				"name",
				"provider0",
			);
			await command("ip", "addr", "add", "192.0.2.2/32", "dev", "wwan0");
			await command("ip", "link", "set", "wwan0", "up");
			await command("ip", "link", "add", "lan0", "type", "dummy");
			await command("ip", "link", "set", "lan0", "up");
			await command("ip", "route", "add", "default", "dev", "lan0");
			await command(
				"openssl",
				"req",
				"-new",
				"-x509",
				"-newkey",
				"rsa:2048",
				"-nodes",
				"-keyout",
				key,
				"-out",
				cert,
				"-days",
				"1",
				"-subj",
				"/CN=1.1.1.1",
				"-addext",
				"subjectAltName=IP:1.1.1.1",
			);
			// The provider owns a separate network namespace. Its startup waits for
			// an explicit ready file after the parent configures only that namespace.
			const providerScript = fileURLToPath(
				new URL("./fixtures/cellular-runtime-provider.ts", import.meta.url),
			);
			provider = Bun.spawn(
				[
					"unshare",
					"-n",
					"sh",
					"-c",
					'while [ ! -f "$1" ]; do sleep 0.02; done; exec "$2" "$3" "$4" "$5" "$6"',
					"provider",
					`${receipt}.configured`,
					process.execPath,
					providerScript,
					cert,
					key,
					receipt,
				],
				{ stdin: "ignore", stdout: "ignore", stderr: "pipe" },
			);
			let separated = false;
			for (let attempt = 0; attempt < 100; attempt++) {
				try {
					separated =
						readlinkSync(`/proc/${provider.pid}/ns/net`) !==
						readlinkSync("/proc/self/ns/net");
				} catch {
					/* Child has not entered its namespace. */
				}
				if (separated) break;
				await Bun.sleep(10);
			}
			if (!separated) throw new Error("Provider namespace did not separate");
			await command(
				"ip",
				"link",
				"set",
				"provider0",
				"netns",
				String(provider.pid),
			);
			const inside = (...args: string[]) =>
				command("nsenter", "-t", String(provider?.pid), "-n", ...args);
			await inside("ip", "link", "set", "lo", "up");
			await inside("ip", "link", "set", "provider0", "up");
			await inside("ip", "addr", "add", "192.0.2.1/32", "dev", "provider0");
			await inside("ip", "addr", "add", "192.0.2.53/32", "dev", "lo");
			await inside("ip", "addr", "add", "1.1.1.1/32", "dev", "lo");
			await inside("ip", "route", "add", "192.0.2.2/32", "dev", "provider0");
			await Bun.write(`${receipt}.configured`, "ready");
			let ready = false;
			for (let attempt = 0; attempt < 200; attempt++) {
				if (await Bun.file(`${receipt}.ready`).exists()) {
					ready = true;
					break;
				}
				if (provider.exitCode !== null) throw new Error("Provider exited");
				await Bun.sleep(10);
			}
			if (!ready) throw new Error("Provider did not become ready");
			const link = JSON.parse(
					await command("ip", "-j", "link", "show", "dev", "wwan0"),
				)[0],
				bootId = (
					await readFile("/proc/sys/kernel/random/boot_id", "ascii")
				).trim();
			const mainBefore = await command(
				"ip",
				"-j",
				"route",
				"show",
				"table",
				"main",
			);
			let released = false,
				faults = 0,
				reserved = 0;
			const store = {
					dir: join(directory, "state"),
					readFault: () => {
						faults++;
					},
				},
				owner = "a".repeat(64),
				grant: CellularDataGrant = {
					family: "ipv4",
					source: "192.0.2.2",
					gateway: "192.0.2.1",
					mtu: 1428,
					dns: ["192.0.2.53"],
					generation: "native-one",
					physical: {
						ifname: "wwan0",
						ifindex: String(link.ifindex),
						usbDevice: "synthetic-usb",
						netDevice: "synthetic-veth",
						generation: "one",
					},
				},
				current = async () =>
					JSON.parse(
						await command("ip", "-j", "link", "show", "dev", "wwan0"),
					)[0]?.ifindex === link.ifindex;
			const sender = process.env.CERALIVE_REQUIRED_SENDER_TEST_BINARY;
			if (!sender)
				throw new Error("Runtime fixture requires the pinned strict sender");
			const capabilities = await probeSrtlaSenderCapabilities(sender);
			expect(supportsRequiredCellularBinding(capabilities)).toBe(true);
			const failures: unknown[] = [];
			// Model a crashed peer whose old consumer cannot yet acknowledge closure.
			// Use its actual private slot lease and host inverse, with only that consumer
			// observation injected; all healthy packet/routing/probe operations are real.
			const blockedPlan = parseCellularNativeHostPlan({
				input: {
					owner: "b".repeat(64),
					epoch: "blocked",
					slot: 32,
					iface: "wwanBad",
					mtu: 1428,
					ipv4: grant.source,
				},
				bootId,
				ifindex: 9999,
				dns: [],
			});
			await writePrivateJson(store, cellularUplinkSlotKey(32), {
				version: 1,
				owner: blockedPlan.input.owner,
				epoch: blockedPlan.input.epoch,
				plan: blockedPlan,
				steps: cellularNativeHostSteps(blockedPlan),
				cursor: cellularNativeHostSteps(blockedPlan).length,
				phase: "active",
			});
			initCellularRuntimeAdmission();
			const startup = new CellularHostRecovery({
				store,
				bootId: async () => bootId,
				retain: (authority, boot) =>
					retainCellularHostInverse(authority, boot, store, async () => false),
				isolate: isolateCellularHostAuthority,
			});
			setMutationJournalDeps({
				fs: defaultMutationJournalFs,
				dir: join(directory, "journal"),
			});
			const recovery = await initMutationRecovery({
				replayHosts: () => startup.replay(),
			});
			expect(recovery.unreadable).toBe(0);
			expect(isRecoveryPending()).toBe(false);
			expect(cellularRecoveryReservedSlots()).toContain(32);
			expect(cellularSourceReady("wwanBad", grant.source)).toBe(false);
			root = new CellularRuntime({
				now: () => performance.now(),
				reservedSlots: cellularRecoveryReservedSlots,
				capable: async () => !isRecoveryPending(),
				reserve: async (_owner, bytes) => {
					reserved += bytes;
					return { remaining: 1024 * 1024 };
				},
				failure: (error) => failures.push(error),
				retain: (
					_row,
					captured,
					slot,
					_sourceEpoch,
					hostEpoch,
					owned,
					currentNow,
				) => ({
					session: createCellularRuntimeKernelSession(
						captured,
						slot,
						owner,
						hostEpoch,
						{
							store,
							bootId,
							owned,
							currentNow,
							current,
							withdraw: () => {},
							consumersReleased: async () => released,
							reserve: async () => true,
							probe: {
								transactionId: () => 1234,
								datagram: exchangeSourceBoundDatagram,
								https: (path) => probeSourceBoundHttps(path, { caFile: cert }),
							},
						},
					),
					finish: () => {},
				}),
			});
			const observation: CellularRuntimeObservation = {
				owner,
				iface: "wwan0",
				linkId: "synthetic-link",
				physicalGeneration: "one",
				stamp: "one",
				grant,
				currentNow: () => true,
				current,
				close: async () => {},
				reconnect: async () => false,
			};
			await root.reconcile([observation]);
			expect(failures).toEqual([]);
			expect(cellularSourceReady("wwan0", grant.source)).toBe(true);
			expect(reserved).toBe(32 * 1024);
			const seen = JSON.parse(await readFile(receipt, "utf8"));
			expect(seen).toEqual([
				{ kind: "dns", source: grant.source },
				{ kind: "https", source: grant.source },
			]);
			expect(
				(await inventoryCellularHosts(store)).map((row) => row.kind),
			).toEqual(["native", "native"]);
			root.invalidate("wwan0");
			expect(cellularSourceReady("wwan0", grant.source)).toBe(false);
			expect(await root.close()).toBe(false);
			const authority = await readPrivateJson(store, cellularUplinkSlotKey(1));
			if (!authority || typeof authority !== "object")
				throw new Error("Retained runtime authority missing");
			await writePrivateJson(store, cellularUplinkSlotKey(1), {
				...authority,
				version: 99,
			});
			await expect(root.close()).rejects.toThrow();
			expect(faults).toBeGreaterThan(0);
			await writePrivateJson(store, cellularUplinkSlotKey(1), authority);
			released = true;
			expect(await root.close()).toBe(true);
			expect(
				(await inventoryCellularHosts(store)).map((row) => row.slot),
			).toEqual([32]);
			expect(cellularSourceReady("wwanBad", grant.source)).toBe(false);
			expect(await command("ip", "-j", "route", "show", "table", "main")).toBe(
				mainBefore,
			);
			expect(
				JSON.parse(
					await command("ip", "-j", "addr", "show", "dev", "wwan0"),
				)[0].addr_info.some(
					(address: { local: string }) => address.local === grant.source,
				),
			).toBe(true);
		} finally {
			resetMutationJournalDeps();
			resetRecoveryBarrier();
			if (provider) {
				provider.kill("SIGTERM");
				await Promise.race([provider.exited, Bun.sleep(1000)]);
				if (provider.exitCode === null) {
					provider.kill("SIGKILL");
					await provider.exited;
				}
			}
			await rm(directory, { recursive: true, force: true });
		}
	},
	30000,
);
