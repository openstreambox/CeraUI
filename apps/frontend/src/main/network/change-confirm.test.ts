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
	forgetConfirmationCode,
	mintConfirmationCode,
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

/**
 * A device whose settle floor is at `floorAt` and deadline at 180 000 on the
 * page's clock (the device answers in relative times, as the real one does).
 */
function world(options: {
	pending?: "none" | "cannot-confirm";
	floorAt?: number;
	path?: string;
	openedAt?: number;
	answers?: ChangeSafetyConfirmOutput[];
	code?: boolean;
	/** After this many reads the device reports nothing pending. */
	pendingReads?: number;
}) {
	let now = 100_000;
	let openedAt: number | undefined = options.openedAt ?? 90_000;
	const floorAt = options.floorAt ?? 105_000;
	const storage = memoryStorage();
	if (options.code !== false) rememberConfirmationCode(storage, CODE, now);
	const log: string[] = [];
	const answers = [...(options.answers ?? [{ success: true }])];
	let reads = 0;
	const deps: ConfirmDeps = {
		storage,
		now: () => now,
		sleep: (ms) => {
			log.push(`sleep:${ms}`);
			now += ms;
			return Promise.resolve();
		},
		pending: () => {
			reads++;
			if (
				options.pending === "none" ||
				(options.pendingReads !== undefined && reads > options.pendingReads)
			)
				return Promise.resolve(null);
			return Promise.resolve({
				id: "tx",
				msLeft: Math.max(0, 180_000 - now),
				confirmAfterMs: Math.max(0, floorAt - now),
				floorAgoMs: Math.max(0, now - floorAt),
				path: options.path ?? "own",
				canConfirm: options.pending !== "cannot-confirm",
			});
		},
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
		expect(w.log).toEqual(["sleep:5000", "reconnect"]);
		expect(ready).toEqual({ kind: "ready", id: "tx", msLeft: 75_000 });
	});

	it("keeps a socket that opened after the floor, even when the floor passed long ago", async () => {
		// The floor passed at 95 000; this socket opened at 97 000.
		const w = world({ floorAt: 95_000, openedAt: 97_000 });
		expect((await prepareConfirmation(w.deps)).kind).toBe("ready");
		expect(w.log).toEqual([]);
	});

	it("replaces a socket that opened before a floor that has already passed", async () => {
		const w = world({ floorAt: 95_000, openedAt: 94_000 });
		await prepareConfirmation(w.deps);
		expect(w.log).toEqual(["reconnect"]);
	});

	it("a socket that reconnected on its own before the floor is replaced", async () => {
		// The change cut the socket at +2 s and the client reconnected at +3 s:
		// opened after the change, but before the floor.
		const w = world({ openedAt: 100_000 });
		await prepareConfirmation(w.deps);
		expect(w.log).toContain("reconnect");
	});

	it("on a path the change missed, keeps the tab's own socket", async () => {
		const w = world({ path: "other", openedAt: 50_000 });
		expect((await prepareConfirmation(w.deps)).kind).toBe("ready");
		expect(w.log).toEqual(["sleep:5000"]);
	});

	it("never reports ready for a change that ended while it waited", async () => {
		const w = world({ pendingReads: 1 });
		expect((await prepareConfirmation(w.deps)).kind).toBe("nothing-pending");
	});

	it("does nothing without this tab's code, and forgets the code once nothing is pending", async () => {
		expect((await prepareConfirmation(world({ code: false }).deps)).kind).toBe(
			"no-code",
		);
		const gone = world({ pending: "none" });
		expect((await prepareConfirmation(gone.deps)).kind).toBe("nothing-pending");
		expect(readConfirmationCode(gone.storage)).toBeUndefined();
		const script = world({ pending: "cannot-confirm" });
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

	it("a confirmation that is still being saved is reported as such, not as kept", async () => {
		const w = world({
			answers: [{ success: true, confirmedVia: null, saving: true }],
		});
		expect(await confirmFromThisBrowser(w.deps, "tx")).toEqual({
			kind: "saving",
			via: null,
		});
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
