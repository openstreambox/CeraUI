import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BOOT_FAT_FAULT_KEY,
	BOOT_FAT_FAULT_MESSAGE,
	type BootFatFault,
	classifyBootFatFault,
	createBootFatFaultMonitor,
	readBootFatFault,
} from "../modules/system/boot-fat-fault.ts";

const PREFIX = "Shared /boot FAT check needs attention: ";
// The checker's exact lines for a lost cluster and for its own faults.
const LOST_CLUSTER = `${PREFIX}read-only fsck.fat reported filesystem diagnostics (exit 1)\n`;
const BUSY = `${PREFIX}[Errno 16] Device or resource busy: '/dev/disk/by-partlabel/boot'\n`;

let dir: string;
beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "boot-fat-fault-"));
});
afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});
let count = 0;
async function marker(contents: string | Uint8Array) {
	const path = join(dir, `marker-${count++}`);
	await writeFile(path, contents);
	return path;
}
const encode = (text: string) => new TextEncoder().encode(text);

test("a lost-cluster marker reads as present with its fsck reason and exit status", async () => {
	expect(await readBootFatFault(await marker(LOST_CLUSTER))).toEqual({
		state: "present",
		reason: "fsck_findings",
		exit: 1,
		errno: null,
	});
});

test("every checker reason maps to a code, and OS errors keep only the errno name", () => {
	const cases: Array<[string, Partial<BootFatFault>]> = [
		["invalid FAT boot sector", { reason: "boot_sector" }],
		["unexpected FAT geometry", { reason: "geometry" }],
		["unexpected FAT16 cluster count", { reason: "fat16_clusters" }],
		[
			"dirty report did not match the FAT geometry",
			{ reason: "dirty_geometry" },
		],
		["dirty byte did not match the read-only check", { reason: "dirty_byte" }],
		[
			"FAT table reports a dirty shutdown or an I/O error",
			{ reason: "fat_flags" },
		],
		["short write while clearing the dirty byte", { reason: "short_write" }],
		[
			"expected a block device or a regular FAT image",
			{ reason: "not_block_device" },
		],
		[
			"read-only fsck.fat status disagreed with its report (exit 0)",
			{ reason: "fsck_status_mismatch", exit: 0 },
		],
		[
			"Command '['/usr/sbin/fsck.fat', '-n', '/proc/self/fd/3']' timed out after 12 seconds",
			{ reason: "timeout" },
		],
		[
			"[Errno 16] Device or resource busy: '/dev/disk/by-partlabel/boot'",
			{ reason: "os_error", errno: "EBUSY" },
		],
		[
			"[Errno 2] No such file or directory: '/usr/sbin/fsck.fat'",
			{ reason: "os_error", errno: "ENOENT" },
		],
	];
	for (const [reason, expected] of cases)
		expect(classifyBootFatFault(encode(`${PREFIX}${reason}\n`))).toEqual({
			state: "present",
			exit: null,
			errno: null,
			...expected,
		} as BootFatFault);
	// Nothing of the path or message survives classification.
	expect(JSON.stringify(classifyBootFatFault(encode(BUSY)))).not.toContain(
		"/dev",
	);
});

test("no marker, or no /run/ceralive directory, reads as absent", async () => {
	expect(await readBootFatFault(join(dir, "missing"))).toEqual({
		state: "absent",
	});
	const file = await marker("x");
	expect(await readBootFatFault(join(file, "boot-fat-fault"))).toEqual({
		state: "absent",
	});
});

test("an unreadable marker keeps only the errno name", async () => {
	const link = join(dir, "link");
	await symlink(await marker(LOST_CLUSTER), link);
	expect(await readBootFatFault(link)).toEqual({
		state: "unreadable",
		errno: "ELOOP",
	});
	// Root reads any mode, so the permission case only exists for other users.
	if (process.getuid?.() !== 0) {
		const locked = await marker(LOST_CLUSTER);
		await chmod(locked, 0o000);
		expect(await readBootFatFault(locked)).toEqual({
			state: "unreadable",
			errno: "EACCES",
		});
	}
});

