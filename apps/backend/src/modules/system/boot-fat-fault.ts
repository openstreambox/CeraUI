/**
 * The image's `/boot` FAT fault marker, as a support signal.
 *
 * The image-building-pipeline boot checker (`check-boot-fat.py`, run once per
 * boot before `boot.mount`) writes `/run/ceralive/boot-fat-fault` when the
 * shared FAT boot partition reports damage it does not repair (for example lost
 * clusters) or when the check itself fails. The box still boots and mounts
 * `/boot`. A later clean check removes the marker, and `/run` starts empty on
 * every boot. The file holds one line, root-owned and mode 0644:
 *
 *   Shared /boot FAT check needs attention: <reason>
 *
 * CeraUI shows one calm, dismissable notice while the marker exists, and the
 * support bundle records which of the checker's known reasons it names. No text
 * from the file is ever copied: a reason can carry a device path or anything an
 * OS error says. Nothing here writes to the device.
 */
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { constants as os } from "node:os";
import { shouldUseMocks } from "../../mocks/index.ts";
import { notificationRemove, notificationSend } from "../ui/notifications.ts";

export const BOOT_FAT_FAULT_PATH = "/run/ceralive/boot-fat-fault";
export const BOOT_FAT_FAULT_NOTICE = "boot-fat-fault";
export const BOOT_FAT_FAULT_KEY = "notifications.bootFatFault";
export const BOOT_FAT_FAULT_MESSAGE =
	"The box started normally. Its startup files need a check at the next service visit. Nothing to do now.";
const PREFIX = "Shared /boot FAT check needs attention: ";
const MAX_READ_BYTES = 4096;
const POLL_MS = 30_000;

/** The checker's fixed messages (check-boot-fat.py), one code each. */
const FIXED_REASONS = {
	"invalid FAT boot sector": "boot_sector",
	"unexpected FAT geometry": "geometry",
	"unexpected FAT16 cluster count": "fat16_clusters",
	"dirty report did not match the FAT geometry": "dirty_geometry",
	"dirty byte did not match the read-only check": "dirty_byte",
	"FAT table reports a dirty shutdown or an I/O error": "fat_flags",
	"short write while clearing the dirty byte": "short_write",
	"expected a block device or a regular FAT image": "not_block_device",
} as const;

export type BootFatFaultReason =
	| (typeof FIXED_REASONS)[keyof typeof FIXED_REASONS]
	/** fsck.fat -n reported findings the checker does not repair (lost clusters). */
	| "fsck_findings"
	| "fsck_status_mismatch"
	| "timeout"
	| "os_error"
	| "not_regular_file"
	/** Not in any form the checker writes. */
	| "unrecognized";

export type BootFatFault =
	| { readonly state: "absent" }
	| {
			readonly state: "present";
			readonly reason: BootFatFaultReason;
			/** fsck.fat's exit status, for the two fsck reasons. */
			readonly exit: number | null;
			/** The errno name of an OS error, never its message or path. */
			readonly errno: string | null;
	  }
	| { readonly state: "unreadable"; readonly errno: string };

const ERRNO_NAMES = new Map<number, string>(
	Object.entries(os.errno).map(([name, value]) => [value, name]),
);

function errnoName(error: unknown): string {
	const code = (error as NodeJS.ErrnoException | null)?.code;
	return typeof code === "string" && /^E[A-Z0-9]{1,15}$/.test(code)
		? code
		: "unknown";
}

function present(
	reason: BootFatFaultReason,
	exit: number | null = null,
	errno: string | null = null,
): BootFatFault {
	return { state: "present", reason, exit, errno };
}

