import { spyOn } from "bun:test";
import * as runner from "../../helpers/run.ts";
import * as time from "../../helpers/time.ts";
import { resolvePhysicalDevice } from "../../modules/modems/physical-identity.ts";
import {
	defaultRouterCellularScanDeps,
	refreshUsbNetMarkers,
} from "../../modules/network/router-cellular-scan.ts";
import {
	constructedTwinDeps,
	constructedTwins,
} from "./constructed-usb-twins.ts";

export const FIRST_SIGHT_IFACE = "wwu1c2";
export const FIRST_SIGHT_IP = "100.64.1.2";

export function firstSightIfconfig(ifname: string, ip: string): string {
	return [
		`${ifname}: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500`,
		`        inet ${ip}  netmask 255.255.255.0`,
		"        ether 02:00:00:00:00:01",
		"        RX packets 1  bytes 0",
		"        TX packets 1  bytes 0",
	].join("\n");
}

/** Constructed port identity, independent of the live descriptor cache. */
export function firstSightPhysicalDevice() {
	const device = constructedTwins.find((d) => d.ifname === FIRST_SIGHT_IFACE);
	if (device === undefined) throw new Error("missing constructed modem");
	return resolvePhysicalDevice({
		ifname: FIRST_SIGHT_IFACE,
		idPath: device.udevadm.ID_PATH,
		vid: device.idVendor,
		pid: device.idProduct,
	});
}

/** The real OS publication and USB reader, with only OS reads and time injected. */
export function firstSightScan(
	output: string,
	options: {
		blocked?: readonly string[];
		buses?: Readonly<Record<string, string>>;
		devices?: typeof constructedTwins;
	} = {},
) {
	const clock = { now: 0 };
	const indices = new Map<string, number>();
	let ipUnavailable = false;
	const fixture = constructedTwinDeps(options.devices);
	const reads = new Map<
		string,
		{
			gate: ReturnType<typeof Promise.withResolvers<void>>;
			entered: ReturnType<typeof Promise.withResolvers<void>>;
		}
	>();
	const block = (name: string) => {
		reads.set(name, {
			gate: Promise.withResolvers<void>(),
			entered: Promise.withResolvers<void>(),
		});
	};
	for (const name of options.blocked ?? [FIRST_SIGHT_IFACE]) block(name);
	const busReplies = new Map<string, () => Promise<string | undefined>>();
	const busCounts = new Map<string, number>();
	for (const [name, bus] of Object.entries(options.buses ?? {}))
		busReplies.set(name, async () => bus);
	spyOn(time, "getms").mockImplementation(() => clock.now);
	spyOn(defaultRouterCellularScanDeps, "resolveLink").mockImplementation(
		async (path) => {
			const parked = reads.get(path.split("/").at(-2) ?? "");
			if (parked) {
				parked.entered.resolve();
				await parked.gate.promise;
			}
			return fixture.resolveLink(path);
		},
	);
	spyOn(defaultRouterCellularScanDeps, "readAttr").mockImplementation(
		async (path) => {
			if (path.endsWith("/ifindex")) {
				const index = indices.get(path.split("/").at(-2) ?? "");
				return index?.toString();
			}
			return fixture.readAttr(path);
		},
	);
	spyOn(defaultRouterCellularScanDeps, "listDir").mockImplementation(
		fixture.listDir,
	);
	spyOn(defaultRouterCellularScanDeps, "readLinkName").mockImplementation(
		fixture.readLinkName,
	);
	spyOn(defaultRouterCellularScanDeps, "readLinkResult").mockImplementation(
		async (path) => {
			if (!path.endsWith("/device/subsystem"))
				return { ok: true, target: "/sys/devices/virtual/net/fixture" };
			const name = path.split("/").at(-3) ?? "";
			busCounts.set(name, (busCounts.get(name) ?? 0) + 1);
			const bus = await busReplies.get(name)?.();
			return bus === undefined
				? { ok: false, code: "ENOENT" }
				: { ok: true, target: `/sys/bus/${bus}` };
		},
	);
	spyOn(runner, "run").mockImplementation(async (bin) => {
		if (bin === "ifconfig") return output;
		if (ipUnavailable) throw new Error("fixture address command unavailable");
		return output
			.split("\n\n")
			.flatMap((entry) => {
				const name = entry.split(":")[0];
				if (!name) return [];
				if (!indices.has(name)) indices.set(name, indices.size + 10);
				return [`${indices.get(name)}: ${name}: <UP> mtu 1500`];
			})
			.join("\n");
	});
	return {
		clock,
		block,
		busCounts,
		setIndex: (name: string, index: number) => indices.set(name, index),
		setIpUnavailable: () => {
			ipUnavailable = true;
		},
		entered: reads.get(FIRST_SIGHT_IFACE)?.entered.promise ?? Promise.resolve(),
		enteredFor: (name: string) =>
			reads.get(name)?.entered.promise ?? Promise.resolve(),
		setOutput: (next: string) => {
			output = next;
		},
		setBus: (name: string, reply: () => Promise<string | undefined>) =>
			busReplies.set(name, reply),
		release: () => {
			for (const read of reads.values()) read.gate.resolve();
		},
		settle: () =>
			refreshUsbNetMarkers(
				output.split("\n\n").map((entry) => entry.split(":")[0] ?? ""),
			),
	};
}
