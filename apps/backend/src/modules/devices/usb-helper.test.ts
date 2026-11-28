import { describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { readUsbHelper } from "./usb-helper.ts";

const IMEI = "490154203237518";
const SERIAL = "2C1MX4A01234";
const mkfifo = promisify(execFile);

async function rock(root: string) {
	const opened: { op: string; path: string }[] = [];
	return {
		opened,
		options: {
			root,
			board: "rock-5b-plus" as const,
			trace: (event: { op: string; path: string }) => opened.push(event),
		},
	};
}

describe("usb helper reads", () => {
	it("keeps J11, the rebind marker and a stored 20, and drops everything else", async () => {
		const root = await mkdtemp(join(tmpdir(), "ceraui-usb-helper-"));
		try {
			const port = join(root, "sys/class/typec/port0");
			const partner = join(root, "sys/class/typec/port0-partner");
			await mkdir(port, { recursive: true });
			await mkdir(partner, { recursive: true });
			await writeFile(join(port, "power_role"), `[source] sink ${IMEI}\n`);
			await writeFile(join(port, "data_role"), "host [host] device\n");
			await writeFile(join(partner, "identity"), `${SERIAL}\n`);
			const decoy = join(root, "sys/class/regulator/regulator.0");
			const vbus = join(root, "sys/class/regulator/regulator.1");
			await mkdir(decoy, { recursive: true });
			await mkdir(vbus, { recursive: true });
			await writeFile(join(decoy, "name"), "other\n");
			await writeFile(join(decoy, "state"), `${IMEI}\n`);
			await writeFile(join(vbus, "name"), "vbus5v0_typec\n");
			await writeFile(join(vbus, "state"), "enabled\n");
			const run = join(root, "run/ceralive-typec");
			await mkdir(run, { recursive: true });
			await writeFile(join(run, "reprobe"), "recovered 1710000000\n");
			await writeFile(join(run, "rearm"), "2\n");
			const marks = join(root, "run/ceralive/modem-usbspeed");
			await mkdir(marks, { recursive: true });
			await writeFile(
				join(marks, "4-1.json"),
				JSON.stringify({
					phase: "verified",
					original: "312",
					unit: IMEI,
					model: `RM520 ${SERIAL}`,
					port_paths: [`pci-${SERIAL}`],
					pid: 44,
				}),
			);
			await writeFile(
				join(marks, "notes.json"),
				JSON.stringify({ phase: "verified", note: IMEI }),
			);
			const traced = await rock(root);
			const helper = await readUsbHelper({
				...traced.options,
				kernelKeys: new Map([["4-1", "replacement"]]),
			});
			expect(
				traced.opened.filter(
					(event) => event.op !== "stat" && event.path.startsWith(partner),
				),
			).toEqual([]);
			expect(
				traced.opened.some(
					(event) => event.op === "stat" && event.path === partner,
				),
			).toBe(true);
			expect(helper.typec).toEqual({
				powerRole: "source",
				dataRole: "host",
				partner: true,
				vbus: "on",
			});
			expect(helper.reprobe).toEqual({ outcome: "recovered", rearm: 2 });
			expect(helper.holds).toEqual([
				{ key: null, stored: "20", outcome: "verified" },
			]);
			const encoded = JSON.stringify(helper);
			expect(encoded).not.toContain(IMEI);
			expect(encoded).not.toContain(SERIAL);
			expect(encoded).not.toContain("312");
			expect(encoded).not.toContain("4-1");
			expect(encoded).not.toContain("pci-");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("hides a marker that is not one of the known lines", async () => {
		const root = await mkdtemp(join(tmpdir(), "ceraui-usb-helper-"));
		try {
			const run = join(root, "run/ceralive-typec");
			await mkdir(run, { recursive: true });
			await writeFile(join(run, "reprobe"), `recovered ${IMEI}\n`);
			await writeFile(join(run, "rearm"), "9\n");
			const marks = join(root, "run/ceralive/modem-usbspeed");
			await mkdir(marks, { recursive: true });
			await writeFile(
				join(marks, "1-1.json"),
				JSON.stringify({ phase: "custom", original: "20", reason: IMEI }),
			);
			const helper = await readUsbHelper({ root });
			expect(helper).toEqual({ typec: null, reprobe: null, holds: [] });
			expect(JSON.stringify(helper)).not.toContain(IMEI);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("reports a stored 20 that was not reset, and no partner", async () => {
		const root = await mkdtemp(join(tmpdir(), "ceraui-usb-helper-"));
		try {
			const port = join(root, "sys/class/typec/port0");
			await mkdir(port, { recursive: true });
			await writeFile(join(port, "power_role"), "sink\n");
			await writeFile(join(port, "data_role"), "[device]\n");
			const vbus = join(root, "sys/class/regulator/regulator.3");
			await mkdir(vbus, { recursive: true });
			await writeFile(join(vbus, "name"), "vbus5v0_typec\n");
			await writeFile(join(vbus, "num_users"), "0\n");
			await mkdir(join(root, "run/ceralive-typec"), { recursive: true });
			await writeFile(join(root, "run/ceralive-typec/reprobe"), "no-partner\n");
			await mkdir(join(root, "run/ceralive/modem-usbspeed"), {
				recursive: true,
			});
			await writeFile(
				join(root, "run/ceralive/modem-usbspeed/2-1.json"),
				JSON.stringify({ phase: "stored-no-reset", original: "20" }),
			);
			const helper = await readUsbHelper({
				root,
				board: "rock-5b-plus",
			});
			expect(helper.typec).toMatchObject({
				powerRole: "sink",
				dataRole: "device",
				partner: false,
				vbus: "unknown",
			});
			expect(helper.reprobe).toEqual({ outcome: "no-partner", rearm: null });
			expect(helper.holds).toEqual([
				{ key: null, stored: "20", outcome: "stored-no-reset" },
			]);
			const elsewhere = await readUsbHelper({ root, board: "generic" });
			expect(elsewhere.typec).toBeNull();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("leaves a hold unassigned when a replacement sits at the returned address", async () => {
		const root = await mkdtemp(join(tmpdir(), "ceraui-usb-helper-"));
		try {
			const marks = join(root, "run/ceralive/modem-usbspeed");
			await mkdir(marks, { recursive: true });
			await writeFile(
				join(marks, "4-1.json"),
				JSON.stringify({
					phase: "verified",
					original: "312",
					model: "RM520N-GL",
					returned_as: "1-1",
					unit: IMEI,
				}),
			);
			const sameModel = await readUsbHelper({
				root,
				kernelKeys: new Map([
					["4-1", "old-address"],
					["1-1", "replacement-same-model"],
				]),
			});
			expect(sameModel.holds).toEqual([
				{ key: null, stored: "20", outcome: "verified" },
			]);
			const encoded = JSON.stringify(sameModel);
			expect(encoded).not.toContain("replacement-same-model");
			expect(encoded).not.toContain("old-address");
			expect(encoded).not.toContain("1-1");
			expect(encoded).not.toContain("4-1");
			expect(encoded).not.toContain(IMEI);
			expect(encoded).not.toContain("RM520N-GL");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("does not follow a marker symlink or open a marker FIFO", async () => {
		const root = await mkdtemp(join(tmpdir(), "ceraui-usb-helper-"));
		try {
			const marks = join(root, "run/ceralive/modem-usbspeed");
			await mkdir(marks, { recursive: true });
			const secret = join(root, "secret.json");
			await writeFile(
				secret,
				JSON.stringify({ phase: "verified", original: "20", unit: IMEI }),
			);
			await symlink(secret, join(marks, "5-1.json"));
			await mkfifo("mkfifo", [join(marks, "6-1.json")]);
			const helper = await readUsbHelper({
				root,
				kernelKeys: new Map([["5-1", "followed"]]),
			});
			expect(helper.holds).toEqual([]);
			expect(JSON.stringify(helper)).not.toContain(IMEI);
			expect(JSON.stringify(helper)).not.toContain("followed");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
