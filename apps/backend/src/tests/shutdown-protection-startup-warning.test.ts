import { afterEach, expect, spyOn, test } from "bun:test";
import { logger } from "../helpers/logger.ts";
import {
	initShutdownProtection,
	resetShutdownProtectionForTest,
	setShutdownProtection,
} from "../modules/system/shutdown-protection.ts";

const STARTUP_WARNING =
	"Shutdown protection unavailable at startup; retaining owners for retry";

function startupWarnings() {
	const warn = spyOn(logger, "warn").mockImplementation(() => logger);
	return {
		count: () =>
			warn.mock.calls.filter(([message]) => message === STARTUP_WARNING).length,
		restore: () => warn.mockRestore(),
	};
}

function deferred() {
	let resolve!: (close: () => void) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<() => void>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

afterEach(() => {
	resetShutdownProtectionForTest();
});

test("a pending logind acquisition at startup is not reported as unavailable", async () => {
	setShutdownProtection("carrying", true);
	const acquisition = deferred();
	const warnings = startupWarnings();
	try {
		initShutdownProtection(() => acquisition.promise);
		expect(warnings.count()).toBe(0);
		acquisition.resolve(() => {});
		await Promise.resolve();
		await Bun.sleep(0);
		expect(warnings.count()).toBe(0);
	} finally {
		warnings.restore();
	}
});

test("a rejected logind acquisition at startup is reported once it settles", async () => {
	setShutdownProtection("encoder", true);
	setShutdownProtection("carrying", true);
	const acquisition = deferred();
	const warnings = startupWarnings();
	try {
		initShutdownProtection(() => acquisition.promise);
		expect(warnings.count()).toBe(0);
		acquisition.reject(Error("logind not answering"));
		await Bun.sleep(0);
		expect(warnings.count()).toBe(1);
	} finally {
		warnings.restore();
	}
});

test("a synchronous acquisition failure at startup is reported at once", () => {
	setShutdownProtection("carrying", true);
	const warnings = startupWarnings();
	try {
		initShutdownProtection(() => {
			throw Error("logind starting");
		});
		expect(warnings.count()).toBe(1);
	} finally {
		warnings.restore();
	}
});

test("an acquisition whose owners left before it settled is not reported", async () => {
	setShutdownProtection("carrying", true);
	const acquisition = deferred();
	const warnings = startupWarnings();
	let closed = 0;
	try {
		initShutdownProtection(() => acquisition.promise);
		setShutdownProtection("carrying", false);
		acquisition.resolve(() => {
			closed++;
		});
		await Bun.sleep(0);
		expect(closed).toBe(1);
		expect(warnings.count()).toBe(0);
	} finally {
		warnings.restore();
	}
});

test("no owner at startup needs no acquisition and logs nothing", () => {
	let attempts = 0;
	const warnings = startupWarnings();
	try {
		initShutdownProtection(() => {
			attempts++;
			return () => {};
		});
		expect(attempts).toBe(0);
		expect(warnings.count()).toBe(0);
	} finally {
		warnings.restore();
	}
});
