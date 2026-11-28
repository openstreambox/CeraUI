import { afterEach, beforeAll, beforeEach, spyOn } from "bun:test";
import fsDefault, * as fs from "node:fs";
import * as fsp from "node:fs/promises";

type Spy = { mockRestore(): void };

/**
 * For durable-store tests whose subject is authority, not the kernel flush.
 *
 * On ext4 a directory fsync forces a commit of the running journal
 * transaction, if there is one, and waits for it. In data=ordered mode that
 * commit first writes out the data the transaction tracks, which in a parallel
 * run includes other processes' new files. The private state writers fsync
 * each new directory's ancestry up to `/`, so under a parallel gate those
 * commits were the main wait in tests that otherwise take milliseconds.
 *
 * Within each test of the calling file, every fsync and fdatasync form records
 * the synced path in call order (and passes it to `observe`, if given) but
 * forces no journal commit. Spies are restored after each test.
 *
 * Limits: a closed or invalid descriptor still fails, but a live descriptor the
 * kernel would refuse to sync (a pipe or socket, EINVAL) is accepted, and
 * writeback errors (EIO) cannot occur. Tests of fsync failure inject it through
 * their store's own seams or spy on the real call instead.
 */
export function recordFsyncsPerTest(observe?: (path: string) => void): {
	readonly synced: string[];
} {
	const synced: string[] = [];
	let spies: Spy[] = [];
	let handlePrototype: { sync(): Promise<void>; datasync(): Promise<void> };
	const record = (fd: number) => {
		fs.fstatSync(fd);
		const path = fs.readlinkSync(`/proc/self/fd/${fd}`);
		synced.push(path);
		observe?.(path);
	};
	beforeAll(async () => {
		const handle = await fsp.open("/dev/null", "r");
		handlePrototype = Object.getPrototypeOf(handle);
		await handle.close();
	});
	beforeEach(() => {
		synced.length = 0;
		const callback = (fd: number, done: (error: Error | null) => void) => {
			let error: Error | null = null;
			try {
				record(fd);
			} catch (caught) {
				error = caught as Error;
			}
			queueMicrotask(() => done(error));
		};
		// Named imports bind to the namespace; `import fs from "node:fs"` callers
		// use the default object, which Bun keeps separate.
		const modules = new Set<typeof fs>([fs, fsDefault]);
		spies = [...modules].flatMap((module) => [
			spyOn(module, "fsyncSync").mockImplementation(record),
			spyOn(module, "fdatasyncSync").mockImplementation(record),
			spyOn(module, "fsync").mockImplementation(callback as typeof fs.fsync),
			spyOn(module, "fdatasync").mockImplementation(
				callback as typeof fs.fdatasync,
			),
		]);
		for (const name of ["sync", "datasync"] as const)
			spies.push(
				spyOn(handlePrototype, name).mockImplementation(async function (
					this: fsp.FileHandle,
				) {
					record(this.fd);
				}),
			);
	});
	afterEach(() => {
		for (const spy of spies.splice(0)) spy.mockRestore();
	});
	return { synced };
}
