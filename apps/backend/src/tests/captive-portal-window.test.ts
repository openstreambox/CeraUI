import { expect, mock, test } from "bun:test";
import { createSignInWindow } from "../modules/wifi/captive-portal-window.ts";

test("only the owning phone can cancel; timeout closes before checking", async () => {
	const events: string[] = [];
	let expire: () => void = () => undefined;
	const window = createSignInWindow({
		open: async () => {
			events.push("open");
		},
		close: async () => {
			events.push("close");
		},
		check: async () => {
			events.push("check");
			return false;
		},
		unchanged: async () => true,
		arm: (fn) => {
			expire = fn;
			return () => undefined;
		},
	});
	expect((await window.start("phone", "wifi")).phase).toBe("signing_in");
	await expect(window.start("other", "wifi")).rejects.toThrow();
	await expect(window.finish("other")).rejects.toThrow();
	expire();
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(events).toEqual(["open", "close", "check"]);
	expect(window.status("phone").phase).toBe("needs_sign_in");
});

test("cleanup failure never reports a completed window or runs checks", async () => {
	const window = createSignInWindow({
		open: async () => undefined,
		close: async () => {
			throw Error();
		},
		check: async () => {
			throw Error("must not check");
		},
		unchanged: async () => true,
		arm: () => () => undefined,
	});
	await window.start("phone", "wifi");
	await window.finish("phone");
	expect(window.status("phone").phase).toBe("cleanup_unknown");
	await expect(window.start("phone", "wifi")).rejects.toThrow();
});

test("a changed radio closes the window before any internet claim", async () => {
	const calls: string[] = [];
	const window = createSignInWindow({
		open: async () => undefined,
		close: async () => {
			calls.push("close");
		},
		check: async () => {
			calls.push("check");
			return false;
		},
		unchanged: async () => false,
		arm: () => () => undefined,
	});
	await window.start("phone", "wifi");
	expect((await window.refresh("phone")).phase).toBe("needs_sign_in");
	expect(calls).toEqual(["close", "check"]);
});

test("only the venue health probe is held, including an already pending probe", async () => {
	const { holdPortalInterface, portalHealthProbe } = await import(
		"../modules/wifi/captive-portal-health.ts"
	);
	let resolve: (value: string) => void = () => undefined;
	const pending = portalHealthProbe(
		"venue",
		() =>
			new Promise<string>((r) => {
				resolve = r;
			}),
	);
	const release = holdPortalInterface("venue");
	resolve("success");
	expect(await pending).toBe("captive_portal");
	expect(await portalHealthProbe("healthy", async () => "success")).toBe(
		"success",
	);
	expect(await portalHealthProbe("venue", async () => "success")).toBe(
		"captive_portal",
	);
	release();
	expect(await portalHealthProbe("venue", async () => "success")).toBe(
		"success",
	);
});

test("a late identity read from an older window cannot cancel its successor", async () => {
	let resolve: (value: boolean) => void = () => undefined;
	let closes = 0;
	const window = createSignInWindow({
		open: async () => undefined,
		close: async () => {
			closes++;
		},
		check: async () => false,
		unchanged: () =>
			new Promise<boolean>((r) => {
				resolve = r;
			}),
		arm: () => () => undefined,
	});
	await window.start("phone", "wifi");
	const oldRead = window.refresh("phone");
	await window.finish("phone");
	await window.start("phone", "wifi");
	resolve(false);
	await oldRead;
	expect(closes).toBe(1);
	expect(window.status("phone").phase).toBe("signing_in");
});

test("an uncertain open is closed before failure and remains closable if cleanup fails", async () => {
	const close = mock(async (): Promise<void> => {
		throw Error("cleanup");
	});
	const owner = createSignInWindow({
		open: async () => {
			throw Error("timeout");
		},
		close,
		check: async () => false,
		unchanged: async () => true,
		arm: () => () => {},
	});
	expect((await owner.start("phone", "2")).expiresAt).toBeGreaterThan(
		Date.now(),
	);
	expect(close).toHaveBeenCalledTimes(1);
	expect(owner.status("phone").phase).toBe("cleanup_unknown");
	close.mockImplementation(async () => {});
	expect((await owner.finish("phone")).phase).toBe("needs_sign_in");
});
