/**
 * The browser's half of confirming a protected network change: the code is
 * minted here, kept per tab, and presented only from a socket opened after
 * the device's settle floor.
 */
import type { ChangeSafetyConfirmOutput } from "@ceraui/rpc/schemas";
import { confirmationCodeSchema } from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import {
	CONFIRMATION_CODE_STORAGE_KEY,
	type ConfirmDeps,
	confirmFromThisBrowser,
	FLOOR_MARGIN_MS,
	forgetConfirmationCode,
	mintConfirmationCode,
	type PendingChange,
	prepareConfirmation,
	readConfirmationCode,
	rememberConfirmationCode,
} from "./change-confirm";

function memoryStorage() {
	const map = new Map<string, string>();
	return {
		map,
		getItem: (key: string) => map.get(key) ?? null,
		setItem: (key: string, value: string) => {
			map.set(key, value);
		},
		removeItem: (key: string) => {
			map.delete(key);
		},
	};
}

const CODE = mintConfirmationCode();

function world(options: {
	pending?: PendingChange | null;
	openedAt?: number;
	answers?: ChangeSafetyConfirmOutput[];
	code?: boolean;
}) {
	let now = 100_000;
	let openedAt: number | undefined = options.openedAt ?? 90_000;
	const storage = memoryStorage();
	if (options.code !== false) rememberConfirmationCode(storage, CODE, now);
	const log: string[] = [];
	const answers = [...(options.answers ?? [{ success: true }])];
	const deps: ConfirmDeps = {
		storage,
		now: () => now,
		sleep: (ms) => {
			log.push(`sleep:${ms}`);
			now += ms;
			return Promise.resolve();
		},
		pending: async () =>
			options.pending === undefined
				? { id: "tx", msLeft: 80_000, confirmAfterMs: 5_000, canConfirm: true }
				: options.pending,
		socketOpenedAt: () => openedAt,
		reconnect: () => {
			log.push("reconnect");
			openedAt = now;
			return Promise.resolve();
		},
		confirm: (id, code) => {
			log.push(`confirm:${id}:${code === CODE ? "code" : "other"}`);
			return Promise.resolve(
				answers.shift() ?? { success: false, error: "no answer" },
			);
		},
	};
	return { deps, storage, log, now: () => now };
}

describe("the one-time code", () => {
	it("is 32 random bytes in base64url, the shape the device accepts", () => {
		expect(CODE).toHaveLength(43);
		expect(confirmationCodeSchema.safeParse(CODE).success).toBe(true);
		const fixed = mintConfirmationCode((bytes) => bytes.fill(0xff));
		expect(fixed).toBe(`${"_".repeat(42)}8`);
		expect(mintConfirmationCode()).not.toBe(CODE);
	});

	it("is kept per tab and read back only when it is a code", () => {
		const storage = memoryStorage();
		expect(readConfirmationCode(storage)).toBeUndefined();
		rememberConfirmationCode(storage, CODE, 5);
		expect(readConfirmationCode(storage)).toEqual({
			code: CODE,
			requestedAt: 5,
		});
		storage.setItem(CONFIRMATION_CODE_STORAGE_KEY, '{"code":"short"}');
		expect(readConfirmationCode(storage)).toBeUndefined();
		storage.setItem(CONFIRMATION_CODE_STORAGE_KEY, "not json");
		expect(readConfirmationCode(storage)).toBeUndefined();
		forgetConfirmationCode(storage);
		expect(storage.map.size).toBe(0);
	});

	it("an unavailable storage reads as no code", () => {
		const broken = {
			getItem: () => {
				throw new Error("blocked");
			},
			setItem: () => {},
			removeItem: () => {
				throw new Error("blocked");
			},
		};
		expect(readConfirmationCode(broken)).toBeUndefined();
		expect(() => forgetConfirmationCode(broken)).not.toThrow();
	});
});

describe("getting ready to confirm", () => {
	it("waits for the device's floor, then opens a new connection when the current one is older", async () => {
		const w = world({ openedAt: 90_000 });
		const ready = await prepareConfirmation(w.deps);
		expect(w.log).toEqual([`sleep:${5_000 + FLOOR_MARGIN_MS}`, "reconnect"]);
		expect(ready).toEqual({
			kind: "ready",
			id: "tx",
			msLeft: 80_000 - 5_000 - FLOOR_MARGIN_MS,
		});
	});

	it("keeps a socket that already opened after the floor", async () => {
		const w = world({
			openedAt: 200_000,
			pending: {
				id: "tx",
				msLeft: 40_000,
				confirmAfterMs: 0,
				canConfirm: true,
			},
		});
		expect((await prepareConfirmation(w.deps)).kind).toBe("ready");
		expect(w.log).toEqual([]);
	});

	it("a socket that reconnected on its own before the floor is replaced", async () => {
		// The change cut the socket at +2 s and the client reconnected at +3 s:
		// opened after the change, but before the floor.
		const w = world({ openedAt: 100_000 });
		await prepareConfirmation(w.deps);
		expect(w.log).toContain("reconnect");
	});

	it("does nothing without this tab's code, and forgets the code once nothing is pending", async () => {
		expect((await prepareConfirmation(world({ code: false }).deps)).kind).toBe(
			"no-code",
		);
		const gone = world({ pending: null });
		expect((await prepareConfirmation(gone.deps)).kind).toBe("nothing-pending");
		expect(readConfirmationCode(gone.storage)).toBeUndefined();
		const script = world({
			pending: { id: "tx", msLeft: 1, confirmAfterMs: 0, canConfirm: false },
		});
		expect((await prepareConfirmation(script.deps)).kind).toBe(
			"cannot-confirm",
		);
	});
});

describe("confirming from this browser", () => {
	it("presents this tab's code and forgets it once the device keeps the change", async () => {
		const w = world({ answers: [{ success: true, confirmedVia: null }] });
		expect(await confirmFromThisBrowser(w.deps, "tx")).toEqual({
			kind: "kept",
			via: null,
		});
		expect(w.log).toEqual(["confirm:tx:code"]);
		expect(readConfirmationCode(w.storage)).toBeUndefined();
	});

	it("a too_early refusal opens one new connection and tries once more", async () => {
		const w = world({
			answers: [
				{ success: false, refusal: "too_early" },
				{ success: true, confirmedVia: "eth0" },
			],
		});
		expect(await confirmFromThisBrowser(w.deps, "tx")).toEqual({
			kind: "kept",
			via: "eth0",
		});
		expect(w.log).toEqual(["confirm:tx:code", "reconnect", "confirm:tx:code"]);
	});

	it("a final refusal forgets the code; a transport failure keeps it for another try", async () => {
		const refused = world({
			answers: [{ success: false, refusal: "wrong_address" }],
		});
		expect(await confirmFromThisBrowser(refused.deps, "tx")).toEqual({
			kind: "refused",
			reason: "wrong_address",
		});
		expect(readConfirmationCode(refused.storage)).toBeUndefined();
		const failed = world({
			answers: [{ success: false, error: "unavailable" }],
		});
		expect((await confirmFromThisBrowser(failed.deps, "tx")).kind).toBe(
			"failed",
		);
		expect(readConfirmationCode(failed.storage)?.code).toBe(CODE);
	});

	it("without this tab's code, nothing is sent", async () => {
		const w = world({ code: false });
		expect(await confirmFromThisBrowser(w.deps, "tx")).toEqual({
			kind: "no-code",
		});
		expect(w.log).toEqual([]);
	});
});
