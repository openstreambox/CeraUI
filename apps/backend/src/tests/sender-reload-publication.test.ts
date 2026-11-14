import { beforeEach, expect, test } from "bun:test";
import {
	publishBondMapping,
	resetBindMapWriter,
} from "../modules/streaming/bind-map-writer.ts";
import { restartSrtla } from "../modules/streaming/srtla.ts";

beforeEach(resetBindMapWriter);
const deps = {
	ipsFile: "/tmp/ips",
	sidecarFile: "/tmp/map",
	writeFile: async () => {},
	renameFile: async () => {},
	removeFile: async () => {},
};
test.each([false, "throw"])(
	"failed reload delivery %p invalidates no-op identity reuse",
	async (outcome) => {
		await publishBondMapping([], deps);
		await restartSrtla(async () => {
			if (outcome === "throw") throw new Error("delivery failed");
			return false;
		});
		const retry = await publishBondMapping([], deps);
		expect(retry.changed).toBe(true);
		expect(retry.ok && retry.generation).toBe(2);
	},
);
test("successful reload delivery preserves stable no-op identity", async () => {
	const first = await publishBondMapping([], deps);
	await restartSrtla(async () => true);
	expect(await publishBondMapping([], deps)).toEqual({
		...first,
		changed: false,
	});
});
test("queued writes cannot overwrite a failed-delivery invalidation", async () => {
	const entered = Promise.withResolvers<void>(),
		release = Promise.withResolvers<void>();
	await publishBondMapping([], deps);
	const inflight = publishBondMapping([], {
		...deps,
		writeFile: async () => {
			entered.resolve();
			await release.promise;
		},
	});
	await entered.promise;
	await restartSrtla(async () => false);
	release.resolve();
	await inflight;
	expect((await publishBondMapping([], deps)).changed).toBe(true);
});
