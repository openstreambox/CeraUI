import {
	closeSync,
	constants,
	fstatSync,
	openSync,
	readSync,
	writeSync,
} from "node:fs";
import { readdir, readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { run } from "./run.ts";

export interface UsbSerialIdentity {
	readonly usbDevice: string;
	readonly usbInterface: string;
	readonly generation: string;
}
export interface UsbSerialPaths {
	readonly ttyRoot: string;
	readonly devRoot: string;
	readonly bootId: string;
}
const defaultPaths: UsbSerialPaths = {
	ttyRoot: "/sys/class/tty",
	devRoot: "/dev",
	bootId: "/proc/sys/kernel/random/boot_id",
};
async function interfaceFor(
	name: string,
	paths: UsbSerialPaths,
): Promise<string | undefined> {
	if (!/^tty(?:USB|ACM)\d+$/.test(name)) return undefined;
	let path = await realpath(join(paths.ttyRoot, name, "device"));
	while (path !== dirname(path)) {
		try {
			await readFile(join(path, "bInterfaceNumber"));
			return path;
		} catch (error) {
			if (
				!(error instanceof Error && "code" in error && error.code === "ENOENT")
			)
				throw error;
		}
		path = dirname(path);
	}
	return undefined;
}
export async function usbGeneration(
	usbDevice: string,
	bootId: string = defaultPaths.bootId,
): Promise<string> {
	const [bus, device, boot] = await Promise.all([
		readFile(join(usbDevice, "busnum"), "utf8"),
		readFile(join(usbDevice, "devnum"), "utf8"),
		readFile(bootId, "utf8"),
	]);
	if (
		!/^\d+\s*$/.test(bus) ||
		!/^\d+\s*$/.test(device) ||
		!/^[a-f0-9-]+\s*$/.test(boot)
	)
		throw new Error("Unreadable USB generation");
	return `${boot.trim()}:${bus.trim()}:${device.trim()}`;
}
/** A reported candidate establishes the USB interface, never a remembered tty alias. */
export async function identifyUsbSerial(
	name: string,
	usbDevice: string,
	paths: UsbSerialPaths = defaultPaths,
): Promise<UsbSerialIdentity | undefined> {
	const path = await interfaceFor(name, paths);
	if (!path || dirname(path) !== usbDevice) return undefined;
	const number = (await readFile(join(path, "bInterfaceNumber"), "utf8"))
		.trim()
		.toLowerCase();
	if (!/^[a-f0-9]{2}$/.test(number)) return undefined;
	return {
		usbDevice,
		usbInterface: number,
		generation: await usbGeneration(usbDevice, paths.bootId),
	};
}
export async function resolveUsbSerial(
	identity: UsbSerialIdentity,
	paths: UsbSerialPaths = defaultPaths,
): Promise<string | undefined> {
	if (
		(await usbGeneration(identity.usbDevice, paths.bootId)) !==
		identity.generation
	)
		return undefined;
	const matches: string[] = [];
	for (const name of await readdir(paths.ttyRoot)) {
		try {
			const observed = await identifyUsbSerial(name, identity.usbDevice, paths);
			if (
				observed?.usbInterface === identity.usbInterface &&
				observed.generation === identity.generation
			)
				matches.push(join(paths.devRoot, name));
		} catch {
			/* A sibling endpoint may disappear while enumerating. */
		}
	}
	return matches.length === 1 ? matches[0] : undefined;
}
function retryable(error: unknown) {
	return (
		error instanceof Error &&
		"code" in error &&
		(error.code === "EAGAIN" || error.code === "EWOULDBLOCK")
	);
}
export function readUsbSerialChunk(fd: number, buffer: Buffer): number {
	try {
		return readSync(fd, buffer);
	} catch (error) {
		if (retryable(error)) return 0;
		throw error;
	}
}
/** The caller owns protocol and exclusion. This helper only exchanges bounded lines. */
export async function exchangeUsbSerial(
	identity: UsbSerialIdentity,
	command: string,
	valid: () => Promise<boolean>,
	signal?: AbortSignal,
): Promise<string> {
	if (!command || command.length > 256 || /[\r\n\0]/.test(command))
		throw new Error("Invalid serial request");
	const port = await resolveUsbSerial(identity);
	if (!port || !(await valid())) throw new Error("Serial identity changed");
	const fd = openSync(
		port,
		constants.O_RDWR |
			constants.O_NOCTTY |
			constants.O_NONBLOCK |
			constants.O_NOFOLLOW,
	);
	try {
		if (!fstatSync(fd).isCharacterDevice())
			throw new Error("Invalid serial endpoint");
		// Anchor termios setup to the open descriptor so tty alias reuse cannot retarget it.
		await run(
			"stty",
			[
				"-F",
				`/proc/${process.pid}/fd/${fd}`,
				"115200",
				"raw",
				"-echo",
				"clocal",
				"cread",
			],
			{ timeout: 5000, maxBuffer: 4096, ...(signal ? { signal } : {}) },
		);
		const scratch = Buffer.alloc(4096);
		let drained = 0;
		while (drained < 65536) {
			try {
				const count = readUsbSerialChunk(fd, scratch);
				if (!count) break;
				drained += count;
			} catch (error) {
				if (retryable(error)) break;
				throw error;
			}
		}
		if (
			drained >= 65536 ||
			signal?.aborted ||
			!(await valid()) ||
			(await usbGeneration(identity.usbDevice)) !== identity.generation
		)
			throw new Error("Serial admission lost");
		const request = Buffer.from(`${command}\r`);
		const end = performance.now() + 40_000;
		let sent = 0;
		while (sent < request.length) {
			if (performance.now() >= end || signal?.aborted)
				throw new Error("Serial request timed out");
			try {
				sent += writeSync(fd, request, sent, request.length - sent);
			} catch (error) {
				if (!retryable(error)) throw error;
				await delay(50, undefined, { signal });
			}
		}
		let reply = "";
		while (performance.now() < end && !signal?.aborted) {
			try {
				const count = readUsbSerialChunk(fd, scratch);
				if (count) reply += scratch.subarray(0, count).toString("ascii");
			} catch (error) {
				if (!retryable(error)) throw error;
			}
			if (reply.length > 65536)
				throw new Error("Serial response exceeds limit");
			if (
				/(?:^|\r?\n)(?:ERROR|\+CME ERROR:[^\r\n]*|\+CMS ERROR:[^\r\n]*)\r?\n/.test(
					reply,
				)
			)
				throw new Error("Serial request rejected");
			if (/\r?\nOK\r?\n/.test(reply)) {
				if (
					!(await valid()) ||
					(await usbGeneration(identity.usbDevice)) !== identity.generation
				)
					throw new Error("Serial response from retired generation");
				return reply;
			}
			await delay(50, undefined, { signal });
		}
		throw new Error("Serial response timed out");
	} finally {
		closeSync(fd);
	}
}
