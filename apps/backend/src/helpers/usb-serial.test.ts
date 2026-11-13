import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	identifyUsbSerial,
	readUsbSerialChunk,
	resolveUsbSerial,
	type UsbSerialPaths,
} from "./usb-serial.ts";

let root: string, unit: string, other: string, paths: UsbSerialPaths;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "serial-identity-"));
	paths = {
		ttyRoot: join(root, "tty"),
		devRoot: join(root, "dev"),
		bootId: join(root, "boot-id"),
	};
	await mkdir(paths.ttyRoot);
	await writeFile(paths.bootId, "00000000-0000-0000-0000-000000000001\n");
	unit = join(root, "unit");
	other = join(root, "other");
	for (const dir of [unit, other]) {
		await mkdir(join(dir, "usb:1.2"), { recursive: true });
		await writeFile(join(dir, "usb:1.2", "bInterfaceNumber"), "02\n");
		await writeFile(join(dir, "busnum"), "1\n");
		await writeFile(join(dir, "devnum"), "9\n");
	}
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});
async function alias(name: string, device: string) {
	await mkdir(join(paths.ttyRoot, name));
	await symlink(join(device, "usb:1.2"), join(paths.ttyRoot, name, "device"));
}
test("USB-interface identity follows a renamed tty and refuses an old alias reused by another unit", async () => {
	await alias("ttyUSB7", unit);
	const identity = await identifyUsbSerial("ttyUSB7", unit, paths);
	if (!identity) throw new Error("Fixture identity");
	await rm(join(paths.ttyRoot, "ttyUSB7"), { recursive: true });
	await alias("ttyUSB7", other);
	await alias("ttyUSB11", unit);
	expect(await resolveUsbSerial(identity, paths)).toBe(
		join(paths.devRoot, "ttyUSB11"),
	);
});
test("an ambiguous alias or changed USB generation cannot open a serial path", async () => {
	await alias("ttyUSB7", unit);
	const identity = await identifyUsbSerial("ttyUSB7", unit, paths);
	if (!identity) throw new Error("Fixture identity");
	await alias("ttyUSB8", unit);
	expect(await resolveUsbSerial(identity, paths)).toBeUndefined();
	await rm(join(paths.ttyRoot, "ttyUSB8"), { recursive: true });
	await writeFile(join(unit, "devnum"), "10\n");
	expect(await resolveUsbSerial(identity, paths)).toBeUndefined();
});
test("nonblocking serial EAGAIN means no bytes yet; device loss still throws", () => {
	const spy = spyOn(fs, "readSync");
	const buffer = Buffer.alloc(64);
	try {
		spy.mockImplementationOnce(() => {
			throw Object.assign(new Error("not ready"), { code: "EAGAIN" });
		});
		expect(readUsbSerialChunk(-1, buffer)).toBe(0);
		spy.mockImplementationOnce(() => {
			throw Object.assign(new Error("gone"), { code: "EIO" });
		});
		expect(() => readUsbSerialChunk(-1, buffer)).toThrow("gone");
	} finally {
		spy.mockRestore();
	}
});
