/**
 * Confirming a protected network change over real WebSockets.
 *
 * A Bun server upgrades with the production `initSocketData(request)`, so each
 * socket keeps the `Origin` and `Host` of its own upgrade and its boot-clock
 * open stamp; sessions are built with the production `networkChangeSession`.
 * The owner runs on the NetworkManager model with the real boot clock and a
 * short settle time. What it shows end to end: the requester's socket that
 * made the change can't keep it, another login can't, a new socket to another
 * address can't, and a new socket of the same login to the same address,
 * opened after the settle time and presenting the code, can.
 */
import { afterEach, describe, expect, test } from "bun:test";

import { bootClock } from "../helpers/boot-clock.ts";
import { createEffectRegistry } from "../modules/network/network-change-effects.ts";
import { createMemoryJournalStore } from "../modules/network/network-change-journal.ts";
import { networkChangeSession } from "../modules/network/network-change-runtime.ts";
import {
	CODE,
	createFakeNm,
	plan,
} from "../modules/network/network-change-test-fakes.ts";
import {
	createNetworkChangeOwner,
	NetworkChangeConfirmError,
} from "../modules/network/network-checkpoint.ts";
import { createContext, initSocketData } from "../rpc/context.ts";
import type { SocketData } from "../rpc/types.ts";

const SETTLE_MS = 300;

function box() {
	const fake = createFakeNm();
	const eth = fake.add("Wired", { "ipv4.method": "auto" });
	fake.active.set("eth0", eth);
	const owner = createNetworkChangeOwner({
		now: Date.now,
		clock: bootClock,
		bootId: async () => "boot",
		nm: fake.nm,
		effects: createEffectRegistry([]),
		journal: createMemoryJournalStore(),
		settleMs: SETTLE_MS,
	});
	const ethPlan = plan({
		devices: ["eth0"],
		profiles: [
			{ uuid: eth, set: [["ipv4.method", "shared"]], activateOn: "eth0" },
		],
	});
	const server = Bun.serve<SocketData>({
		port: 0,
		hostname: "127.0.0.1",
		fetch(request, server) {
			if (server.upgrade(request, { data: initSocketData(request) })) return;
			return new Response(null, { status: 400 });
		},
		websocket: {
			async message(ws, raw) {
				const request = JSON.parse(String(raw)) as {
					op: "login" | "apply" | "confirm";
					token?: string;
					id?: string;
					code?: string;
				};
				const reply = (value: unknown) => ws.send(JSON.stringify(value));
				try {
					if (request.op === "login") {
						createContext(ws).authenticate(request.token);
						reply({ ok: true });
					} else if (request.op === "apply") {
						reply(
							await owner.apply(networkChangeSession(ws), ethPlan, {
								answer: "undo-automatically",
								confirmationCode: CODE,
							}),
						);
					} else {
						reply(
							await owner.confirm(
								request.id as string,
								request.code as string,
								() => networkChangeSession(ws),
							),
						);
					}
				} catch (error) {
					reply({
						refused:
							error instanceof NetworkChangeConfirmError
								? error.reason
								: (error as Error).message,
					});
				}
			},
		},
	});
	return { fake, owner, server };
}

/** A browser socket: its own upgrade carries the page's origin. */
async function browserSocket(
	port: number,
	origin: string,
	host = `127.0.0.1:${port}`,
) {
	const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
		headers: { Origin: origin, Host: host },
	} as unknown as string[]);
	const replies: unknown[] = [];
	const waiting: Array<(value: unknown) => void> = [];
	socket.onmessage = ({ data }) => {
		const value = JSON.parse(String(data));
		const next = waiting.shift();
		if (next) next(value);
		else replies.push(value);
	};
	await new Promise<void>((resolve, reject) => {
		socket.onopen = () => resolve();
		socket.onerror = () => reject(new Error("socket failed"));
	});
	const send = (value: unknown) => {
		socket.send(JSON.stringify(value));
		return new Promise<unknown>((resolve) => {
			const ready = replies.shift();
			if (ready !== undefined) resolve(ready);
			else waiting.push(resolve);
		});
	};
	return { socket, send };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let stop: (() => Promise<void>) | undefined;
afterEach(async () => {
	await stop?.();
	stop = undefined;
});

describe("confirming a protected change from a new connection of the same browser", () => {
	test("only the requester's browser, back at the same address after the settle time, keeps it", async () => {
		const b = box();
		const sockets: WebSocket[] = [];
		stop = async () => {
			for (const s of sockets) s.close();
			await b.server.stop(true);
		};
		const port = b.server.port as number;
		const page = "http://box.example";

		const requester = await browserSocket(port, page);
		sockets.push(requester.socket);
		await requester.send({ op: "login", token: "token-a" });
		const pending = (await requester.send({ op: "apply" })) as {
			kind: string;
			id: string;
			canConfirm: boolean;
		};
		expect(pending).toMatchObject({ kind: "pending", canConfirm: true });

		// Too early: a new socket of the same browser before the settle time.
		const early = await browserSocket(port, page);
		sockets.push(early.socket);
		await early.send({ op: "login", token: "token-a" });
		expect(
			await early.send({ op: "confirm", id: pending.id, code: CODE }),
		).toEqual({ refused: "too_early" });

		await sleep(SETTLE_MS + 50);
		// The socket that made the change, even after the settle time.
		expect(
			await requester.send({ op: "confirm", id: pending.id, code: CODE }),
		).toEqual({ refused: "too_early" });
		// Another login with the code.
		const other = await browserSocket(port, page);
		sockets.push(other.socket);
		await other.send({ op: "login", token: "token-b" });
		expect(
			await other.send({ op: "confirm", id: pending.id, code: CODE }),
		).toEqual({ refused: "not_requester" });
		// The same login, but the page came back at another address.
		const elsewhere = await browserSocket(port, "http://192.0.2.50");
		sockets.push(elsewhere.socket);
		await elsewhere.send({ op: "login", token: "token-a" });
		expect(
			await elsewhere.send({ op: "confirm", id: pending.id, code: CODE }),
		).toEqual({ refused: "wrong_address" });
		expect(b.fake.calls).not.toContain("destroy");

		// The requester's browser, new socket, same address, with the code.
		const back = await browserSocket(port, page);
		sockets.push(back.socket);
		await back.send({ op: "login", token: "token-a" });
		expect(
			await back.send({ op: "confirm", id: pending.id, code: CODE }),
		).toEqual({ via: null, saved: true });
		expect(b.fake.calls).toContain("destroy");
		expect((await b.owner.status()).confirmed?.labelKey).toBe(
			"network.changeSafety.confirmed.remote",
		);
	});
});
