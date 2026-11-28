import { spyOn } from "bun:test";
import fs from "node:fs";
import { basename, dirname, join } from "node:path";

export const bondStorageFaults = [
	"none",
	"unwritable-dir",
	"read-only-file",
	"ENOSPC",
	"EISDIR",
	"EIO",
	"final-rename",
	"once-fsync",
] as const;
export type BondStorageFault = (typeof bondStorageFaults)[number];

// The atomic config writer names its stage with a random part before the pid.
export const isConfigStage = (file: string, path: unknown) =>
	typeof path === "string" &&
	dirname(path) === dirname(file) &&
	basename(path).startsWith(`.${basename(file)}.`) &&
	basename(path).endsWith(`.${process.pid}.tmp`);

/** Every stage file left next to the config, or null when there is none. */
export function configStageSnapshot(file: string) {
	const stages = fs
		.readdirSync(dirname(file))
		.map((name) => join(dirname(file), name))
		.filter((path) => isConfigStage(file, path))
		.sort();
	return stages.length === 0 ? null : stages.map(configFileSnapshot);
}

/** Replace each stage path in a frame with a fixed token. */
export function maskConfigStage(file: string, text: string): string {
	return text
		.split(/([^\s"']+)/)
		.map((part) => (isConfigStage(file, part) ? "<stage>" : part))
		.join("");
}

class InjectedConfigFault extends Error {
	constructor(code: string, operation: string) {
		super(`${code}: injected config ${operation} failure`);
	}
}

// Leave the production writer intact. Scope faults and recorded calls to its
// actual temp file and fd; never affect unrelated filesystem traffic.
export function watchConfigWrite(file: string, fault: BondStorageFault) {
	const isTemp = (path: unknown) => isConfigStage(file, path);
	if (fault === "unwritable-dir") fs.chmodSync(dirname(file), 0o500);
	if (fault === "read-only-file") fs.chmodSync(file, 0o444);
	if (fault === "EISDIR") {
		fs.renameSync(file, `${file}.original`);
		fs.mkdirSync(file);
	}
	const steps: string[] = [];
	let fd: number | undefined;
	let fsyncs = 0;
	const {
		openSync,
		writeFileSync,
		fsyncSync,
		closeSync,
		renameSync,
		unlinkSync,
	} = fs;
	const open = spyOn(fs, "openSync").mockImplementation((path, flags, mode) => {
		if (!isTemp(path)) return openSync(path, flags, mode);
		steps.push("open");
		fd = openSync(path, flags, mode);
		return fd;
	});
	const write = spyOn(fs, "writeFileSync").mockImplementation(
		(path, data, opts) => {
			if (typeof path === "number" && path === fd) {
				steps.push(`write:${Buffer.byteLength(data)}`);
				// A cap that accepts the old full serialization, but not the new
				// opt-out. An old-payload-only dry run does not reproduce it.
				if (fault === "ENOSPC" && Buffer.byteLength(data) > cap)
					throw new InjectedConfigFault("ENOSPC", "write");
				if (fault === "EIO") {
					const bytes =
						typeof data === "string"
							? Buffer.from(data)
							: new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
					writeFileSync(path, bytes.subarray(0, 8));
					throw new InjectedConfigFault("EIO", "torn write");
				}
			}
			writeFileSync(path, data, opts);
		},
	);
	const sync = spyOn(fs, "fsyncSync").mockImplementation((active) => {
		if (active === fd) {
			steps.push("fsync");
			if (++fsyncs === 1 && fault === "once-fsync")
				throw new InjectedConfigFault("EIO", "fsync");
		}
		fsyncSync(active);
	});
	const close = spyOn(fs, "closeSync").mockImplementation((active) => {
		if (active === fd) {
			steps.push("close");
			fd = undefined;
		}
		closeSync(active);
	});
	const rename = spyOn(fs, "renameSync").mockImplementation((from, to) => {
		if (isTemp(from) && to === file) {
			steps.push("rename");
			if (fault === "final-rename")
				throw new InjectedConfigFault("EIO", "final rename");
		}
		renameSync(from, to);
	});
	const unlink = spyOn(fs, "unlinkSync").mockImplementation((path) => {
		if (isTemp(path)) steps.push("unlink");
		unlinkSync(path);
	});
	const cap = fault === "ENOSPC" ? fs.statSync(file).size : Infinity;
	return {
		steps,
		restore() {
			for (const spy of [open, write, sync, close, rename, unlink])
				spy.mockRestore();
			if (fault === "unwritable-dir") fs.chmodSync(dirname(file), 0o700);
		},
	};
}

export function configFileSnapshot(file: string) {
	const stat = fs.statSync(file, { throwIfNoEntry: false });
	if (!stat) return null;
	return stat.isDirectory()
		? { mode: stat.mode, directory: true }
		: { mode: stat.mode, bytes: fs.readFileSync(file).toString("base64") };
}
