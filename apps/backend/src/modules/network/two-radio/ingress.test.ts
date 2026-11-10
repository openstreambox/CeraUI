import { expect, test } from "bun:test";
import type { Identity } from "./effect-adapter.ts";
import { Ingress, type IngressAuthority } from "./ingress.ts";
import { initialState, reduce } from "./reducer.ts";

const live: Identity = {
	physical: "usb-port-2",
	permanentMac: "02:00:00:00:00:02",
	epoch: {
		bssid: "ap",
		lease: "lease",
		activation: "active",
		routeGeneration: 1,
	},
};
const authority = (): IngressAuthority => ({
	resolve: (physical) =>
		physical === live.physical ? { radio: "b", identity: live } : null,
	absent: () => false,
	bound: (socket, _, nonce) => socket === "bound-socket" && nonce === "nonce",
	traffic: () => false,
});
const row = (event: unknown, at = 0, physical = live.physical) =>
	JSON.stringify({ version: 1, at, physical, event });
const challenge = {
	id: "nonce",
	radio: "b",
	epoch: live.epoch,
	target: "receiver",
	round: "round",
	socket: "bound-socket",
	startedAt: 0,
	expiresAt: 100,
};
test("validated physical identity feeds the reducer", () => {
	const ingress = new Ingress(authority());
	const state = reduce(
		initialState(),
		ingress.parse(row({ type: "identity", radio: "b", epoch: live.epoch })),
	).state;
	expect(state.paths.b.epoch).toEqual(live.epoch);
});
test("attested dispatch plus actual response establishes proof; no synthetic ACK", () => {
	const ingress = new Ingress(authority());
	let state = initialState();
	for (const event of [
		{ type: "identity", radio: "b", epoch: live.epoch },
		{ type: "challenge", challenge },
		{
			type: "response",
			id: "nonce",
			nonce: "nonce",
			radio: "b",
			epoch: live.epoch,
			socket: "bound-socket",
			ok: true,
		},
	])
		state = reduce(state, ingress.parse(row(event))).state;
	expect(state.paths.b.label).toBe("useful");
	expect(state.op).toBeNull();
});
test("ACK records cannot enter through event ingress", () => {
	for (const ok of [true, false])
		expect(() =>
			new Ingress(authority()).parse(
				row({ type: "ack", operation: 1, command: 2, ok }),
			),
		).toThrow();
});
test("malformed, unknown, oversized, nonfinite and nonmonotonic records fail", () => {
	const ingress = new Ingress(authority());
	for (const json of [
		"{",
		"null",
		row({ type: "mystery" }),
		row({ type: "tick" }, -1),
		JSON.stringify({ version: 2, at: 0, event: { type: "tick" } }),
		" ".repeat(16385),
	])
		expect(() => ingress.parse(json)).toThrow();
	ingress.parse(row({ type: "tick" }, 2));
	expect(() => ingress.parse(row({ type: "tick" }, 1))).toThrow();
});
test("slot/physical mapping cannot be replaced by interface or array position", () => {
	const ingress = new Ingress(authority());
	expect(() =>
		ingress.parse(row({ type: "identity", radio: "a", epoch: live.epoch })),
	).toThrow();
	expect(() =>
		ingress.parse(
			row({ type: "identity", radio: "b", epoch: live.epoch }, 0, "wlan0"),
		),
	).toThrow();
});
test("stale identity and unknown absence cannot erase a live incarnation", () => {
	const ingress = new Ingress(authority());
	expect(() =>
		ingress.parse(
			row({
				type: "identity",
				radio: "b",
				epoch: { ...live.epoch, activation: "old" },
			}),
		),
	).toThrow();
	expect(() =>
		ingress.parse(row({ type: "identity", radio: "b", epoch: null })),
	).toThrow();
	const port = authority();
	port.absent = () => true;
	expect(
		new Ingress(port).parse(row({ type: "identity", radio: "b", epoch: null }))
			.event.type,
	).toBe("identity");
});
test("JSON cannot self-attest device binding", () => {
	expect(() =>
		new Ingress(authority()).parse(
			row({ type: "challenge", challenge, deviceBound: true }),
		),
	).toThrow();
	const port = authority();
	port.bound = () => false;
	expect(() =>
		new Ingress(port).parse(row({ type: "challenge", challenge })),
	).toThrow();
});
test("challenge times and response identity are validated", () => {
	const ingress = new Ingress(authority());
	expect(() =>
		ingress.parse(
			row({ type: "challenge", challenge: { ...challenge, expiresAt: 0 } }),
		),
	).toThrow();
	expect(() =>
		ingress.parse(
			row({
				type: "response",
				id: "nonce",
				nonce: "nonce",
				socket: "bound-socket",
				radio: "b",
				epoch: { ...live.epoch, routeGeneration: 2 },
				ok: true,
			}),
		),
	).toThrow();
});
test("a probe cannot attest real traffic", () => {
	const event = {
		type: "traffic" as const,
		operation: 1,
		radio: "b" as const,
		epoch: live.epoch,
	};
	expect(() => new Ingress(authority()).parse(row(event))).toThrow();
	const port = authority();
	port.traffic = () => true;
	expect(new Ingress(port).parse(row(event)).event).toEqual(event);
});
test("external receiver events and aggregate timing cannot establish proof", () => {
	for (const json of [
		JSON.stringify({
			version: 1,
			at: 0,
			event: {
				type: "receiver.received",
				messageId: "example-message",
				transport: "udp",
				accepted: true,
			},
		}),
		JSON.stringify({ duration: 2, cleanupDuration: 4 }),
	])
		expect(() => new Ingress(authority()).parse(json)).toThrow();
});
