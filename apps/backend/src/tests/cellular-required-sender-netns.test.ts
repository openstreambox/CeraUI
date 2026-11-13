import { expect, test } from "bun:test";
import { readlinkSync } from "node:fs";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	readlink,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Telemetry, telemetrySchema } from "@ceraui/srtla-send/telemetry";
import { prepareUpdateTransportSetup } from "./fixtures/update-transport-setup.ts";
import { runTestCommand } from "./helpers/run-test-command.ts";

const binary = process.env.CERALIVE_REQUIRED_SENDER_TEST_BINARY,
	child = process.env.CERALIVE_CELLULAR_SENDER_CHILD === "1",
	missing = ["unshare", "mount", "ip"].some((name) => !Bun.which(name)),
	privilege =
		!child && !missing
			? await runTestCommand(["unshare", "-Urnm", "true"])
			: undefined,
	unavailable = !binary || missing || (!child && privilege?.code !== 0);
if (unavailable && process.env.CERALIVE_REQUIRE_CELLULAR_SENDER === "1")
	throw new Error("Required native sender namespace unavailable");

async function waitFor(
	check: () => Promise<boolean>,
	label: string,
): Promise<void> {
	const deadline = performance.now() + 5000;
	while (performance.now() < deadline) {
		if (await check()) return;
		await Bun.sleep(25);
	}
	throw new Error(`Native sender fixture timed out: ${label}`);
}
async function sourceSockets(pid: number): Promise<string[]> {
	const names = await readdir(`/proc/${pid}/fd`);
	if (names.length > 256)
		throw new Error("Unknown sender descriptor inventory");
	const inodes = new Set<string>();
	for (const name of names) {
		let target: string;
		try {
			target = await readlink(`/proc/${pid}/fd/${name}`);
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT")
				continue;
			throw error;
		}
		const match = /^socket:\[(\d+)\]$/.exec(target);
		if (match?.[1]) inodes.add(match[1]);
	}
	return (await readFile("/proc/net/udp", "utf8"))
		.trim()
		.split("\n")
		.slice(1)
		.filter((line) => {
			const fields = line.trim().split(/\s+/);
			return (
				fields[1]?.startsWith("020200C0:") &&
				!!fields[9] &&
				inodes.has(fields[9])
			);
		})
		.map((line) => line.trim().split(/\s+/)[9] as string);
}
(unavailable ? test.skip : test)(
	"required sender withdrawal closes real source sockets and re-adds a fresh mapped link",
	async () => {
		if (!child) {
			const root = await mkdtemp(join(tmpdir(), "cellular-sender-root-"));
			await mkdir(join(root, "tmp"), { mode: 0o700 });
			try {
				const result = await runTestCommand(
					[
						"unshare",
						"-Urnm",
						"sh",
						"-c",
						'mount --make-rprivate / && mount --bind "$1" /var && exec "$2" test "$3"',
						"cellular-sender",
						root,
						process.execPath,
						fileURLToPath(import.meta.url),
					],
					{
						cwd: root,
						env: {
							CERALIVE_CELLULAR_SENDER_CHILD: "1",
							CELLULAR_SENDER_HOST_NETNS: readlinkSync("/proc/self/ns/net"),
							CELLULAR_SENDER_HOST_MNTNS: readlinkSync("/proc/self/ns/mnt"),
							TMPDIR: "/var/tmp",
						},
					},
				);
				expect(result.code, result.stdout + result.stderr).toBe(0);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
			return;
		}
		if (
			!binary ||
			!process.env.CELLULAR_SENDER_HOST_NETNS ||
			readlinkSync("/proc/self/ns/net") ===
				process.env.CELLULAR_SENDER_HOST_NETNS ||
			!process.env.CELLULAR_SENDER_HOST_MNTNS ||
			readlinkSync("/proc/self/ns/mnt") ===
				process.env.CELLULAR_SENDER_HOST_MNTNS
		)
			throw new Error(
				"Native sender requires owned network and mount namespaces",
			);
		const root = await mkdtemp(join(tmpdir(), "cellular-sender-state-"));
		await prepareUpdateTransportSetup(root);
		// Select the private executable before importing the actual composition.
		const { setup } = await import("../modules/setup.ts");
		const ipsFile = join(root, "ips"),
			mapFile = join(root, "map");
		setup.srtla_path = binary;
		setup.ips_file = ipsFile;
		setup.bind_map_file = mapFile;
		const state = await import("../modules/network/cellular-source-state.ts"),
			network = await import("../modules/network/network-interfaces.ts"),
			bond = await import("../modules/streaming/srtla.ts"),
			binding = await import("../modules/streaming/bind-map-spawn.ts"),
			capabilities = await import("../modules/streaming/srtla-capabilities.ts"),
			processes = await import(
				"../modules/streaming/streamloop/process-runner.ts"
			),
			telemetry = await import("../modules/streaming/link-telemetry.ts"),
			withdrawal = await import(
				"../modules/streaming/cellular-withdrawal-receipt.ts"
			);
		const ip = async (...args: string[]) => {
			const result = await runTestCommand(["ip", ...args]);
			if (result.code) throw new Error(result.stderr);
		};
		await ip("link", "set", "lo", "up");
		await ip("link", "add", "wwan0", "type", "dummy");
		await ip("addr", "add", "192.0.2.2/32", "dev", "wwan0");
		await ip("link", "set", "wwan0", "up");
		await ip("route", "add", "198.51.100.1/32", "dev", "wwan0");
		const { mintLinkId } = await import(
			"../modules/modems/physical-identity.ts"
		);
		const owner = "a".repeat(64),
			epoch = "usb-one",
			linkId = mintLinkId("synthetic:cellular"),
			telemetryInstance = (
				await import("../modules/streaming/sender-telemetry-instance.ts")
			).createSenderTelemetryInstance(
				join(root, "stats"),
				join(root, "control"),
			),
			stats = telemetryInstance.statsFile;
		let owned = true,
			sender: ReturnType<typeof processes.spawnStreamingLoop> | undefined;
		bond.setBondIdentityResolverForTest((name) => ({
			identityKey: "synthetic:cellular",
			anchor: "id-path",
			linkId,
			ifname: name,
			idPath: "/synthetic/cellular",
			displayName: "Synthetic cellular",
		}));
		const ready = (generation: string) => {
			state.claimCellularSource(owner, epoch, "wwan0");
			state.setCellularSourceBinding(owner, epoch, "wwan0", {
				source: "192.0.2.2",
				device: "wwan0",
				translated: false,
				generation,
			});
			state.setCellularSourceReady(owner, epoch, "wwan0", generation, true);
			network.processIfconfigOutput(
				"wwan0: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500\n        inet 192.0.2.2  netmask 255.255.255.255\n        RX packets 1  bytes 100\n        TX packets 1  bytes 100",
			);
		};
		const snapshot = async (): Promise<Telemetry | undefined> => {
			try {
				return telemetrySchema.parse(await Bun.file(stats).json());
			} catch (error) {
				if (
					error instanceof Error &&
					"code" in error &&
					error.code === "ENOENT"
				)
					return undefined;
				throw error;
			}
		};
		try {
			ready("first");
			expect((await bond.publishSrtlaBond(bond.genSrtlaBondEntries())).ok).toBe(
				true,
			);
			const resolved = await binding.resolveCellularBindMapArgs(
				binary,
				{
					getBond: bond.getLastPublishedBond,
					probe: capabilities.probeSrtlaSenderCapabilities,
					announce: () => {},
				},
				bond.publishedBondNeedsRequiredBinding,
			);
			if (!resolved.ok || !resolved.required)
				throw new Error(
					"Both required native binding capabilities must be present",
				);
			sender = processes.spawnStreamingLoop(
				binary,
				[
					"19990",
					"198.51.100.1",
					"19991",
					ipsFile,
					"--stats-file",
					stats,
					"--control-socket",
					telemetryInstance.controlSocket,
					"--stats-file-interval",
					"100",
					...resolved.args,
				],
				() => {},
			);
			telemetry.startLinkTelemetry(stats, ["192.0.2.2"], {
				producer: sender,
				telemetryInstance,
				controlSocket: telemetryInstance.controlSocket,
				intervalMs: 25,
			});
			expect(sender.senderBinding?.required).toBe(true);
			await waitFor(
				async () => (await snapshot())?.connections.length === 1,
				"initial mapped source",
			);
			const firstSockets = await sourceSockets(sender.proc.pid);
			expect(firstSockets).toHaveLength(1);
			const firstMap = bond.getLastPublishedBond()?.publication;
			if (!firstMap?.ok) throw new Error("Initial native map unavailable");
			state.withdrawCellularSource(owner, epoch, "wwan0");
			await writeFile(mapFile, "{", { mode: 0o600 });
			const failedAt = Date.now(),
				failedReadBoundary = performance.now();
			sender.proc.kill("SIGHUP");
			await waitFor(async () => {
				const value = await snapshot();
				return (
					!!value &&
					value.last_updated_ms > failedAt &&
					value.bind_map_status?.state === "degraded"
				);
			}, "refused malformed reload");
			expect(
				telemetry.senderReleasedCellularSource(
					sender,
					failedReadBoundary,
					linkId,
					["wwan0"],
					{
						generation: firstMap.generation,
						ips_file_sha256: firstMap.ipsFileSha256,
					},
				),
			).toBe(false);
			expect(await sourceSockets(sender.proc.pid)).toHaveLength(1);
			const receipt = await withdrawal.createCellularWithdrawalReceipt({
				owner,
				epoch,
				iface: "wwan0",
				linkId,
				devices: ["wwan0"],
				owned: () => owned,
			});
			if (!receipt) throw new Error("Native withdrawal receipt unavailable");
			await waitFor(
				async () => receipt.confirmed(),
				"fresh empty native acknowledgement",
			);
			// The acknowledged control frame must already follow joined socket
			// teardown. The independent periodic file publisher may catch up later.
			expect(await sourceSockets(sender.proc.pid)).toHaveLength(0);
			const committed = bond.getLastPublishedBond()?.publication;
			if (!committed?.ok)
				throw new Error("Native withdrawal lost its publication");
			await waitFor(async () => {
				const value = await snapshot();
				return (
					value?.connections.length === 0 &&
					value.bind_map_applied?.generation === committed.generation &&
					value.bind_map_applied.ips_file_sha256 === committed.ipsFileSha256
				);
			}, "stats file publishes the same applied empty identity");
			expect((await snapshot())?.connections).toEqual([]);
			expect(await sourceSockets(sender.proc.pid)).toHaveLength(0);
			expect(sender.proc.exitCode).toBeNull();
			ready("successor");
			expect(receipt.confirmed()).toBe(false);
			expect((await bond.publishSrtlaBond(bond.genSrtlaBondEntries())).ok).toBe(
				true,
			);
			sender.proc.kill("SIGHUP");
			await waitFor(
				async () => (await snapshot())?.connections.length === 1,
				"mapped source re-add",
			);
			const freshSockets = await sourceSockets(sender.proc.pid);
			expect(freshSockets).toHaveLength(1);
			expect(freshSockets[0]).not.toBe(firstSockets[0]);
			expect(await sourceSockets(sender.proc.pid)).toHaveLength(1);
			expect(sender.proc.exitCode).toBeNull();
		} finally {
			if (sender) await processes.stopProcessAndWait(sender);
			telemetry.stopLinkTelemetry();
			owned = false;
			state.resetCellularSourcesForTest();
			bond.setBondIdentityResolverForTest(null);
			await rm(root, { recursive: true, force: true });
		}
	},
	30_000,
);
