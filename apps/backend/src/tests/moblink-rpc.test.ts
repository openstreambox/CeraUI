import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call } from "@orpc/server";
import { MoblinkOwner } from "../modules/moblink/owner";
import { buildControlContext } from "../modules/remote-control/control-context";
import { createContext } from "../rpc/context";
import { createMoblinkProcedures } from "../rpc/procedures/moblink.procedure";
import type { AppWebSocket } from "../rpc/types";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
function fixture(authenticated = true, senderId?: string) {
	const dir = mkdtempSync(join(tmpdir(), "credential-rpc-"));
	dirs.push(dir);
	const owner = new MoblinkOwner({
		directory: join(dir, "private"),
		available: () => true,
		idle: () => true,
		start: () => {},
		stop: async () => {},
	});
	const context = createContext({
		data: { isAuthenticated: authenticated, senderId },
		remoteAddress: "127.0.0.1",
	} as AppWebSocket);
	return { owner, context, rpc: createMoblinkProcedures(owner) };
}
test("local operator may replace and clear; RPC has no readable credential", async () => {
	const f = fixture();
	const secret = "phone-rpc-sentinel";
	const replies = [
		await call(
			f.rpc.setCredential,
			{ password: secret },
			{ context: f.context },
		),
		await call(f.rpc.getStatus, undefined, { context: f.context }),
	];
	expect(JSON.stringify(replies)).not.toContain(secret);
	expect(replies[1]).toEqual({ available: true, configured: true });
	expect(Object.keys(f.rpc).sort()).toEqual([
		"clearCredential",
		"getStatus",
		"setCredential",
	]);
	expect(
		await call(f.rpc.clearCredential, undefined, { context: f.context }),
	).toEqual({ success: true });
});
test("anonymous, relay and control-channel contexts cannot read or mutate", async () => {
	for (const context of [
		fixture(false).context,
		fixture(true, "remote-viewer").context,
		buildControlContext(),
	]) {
		const f = fixture();
		await expect(
			call(f.rpc.setCredential, { password: "never-stored" }, { context }),
		).rejects.toThrow();
		await expect(
			call(f.rpc.clearCredential, undefined, { context }),
		).rejects.toThrow();
		await expect(
			call(f.rpc.getStatus, undefined, { context }),
		).rejects.toThrow();
		expect(f.owner.status().configured).toBe(false);
	}
});

test("status schemas and phone remote fan-out strip planted credential fields", async () => {
	const { moblinkStatusSchema } = await import("@ceraui/rpc/schemas");
	const { projectRemoteStatus } = await import(
		"../modules/remote/remote-status"
	);
	const { runtimeConfigSchema } = await import("../helpers/config-schemas");
	const secret = "non-disclosure-sentinel";
	expect(
		moblinkStatusSchema.parse({
			available: true,
			configured: true,
			password: secret,
		}),
	).toEqual({ available: true, configured: true });
	expect(
		JSON.stringify(
			projectRemoteStatus({
				phone_box: true,
				moblink: { password: secret },
				carrying: { state: "idle" },
				phone_links: { ready: 0, sending: null },
				box_health: [],
			}),
		),
	).not.toContain(secret);
	expect(
		JSON.stringify(
			runtimeConfigSchema.parse({
				moblink_password: secret,
				moblink: { password: secret },
			}),
		),
	).not.toContain(secret);
});

test("real initial status and outbound status relay contain no saved credential", async () => {
	const f = fixture();
	const secret = "saved-wire-sentinel";
	await call(f.rpc.setCredential, { password: secret }, { context: f.context });
	const { buildInitialStatus } = await import(
		"../rpc/procedures/status.procedure"
	);
	const { setControlChannel, relayStatusToGateway, resetStatusRelay } =
		await import("../modules/remote-control/status-relay");
	const frames: unknown[] = [];
	try {
		setControlChannel({
			isConnected: () => true,
			sendFrame: (frame) => {
				frames.push(frame);
			},
		});
		const initial = buildInitialStatus();
		relayStatusToGateway("status", initial.status, 1);
		relayStatusToGateway("config", initial.config, 1);
		expect(frames.length).toBe(2);
		expect(JSON.stringify([initial, frames])).not.toContain(secret);
	} finally {
		resetStatusRelay();
	}
});
