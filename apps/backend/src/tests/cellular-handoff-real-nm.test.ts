import { expect, test } from "bun:test";
import { readlinkSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { privateInverseStore } from "../helpers/durable-inverse.ts";
import { setLinkUpByIndex } from "../helpers/link-up-by-index.ts";
import { readCellularNmIp } from "../modules/modems/cellular-nm-ip.ts";
import { createCellularSystemTransport } from "../modules/modems/modems.ts";
import {
	type CellularHandoffIO,
	CellularHostHandoff,
} from "../modules/network/cellular-host-handoff.ts";
import { acquireCellularNmControl } from "../modules/network/cellular-nm-control.ts";
import { cellularNmHandoffRestored } from "../modules/network/cellular-nm-handoff-observation.ts";
import { inspectCellularNmcliObserver } from "../modules/network/cellular-observer-census.ts";
import {
	captureReadOnlyNmcliMonitors,
	NmcliMonitorManager,
} from "../modules/network/monitor/monitor-manager.ts";
import { runTestCommand } from "./helpers/run-test-command.ts";

const child = process.env.CERALIVE_NM_PROFILE_CHILD === "1";
const missing = [
	"unshare",
	"mount",
	"NetworkManager",
	"nmcli",
	"dbus-daemon",
].some((name) => !Bun.which(name));
const privilege =
	child || missing
		? undefined
		: await runTestCommand(["unshare", "-Urnm", "true"]);
const unavailable = missing || (!child && privilege?.code !== 0);
if (unavailable && process.env.CERALIVE_REQUIRE_REAL_NM === "1")
	throw new Error("Required NM handoff namespace unavailable");
(unavailable ? test.skip : test)(
	"RNDIS host handoff reverses actual NM Managed, per-link RA and link state",
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
						CELLULAR_HANDOFF_FIXTURE: "1",
					},
				},
			);
			expect(result.code, result.stdout + result.stderr).toBe(0);
			return;
		}
		if (
			readlinkSync("/proc/self/ns/net") === process.env.CELLULAR_HOST_NETNS ||
			readlinkSync("/proc/self/ns/mnt") === process.env.CELLULAR_HOST_MNTNS
		)
			throw new Error("Handoff must use private namespaces");
		const command = async (...args: string[]) => {
			const result = await runTestCommand(args);
			if (result.code) throw new Error(result.stderr);
			return result.stdout;
		};
		// Read actual NM AddressData/NameserverData and active-profile authority,
		// including a kernel device distinct from the modem's control-port name.
		await command(
			"nmcli",
			"connection",
			"add",
			"type",
			"dummy",
			"ifname",
			"observer0",
			"con-name",
			"nm-ip-fixture",
			"connection.autoconnect",
			"no",
			"ipv4.method",
			"manual",
			"ipv4.addresses",
			"192.0.2.2/24",
			"ipv4.gateway",
			"192.0.2.1",
			"ipv4.dns",
			"192.0.2.53",
			"ipv4.never-default",
			"yes",
			"ipv6.method",
			"manual",
			"ipv6.addresses",
			"2001:db8:1::2/64",
			"ipv6.gateway",
			"2001:db8:1::1",
			"ipv6.dns",
			"2001:db8::53",
			"ipv6.never-default",
			"yes",
		);
		const observedUuid = (
			await command(
				"nmcli",
				"-g",
				"connection.uuid",
				"connection",
				"show",
				"nm-ip-fixture",
			)
		).trim();
		const monitor = new NmcliMonitorManager(() => {});
		monitor.start();
		try {
			await command("nmcli", "connection", "up", "uuid", observedUuid);
			const observed = await readCellularNmIp(
				{ id: 0, ifname: "observer0" },
				observedUuid,
				async () => true,
			);
			expect(observed?.ipv4).toMatchObject({
				addresses: [{ address: "192.0.2.2", prefix: 24 }],
				dns: ["192.0.2.53"],
			});
			expect(observed?.ipv6).toMatchObject({
				addresses: expect.arrayContaining([
					{ address: "2001:db8:1::2", prefix: 64 },
				]),
				dns: ["2001:db8::53"],
			});
			// NM omits active gateways for never-default profiles. Saved gateway
			// settings alone are not evidence of a granted host default.
			expect(observed?.ipv4?.gateway).toBeUndefined();
			expect(observed?.ipv6?.gateway).toBeUndefined();
			const observers = captureReadOnlyNmcliMonitors();
			expect(observers.pids).toHaveLength(1);
			const pid = observers.pids[0];
			if (!pid) throw new Error("Actual NM observer missing");
			let proof: string | undefined;
			for (let attempt = 0; attempt < 10 && !proof; attempt++) {
				proof = await inspectCellularNmcliObserver(pid, process.pid);
				if (!proof) await Bun.sleep(20);
			}
			expect(proof).toMatch(/^[a-f0-9]{64}$/);
			expect(observers.current()).toBe(true);
		} finally {
			monitor.stop();
			await command("nmcli", "connection", "delete", "uuid", observedUuid);
		}
		const row = async () =>
			JSON.parse(
				await command("ip", "-j", "link", "show", "dev", "cellular0"),
			)[0];
		const index = (await row()).ifindex as number;
		const present = async () => (await row()).ifindex === index;
		const link = {
			ifname: "cellular0",
			ifindex: String(index),
			usbDevice: "synthetic-usb",
			netDevice: "synthetic-veth",
			generation: "one",
		};
		const control = await acquireCellularNmControl(
			link,
			"/org/freedesktop/ModemManager1/Modem/0",
			{ transport: createCellularSystemTransport, present, revoked: () => {} },
		);
		try {
			const device = control.devices[0];
			if (!device) throw new Error("Missing actual NM physical device");
			const observeRestoration = async (expected: boolean) => {
				const trace: unknown[] = [];
				const restored = await cellularNmHandoffRestored(device, {
					now: () => performance.now(),
					transport: (options) => {
						const transport = createCellularSystemTransport(options),
							dispatch = transport.callMethod.bind(transport);
						transport.callMethod = async (call) => {
							const reply = await dispatch(call);
							trace.push({
								member: call.member,
								signature: reply.signature,
								body:
									call.member === "GetAll" && Array.isArray(reply.body[0])
										? reply.body[0].filter(
												(item) =>
													Array.isArray(item) &&
													[
														"Udi",
														"Interface",
														"IpInterface",
														"Managed",
													].includes(String(item[0])),
											)
										: reply.body,
							});
							return reply;
						};
						return transport;
					},
				});
				expect(restored, JSON.stringify(trace)).toBe(expected);
			};
			expect(device.managed).toBe(true);
			await observeRestoration(true);
			const raPath = "/proc/sys/net/ipv6/conf/cellular0/accept_ra_defrtr";
			const readRaDefault = async () => {
				const value = (await readFile(raPath, "ascii")).trim();
				return value === "0" || value === "1" ? value : undefined;
			};
			const originalRa = await readRaDefault();
			const originalUp = (await row()).flags.includes("UP") as boolean;
			const io: CellularHandoffIO = {
				resourceState: async () => ((await present()) ? "present" : "unknown"),
				nmRestored: async () => false,
				present,
				nm: control,
				readRaDefault,
				setRaDefault: async (expected, desired) => {
					const value = await readRaDefault();
					if (value !== expected && value !== desired) return false;
					await writeFile(raPath, `${desired}\n`);
					return (await readRaDefault()) === desired;
				},
				readUp: async () => (await row()).flags.includes("UP"),
				setUp: async (expected, desired) => {
					const value = (await row()).flags.includes("UP");
					return (
						(value === expected || value === desired) &&
						(await setLinkUpByIndex(index, desired)) &&
						(await row()).flags.includes("UP") === desired
					);
				},
			};
			const owner = "a".repeat(64),
				store = privateInverseStore(
					{ dir: "/run/cellular-profile-fixture/handoff" },
					owner,
				);
			const handoff = new CellularHostHandoff(owner, "one", link, io, {
				...store,
				bootId: (
					await readFile("/proc/sys/kernel/random/boot_id", "ascii")
				).trim(),
				current: present,
				withdraw: () => {},
				fence: async () => {},
				consumersReleased: async () => true,
			});
			await handoff.prepare();
			expect((await control.read(device))?.managed).toBe(false);
			await observeRestoration(false);
			expect(await readRaDefault()).toBe("0");
			await handoff.prepareCall();
			expect((await row()).flags).toContain("UP");
			expect(await handoff.cleanup()).toBe(true);
			expect((await control.read(device))?.managed).toBe(true);
			await observeRestoration(true);
			expect(await readRaDefault()).toBe(originalRa);
			expect((await row()).flags.includes("UP")).toBe(originalUp);
			expect(await store.read()).toBeUndefined();
		} finally {
			await control.close();
		}
	},
	30000,
);
