/**
 * Every procedure the frontend can call has a decided place in the reconnect
 * session gate: the sign-in itself, a read that may wait for the re-auth, or
 * a call that fails at once and is never sent. A new procedure that nobody
 * classified fails here, so it can't silently become holdable.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { appContract } from "@ceraui/rpc";
import { describe, expect, it } from "vitest";

import {
	HELD_DURING_REAUTH,
	INTENTS_AFTER_REAUTH,
	mayHoldForReauth,
	REFUSED_DURING_REAUTH,
	SIGN_IN_PROCEDURE,
} from "./session-gate-policy";

/** Contract procedures, each with whether it declares an answer at all. */
function contractProcedures(
	node: object,
	prefix: string[] = [],
): Map<string, boolean> {
	const found = new Map<string, boolean>();
	for (const [name, value] of Object.entries(node)) {
		if (value === null || typeof value !== "object") continue;
		if ("~orpc" in value) {
			const definition = (value as { "~orpc": { outputSchemas?: unknown } })[
				"~orpc"
			];
			found.set(
				[...prefix, name].join("."),
				definition.outputSchemas !== undefined,
			);
		} else {
			for (const [path, answers] of contractProcedures(value, [
				...prefix,
				name,
			]))
				found.set(path, answers);
		}
	}
	return found;
}

/** `namespace.name` of every procedure the device's router registers (router.ts). */
function routedNames(): Set<string> {
	const source = readFileSync(
		fileURLToPath(
			new URL("../../../../backend/src/rpc/router.ts", import.meta.url),
		),
		"utf8",
	);
	// `namespace: base.router({` opens a namespace; its two-tab keys are its
	// procedures. Keyed `namespace.name`, so `wifi.getStatus` never vouches for
	// another namespace's `getStatus`.
	const routed = new Set<string>();
	let namespace: string | undefined;
	for (const line of source.split("\n")) {
		const opened = /^\t(\w+): base\.router\(/.exec(line);
		if (opened) {
			namespace = opened[1];
			continue;
		}
		if (/^\S/.test(line) || /^\t\S/.test(line)) namespace = undefined;
		const key = /^\t\t(\w+): \w+/.exec(line);
		if (key && namespace) routed.add(`${namespace}.${key[1]}`);
	}
	return routed;
}

/** The procedures the typed `rpc` proxy exposes (`TypedRPC` in client.ts). */
function typedProcedures(): string[] {
	const source = readFileSync(
		fileURLToPath(new URL("./client.ts", import.meta.url)),
		"utf8",
	);
	const start = source.indexOf("export interface TypedRPC {");
	const end = source.indexOf("\n}\n", start);
	expect(start).toBeGreaterThan(-1);
	const found: string[] = [];
	let group: string | undefined;
	for (const line of source.slice(start, end).split("\n")) {
		const opened = /^\t(\w+)\??: \{$/.exec(line);
		if (opened) {
			group = opened[1];
			continue;
		}
		const method = /^\t\t(\w+)\??: /.exec(line);
		if (method && group) found.push(`${group}.${method[1]}`);
	}
	return found;
}

const contract = contractProcedures(appContract);
const callable = new Set([...contract.keys(), ...typedProcedures()]);
const lists = [HELD_DURING_REAUTH, INTENTS_AFTER_REAUTH, REFUSED_DURING_REAUTH];

describe("reconnect session gate policy", () => {
	it("classifies every callable procedure exactly once", () => {
		const unclassified = [...callable].filter(
			(procedure) =>
				procedure !== SIGN_IN_PROCEDURE &&
				!lists.some((list) => list.has(procedure)),
		);
		expect(unclassified).toEqual([]);
		const twice = [...callable].filter(
			(procedure) => lists.filter((list) => list.has(procedure)).length > 1,
		);
		expect(twice).toEqual([]);
	});

	it("lists no procedure that no longer exists", () => {
		const stale = lists
			.flatMap((list) => [...list])
			.filter((procedure) => !callable.has(procedure));
		expect(stale).toEqual([]);
	});

	it("holds only reads", () => {
		for (const procedure of HELD_DURING_REAUTH) {
			const name = procedure.split(".")[1] ?? "";
			expect(
				/^(get|list|kioskStatus$|streamHealth$)/.test(name),
				procedure,
			).toBe(true);
		}
	});

	it("matches routed procedures by namespace, not by bare name", () => {
		const routed = routedNames();
		expect(routed.has("wifi.getStatus")).toBe(true);
		expect(routed.has("addons.list")).toBe(true);
		expect(routed.has("foo.getStatus")).toBe(false);
	});

	it("holds only reads the device actually answers", () => {
		const routed = routedNames();
		const unanswered = [...HELD_DURING_REAUTH].filter((procedure) => {
			const answers = contract.get(procedure);
			// A bare contract entry (no answer declared, no handler) is a
			// placeholder; outside the contract the router must register it.
			return answers === undefined ? !routed.has(procedure) : !answers;
		});
		expect(unanswered).toEqual([]);
	});

	it("holds no read with a side effect outside the device's state", () => {
		for (const procedure of [
			"relay.validate",
			"ui.heartbeat",
			"system.getLog",
			"system.getSyslog",
		])
			expect(HELD_DURING_REAUTH.has(procedure), procedure).toBe(false);
	});

	it("keeps Stop as the one intent sent after the re-auth, never held by the client", () => {
		expect([...INTENTS_AFTER_REAUTH]).toEqual(["streaming.stop"]);
		expect(mayHoldForReauth("streaming.stop")).toBe(false);
	});

	it("refuses anything unknown", () => {
		expect(mayHoldForReauth("captive.open")).toBe(false);
		expect(mayHoldForReauth("wifi.hotspotDelete")).toBe(false);
		expect(mayHoldForReauth(SIGN_IN_PROCEDURE)).toBe(false);
		expect(mayHoldForReauth("status.getStatus")).toBe(true);
	});
});
