import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call } from "@orpc/server";
import { setupConfigSchema } from "../helpers/config-schemas";
import { loadForwardSecret } from "../modules/ingest/forward-secret";
import { setup } from "../modules/setup";
import { getPhoneBoxProcedure } from "../rpc/procedures/phone-box.procedure";
import type { RPCContext } from "../rpc/types";

test("authenticated phone details use the listener's persisted generated credential", async () => {
	const dir = mkdtempSync(join(tmpdir(), "phone-credential-"));
	const previous = setup.srt_forward;
	const context = {
		isAuthenticated: () => true,
		markActive: () => {},
	} as RPCContext;
	try {
		const config = setupConfigSchema.parse({
			hw: "rk3588",
			srt_forward: { host: "192.168.4.1" },
		}).srt_forward;
		if (!config) throw Error("missing forwarding config");
		const path = join(dir, "secret");
		config.passphrase = await loadForwardSecret(path, config.passphrase);
		setup.srt_forward = config;
		const first = await call(getPhoneBoxProcedure, undefined, { context });
		expect(first.srt).toEqual({
			address: `srt://${config.host}:${config.port}`,
			passphrase: config.passphrase,
		});
		const restarted = setupConfigSchema.parse({
			hw: "rk3588",
			srt_forward: { host: "192.168.4.1" },
		}).srt_forward;
		if (!restarted) throw Error("missing forwarding config");
		restarted.passphrase = await loadForwardSecret(path, restarted.passphrase);
		setup.srt_forward = restarted;
		expect(
			(await call(getPhoneBoxProcedure, undefined, { context })).srt,
		).toEqual(first.srt);
		await expect(
			call(getPhoneBoxProcedure, undefined, {
				context: { ...context, isAuthenticated: () => false },
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		setup.srt_forward = undefined;
		expect(
			(await call(getPhoneBoxProcedure, undefined, { context })).srt,
		).toBeNull();
	} finally {
		setup.srt_forward = previous;
		rmSync(dir, { recursive: true, force: true });
	}
});
