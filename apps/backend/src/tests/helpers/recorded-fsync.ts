import { afterEach, beforeAll, beforeEach, spyOn } from "bun:test";
import fsDefault, * as fs from "node:fs";
import * as fsp from "node:fs/promises";

type Spy = { mockRestore(): void };

/**
 * For durable-store tests whose subject is authority, not the kernel flush.
 *
 * On ext4 every directory fsync forces a commit of the whole filesystem's
 * running journal transaction, and in data=ordered mode that commit first
 * writes back other processes' dirty data. The private state writers fsync
 * each new directory's ancestry up to `/`, so under a parallel gate one test
 * can wait seconds on writeback it does not own and hit its timeout.
 *
 * Within each test of the calling file, every fsync and fdatasync form still
 * validates its descriptor (a closed or bad fd fails as it would in the
 * kernel) and records the synced path in call order, but forces no journal
 * commit. Spies are restored after each test. Directory-ancestry and
 * fsync-failure behaviour stays covered by the tests that observe or inject
 * those calls directly.
 */
export function recordFsyncsPerTest(): { readonly synced: string[] } {
	const synced: string[] = [];
	let spies: Spy[] = [];
	let handlePrototype: { sync(): Promise<void>; datasync(): Promise<void> };
	const record = (fd: number) => {
		fs.fstatSync(fd);
		synced.push(fs.readlinkSync(`/proc/self/fd/${fd}`));
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
