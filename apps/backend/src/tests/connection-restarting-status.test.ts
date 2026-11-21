/*
  A client that connects, or reconnects, while a supervised connection restart
  runs must read "Restarting connection" at once, not "Not streaming" until the
  next change. The flag rides every status snapshot as an explicit boolean: the
  post-login snapshot, the reconnect pull and the legacy status frame.
*/

import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	test,
} from "bun:test";
import { call } from "@orpc/server";
import type WebSocket from "ws";

import { setup } from "../modules/setup.ts";
import {
	beginConnectionRestart,
	resetConnectionRestartingForTest,
} from "../modules/streaming/connection-restarting.ts";
import { sendStatus } from "../modules/ui/status.ts";
import {
	buildInitialStatus,
	getStatusProcedure,
} from "../rpc/procedures/status.procedure.ts";
import type { AppWebSocket, RPCContext } from "../rpc/types.ts";

function makeContext(): RPCContext {
	const ws = {
		send: () => {},
		data: { isAuthenticated: true, lastActive: Date.now(), senderId: "test" },
	} as unknown as AppWebSocket;
	return {
		ws,
		isAuthenticated: () => true,
		authenticate: () => {},
		deauthenticate: () => {},
		markActive: () => {},
		getLastActive: () => 0,
		setSenderId: () => {},
		getSenderId: () => undefined,
		clearSenderId: () => {},
	};
}

function statusFrameFlag(): unknown {
	const sent: string[] = [];
	sendStatus({ send: (f: string) => sent.push(f) } as unknown as WebSocket);
	return (JSON.parse(sent[0] as string).status as Record<string, unknown>)
		.connection_restarting;
}

async function snapshots(): Promise<unknown[]> {
	const pulled = await call(getStatusProcedure, undefined, {
		context: makeContext(),
	});
	return [
		buildInitialStatus().status.connection_restarting,
		pulled.connection_restarting,
		statusFrameFlag(),
	];
}

// The snapshot builders fire getSshStatus, which rejects on a stray
// setup.ssh_user a sibling test file may have left behind.
let savedSshUser: string | undefined;
beforeAll(() => {
	savedSshUser = (setup as { ssh_user?: string }).ssh_user;
	(setup as { ssh_user?: string }).ssh_user = undefined;
});
afterAll(() => {
	(setup as { ssh_user?: string }).ssh_user = savedSshUser;
});
afterEach(() => {
	resetConnectionRestartingForTest();
});

describe("connection_restarting in every status snapshot", () => {
	test("a client connecting mid-restart reads it as true", async () => {
		resetConnectionRestartingForTest();
		const end = beginConnectionRestart(() => {});
		try {
			expect(await snapshots()).toEqual([true, true, true]);
		} finally {
			end();
		}
	});

	test("is an explicit false otherwise, never an omission", async () => {
		resetConnectionRestartingForTest();
		expect(await snapshots()).toEqual([false, false, false]);
	});
});