/** Classifies the marker's bytes into a closed set of codes. */
export function classifyBootFatFault(bytes: Uint8Array): BootFatFault {
	if (bytes.byteLength > MAX_READ_BYTES) return present("unrecognized");
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return present("unrecognized");
	}
	const line = text.endsWith("\n") ? text.slice(0, -1) : text;
	if (!line.startsWith(PREFIX) || line.includes("\n"))
		return present("unrecognized");
	const reason = line.slice(PREFIX.length);
	const fixed = FIXED_REASONS[reason as keyof typeof FIXED_REASONS];
	if (fixed) return present(fixed);
	const fsck =
		/^read-only fsck\.fat (reported filesystem diagnostics|status disagreed with its report) \(exit (-?\d{1,3})\)$/.exec(
			reason,
		);
	if (fsck?.[1] && fsck[2])
		return present(
			fsck[1].startsWith("reported") ? "fsck_findings" : "fsck_status_mismatch",
			Number(fsck[2]),
		);
	if (/^Command '.*' timed out after [\d.]+ seconds$/.test(reason))
		return present("timeout");
	const errno = /^\[Errno (\d{1,4})\] /.exec(reason)?.[1];
	if (errno)
		return present(
			"os_error",
			null,
			ERRNO_NAMES.get(Number(errno)) ?? "unknown",
		);
	return present("unrecognized");
}

/** The marker path; `CERALIVE_BOOT_FAT_FAULT` points dev and E2E runs elsewhere. */
export function bootFatFaultPath(): string {
	return process.env.CERALIVE_BOOT_FAT_FAULT || BOOT_FAT_FAULT_PATH;
}

export async function readBootFatFault(
	path: string = bootFatFaultPath(),
): Promise<BootFatFault> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		// Non-blocking and no symlinks: a FIFO or device at the path must never
		// stall the poll or a support-bundle preparation.
		handle = await open(
			path,
			constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
		);
		if (!(await handle.stat()).isFile()) return present("not_regular_file");
		// One byte past the limit tells an oversized file from a full one.
		const buffer = new Uint8Array(MAX_READ_BYTES + 1);
		let length = 0;
		while (length < buffer.byteLength) {
			const { bytesRead } = await handle.read(
				buffer,
				length,
				buffer.byteLength - length,
				length,
			);
			if (bytesRead === 0) break;
			length += bytesRead;
		}
		return classifyBootFatFault(buffer.subarray(0, length));
	} catch (error) {
		const errno = errnoName(error);
		// ENOTDIR: /run/ceralive is not a directory, so the marker cannot exist.
		if (errno === "ENOENT" || errno === "ENOTDIR") return { state: "absent" };
		return { state: "unreadable", errno };
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

export interface BootFatFaultMonitorDeps {
	readonly read: () => Promise<BootFatFault>;
	/** False when the notice was not taken (for example the store was busy). */
	readonly show: () => boolean;
	readonly remove: () => void;
}

const defaultDeps: BootFatFaultMonitorDeps = {
	read: () => readBootFatFault(),
	show: () =>
		notificationSend(
			undefined,
			BOOT_FAT_FAULT_NOTICE,
			"warning",
			BOOT_FAT_FAULT_MESSAGE,
			0,
			true,
			true,
			true,
			BOOT_FAT_FAULT_KEY,
		) !== false,
	remove: () => {
		notificationRemove(BOOT_FAT_FAULT_NOTICE);
	},
};

/**
 * One reconciliation step. The notice is raised when the marker exists in any
 * form, because only the checker writes there; an unreadable or unexpected
 * file still means it recorded something. A dismissal is not stored: it holds
 * while this backend runs, and a fault still there after a restart or the
 * next boot is shown again. That keeps per-boot keys out of the shared
 * dismissal store.
 */
export function createBootFatFaultMonitor(
	deps: BootFatFaultMonitorDeps = defaultDeps,
) {
	let shown = false;
	return async function tick(): Promise<BootFatFault> {
		const fault = await deps.read();
		if (fault.state === "absent") {
			if (shown) deps.remove();
			shown = false;
			return fault;
		}
		if (!shown) shown = deps.show();
		return fault;
	};
}

let started = false;
/**
 * The checker runs before CeraUI on a normal boot, but a manual rerun of its
 * unit can add or clear the marker later, so the file is polled. A failed read
 * never stops the poll.
 */
export function initBootFatFaultMonitoring(
	deps: BootFatFaultMonitorDeps = defaultDeps,
): void {
	// A dev host has no image marker; under mocks only an explicit test path is read.
	if (started || (shouldUseMocks() && !process.env.CERALIVE_BOOT_FAT_FAULT))
		return;
	started = true;
	const tick = createBootFatFaultMonitor(deps);
	const run = async () => {
		try {
			await tick();
		} catch {
			// A notification or transport failure must not stop the poll.
		}
		setTimeout(() => {
			void run();
		}, POLL_MS).unref();
	};
	void run();
}
