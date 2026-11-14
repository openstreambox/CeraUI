import { afterEach, expect, test } from "bun:test";
import { radioHealthListSchema } from "@ceraui/rpc/schemas";
import {
	getRadioHealth,
	radioForModem,
	refreshRadioHealth,
	resetRadioHealthForTest,
} from "../modules/modems/radio-health-runtime.ts";

afterEach(resetRadioHealthForTest);
test("the real sampler publishes explicit unavailable fields and a neighbour delta without any device commands", async () => {
	let bytes = 100;
	const deps = {
		enabled: async () => true,
		registration: () => undefined,
		readNas: async () => ({
			signal: "LTE:\n RSRP: '-101 dBm'\n SNR: '-8 dB'",
			band: "Active band: 'LTE band 3'",
		}),
		readText: async () => String(bytes),
		realpath: async () => "/sys/devices/usb1/1-1/1-1.2/1-1.2:1.4",
		run: async () =>
			JSON.stringify({
				MESSAGE: "usb 1-1.2: reset high-speed USB device",
				__REALTIME_TIMESTAMP: "30000000",
			}),
		health: () => undefined,
		modem: () => undefined,
	};
	const rows = {
		"1": { ifname: "fixture1", stable_key: "port-1" },
		"2": { ifname: "fixture2", stable_key: "port-2" },
	};
	await refreshRadioHealth(rows, 1000, deps);
	bytes = 200;
	await refreshRadioHealth(rows, 31000, deps);
	const result = radioHealthListSchema.parse(getRadioHealth(31000));
	expect(result["1"]?.metrics.lteTxPower?.value).toBeNull();
	expect(result["1"]?.neighbours[0]?.transmitting).toBe("yes");
	expect(result["1"]?.usb.events).toEqual([{ at: 30000, kind: "reset" }]);
	expect(result["1"]?.finding.kind).toBe("unknown");
	expect(result["1"]?.timeline.length).toBe(2);
	expect(radioForModem("1", rows["1"], 31000).timeline).toHaveLength(1);
	expect(getRadioHealth(100000)["1"]?.finding.kind).toBe("unknown");
	expect(getRadioHealth(100000)["1"]?.metrics.rsrp?.reason).toBe(
		"not-observed",
	);
	bytes = 0;
	await refreshRadioHealth(rows, 61000, deps);
	expect(getRadioHealth(61000)["1"]?.neighbours[0]?.transmitting).toBe(
		"unknown",
	);
	await refreshRadioHealth(rows, 90000, {
		...deps,
		enabled: async () => false,
		readNas: async () => {
			throw new Error("disabled sampler issued modem query");
		},
	});
	expect(getRadioHealth(90000)).toEqual({});
	await refreshRadioHealth({}, 91000, deps);
	expect(getRadioHealth(91000)).toEqual({});
});

test("vendor-neutral devices never enter the vendor reader, and replacement drops history", async () => {
	const deps = {
		enabled: async () => true,
		registration: () => undefined,
		readNas: async () => {
			throw new Error("unexpected vendor read");
		},
		readText: async () => "100",
		realpath: async () => "/sys/1-1/1-1:1.4",
		run: async () => "",
		health: () => undefined,
		modem: () => undefined,
	};
	const rows = {
		"1": { ifname: "fixture1", stable_key: "port-1", model: "FM350-GL" },
		"2": { ifname: "fixture2", stable_key: "port-2", model: "DW5821e" },
	};
	await refreshRadioHealth(rows, 1000, deps);
	await refreshRadioHealth(rows, 31000, deps);
	expect(getRadioHealth(31000)["1"]?.timeline.length).toBe(2);
	await refreshRadioHealth(
		{ ...rows, "1": { ...rows["1"], stable_key: "replacement" } },
		61000,
		deps,
	);
	expect(getRadioHealth(61000)["1"]?.timeline.length).toBe(1);
	expect(getRadioHealth(100)["1"]?.registration.value).toBeNull();
	await refreshRadioHealth(
		{ ...rows, "2": { ...rows["2"], availability_reason: "mm-restarting" } },
		91000,
		deps,
	);
	expect(
		getRadioHealth(91000)["1"]?.neighbours.find((n) => n.id === "2")
			?.transmitting,
	).toBe("unknown");
});

test("wire unknowns explicitly replace a missing, stale or differently identified cache", async () => {
	const { radioForModem } = await import(
		"../modules/modems/radio-health-runtime.ts"
	);
	expect(
		radioForModem("1", { ifname: "fixture", stable_key: "new" }, 1000)
			.registration.value,
	).toBeNull();
	const first = radioForModem(
		"1",
		{ ifname: "fixture", stable_key: "new" },
		1000,
	);
	expect(
		radioForModem("1", { ifname: "fixture", stable_key: "new" }, 2000),
	).toEqual(first);
	expect(
		radioForModem(
			"1",
			{ ifname: "fixture", availability_reason: "mm-unavailable" },
			3000,
		).finding.kind,
	).toBe("unknown");
});

