import { expect, test } from "bun:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquirePrivateStateLease } from "./private-state-lease.ts";

test.skipIf(process.platform !== "linux")(
	"private state kernel lease excludes another descriptor and releases exactly once",
	async () => {
		const dir = await mkdtemp(join(tmpdir(), "private-kernel-lease-")),
			key = "a".repeat(64);
		try {
			const held = await acquirePrivateStateLease({ dir }, key);
			expect(held).toBeDefined();
			expect(await acquirePrivateStateLease({ dir }, key)).toBeUndefined();
			held?.release();
			held?.release();
			const successor = await acquirePrivateStateLease({ dir }, key);
			expect(successor).toBeDefined();
			successor?.release();
			await symlink("/dev/null", join(dir, `${"b".repeat(64)}.lock`));
			await expect(
				acquirePrivateStateLease({ dir }, "b".repeat(64)),
			).rejects.toThrow();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	},
);