test("a directory or a FIFO with no writer is reported without blocking", async () => {
	const fifo = join(dir, "fifo");
	execFileSync("mkfifo", [fifo]);
	const expected: BootFatFault = {
		state: "present",
		reason: "not_regular_file",
		exit: null,
		errno: null,
	};
	expect(await readBootFatFault(fifo)).toEqual(expected);
	expect(await readBootFatFault(dir)).toEqual(expected);
});

test("garbage is still a marker, but none of its contents are kept", async () => {
	const cases: Array<string | Uint8Array> = [
		"",
		"\n",
		"something else entirely\n",
		`${PREFIX}\n`,
		`${PREFIX}a new reason naming /media/card/boot.img\n`,
		`${PREFIX}invalid FAT boot sector\nsecond line\n`,
		`${PREFIX}[Errno x] not a number\n`,
		`${PREFIX}${"x".repeat(5000)}\n`,
		new Uint8Array([0xff, 0xfe, 0x00, 0x53]),
	];
	for (const contents of cases)
		expect(await readBootFatFault(await marker(contents))).toEqual({
			state: "present",
			reason: "unrecognized",
			exit: null,
			errno: null,
		});
});

function harness(initial: BootFatFault) {
	let fault = initial;
	let accept = true;
	let shown = 0;
	let removed = 0;
	const tick = createBootFatFaultMonitor({
		read: async () => fault,
		show: () => {
			shown++;
			return accept;
		},
		remove: () => {
			removed++;
		},
	});
	return {
		tick,
		set(next: BootFatFault) {
			fault = next;
		},
		accept(value: boolean) {
			accept = value;
		},
		get shown() {
			return shown;
		},
		get removed() {
			return removed;
		},
	};
}
const FAULT = classifyBootFatFault(encode(LOST_CLUSTER));

test("a marker present at start raises one notice", async () => {
	const h = harness(FAULT);
	await h.tick();
	await h.tick();
	expect(h.shown).toBe(1);
	expect(h.removed).toBe(0);
});

test("no marker raises nothing and removes nothing", async () => {
	const h = harness({ state: "absent" });
	await h.tick();
	await h.tick();
	expect(h.shown).toBe(0);
	expect(h.removed).toBe(0);
});

test("unreadable and garbage markers still raise the notice", async () => {
	for (const fault of [
		{ state: "unreadable", errno: "EIO" },
		classifyBootFatFault(encode("garbage")),
	] as const) {
		const h = harness(fault);
		await h.tick();
		expect(h.shown).toBe(1);
	}
});

test("a marker written after start raises the notice, and a later clean check removes it", async () => {
	const h = harness({ state: "absent" });
	await h.tick();
	h.set(FAULT);
	await h.tick();
	expect(h.shown).toBe(1);
	h.set({ state: "absent" });
	await h.tick();
	await h.tick();
	expect(h.removed).toBe(1);
	h.set(FAULT);
	await h.tick();
	expect(h.shown).toBe(2);
});

test("a notice that was not taken is offered again on the next poll", async () => {
	const h = harness(FAULT);
	h.accept(false);
	await h.tick();
	h.accept(true);
	await h.tick();
	await h.tick();
	expect(h.shown).toBe(2);
});

test("the notice copy is calm and names its catalog key", () => {
	expect(BOOT_FAT_FAULT_KEY).toBe("notifications.bootFatFault");
	expect(BOOT_FAT_FAULT_MESSAGE).toContain("started normally");
	expect(BOOT_FAT_FAULT_MESSAGE).toContain("Nothing to do now");
	expect(BOOT_FAT_FAULT_MESSAGE).not.toMatch(/live|error|fail|corrupt/i);
});
