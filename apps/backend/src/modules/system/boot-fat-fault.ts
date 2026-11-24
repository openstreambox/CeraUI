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
 * CeraUI shows one calm, dismissable notice while the marker exists and copies
 * its line into the support bundle. Nothing here writes to the device.
 */
import { open } from "node:fs/promises";
import { shouldUseMocks } from "../../mocks/index.ts";
import { currentBootId } from "../device-logs/boot-id.ts";
import { notificationRemove, notificationSend } from "../ui/notifications.ts";

export const BOOT_FAT_FAULT_PATH = "/run/ceralive/boot-fat-fault";
export const BOOT_FAT_FAULT_NOTICE = "boot-fat-fault";
export const BOOT_FAT_FAULT_KEY = "notifications.bootFatFault";
export const BOOT_FAT_FAULT_MESSAGE =
	"The box started normally. Its startup files need a check at the next service visit. Nothing to do now.";
/** The checker's own wording; anything else is kept out of the bundle text. */
export const BOOT_FAT_FAULT_PREFIX = "Shared /boot FAT check needs attention: ";
const MAX_READ_BYTES = 4096;
const MAX_DETAIL_CHARS = 512;
const POLL_MS = 30_000;

export type BootFatFault =
	| { readonly state: "absent" }
	| {
			readonly state: "present";
			/** The checker's line, or null when the file is not in its format. */
			readonly detail: string | null;
	  }
	| { readonly state: "unreadable"; readonly code: string };

function errnoCode(error: unknown): string {
	const code = (error as NodeJS.ErrnoException | null)?.code;
	return typeof code === "string" && /^E[A-Z0-9]{1,15}$/.test(code)
		? code
		: "unknown";
}

/** The checker's line when the bytes are exactly that, otherwise null. */
export function bootFatFaultDetail(bytes: Uint8Array): string | null {
	if (bytes.byteLength > MAX_READ_BYTES) return null;
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return null;
	}
	const line = text.endsWith("\n") ? text.slice(0, -1) : text;
	if (
		!line.startsWith(BOOT_FAT_FAULT_PREFIX) ||
		line.length > MAX_DETAIL_CHARS ||
		line.length === BOOT_FAT_FAULT_PREFIX.length ||
		// One printable line: no controls, line breaks or bidi overrides.
		/[\p{Cc}\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(line)
	)
		return null;
	return line;
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
		handle = await open(path, "r");
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
		return {
			state: "present",
			detail: bootFatFaultDetail(buffer.subarray(0, length)),
		};
	} catch (error) {
		const code = errnoCode(error);
		// ENOTDIR: /run/ceralive is not a directory, so the marker cannot exist.
		if (code === "ENOENT" || code === "ENOTDIR") return { state: "absent" };
		return { state: "unreadable", code };
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

export interface BootFatFaultMonitorDeps {
	readonly read: () => Promise<BootFatFault>;
	readonly bootId: () => string | undefined;
	/** False when the notice was not taken (dismissed for this boot, store busy). */
	readonly show: (dismissalKey: string | undefined) => boolean;
	readonly remove: () => void;
}

const defaultDeps: BootFatFaultMonitorDeps = {
	read: () => readBootFatFault(),
	bootId: () => currentBootId(),
	show: (dismissalKey) =>
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
			undefined,
			dismissalKey ? { dismissalKey } : undefined,
		) !== false,
	remove: () => {
		notificationRemove(BOOT_FAT_FAULT_NOTICE);
	},
};

/**
 * One reconciliation step. The notice is raised when the marker exists in any
 * form, because only the checker writes there; an unreadable or unexpected
 * file still means it recorded something. A dismissal holds for this boot only,
 * so a fault that is still there after the next boot is shown again.
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
		if (!shown) {
			const boot = deps.bootId();
			shown = deps.show(boot ? `${BOOT_FAT_FAULT_NOTICE}:${boot}` : undefined);
		}
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
