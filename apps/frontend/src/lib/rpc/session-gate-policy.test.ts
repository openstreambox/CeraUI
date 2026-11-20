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
	mayHoldForReauth,
	REFUSED_DURING_REAUTH,
	SIGN_IN_PROCEDURE,
} from "./session-gate-policy";

function contractProcedures(node: object, prefix: string[] = []): string[] {
	const found: string[] = [];
	for (const [name, value] of Object.entries(node)) {
		if (value === null || typeof value !== "object") continue;
		if ("~orpc" in value) found.push([...prefix, name].join("."));
		else found.push(...contractProcedures(value, [...prefix, name]));
	}
	return found;
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

const callable = new Set([
	...contractProcedures(appContract),
	...typedProcedures(),
]);

describe("reconnect session gate policy", () => {
	it("classifies every callable procedure exactly once", () => {
		const unclassified = [...callable].filter(
			(procedure) =>
				procedure !== SIGN_IN_PROCEDURE &&
				!HELD_DURING_REAUTH.has(procedure) &&
				!REFUSED_DURING_REAUTH.has(procedure),
		);
		expect(unclassified).toEqual([]);
		const both = [...HELD_DURING_REAUTH].filter((procedure) =>
			REFUSED_DURING_REAUTH.has(procedure),
		);
		expect(both).toEqual([]);
	});

	it("lists no procedure that no longer exists", () => {
		const stale = [...HELD_DURING_REAUTH, ...REFUSED_DURING_REAUTH].filter(
			(procedure) => !callable.has(procedure),
		);
		expect(stale).toEqual([]);
	});

	it("holds only reads and subscriptions", () => {
		for (const procedure of HELD_DURING_REAUTH) {
			const name = procedure.split(".")[1] ?? "";
			expect(
				/^(get|list|on|kioskStatus$|streamHealth$|heartbeat$|validate$)/.test(
					name,
				),
				procedure,
			).toBe(true);
		}
	});

	it("refuses anything unknown", () => {
		expect(mayHoldForReauth("captive.open")).toBe(false);
		expect(mayHoldForReauth("wifi.hotspotDelete")).toBe(false);
		expect(mayHoldForReauth(SIGN_IN_PROCEDURE)).toBe(false);
		expect(mayHoldForReauth("status.getStatus")).toBe(true);
	});
});
