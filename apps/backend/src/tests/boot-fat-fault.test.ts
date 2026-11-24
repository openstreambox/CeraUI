import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BOOT_FAT_FAULT_KEY,
	BOOT_FAT_FAULT_MESSAGE,
	BOOT_FAT_FAULT_NOTICE,
	type BootFatFault,
	bootFatFaultDetail,
	createBootFatFaultMonitor,
	readBootFatFault,
} from "../modules/system/boot-fat-fault.ts";

// The checker's exact output for a lost cluster and for its own fault.
const LOST_CLUSTER =
	"Shared /boot FAT check needs attention: read-only fsck.fat reported filesystem diagnostics (exit 1)\n";
const CHECKER_FAULT =
	"Shared /boot FAT check needs attention: [Errno 16] Device or resource busy: '/dev/disk/by-partlabel/boot'\n";

let dir: string;
beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "boot-fat-fault-"));
});
afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});
async function marker(name: string, contents: string | Uint8Array) {
	const path = join(dir, name);
	await writeFile(path, contents);
	return path;
}

test("a lost-cluster marker reads as present with the checker's line", async () => {
	expect(await readBootFatFault(await marker("lost", LOST_CLUSTER))).toEqual({
		state: "present",
		detail: LOST_CLUSTER.trimEnd(),
	});
	expect(await readBootFatFault(await marker("busy", CHECKER_FAULT))).toEqual({
		state: "present",
		detail: CHECKER_FAULT.trimEnd(),
	});
});

test("no marker, or no /run/ceralive directory, reads as absent", async () => {
	expect(await readBootFatFault(join(dir, "missing"))).toEqual({
		state: "absent",
	});
	const file = await marker("plain-file", "x");
	expect(await readBootFatFault(join(file, "boot-fat-fault"))).toEqual({
		state: "absent",
	});
});

test("an unreadable marker keeps only the errno code", async () => {
	expect(await readBootFatFault(dir)).toEqual({
		state: "unreadable",
		code: "EISDIR",
	});
	// Root reads any mode, so the permission case only exists for other users.
	if (process.getuid?.() !== 0) {
		const locked = await marker("locked", LOST_CLUSTER);
		await chmod(locked, 0o000);
		expect(await readBootFatFault(locked)).toEqual({
			state: "unreadable",
			code: "EACCES",
		});
	}
});

test("garbage is still a marker, but none of its contents are kept", async () => {
	const cases: Array<string | Uint8Array> = [
		"",
		"\n",
		"something else entirely\n",
		"Shared /boot FAT check needs attention: \n",
		"Shared /boot FAT check needs attention: two\nlines\n",
		"Shared /boot FAT check needs attention: bell\u0007\n",
		"Shared /boot FAT check needs attention: \u202eoverride\n",
		`Shared /boot FAT check needs attention: ${"x".repeat(600)}\n`,
		`Shared /boot FAT check needs attention: ${"x".repeat(5000)}\n`,
		new Uint8Array([0xff, 0xfe, 0x00, 0x53]),
	];
	for (const [index, contents] of cases.entries()) {
		const fault = await readBootFatFault(
			await marker(`garbage-${index}`, contents),
		);
		expect(fault).toEqual({ state: "present", detail: null });
	}
	expect(bootFatFaultDetail(new TextEncoder().encode(LOST_CLUSTER))).toBe(
		LOST_CLUSTER.trimEnd(),
	);
});

function harness(initial: BootFatFault, bootId: string | null = "b1") {
	let fault = initial;
	let accept = true;
	const shown: Array<string | undefined> = [];
	let removed = 0;
	const tick = createBootFatFaultMonitor({
		read: async () => fault,
		bootId: () => bootId ?? undefined,
		show: (key) => {
			shown.push(key);
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
		refuse() {
			accept = false;
		},
		allow() {
			accept = true;
		},
		get shown() {
			return shown;
		},
		get removed() {
			return removed;
		},
	};
}

test("a marker present at start raises one notice, dismissable for this boot only", async () => {
	const h = harness({ state: "present", detail: LOST_CLUSTER.trimEnd() });
	await h.tick();
	await h.tick();
	expect(h.shown).toEqual([`${BOOT_FAT_FAULT_NOTICE}:b1`]);
	expect(h.removed).toBe(0);
});

test("no marker raises nothing and removes nothing", async () => {
	const h = harness({ state: "absent" });
	await h.tick();
	await h.tick();
	expect(h.shown).toEqual([]);
	expect(h.removed).toBe(0);
});

test("unreadable and garbage markers still raise the notice", async () => {
	for (const fault of [
		{ state: "unreadable", code: "EIO" },
		{ state: "present", detail: null },
	] as const) {
		const h = harness(fault);
		await h.tick();
		expect(h.shown).toHaveLength(1);
	}
});

test("a marker written after start raises the notice, and a later clean check removes it", async () => {
	const h = harness({ state: "absent" });
	await h.tick();
	h.set({ state: "present", detail: CHECKER_FAULT.trimEnd() });
	await h.tick();
	expect(h.shown).toEqual([`${BOOT_FAT_FAULT_NOTICE}:b1`]);
	h.set({ state: "absent" });
	await h.tick();
	await h.tick();
	expect(h.removed).toBe(1);
	h.set({ state: "present", detail: null });
	await h.tick();
	expect(h.shown).toHaveLength(2);
});

test("a notice that was not taken is offered again on the next poll", async () => {
	const h = harness({ state: "present", detail: null });
	h.refuse();
	await h.tick();
	h.allow();
	await h.tick();
	await h.tick();
	expect(h.shown).toHaveLength(2);
});

test("without a boot ID the notice carries no durable dismissal", async () => {
	const h = harness({ state: "present", detail: null }, null);
	await h.tick();
	expect(h.shown).toEqual([undefined]);
});

test("the notice copy is calm and names its catalog key", () => {
	expect(BOOT_FAT_FAULT_KEY).toBe("notifications.bootFatFault");
	expect(BOOT_FAT_FAULT_MESSAGE).toContain("started normally");
	expect(BOOT_FAT_FAULT_MESSAGE).toContain("Nothing to do now");
	expect(BOOT_FAT_FAULT_MESSAGE).not.toMatch(/live|error|fail|corrupt/i);
});
