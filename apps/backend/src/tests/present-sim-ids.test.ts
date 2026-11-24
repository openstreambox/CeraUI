import { afterEach, expect, spyOn, test } from "bun:test";
import * as runner from "../helpers/run.ts";
import {
	type PresentSimDeps,
	readPresentSimIds,
	type TwinUsbDevice,
} from "../modules/modems/modem-registration.ts";

type Row = { device: string; sim?: number; iccid?: string };

const RM520 = "2c7c:0801";
const usbPath = (id: number | string): string => `/sys/devices/usb1/1-${id}`;

/** Every listed modem on USB as the same model, unless a test says otherwise. */
let usb: readonly TwinUsbDevice[] | undefined;

function usbFor(rows: Record<number, Row>): TwinUsbDevice[] {
	return Object.keys(rows).map((id) => ({
		vidPid: RM520,
		sysfsPath: usbPath(id),
	}));
}

const deps: PresentSimDeps = {
	usbDevices: async () => usb,
	resolvePath: async (path) => path,
};

const read = (deviceId: string) => readPresentSimIds(deviceId, deps);

function serve(rows: Record<number, Row>): void {
	usb = usbFor(rows);
	spyOn(runner, "run").mockImplementation(async (binary, args) => {
		if (binary !== "mmcli") throw new Error(`unexpected ${binary}`);
		if (args.includes("-L"))
			return [
				`modem-list.length : ${Object.keys(rows).length}`,
				...Object.keys(rows).map(
					(id, i) =>
						`modem-list.value[${i + 1}] : /org/freedesktop/ModemManager1/Modem/${id}`,
				),
			].join("\n");
		if (args.includes("-m")) {
			const row = rows[Number(args[args.indexOf("-m") + 1])];
			if (!row) throw new Error("gone");
			return `modem.generic.device-identifier : ${row.device || "--"}
modem.generic.device : ${usbPath(args[args.indexOf("-m") + 1] ?? "")}
modem.generic.sim : ${row.sim === undefined ? "--" : `/org/freedesktop/ModemManager1/SIM/${row.sim}`}
modem.generic.ports.length : 0`;
		}
		if (args.includes("-i")) {
			const sim = Number(args[args.indexOf("-i") + 1]);
			const row = Object.values(rows).find((r) => r.sim === sim);
			return `sim.properties.iccid : ${row?.iccid ?? "--"}`;
		}
		throw new Error(`unexpected mmcli ${args.join(" ")}`);
	});
}

afterEach(() => {
	spyOn(runner, "run").mockRestore();
});

test("collects the ICCIDs of every modem with the device id", async () => {
	serve({
		1: { device: "twin", sim: 11, iccid: "8901" },
		2: { device: "twin", sim: 12, iccid: "8902" },
		3: { device: "other", sim: 13, iccid: "8903" },
		4: { device: "other" },
	});
	expect([...((await read("twin")) ?? [])].sort()).toEqual(["8901", "8902"]);
});

test("a modem with the device id and no SIM object yet makes the answer unknown", async () => {
	serve({
		1: { device: "twin", sim: 11, iccid: "8901" },
		2: { device: "twin" },
	});
	expect(await read("twin")).toBeUndefined();
});

test("a locked SIM in a modem with the device id makes the answer unknown", async () => {
	serve({
		1: { device: "twin", sim: 11, iccid: "8901" },
		2: { device: "twin", sim: 12 },
	});
	expect(await read("twin")).toBeUndefined();
});

test("a locked SIM in another modem does not matter", async () => {
	serve({
		1: { device: "twin", sim: 11, iccid: "8901" },
		2: { device: "other", sim: 12 },
	});
	expect([...((await read("twin")) ?? [])]).toEqual(["8901"]);
});

test("a modem that cannot be read makes the answer unknown", async () => {
	serve({ 1: { device: "twin", sim: 11, iccid: "8901" } });
	const real = runner.run;
	spyOn(runner, "run").mockImplementation(async (binary, args, ...rest) => {
		if (args.includes("-m")) throw new Error("gone");
		return (real as typeof runner.run)(binary, args, ...rest);
	});
	expect(await read("twin")).toBeUndefined();
});

test("a USB modem of the same model that ModemManager has not listed yet makes the answer unknown", async () => {
	serve({ 1: { device: "twin", sim: 11, iccid: "8901" } });
	usb = [
		...usbFor({ 1: { device: "twin" } }),
		{ vidPid: RM520, sysfsPath: usbPath(2) },
	];
	expect(await read("twin")).toBeUndefined();
});

test("an unlisted USB device of another model does not matter", async () => {
	serve({ 1: { device: "twin", sim: 11, iccid: "8901" } });
	usb = [
		...usbFor({ 1: { device: "twin" } }),
		{ vidPid: "1d6b:0003", sysfsPath: "/sys/devices/usb1" },
	];
	expect([...((await read("twin")) ?? [])]).toEqual(["8901"]);
});

test("a listed modem without a device id yet makes the answer unknown", async () => {
	serve({
		1: { device: "twin", sim: 11, iccid: "8901" },
		2: { device: "" },
	});
	// Even one the USB check would not count as a twin.
	usb = [
		{ vidPid: RM520, sysfsPath: usbPath(1) },
		{ vidPid: "1199:90d3", sysfsPath: usbPath(2) },
	];
	expect(await read("twin")).toBeUndefined();
});

test("an unreadable USB bus makes the answer unknown", async () => {
	serve({ 1: { device: "twin", sim: 11, iccid: "8901" } });
	usb = undefined;
	expect(await read("twin")).toBeUndefined();
});

test("a modem with the device id that is not on the USB bus makes the answer unknown", async () => {
	serve({ 1: { device: "twin", sim: 11, iccid: "8901" } });
	usb = [];
	expect(await read("twin")).toBeUndefined();
});