test("registration retains its successful owner-read time and expires without another read", async () => {
	const deps = {
		enabled: async () => true,
		registration: () => ({ value: "home", capturedAt: 1000 }),
		readNas: async () => ({ signal: "", band: "" }),
		readText: async () => "0",
		realpath: async () => "/sys/1-1/1-1:1.4",
		run: async () => "",
		health: () => undefined,
		modem: () => undefined,
	};
	const rows = {
		"1": { ifname: "fixture1", stable_key: "port-1", model: "DW5821e" },
	};
	await refreshRadioHealth(rows, 31000, deps);
	expect(getRadioHealth(31000)["1"]?.registration.value).toBe("home");
	expect(getRadioHealth(31000)["1"]?.registration.capturedAt).toBe(1000);
	await refreshRadioHealth(rows, 91000, deps);
	expect(getRadioHealth(91000)["1"]?.registration.value).toBeNull();
	expect(getRadioHealth(91000)["1"]?.finding.kind).toBe("unknown");
});

test("the serving cell is read only on the released AT port, and a refusal says why", async () => {
	const { QENG_LTE_REPLY } = await import("./helpers/fake-at-modem.ts");
	const served: number[] = [];
	const base = {
		enabled: async () => true,
		registration: () => undefined,
		readNas: async () => ({ signal: "", band: "", listed: true }),
		readText: async () => "100",
		realpath: async () => "/sys/1-1/1-1:1.4",
		run: async () => "",
		health: () => undefined,
		modem: () => undefined,
	};
	const rows = {
		"1": { ifname: "fixture1", stable_key: "port-1", model: "RM520N-GL" },
	};
	await refreshRadioHealth(rows, 1000, {
		...base,
		readServing: async (id: number) => {
			served.push(id);
			return { ok: true as const, raw: QENG_LTE_REPLY.replace(/\r\n?/g, "\n") };
		},
	});
	expect(served).toEqual([1]);
	expect(getRadioHealth(1000)["1"]?.layer.source).toBe("QENG servingcell");
	expect(getRadioHealth(1000)["1"]?.metrics.servingCell).toBeUndefined();

	await refreshRadioHealth(rows, 31000, {
		...base,
		readServing: async () => ({
			ok: false as const,
			unavailable: true as const,
			reason: "not-released" as const,
			capturedAt: 1000,
		}),
	});
	const refused = radioHealthListSchema.parse(getRadioHealth(31000))["1"];
	expect(refused?.metrics.servingCell).toMatchObject({
		value: null,
		reason: "not-available",
		source: "QENG servingcell · not available: not-released",
		capturedAt: 1000,
	});

	await refreshRadioHealth(rows, 61000, {
		...base,
		readServing: async () => ({
			ok: false as const,
			unavailable: false as const,
			reason: "timeout" as const,
		}),
	});
	expect(getRadioHealth(61000)["1"]?.metrics.servingCell).toMatchObject({
		value: null,
		reason: "not-reported",
		source: "QENG servingcell · no reading: timeout",
	});

	// Unlisted firmware: no serving-cell read at all.
	await refreshRadioHealth(rows, 91000, {
		...base,
		readNas: async () => ({ signal: "", band: "" }),
		readServing: async () => {
			throw new Error("unlisted firmware reached the AT port");
		},
	});
	expect(getRadioHealth(91000)["1"]?.metrics.servingCell).toBeUndefined();
});

test("binary journal messages cannot stall later USB diagnostics", async () => {
	const deps = {
		enabled: async () => true,
		registration: () => undefined,
		readNas: async () => ({ signal: "", band: "" }),
		readText: async () => "100",
		realpath: async () => "/sys/1-1/1-1:1.4",
		health: () => undefined,
		modem: () => undefined,
		run: async () =>
			[
				JSON.stringify({ MESSAGE: [255, 0], __REALTIME_TIMESTAMP: "1000000" }),
				JSON.stringify({
					MESSAGE: "usb 1-1: reset high-speed USB device",
					__REALTIME_TIMESTAMP: "2000000",
				}),
			].join("\n"),
	};
	await refreshRadioHealth(
		{ "1": { ifname: "fixture1", stable_key: "port-1" } },
		3000,
		deps,
	);
	expect(getRadioHealth(3000)["1"]?.usb.events).toEqual([
		{ at: 2000, kind: "reset" },
	]);
});

test("overlapping refreshes skip immediately and release the guard after failure", async () => {
	let release!: () => void;
	let entered!: () => void;
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const paused = new Promise<void>((resolve) => {
		release = resolve;
	});
	let calls = 0;
	const deps = {
		enabled: async () => {
			calls++;
			entered();
			await paused;
			throw new Error("read failed");
		},
	} as Parameters<typeof refreshRadioHealth>[2];
	const first = refreshRadioHealth({}, 1000, deps);
	await started;
	try {
		const skipped = refreshRadioHealth({}, 2000, deps);
		expect(
			await Promise.race([
				skipped.then(() => true),
				Bun.sleep(100).then(() => false),
			]),
		).toBe(true);
		expect(calls).toBe(1);
	} finally {
		release();
		await expect(first).rejects.toThrow("read failed");
	}
	await refreshRadioHealth({}, 3000, { ...deps, enabled: async () => false });
	expect(getRadioHealth(3000)).toEqual({});
});
