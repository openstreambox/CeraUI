import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call } from "@orpc/server";
import { buttonFlow } from "../modules/system/button-flow-instance.ts";
import type { ButtonResult } from "../modules/system/power-button-client.ts";
import { powerButton } from "../modules/system/power-button-client.ts";
import { setStreamLivenessSourceForTest } from "../modules/system/stream-liveness-source.ts";
import { createContext, initSocketData } from "../rpc/context.ts";
import type { AppWebSocket } from "../rpc/types.ts";

const original = process.cwd();
const dir = mkdtempSync(join(tmpdir(), "button-auth-"));
process.chdir(dir);
const { loginProcedure } = await import("../rpc/procedures/auth.procedure.ts");
const { buttonProcedure } = await import(
	"../rpc/procedures/button.procedure.ts"
);
const { addClient, removeClient } = await import("../rpc/events.ts");
afterAll(() => {
	process.chdir(original);
	rmSync(dir, { recursive: true, force: true });
});
const owners: AppWebSocket[] = [];
afterEach(() => {
	setStreamLivenessSourceForTest(null);
	for (const owner of owners) {
		buttonFlow.cancel(owner);
		removeClient(owner);
	}
	owners.length = 0;
});
function context(local = true) {
	const ws = {
		data: { ...initSocketData(), buttonLocal: local },
		send() {},
		close() {},
	} as unknown as AppWebSocket;
	owners.push(ws);
	return createContext(ws);
}
test("no local presence or live disconnect never opens the socket", async () => {
	const confirm = spyOn(powerButton, "confirm");
	setStreamLivenessSourceForTest(() => "streaming");
	expect(
		await call(
			buttonProcedure,
			{ action: "begin", purpose: "disconnect" },
			{ context: context() },
		),
	).toEqual({ state: "stop-first" });
	expect(
		await call(
			buttonProcedure,
			{ action: "begin", purpose: "connect" },
			{ context: context(false) },
		),
	).toEqual({ state: "local-only" });
	const relay = context();
	relay.setSenderId("remote");
	expect(
		await call(
			buttonProcedure,
			{ action: "begin", purpose: "connect" },
			{ context: relay },
		),
	).toEqual({ state: "local-only" });
	expect(confirm).not.toHaveBeenCalled();
	confirm.mockRestore();
});
test("a fake socket confirmation connects exactly the requesting browser", async () => {
	const confirm = spyOn(powerButton, "confirm").mockResolvedValue({
		result: Promise.resolve("confirmed"),
		cancel() {},
	});
	const ctx = context();
	const ready = await call(
		buttonProcedure,
		{ action: "begin", purpose: "connect" },
		{ context: ctx },
	);
	if (!ready.id) throw new Error("No READY");
	const done = await call(
		buttonProcedure,
		{ action: "poll", id: ready.id },
		{ context: ctx },
	);
	expect(done.state).toBe("confirmed");
	expect(done.auth_token).toBeString();
	expect(ctx.isAuthenticated()).toBe(true);
	expect(
		(
			await call(
				buttonProcedure,
				{ action: "poll", id: ready.id },
				{ context: ctx },
			)
		).state,
	).toBe("cancelled");
	confirm.mockRestore();
});
test("live beginning after READY refuses disconnect without revoking a credential", async () => {
	let finish!: (r: ButtonResult) => void;
	const confirm = spyOn(powerButton, "confirm").mockResolvedValue({
		result: new Promise<ButtonResult>((r) => {
			finish = r;
		}),
		cancel() {},
	});
	setStreamLivenessSourceForTest(() => "idle");
	const ctx = context();
	const ready = await call(
		buttonProcedure,
		{ action: "begin", purpose: "disconnect" },
		{ context: ctx },
	);
	if (!ready.id) throw new Error("No READY");
	setStreamLivenessSourceForTest(() => "streaming");
	finish("confirmed");
	await Promise.resolve();
	expect(
		(
			await call(
				buttonProcedure,
				{ action: "poll", id: ready.id },
				{ context: ctx },
			)
		).state,
	).toBe("stop-first");
	confirm.mockRestore();
});
test("idle way B works without an existing authenticated device and retires open sessions", async () => {
	const confirm = spyOn(powerButton, "confirm").mockResolvedValue({
		result: Promise.resolve("confirmed"),
		cancel() {},
	});
	setStreamLivenessSourceForTest(() => "idle");
	const connected = context();
	const begin = await call(
		buttonProcedure,
		{ action: "begin", purpose: "connect" },
		{ context: connected },
	);
	if (!begin.id) throw new Error("No READY");
	const token = (
		await call(
			buttonProcedure,
			{ action: "poll", id: begin.id },
			{ context: connected },
		)
	).auth_token;
	addClient(connected.ws);
	const visitor = context();
	const reset = await call(
		buttonProcedure,
		{ action: "begin", purpose: "disconnect" },
		{ context: visitor },
	);
	if (!reset.id) throw new Error("No READY");
	expect(
		(
			await call(
				buttonProcedure,
				{ action: "poll", id: reset.id },
				{ context: visitor },
			)
		).state,
	).toBe("confirmed");
	expect(connected.isAuthenticated()).toBe(false);
	expect(
		(
			await call(
				loginProcedure,
				{ token, persistent_token: false },
				{ context: context() },
			)
		).success,
	).toBe(false);
	confirm.mockRestore();
});
