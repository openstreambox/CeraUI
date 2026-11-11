import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fsPromises from "node:fs/promises";
import {
	mkdtemp,
	readFile,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	carrierIntentKey,
	effectiveCarrierAutomatic,
	newCarrierIntent,
	readCarrierIntent,
	writeCarrierIntent,
} from "./automatic-carrier-intent.ts";

const identity = {
	uuid: "synthetic-profile",
	deviceId: "synthetic-device",
	simId: "89000000000000000000",
};
let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "carrier-intent-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

test("durable intent survives a new reader without storing equipment/subscriber identifiers", async () => {
	const intent = newCarrierIntent(identity, "automatic", "example.invalid");
	await writeCarrierIntent(identity, intent, { dir });
	expect(await readCarrierIntent(identity, { dir })).toEqual(intent);
	const file = join(dir, `${carrierIntentKey(identity)}.json`);
	const bytes = await readFile(file, "utf8");
	expect(bytes).not.toContain(identity.simId);
	expect(bytes).not.toContain(identity.deviceId);
	expect((await stat(file)).mode & 0o777).toBe(0o600);
	expect(effectiveCarrierAutomatic(intent, false, "example.invalid")).toBe(
		true,
	);
	expect(effectiveCarrierAutomatic(intent, false, "manual.invalid")).toBe(
		false,
	);
});

test("profile, SIM and device each bind their own intent record", async () => {
	await writeCarrierIntent(
		identity,
		newCarrierIntent(identity, "automatic", "example.invalid"),
		{ dir },
	);
	for (const other of [
		{ ...identity, simId: "other" },
		{ ...identity, deviceId: "other" },
		{ ...identity, uuid: "other" },
	])
		expect(await readCarrierIntent(other, { dir })).toBeUndefined();
	expect(() => carrierIntentKey({ ...identity, simId: "" })).toThrow();
});

test("manual intent remains manual independently of a stale NM auto-config flag", async () => {
	const intent = newCarrierIntent(identity, "manual");
	await writeCarrierIntent(identity, intent, { dir });
	expect(
		effectiveCarrierAutomatic(
			await readCarrierIntent(identity, { dir }),
			true,
			"example.invalid",
		),
	).toBe(false);
	expect(effectiveCarrierAutomatic(undefined, true, "example.invalid")).toBe(
		true,
	);
	expect(
		effectiveCarrierAutomatic(
			newCarrierIntent(identity, "automatic"),
			false,
			"example.invalid",
		),
	).toBe(true);
	await writeCarrierIntent(identity, undefined, { dir });
	expect(await readCarrierIntent(identity, { dir })).toBeUndefined();
});

test("malformed, foreign-slot, duplicate-key and symlink records are not absence", async () => {
	const file = join(dir, `${carrierIntentKey(identity)}.json`);
	for (const bytes of [
		"{",
		JSON.stringify({
			...newCarrierIntent(identity, "automatic"),
			key: "foreign",
		}),
		'{"version":1,"version":1}',
	]) {
		await writeFile(file, bytes, { mode: 0o600 });
		await expect(readCarrierIntent(identity, { dir })).rejects.toThrow();
	}
	await rm(file);
	await writeFile(join(dir, "target"), "{}", { mode: 0o600 });
	await symlink(join(dir, "target"), file);
	await expect(readCarrierIntent(identity, { dir })).rejects.toThrow();
});

test("failure before atomic replacement preserves the previous complete intent", async () => {
	const old = newCarrierIntent(identity, "automatic", "old.invalid");
	await writeCarrierIntent(identity, old, { dir });
	const fault = spyOn(fsPromises, "rename").mockRejectedValueOnce(
		new Error("rename fault"),
	);
	try {
		await expect(
			writeCarrierIntent(identity, newCarrierIntent(identity, "manual"), {
				dir,
			}),
		).rejects.toThrow("rename fault");
	} finally {
		fault.mockRestore();
	}
	expect(await readCarrierIntent(identity, { dir })).toEqual(old);
});
