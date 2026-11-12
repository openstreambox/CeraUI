import { expect, test } from "bun:test";
import { readlinkSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { privateInverseStore } from "../helpers/durable-inverse.ts";
import { setLinkUpByIndex } from "../helpers/link-up-by-index.ts";
import { createCellularSystemTransport } from "../modules/modems/modems.ts";
import {
	type CellularHandoffIO,
	CellularHostHandoff,
} from "../modules/network/cellular-host-handoff.ts";
import { acquireCellularNmControl } from "../modules/network/cellular-nm-control.ts";
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
			expect(device.managed).toBe(true);
			const raPath = "/proc/sys/net/ipv6/conf/cellular0/accept_ra_defrtr";
			const readRaDefault = async () => {
				const value = (await readFile(raPath, "ascii")).trim();
				return value === "0" || value === "1" ? value : undefined;
			};
			const originalRa = await readRaDefault();
			const originalUp = (await row()).flags.includes("UP") as boolean;
			const io: CellularHandoffIO = {
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
				current: present,
				withdraw: () => {},
				fence: async () => {},
				consumersReleased: async () => true,
			});
			await handoff.prepare();
			expect((await control.read(device))?.managed).toBe(false);
			expect(await readRaDefault()).toBe("0");
			await handoff.prepareCall();
			expect((await row()).flags).toContain("UP");
			expect(await handoff.cleanup()).toBe(true);
			expect((await control.read(device))?.managed).toBe(true);
			expect(await readRaDefault()).toBe(originalRa);
			expect((await row()).flags.includes("UP")).toBe(originalUp);
			expect(await store.read()).toBeUndefined();
		} finally {
			await control.close();
		}
	},
	30000,
);
