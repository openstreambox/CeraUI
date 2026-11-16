import { afterEach, expect, test } from "bun:test";
import {
	clearMutationRollbacks,
	registerModemConfigInverse,
	resetMutationCaptureDeps,
	rollbackMutation,
	setMutationCaptureDeps,
} from "./mutation-rollback.ts";

afterEach(() => {
	clearMutationRollbacks();
	resetMutationCaptureDeps();
});
test("an inhibited or missing MM object cannot stand in for an internal context inverse", async () => {
	let captured = 0;
	setMutationCaptureDeps({
		enumerate: async () => {
			captured++;
			return [];
		},
	});
	const before = {
		format: "cellular-internal-context-v1",
		unit: "a".repeat(64),
	};
	registerModemConfigInverse("cellular-internal-context-v1", {
		rollback: async () => "failed",
	});
	expect(await rollbackMutation("modem-config", "synthetic-key", before)).toBe(
		"failed",
	);
	expect(captured).toBe(0);
	clearMutationRollbacks();
	expect(await rollbackMutation("modem-config", "synthetic-key", before)).toBe(
		"failed",
	);
	expect(captured).toBe(0);
});
test("format-specific inverse dispatch preserves generic modem configuration handlers", async () => {
	const { registerMutationRollback } = await import("./mutation-rollback.ts");
	let generic = 0;
	registerMutationRollback("modem-config", {
		rollback: async () => {
			generic++;
			return "restored";
		},
	});
	registerModemConfigInverse("cellular-internal-context-v1", {
		rollback: async () => "failed",
	});
	expect(
		await rollbackMutation("modem-config", "synthetic-key", {
			format: "cellular-internal-context-v1",
		}),
	).toBe("failed");
	expect(generic).toBe(0);
});
