import { expect, test } from "bun:test";
import {
	cellularSenderAllowsPublication,
	cellularSenderRuntime,
} from "./cellular-sender-runtime.ts";
import type { StreamingProcess } from "./streamloop/process-runner.ts";

function sender(required: boolean): StreamingProcess {
	return {
		spawnfile: "/synthetic/sender",
		exitListeners: [],
		proc: { exitCode: null, signalCode: null },
		senderBinding: { epoch: Symbol(), startedAt: 100, required },
	} as unknown as StreamingProcess;
}
test("managed publication follows the existing sole subprocess owner's exact live strict sender", () => {
	const strict = sender(true),
		legacy = sender(false);
	expect(
		cellularSenderAllowsPublication(
			cellularSenderRuntime([], strict.spawnfile),
		),
	).toBe(true);
	expect(
		cellularSenderAllowsPublication(
			cellularSenderRuntime([strict], strict.spawnfile),
		),
	).toBe(true);
	expect(
		cellularSenderAllowsPublication(
			cellularSenderRuntime([legacy], strict.spawnfile),
		),
	).toBe(false);
	expect(cellularSenderRuntime([strict, legacy], strict.spawnfile).kind).toBe(
		"unknown",
	);
	expect(
		cellularSenderAllowsPublication(
			cellularSenderRuntime([strict, legacy], strict.spawnfile),
		),
	).toBe(false);
	const unknown = {
		...strict,
		senderBinding: undefined,
	} as unknown as StreamingProcess;
	expect(cellularSenderRuntime([unknown], strict.spawnfile).kind).toBe(
		"unknown",
	);
	const exiting = {
		...strict,
		proc: { exitCode: 0, signalCode: null },
	} as unknown as StreamingProcess;
	expect(cellularSenderRuntime([exiting], strict.spawnfile).kind).toBe(
		"unknown",
	);
});
