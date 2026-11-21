import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { STREAM_READINESS_EVENT } from "@ceraui/rpc/schemas";
import {
	broadcastStreamReadinessIfChanged,
	resetStreamReadinessForTest,
	setReadinessDepsForTest,
} from "../modules/streaming/stream-readiness.ts";

afterEach(() => resetStreamReadinessForTest());

test("a newly authenticated client is sent the current flag", () => {
	const adapter = readFileSync(
		resolve(import.meta.dir, "../rpc/adapter.ts"),
		"utf8",
	);
	expect(STREAM_READINESS_EVENT).toBe("stream_readiness");
	expect(adapter).toContain(
		"sendToClient(ws, STREAM_READINESS_EVENT, getStreamReadiness());",
	);
});

test("the flag is pushed only when the answer changes, not when time passes", () => {
	let now = 1;
	let lock: string | undefined;
	setReadinessDepsForTest({
		now: () => now,
		live: () => false,
		lock: () =>
			lock === undefined ? { state: "ok" } : { state: "blocked", code: lock },
		source: () => ({ state: "ok" }),
		receiver: () => ({ configured: "yes", key: "relay:1", local: false }),
		candidates: () => [],
	});
	expect(broadcastStreamReadinessIfChanged()?.reason?.code).toBe("no_uplink");
	now = 2;
	expect(broadcastStreamReadinessIfChanged()).toBeNull();
	lock = "recovery_pending";
	expect(broadcastStreamReadinessIfChanged()?.reason).toEqual({
		check: "lock",
		code: "recovery_pending",
	});
});
