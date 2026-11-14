import { open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { Journal, Snapshot } from "./effect-adapter.ts";
import { epochSchema } from "./ingress.ts";

const id = z.number().int().nonnegative().safe();
const radio = z.enum(["a", "b"]);
const identity = z.strictObject({
	physical: z.string().min(1).max(512),
	permanentMac: z.string().regex(/^(?:[\da-fA-F]{2}:){5}[\da-fA-F]{2}$/),
	epoch: epochSchema,
});
const effect = z.strictObject({
	operation: id,
	command: id,
	radio,
	epoch: epochSchema,
	action: z.enum([
		"disconnect",
		"reassociate",
		"scan",
		"reapply",
		"forced-renew",
		"promote",
		"demote",
		"cancel-drain-restore",
	]),
	restore: z.strictObject({ radio, epoch: epochSchema.nullable() }).nullable(),
});
const snapshotSchema = z.strictObject({
	version: z.literal(1),
	session: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
	holder: z.strictObject({ radio, identity }).optional(),
	operations: z
		.array(
			z.strictObject({
				operation: id,
				scope: z.string().regex(/^two-radio-[a-zA-Z0-9_-]+-\d+$/),
				holder: z.strictObject({ radio, identity }),
				closed: z.boolean(),
				clean: z.boolean(),
				commands: z.array(z.strictObject({ effect, identity })).max(1024),
				acknowledgements: z
					.array(
						z.strictObject({
							type: z.literal("ack"),
							operation: id,
							command: id,
							ok: z.boolean(),
						}),
					)
					.max(1024),
			}),
		)
		.max(1024),
});
/** One instance per existing network owner, in its private durable state directory.
 * Missing is fresh; malformed/unreadable is NOT fresh and blocks admission. */
export class FileJournal implements Journal {
	constructor(private readonly path: string) {}
	async load(): Promise<Snapshot | null> {
		try {
			const file = await open(this.path, "r");
			try {
				if ((await file.stat()).size > 4_194_304)
					throw new Error("Oversize journal");
				const snapshot = snapshotSchema.parse(
					JSON.parse(await file.readFile("utf8")),
				);
				for (const op of snapshot.operations) {
					if (
						op.scope !== `two-radio-${snapshot.session}-${op.operation}` ||
						op.commands.some((c) => c.effect.operation !== op.operation)
					)
						throw new Error("Journal ownership mismatch");
				}
				if (
					new Set(snapshot.operations.map((op) => op.operation)).size !==
					snapshot.operations.length
				)
					throw new Error("Duplicate journal operation");
				return snapshot;
			} finally {
				await file.close();
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
	}
	async save(snapshot: Snapshot): Promise<void> {
		const data = JSON.stringify(snapshotSchema.parse(snapshot));
		if (Buffer.byteLength(data) > 4_194_304)
			throw new Error("Oversize journal");
		const temp = `${this.path}.${crypto.randomUUID()}.tmp`;
		const file = await open(temp, "wx", 0o600);
		try {
			await file.chmod(0o600);
			await file.writeFile(data);
			await file.sync();
		} finally {
			await file.close();
		}
		try {
			await rename(temp, this.path);
			const directory = await open(dirname(this.path), "r");
			try {
				await directory.sync();
			} finally {
				await directory.close();
			}
		} finally {
			await unlink(temp).catch(() => {
				// Rename already removed the temporary name.
			});
		}
	}
}
