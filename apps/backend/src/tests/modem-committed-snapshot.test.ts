import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { call } from "@orpc/server";
import {
	initCellularStack,
	resetCellularStack,
} from "../modules/cellular/cellular-stack.ts";
import {
	broadcastModems,
	broadcastRadioHealth,
} from "../modules/modems/modem-status.ts";
import {
	getModemIds,
	type Modem,
	removeModem,
	setModem,
} from "../modules/modems/modems-state.ts";
import { addClient, removeClient } from "../rpc/events.ts";
import { getAllModemsProcedure } from "../rpc/procedures/modems.procedure.ts";
import type { AppWebSocket, RPCContext } from "../rpc/types.ts";

function modem(name: string): Modem {
	return {
		ifname: `wwan-${name}`,
		name,
		network_type: { supported: {}, active: null },
		status: {
			connection: "disconnected",
			network_type: "unknown",
			signal: 0,
			roaming: false,
		},
	} as unknown as Modem;
}

function context(): RPCContext {
	const ws = {
		send: () => {},
		data: { isAuthenticated: true, lastActive: Date.now() },
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

function clearModems(): void {
	for (const id of getModemIds()) removeModem(id);
}

describe("committed modem snapshot", () => {
	beforeEach(async () => {
		clearModems();
		resetCellularStack();
		await initCellularStack({ backend: "mmcli" });
	});

	afterEach(() => {
		clearModems();
		resetCellularStack();
	});

	test("radio enrichment cannot replay control fields into a subscriber", () => {
		setModem(1, modem("diagnostic"));
		broadcastModems();
		const frames: string[] = [];
		const client = {
			data: { isAuthenticated: true, lastActive: Date.now() },
			send: (frame: string) => frames.push(frame),
		} as unknown as AppWebSocket;
		addClient(client);
		try {
			broadcastRadioHealth();
			expect(frames.length).toBe(1);
			const frame = JSON.parse(frames[0] ?? "{}");
			expect(Object.keys(frame.status.modems["1"])).toEqual([
				"status",
				"radio_health",
			]);
			expect(frame.status.modems["1"].radio_health.finding.kind).toBe(
				"unknown",
			);
		} finally {
			removeClient(client);
		}
	});

	test("getAll serves the last complete commit while mutable state is changing", async () => {
		// Given one fully-published modem snapshot
		setModem(1, modem("committed"));
		broadcastModems();

		// When a new row appears before the reconciliation commits its snapshot
		setModem(2, modem("in-progress"));
		broadcastRadioHealth();
		const startedAt = performance.now();
		const result = await call(getAllModemsProcedure, undefined, {
			context: context(),
		});

		// Then the read is immediate and cannot observe the half-applied state
		expect(performance.now() - startedAt).toBeLessThan(1_000);
		expect(Object.keys(result)).toEqual(["1"]);
	});
});
