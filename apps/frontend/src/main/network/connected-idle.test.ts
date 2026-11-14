import { describe, expect, it } from "vitest";
import { buildBond } from "$lib/stores/hud/link-status";
import { ConnectedIdleDetector } from "./connected-idle";
import { links, telemetry } from "./connected-idle-fixture";

function run(
	detector: ConnectedIdleDetector,
	live = true,
	rows = links,
	frame = telemetry(),
) {
	let result: string[] = [];
	for (let t = 0; t <= 20_000; t += 1000)
		result = detector.update(t, live, rows, frame);
	return result;
}
describe("connected idle link", () => {
	it("fires after 20 seconds of fresh quiet samples while a peer carries", () => {
		expect(run(new ConnectedIdleDetector())).toEqual(["eth0"]);
	});
	it("does not fire at startup or during brief dips", () => {
		const d = new ConnectedIdleDetector();
		expect(d.update(0, true, links, telemetry())).toEqual([]);
		expect(d.update(1000, true, links, telemetry())).toEqual([]);
	});
	it("does not fire for a disabled link", () => {
		expect(
			run(
				new ConnectedIdleDetector(),
				true,
				links.map((l, i) => ({ ...l, enabled: i !== 0 })),
			),
		).toEqual([]);
	});
	it("requires a live stream and another carrying link", () => {
		expect(run(new ConnectedIdleDetector(), false)).toEqual([]);
		const frame = telemetry();
		if (!frame.links[1]) throw new Error("Missing peer");
		frame.links[1].bitrate_bps = 0;
		expect(run(new ConnectedIdleDetector(), true, links, frame)).toEqual([]);
	});
	it("clears when traffic resumes", () => {
		const d = new ConnectedIdleDetector();
		run(d);
		expect(d.update(21_000, true, links, telemetry(100_000))).toEqual([]);
	});
	it("does not count missing, stale or unknown measurements", () => {
		const d = new ConnectedIdleDetector();
		d.update(0, true, links, telemetry());
		expect(d.update(20_000, true, links, telemetry())).toEqual([]);
		const frame = telemetry();
		if (!frame.links[0]) throw new Error("Missing link");
		frame.links[0].stale = true;
		expect(run(new ConnectedIdleDetector(), true, links, frame)).toEqual([]);
		frame.links[0].stale = false;
		delete frame.links[0].bitrate_bps;
		expect(run(new ConnectedIdleDetector(), true, links, frame)).toEqual([]);
	});
	it("clears for removal, disconnect and stream stop", () => {
		for (const [live, rows] of [
			[false, links],
			[true, []],
			[true, links.map((l) => ({ ...l, isConnected: false }))],
		] as const) {
			const d = new ConnectedIdleDetector();
			run(d);
			expect(d.update(21_000, live, [...rows], telemetry())).toEqual([]);
		}
	});
	it("resets on counter rollover or bytes proving activity", () => {
		const d = new ConnectedIdleDetector();
		const frame = telemetry();
		if (!frame.links[0]) throw new Error("Missing link");
		frame.links[0].bytes_sent_total = 100;
		run(d, true, links, frame);
		frame.links[0].bytes_sent_total = 10_000;
		expect(d.update(21_000, true, links, frame)).toEqual([]);
		frame.links[0].bytes_sent_total = 0;
		expect(d.update(22_000, true, links, frame)).toEqual([]);
	});
});

it("does not advance the hold on cached timestamps", () => {
	const detector = new ConnectedIdleDetector();
	for (let i = 0; i < 30; i++)
		expect(detector.update(1000, true, links, telemetry())).toEqual([]);
});
it("allows only keepalive-sized traffic and re-arms after a brief dip", () => {
	const detector = new ConnectedIdleDetector();
	expect(run(detector, true, links, telemetry(512))).toEqual(["eth0"]);
	expect(detector.update(21_000, true, links, telemetry(2048))).toEqual([]);
	expect(detector.update(22_000, true, links, telemetry())).toEqual([]);
});

// Delivery is the real 5 s heartbeat with 10% jitter; reads may be quantized to 1 s.
for (const quantized of [false, true]) {
	it(`is stable for ten minutes at heartbeat cadence (quantized=${quantized})`, () => {
		for (let seed = 1; seed <= 100; seed++) {
			let random = seed;
			let delivery = 0;
			let first: number | undefined;
			const quiet = new ConnectedIdleDetector();
			const traffic = new ConnectedIdleDetector();
			for (let _i = 0; delivery < 600_000; _i++) {
				const at = quantized ? Math.floor(delivery / 1000) * 1000 : delivery;
				const shown = quiet
					.update(at, true, links, telemetry())
					.includes("eth0");
				if (shown && first === undefined) first = at;
				if (first !== undefined) expect(shown).toBe(true);
				expect(traffic.update(at, true, links, telemetry(100_000))).toEqual([]);
				random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
				delivery += 4500 + (random / 2 ** 32) * 1000;
			}
			expect(first).toBeGreaterThanOrEqual(20_000);
			expect(first).toBeLessThanOrEqual(25_500);
		}
	});
}
it("holds a shown notice through one missed heartbeat, but resets a new hold", () => {
	const shown = new ConnectedIdleDetector();
	run(shown);
	expect(shown.update(31_000, true, links, telemetry())).toEqual(["eth0"]);
	const starting = new ConnectedIdleDetector();
	starting.update(0, true, links, telemetry());
	starting.update(5000, true, links, telemetry());
	expect(starting.update(16_000, true, links, telemetry())).toEqual([]);
	expect(starting.update(21_000, true, links, telemetry())).toEqual([]);
	expect(shown.update(50_000, true, links, telemetry())).toEqual([]);
});
it("uses a separate recovery threshold to avoid keepalive boundary chatter", () => {
	const d = new ConnectedIdleDetector();
	run(d);
	expect(d.update(25_000, true, links, telemetry(1100))).toEqual(["eth0"]);
	expect(d.update(30_000, true, links, telemetry(2048))).toEqual([]);
	expect(
		run(new ConnectedIdleDetector(), true, links, telemetry(1100)),
	).toEqual([]);
});
for (const [name, change] of [
	[
		"ineligible carrying peer",
		(rows, _frame) => {
			rows.splice(1, 1);
		},
	],
	[
		"stale carrying peer",
		(_rows, frame) => {
			frame.links[1].stale = true;
		},
	],
	[
		"stale link",
		(rows) => {
			rows[0].isStale = true;
		},
	],
	[
		"disconnected state",
		(rows) => {
			rows[0].connectionState = "disconnected";
		},
	],
	[
		"nonfinite rate",
		(_rows, frame) => {
			frame.links[0].bitrate_bps = Number.NaN;
		},
	],
	[
		"missing row",
		(_rows, frame) => {
			frame.links.shift();
		},
	],
] as [
	string,
	(rows: typeof links, frame: ReturnType<typeof telemetry>) => void,
][]) {
	it(`rejects ${name} even with an established hold`, () => {
		const d = new ConnectedIdleDetector();
		run(d);
		const rows = structuredClone(links),
			frame = telemetry();
		change(rows, frame);
		expect(d.update(25_000, true, rows, frame)).toEqual([]);
	});
}
for (const reset of ["identity", "rollback", "backward clock"]) {
	it(`restarts an uninterrupted hold on ${reset}`, () => {
		const d = new ConnectedIdleDetector();
		const frame = telemetry();
		frame.links[0]!.bytes_sent_total = 1000;
		run(d, true, links, frame);
		let at = 25_000;
		if (reset === "identity") frame.links[0]!.conn_id = "new";
		if (reset === "rollback") frame.links[0]!.bytes_sent_total = 0;
		if (reset === "backward clock") at = 19_000;
		expect(d.update(at, true, links, frame)).toEqual([]);
		expect(d.update(at + 5000, true, links, frame)).toEqual([]);
	});
}

it.each(["session opt-out (isBondOptedOut)", "heat-ladder spare rest"])(
	"clears only the rested link on %s",
	() => {
		// Both policies make netIfBuildMsg emit enabled:false; buildBond removes that
		// row rather than publishing a LinkSignal with enabled:false.
		const netif = {
			eth0: { enabled: false, ip: "192.0.2.2", error: "", tp: 0 },
			eth1: { enabled: true, ip: "192.0.2.3", error: "", tp: 1000 },
		};
		const bond = buildBond(undefined, undefined, netif, false, false, false);
		expect(bond.links.map((l) => l.id)).toEqual(["eth1"]);
		const d = new ConnectedIdleDetector();
		run(d);
		expect(d.update(25_000, true, bond.links, telemetry())).toEqual([]);
		expect(d.update(30_000, true, links, telemetry())).toEqual([]);
	},
);

it("does not round fractional traffic into the quiet band", () => {
	expect(
		run(new ConnectedIdleDetector(), true, links, telemetry(1024.5)),
	).toEqual([]);
});

it.each([
	[6250, true],
	[8000, false],
])("pins the initial gap boundary at %i ms", (gap, keeps) => {
	const d = new ConnectedIdleDetector();
	d.update(0, true, links, telemetry());
	d.update(5000, true, links, telemetry());
	d.update(5000 + gap, true, links, telemetry());
	d.update(10000 + gap, true, links, telemetry());
	expect(d.update(15000 + gap, true, links, telemetry())).toEqual(
		keeps ? ["eth0"] : [],
	);
});
it("uses byte-delta recovery hysteresis independently of the reported rate", () => {
	const d = new ConnectedIdleDetector();
	const frame = telemetry();
	frame.links[0]!.bytes_sent_total = 0;
	run(d, true, links, frame);
	frame.links[0]!.bytes_sent_total = 1000; // 1600 bps, below recovery
	expect(d.update(25000, true, links, frame)).toEqual(["eth0"]);
	frame.links[0]!.bytes_sent_total = 2280; // exactly 2048 bps
	expect(d.update(30000, true, links, frame)).toEqual([]);
});

it.each([30000, 40000])(
	"reports actual recoveries in %i ms flap cycles",
	(period) => {
		const d = new ConnectedIdleDetector();
		for (let cycle = 0; cycle < 3; cycle++) {
			const start = cycle * period;
			for (let t = 0; t <= 20000; t += 5000) {
				expect(d.update(start + t, true, links, telemetry())).toEqual(
					t === 20000 ? ["eth0"] : [],
				);
			}
			expect(d.update(start + 25000, true, links, telemetry(100000))).toEqual(
				[],
			);
		}
	},
);
