/*
 * Fan presence + PWM duty cycle — discovery by TYPE STRING, never by index.
 *
 * Every fixture tree below deliberately numbers its cooling device and its
 * hwmon DIFFERENTLY from the reference Rock 5B+ (measured `cooling_device4` +
 * `hwmon8`), and two of them number the same board differently from each other.
 * That is the point: those indices are registration-order artefacts that were
 * confirmed to SHIFT across a reboot on the reference board, so a collector that
 * still reads the right node under arbitrary numbering is the only one that can
 * be trusted on hardware. A test that used the board's own numbers would pass
 * for a collector that hardcoded them.
 *
 * The other load-bearing assertions are negative: nothing here reports an RPM,
 * and nothing derives a percentage from `cur_state`/`max_state` — those levels
 * index a devicetree table rather than scaling airflow, so that division would
 * fabricate a denominator the hardware never produced.
 */
import { describe, expect, test } from "bun:test";
import { Writable } from "node:stream";
import winston from "winston";
import { logger } from "../helpers/logger.ts";
import { withDeviceType } from "../modules/system/device-detection.ts";
import {
	candidatePwmPaths,
	collectFan,
	coolingDeviceHasDeviceLink,
	correlatePwmFanHwmon,
	discoverPwmFanCoolingDevice,
	FAN_ABSENT,
	FAN_UNKNOWN,
	type FanDeps,
	fanReadingForDuty,
	getFan,
	initFan,
	parsePwmDuty,
	readFanDuty,
	resetFanUnreadableLog,
	setFanLogClockForTest,
} from "../modules/system/fan.ts";

// ─── synthetic sysfs trees ───────────────────────────────────────────────────

const THERMAL = "/sysfs-fixture/class/thermal";
const HWMON = "/sysfs-fixture/class/hwmon";

/**
 * The attributes a cooling device carries BESIDES the `device` backlink. Named
 * once because the whole point of the backlink-less fixtures is that this list
 * is complete — the reference board's `cooling_device4` really does list exactly
 * these and nothing else.
 */
const COOLING_DEVICE_ATTRS = [
	"cur_state",
	"max_state",
	"power",
	"subsystem",
	"type",
	"uevent",
];

type SysfsTree = {
	files: Record<string, string>;
	dirs: Record<string, string[]>;
};

type Harness = {
	deps: FanDeps;
	reads: string[];
	listings: string[];
};

function notFound(path: string): Error {
	return Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
}

function makeHarness(tree: SysfsTree): Harness {
	const reads: string[] = [];
	const listings: string[] = [];
	return {
		reads,
		listings,
		deps: {
			readText: async (path) => {
				reads.push(path);
				const value = tree.files[path];
				if (value === undefined) throw notFound(path);
				return value;
			},
			readDir: async (path) => {
				listings.push(path);
				const entries = tree.dirs[path];
				if (entries === undefined) throw notFound(path);
				return entries;
			},
		},
	};
}

type BoardOptions = {
	/** Deliberately NOT the reference board's 4. */
	coolingIndex: number;
	/** Deliberately NOT the reference board's 8. */
	hwmonIndex: number;
	/** Raw `pwm1` register value; omit to make the node absent. */
	pwm?: string;
	/** Cooling devices that are NOT the fan — the SoC's cpufreq coolers etc. */
	otherCoolingTypes?: Record<number, string>;
};

/**
 * Build one board's thermal + hwmon tree. The shape mirrors the kernel ABI the
 * collector walks: `cooling_device<N>/type`, then that device's `device` symlink
 * target owning `hwmon/hwmon<M>/pwm1`.
 */
function buildBoard(opts: BoardOptions): SysfsTree {
	const others = opts.otherCoolingTypes ?? {};
	const coolingNames = [
		...Object.keys(others).map((index) => `cooling_device${index}`),
		`cooling_device${opts.coolingIndex}`,
	];
	const coolingDir = `${THERMAL}/cooling_device${opts.coolingIndex}`;
	const hwmonRoot = `${coolingDir}/device/hwmon`;

	const files: Record<string, string> = {
		[`${coolingDir}/type`]: "pwm-fan\n",
		// Present in the real tree and deliberately NEVER read: a cooling level is
		// an index into `cooling-levels`, not a fraction of airflow.
		[`${coolingDir}/cur_state`]: "2\n",
		[`${coolingDir}/max_state`]: "6\n",
	};
	for (const [index, type] of Object.entries(others)) {
		files[`${THERMAL}/cooling_device${index}/type`] = `${type}\n`;
	}
	if (opts.pwm !== undefined) {
		files[`${hwmonRoot}/hwmon${opts.hwmonIndex}/pwm1`] = `${opts.pwm}\n`;
	}

	return {
		files,
		dirs: {
			[THERMAL]: [...coolingNames, "thermal_zone0", "thermal_zone1"],
			// This board's driver DID set a parent device, so the backlink exists.
			[coolingDir]: [...COOLING_DEVICE_ATTRS, "device"],
			[hwmonRoot]: [`hwmon${opts.hwmonIndex}`],
		},
	};
}

/**
 * The reference Rock 5B+ shape on `7.1.5-ceralive-rk3588`: a `pwm-fan` cooling
 * device with NO `device` entry at all — omitted from the listing exactly as the
 * kernel omits it, not merely made to throw — and the hwmon reachable only by
 * its own `name`.
 */
function buildBacklinklessBoard(opts: {
	coolingIndex: number;
	hwmons: Array<{ index: number; name: string; pwm?: string }>;
}): SysfsTree {
	const coolingDir = `${THERMAL}/cooling_device${opts.coolingIndex}`;
	const files: Record<string, string> = {
		[`${coolingDir}/type`]: "pwm-fan\n",
		[`${coolingDir}/cur_state`]: "1\n",
		[`${coolingDir}/max_state`]: "6\n",
	};
	for (const hwmon of opts.hwmons) {
		files[`${HWMON}/hwmon${hwmon.index}/name`] = `${hwmon.name}\n`;
		if (hwmon.pwm !== undefined) {
			files[`${HWMON}/hwmon${hwmon.index}/pwm1`] = `${hwmon.pwm}\n`;
		}
	}

	return {
		files,
		dirs: {
			[THERMAL]: [`cooling_device${opts.coolingIndex}`, "thermal_zone0"],
			[coolingDir]: COOLING_DEVICE_ATTRS,
			[HWMON]: opts.hwmons.map((hwmon) => `hwmon${hwmon.index}`),
		},
	};
}

/** A board with a thermal class but no `pwm-fan` anywhere — the x86-minipc shape. */
function buildFanlessBoard(): SysfsTree {
	return {
		files: {
			[`${THERMAL}/cooling_device0/type`]: "thermal-cpufreq-0\n",
			[`${THERMAL}/cooling_device1/type`]: "thermal-devfreq-0\n",
		},
		dirs: {
			[THERMAL]: ["cooling_device0", "cooling_device1", "thermal_zone0"],
		},
	};
}

// ─── pure parsers ────────────────────────────────────────────────────────────

describe("parsePwmDuty", () => {
	test("derives the percentage from the register's own full scale (255)", () => {
		expect(parsePwmDuty("0\n")).toBe(0);
		expect(parsePwmDuty("120\n")).toBe(47.1);
		expect(parsePwmDuty("255\n")).toBe(100);
	});

	test("covers every level of the board's real cooling-levels table", () => {
		// `cooling-levels = <0 120 150 180 210 240 255>` — but each is read as a
		// PWM register value, never as an index divided by its max.
		expect(
			[0, 120, 150, 180, 210, 240, 255].map(String).map(parsePwmDuty),
		).toEqual([0, 47.1, 58.8, 70.6, 82.4, 94.1, 100]);
	});

	test("REFUSES an out-of-range register rather than clamping it", () => {
		expect(parsePwmDuty("256")).toBeNull();
		expect(parsePwmDuty("-1")).toBeNull();
		expect(parsePwmDuty("n/a")).toBeNull();
		expect(parsePwmDuty("   ")).toBeNull();
	});
});

describe("fanReadingForDuty", () => {
	test("a MEASURED zero is `off`, never a gap", () => {
		expect(fanReadingForDuty(0)).toEqual({ state: "off", dutyPercent: 0 });
	});

	test("anything above zero is `running` with its own figure", () => {
		expect(fanReadingForDuty(47.1)).toEqual({
			state: "running",
			dutyPercent: 47.1,
		});
	});
});

// ─── discovery is by type string, never by index ─────────────────────────────

describe("discovery", () => {
	test("finds the fan under an index nothing hardcoded", async () => {
		const h = makeHarness(
			buildBoard({ coolingIndex: 9, hwmonIndex: 12, pwm: "120" }),
		);
		expect(await discoverPwmFanCoolingDevice(h.deps, THERMAL)).toEqual({
			kind: "found",
			coolingDir: `${THERMAL}/cooling_device9`,
		});
	});

	test("the SAME board renumbered across a reboot reads identically", async () => {
		// The reference board's indices were confirmed to shift after a reboot.
		const before = makeHarness(
			buildBoard({ coolingIndex: 1, hwmonIndex: 0, pwm: "180" }),
		);
		const after = makeHarness(
			buildBoard({ coolingIndex: 9, hwmonIndex: 12, pwm: "180" }),
		);
		expect(await collectFan(before.deps, THERMAL)).toEqual(
			await collectFan(after.deps, THERMAL),
		);
	});

	test("never adopts a cooling device that is not typed `pwm-fan`", async () => {
		const h = makeHarness(
			buildBoard({
				coolingIndex: 9,
				hwmonIndex: 12,
				pwm: "120",
				otherCoolingTypes: { 0: "thermal-cpufreq-0", 1: "thermal-devfreq-0" },
			}),
		);
		const discovery = await discoverPwmFanCoolingDevice(h.deps, THERMAL);
		expect(discovery).toEqual({
			kind: "found",
			coolingDir: `${THERMAL}/cooling_device9`,
		});
	});

	test("one unreadable `type` node degrades only that candidate", async () => {
		const tree = buildBoard({ coolingIndex: 9, hwmonIndex: 12, pwm: "120" });
		tree.dirs[THERMAL] = ["cooling_device0", ...(tree.dirs[THERMAL] ?? [])];
		// cooling_device0 has no `type` file at all.
		expect(await collectFan(makeHarness(tree).deps, THERMAL)).toEqual({
			state: "running",
			dutyPercent: 47.1,
		});
	});

	test("resolves the hwmon by listing, never by a guessed index", async () => {
		const h = makeHarness(
			buildBoard({ coolingIndex: 9, hwmonIndex: 12, pwm: "120" }),
		);
		expect(
			await candidatePwmPaths(h.deps, `${THERMAL}/cooling_device9`),
		).toEqual([
			`${THERMAL}/cooling_device9/device/hwmon/hwmon12/pwm1`,
			`${THERMAL}/cooling_device9/device/pwm1`,
		]);
	});
});

// ─── the four states ─────────────────────────────────────────────────────────

describe("collectFan", () => {
	test("present + real duty ⇒ running", async () => {
		const h = makeHarness(
			buildBoard({ coolingIndex: 9, hwmonIndex: 12, pwm: "120" }),
		);
		expect(await collectFan(h.deps, THERMAL)).toEqual({
			state: "running",
			dutyPercent: 47.1,
		});
	});

	test("present + zero duty ⇒ off, because a measured zero IS a reading", async () => {
		const h = makeHarness(
			buildBoard({ coolingIndex: 1, hwmonIndex: 0, pwm: "0" }),
		);
		expect(await collectFan(h.deps, THERMAL)).toEqual({
			state: "off",
			dutyPercent: 0,
		});
	});

	test("no `pwm-fan` cooling device at all ⇒ absent, never hidden", async () => {
		const h = makeHarness(buildFanlessBoard());
		expect(await collectFan(h.deps, THERMAL)).toEqual(FAN_ABSENT);
	});

	test("no thermal class at all ⇒ absent — a provable board shape", async () => {
		const h = makeHarness({ files: {}, dirs: {} });
		expect(await collectFan(h.deps, THERMAL)).toEqual(FAN_ABSENT);
	});

	test("an unreadable thermal class ⇒ unknown, NOT absent", async () => {
		const h = makeHarness({ files: {}, dirs: {} });
		h.deps.readDir = async () => {
			throw Object.assign(new Error("EACCES"), { code: "EACCES" });
		};
		expect(await collectFan(h.deps, THERMAL)).toEqual(FAN_UNKNOWN);
	});

	test("a present fan whose pwm1 node is missing ⇒ unknown, not off", async () => {
		const h = makeHarness(buildBoard({ coolingIndex: 9, hwmonIndex: 12 }));
		expect(await collectFan(h.deps, THERMAL)).toEqual(FAN_UNKNOWN);
	});

	test("a pwm1 that throws mid-read ⇒ unknown, and the tick survives", async () => {
		const tree = buildBoard({ coolingIndex: 9, hwmonIndex: 12, pwm: "120" });
		const h = makeHarness(tree);
		const readText = h.deps.readText;
		h.deps.readText = async (path) => {
			if (path.endsWith("/pwm1")) {
				throw Object.assign(new Error("EACCES"), { code: "EACCES" });
			}
			return readText(path);
		};
		expect(await collectFan(h.deps, THERMAL)).toEqual(FAN_UNKNOWN);
	});

	test("an out-of-range register falls through to unknown, never a clamp", async () => {
		const h = makeHarness(
			buildBoard({ coolingIndex: 9, hwmonIndex: 12, pwm: "9999" }),
		);
		expect(await collectFan(h.deps, THERMAL)).toEqual(FAN_UNKNOWN);
	});

	test("a hwmon directory that cannot be listed still tries the platform node", async () => {
		const tree = buildBoard({ coolingIndex: 9, hwmonIndex: 12 });
		tree.dirs = { [THERMAL]: tree.dirs[THERMAL] ?? [] };
		tree.files[`${THERMAL}/cooling_device9/device/pwm1`] = "240\n";
		expect(await collectFan(makeHarness(tree).deps, THERMAL)).toEqual({
			state: "running",
			dutyPercent: 94.1,
		});
	});

	test("a wholly throwing deps surface degrades instead of crashing", async () => {
		const h = makeHarness({ files: {}, dirs: {} });
		h.deps.readDir = async () => {
			throw new Error("EIO");
		};
		h.deps.readText = async () => {
			throw new Error("EIO");
		};
		expect(await collectFan(h.deps, THERMAL)).toEqual(FAN_UNKNOWN);
	});
});

// ─── the backlink-less kernel (board-confirmed on 7.1.5-ceralive-rk3588) ─────

describe("a cooling device with no `device` backlink", () => {
	test("reads the running fan through the hwmon `name` correlation", async () => {
		// Verbatim reproduction of the reference board: cooling_device4 typed
		// `pwm-fan` with no `device` entry, hwmon8 named `pwmfan` at pwm1=120. No
		// other fixture in this suite uses these indices, so the genericity locks
		// above still bind — a collector hardcoding 4/8 fails every other test.
		const h = makeHarness(
			buildBacklinklessBoard({
				coolingIndex: 4,
				hwmons: [{ index: 8, name: "pwmfan", pwm: "120" }],
			}),
		);
		expect(await collectFan(h.deps, THERMAL, HWMON)).toEqual({
			state: "running",
			dutyPercent: 47.1,
		});
	});

	test("a measured zero still reads as `off` through the same path", async () => {
		const h = makeHarness(
			buildBacklinklessBoard({
				coolingIndex: 2,
				hwmons: [{ index: 5, name: "pwmfan", pwm: "0" }],
			}),
		);
		expect(await collectFan(h.deps, THERMAL, HWMON)).toEqual({
			state: "off",
			dutyPercent: 0,
		});
	});

	test("an hwmon named something ELSE is never adopted", async () => {
		const h = makeHarness(
			buildBacklinklessBoard({
				coolingIndex: 2,
				hwmons: [
					{ index: 5, name: "cpu_thermal", pwm: "120" },
					{ index: 6, name: "rk3588_pmic", pwm: "255" },
				],
			}),
		);
		expect(await collectFan(h.deps, THERMAL, HWMON)).toEqual(FAN_UNKNOWN);
	});

	test("TWO hwmons named `pwmfan` are ambiguous ⇒ unknown, never a guess", async () => {
		const h = makeHarness(
			buildBacklinklessBoard({
				coolingIndex: 2,
				hwmons: [
					{ index: 5, name: "pwmfan", pwm: "120" },
					{ index: 6, name: "pwmfan", pwm: "255" },
				],
			}),
		);
		expect(await correlatePwmFanHwmon(h.deps, HWMON)).toEqual({
			kind: "ambiguous",
			matches: [`${HWMON}/hwmon5`, `${HWMON}/hwmon6`],
		});
		expect(await collectFan(h.deps, THERMAL, HWMON)).toEqual(FAN_UNKNOWN);
	});

	test("the fallback stays GATED on a confirmed `pwm-fan` cooling device", async () => {
		// A board with a `pwmfan` hwmon but no pwm-fan cooling device is still
		// `absent` — the scan must never become "find any fan on the system".
		const tree = buildFanlessBoard();
		tree.dirs[HWMON] = ["hwmon5"];
		tree.files[`${HWMON}/hwmon5/name`] = "pwmfan\n";
		tree.files[`${HWMON}/hwmon5/pwm1`] = "120\n";
		expect(await collectFan(makeHarness(tree).deps, THERMAL, HWMON)).toEqual(
			FAN_ABSENT,
		);
	});

	test("a backlink that EXISTS but whose pwm1 failed does NOT start the scan", async () => {
		// The distinction the gate draws: a read failure under a link we already
		// trust is `unknown`. Scanning here could adopt a different fan entirely.
		const tree = buildBoard({ coolingIndex: 9, hwmonIndex: 12 });
		tree.dirs[HWMON] = ["hwmon5"];
		tree.files[`${HWMON}/hwmon5/name`] = "pwmfan\n";
		tree.files[`${HWMON}/hwmon5/pwm1`] = "120\n";
		const h = makeHarness(tree);
		expect(await collectFan(h.deps, THERMAL, HWMON)).toEqual(FAN_UNKNOWN);
		expect(h.reads).not.toContain(`${HWMON}/hwmon5/pwm1`);
	});

	test("correlation never keys on an hwmon index", async () => {
		const low = makeHarness(
			buildBacklinklessBoard({
				coolingIndex: 1,
				hwmons: [{ index: 0, name: "pwmfan", pwm: "210" }],
			}),
		);
		const high = makeHarness(
			buildBacklinklessBoard({
				coolingIndex: 11,
				hwmons: [{ index: 31, name: "pwmfan", pwm: "210" }],
			}),
		);
		expect(await collectFan(low.deps, THERMAL, HWMON)).toEqual(
			await collectFan(high.deps, THERMAL, HWMON),
		);
	});
});

describe("coolingDeviceHasDeviceLink", () => {
	test("distinguishes a listed backlink from a board that has none", async () => {
		const withLink = makeHarness(
			buildBoard({ coolingIndex: 9, hwmonIndex: 12, pwm: "120" }),
		);
		const without = makeHarness(
			buildBacklinklessBoard({
				coolingIndex: 4,
				hwmons: [{ index: 8, name: "pwmfan", pwm: "120" }],
			}),
		);
		expect(
			await coolingDeviceHasDeviceLink(
				withLink.deps,
				`${THERMAL}/cooling_device9`,
			),
		).toBe(true);
		expect(
			await coolingDeviceHasDeviceLink(
				without.deps,
				`${THERMAL}/cooling_device4`,
			),
		).toBe(false);
	});
});

describe("readFanDuty", () => {
	test("prefers the hwmon node and falls back to the platform one", async () => {
		const tree = buildBoard({ coolingIndex: 9, hwmonIndex: 12, pwm: "150" });
		tree.files[`${THERMAL}/cooling_device9/device/pwm1`] = "255\n";
		expect(
			await readFanDuty(makeHarness(tree).deps, `${THERMAL}/cooling_device9`),
		).toBe(58.8);
	});
});

// ─── the emulated-host gate ──────────────────────────────────────────────────

describe("the emulated-host gate", () => {
	test("an emulated host reads NOTHING and publishes NOTHING", async () => {
		const h = makeHarness(
			buildBoard({ coolingIndex: 9, hwmonIndex: 12, pwm: "120" }),
		);
		await withDeviceType("emulated", async () => {
			await initFan(h.deps);
		});
		expect(h.reads).toEqual([]);
		expect(h.listings).toEqual([]);
		// Not `absent` either — that would be a claim about hardware this host
		// does not have. The silence itself is the real-vs-mock seam.
		expect(getFan()).toEqual(FAN_UNKNOWN);
	});
});

// ─── negative locks: no RPM, no fabricated denominator ───────────────────────

describe("no path invents a fan speed", () => {
	test("the module exports no rpm-shaped helper", async () => {
		const module = await import("../modules/system/fan.ts");
		for (const name of Object.keys(module)) {
			expect(name).not.toMatch(/rpm|revolution|tacho/i);
		}
	});

	test("the module source never reads cur_state or max_state", async () => {
		// `cur_state / max_state` is an INDEX over a devicetree table, not a
		// fraction of airflow: publishing it as a percentage is the fabricated
		// denominator this signal exists to avoid.
		const source = await Bun.file(
			new URL("../modules/system/fan.ts", import.meta.url).pathname,
		).text();
		const code = source
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/^\s*\/\/.*$/gm, "");
		expect(code).not.toMatch(/cur_state|max_state/);
	});

	test("a running reading carries a duty and nothing resembling a speed", async () => {
		const h = makeHarness(
			buildBoard({ coolingIndex: 9, hwmonIndex: 12, pwm: "210" }),
		);
		const reading = await collectFan(h.deps, THERMAL);
		expect(JSON.stringify(reading)).not.toMatch(/rpm/i);
		expect(reading).toEqual({ state: "running", dutyPercent: 82.4 });
	});

	test("the cooling-level nodes are present in the fixture and never touched", async () => {
		const h = makeHarness(
			buildBoard({ coolingIndex: 9, hwmonIndex: 12, pwm: "120" }),
		);
		await collectFan(h.deps, THERMAL);
		expect(h.reads.some((path) => /cur_state|max_state/.test(path))).toBe(
			false,
		);
	});
});

describe("unreadable-path logging", () => {
	// Capture debug records from the shared logger through a real Stream
	// transport, so winston's level filter runs as it does on a device.
	async function debugMessages(run: () => Promise<void>): Promise<string[]> {
		const messages: string[] = [];
		const capture = winston.format((info) => {
			const path = (info as { path?: unknown }).path;
			messages.push(
				typeof path === "string"
					? `${info.message} ${path}`
					: String(info.message),
			);
			return info;
		});
		const transport = new winston.transports.Stream({
			stream: new Writable({
				write(_chunk, _enc, cb) {
					cb();
				},
			}),
			level: "debug",
			format: capture(),
		});
		logger.add(transport);
		try {
			await run();
			await new Promise((resolve) => setTimeout(resolve, 15));
		} finally {
			logger.remove(transport);
		}
		return messages.filter((m) => m.startsWith("fan: "));
	}

	test("the reference board's missing backlink paths are logged once, not every tick", async () => {
		resetFanUnreadableLog();
		const h = makeHarness(
			buildBacklinklessBoard({
				coolingIndex: 11,
				hwmons: [{ index: 3, name: "pwmfan", pwm: "120" }],
			}),
		);
		const coolingDir = `${THERMAL}/cooling_device11`;
		const messages = await debugMessages(async () => {
			for (let tick = 0; tick < 5; tick++) {
				expect(await readFanDuty(h.deps, coolingDir, HWMON)).toBe(47.1);
			}
		});
		expect(messages).toEqual([
			"fan: hwmon directory unreadable",
			`fan: pwm1 unreadable ${coolingDir}/device/pwm1`,
		]);
	});

	test("a path that recovers and fails again is logged again", async () => {
		resetFanUnreadableLog();
		const tree = buildBoard({ coolingIndex: 5, hwmonIndex: 2, pwm: "200" });
		const h = makeHarness(tree);
		const coolingDir = `${THERMAL}/cooling_device5`;
		const pwm = `${coolingDir}/device/hwmon/hwmon2/pwm1`;
		const messages = await debugMessages(async () => {
			await readFanDuty(h.deps, coolingDir, HWMON);
			delete tree.files[pwm];
			await readFanDuty(h.deps, coolingDir, HWMON);
			await readFanDuty(h.deps, coolingDir, HWMON);
			tree.files[pwm] = "200\n";
			await readFanDuty(h.deps, coolingDir, HWMON);
			delete tree.files[pwm];
			await readFanDuty(h.deps, coolingDir, HWMON);
		});
		// Logged when it first fails, silent while it stays failed, logged again
		// after a successful read in between. The platform fallback node never
		// read successfully, so it stays logged once.
		expect(messages).toEqual([
			`fan: pwm1 unreadable ${pwm}`,
			`fan: pwm1 unreadable ${coolingDir}/device/pwm1`,
			`fan: pwm1 unreadable ${pwm}`,
		]);
	});

	test("the same errno with a different message is a new diagnostic", async () => {
		resetFanUnreadableLog();
		const coolingDir = `${THERMAL}/cooling_device7`;
		let reads = 0;
		const deps: FanDeps = {
			// A backlink exists, so only the direct candidates are read.
			readDir: async (path) => {
				if (path === coolingDir) return ["cur_state", "device"];
				throw Object.assign(new Error(`EIO: ${path}`), { code: "EIO" });
			},
			// Same errno each time; the message changes after the second read,
			// as when a replacement device reuses the sysfs path.
			readText: async (path) => {
				reads++;
				const which = reads <= 2 ? "first device" : "replacement";
				throw Object.assign(new Error(`EIO: ${path} (${which})`), {
					code: "EIO",
				});
			},
		};
		const messages = await debugMessages(async () => {
			for (let tick = 0; tick < 4; tick++) {
				expect(await readFanDuty(deps, coolingDir, HWMON)).toBeNull();
			}
		});
		expect(
			messages.filter((m) => m.startsWith("fan: pwm1 unreadable")),
		).toEqual([
			`fan: pwm1 unreadable ${coolingDir}/device/pwm1`,
			`fan: pwm1 unreadable ${coolingDir}/device/pwm1`,
		]);
	});

	test("a failure that persists is logged again after the suppression window", async () => {
		resetFanUnreadableLog();
		let now = 1_000_000;
		setFanLogClockForTest(() => now);
		try {
			const h = makeHarness(
				buildBacklinklessBoard({
					coolingIndex: 11,
					hwmons: [{ index: 3, name: "pwmfan", pwm: "120" }],
				}),
			);
			const coolingDir = `${THERMAL}/cooling_device11`;
			const messages = await debugMessages(async () => {
				await readFanDuty(h.deps, coolingDir, HWMON);
				now += 9 * 60_000;
				await readFanDuty(h.deps, coolingDir, HWMON);
				now += 2 * 60_000;
				await readFanDuty(h.deps, coolingDir, HWMON);
			});
			expect(
				messages.filter((m) => m === "fan: hwmon directory unreadable").length,
			).toBe(2);
		} finally {
			setFanLogClockForTest();
		}
	});

	test("the re-log window runs on a monotonic clock, not the wall clock", async () => {
		resetFanUnreadableLog();
		const coolingDir = `${THERMAL}/cooling_device11`;
		const h = makeHarness(
			buildBacklinklessBoard({
				coolingIndex: 11,
				hwmons: [{ index: 3, name: "pwmfan", pwm: "120" }],
			}),
		);
		const realDateNow = Date.now;
		let wall = 10_000_000;
		Date.now = () => wall;
		let mono = 5_000;
		setFanLogClockForTest(() => mono);
		try {
			const messages = await debugMessages(async () => {
				await readFanDuty(h.deps, coolingDir, HWMON);
				// Time sync steps the wall clock back an hour; 10 real minutes pass.
				wall -= 60 * 60_000;
				mono += 10 * 60_000;
				await readFanDuty(h.deps, coolingDir, HWMON);
			});
			expect(
				messages.filter((m) => m === "fan: hwmon directory unreadable").length,
			).toBe(2);
		} finally {
			Date.now = realDateNow;
			setFanLogClockForTest();
		}
	});

	test("the default clock for the re-log window is performance.now", async () => {
		const src = await Bun.file(
			new URL("../modules/system/fan.ts", import.meta.url),
		).text();
		expect(src).toContain(
			"let fanLogNow: () => number = () => performance.now();",
		);
		expect(src).not.toMatch(/fanLogNow\s*=\s*now \?\? Date\.now/);
	});

	test("an unreadable correlated pwm1 is logged once, not every tick", async () => {
		resetFanUnreadableLog();
		const h = makeHarness(
			buildBacklinklessBoard({
				coolingIndex: 11,
				hwmons: [{ index: 3, name: "pwmfan" }],
			}),
		);
		const coolingDir = `${THERMAL}/cooling_device11`;
		const messages = await debugMessages(async () => {
			for (let tick = 0; tick < 5; tick++) {
				expect(await readFanDuty(h.deps, coolingDir, HWMON)).toBeNull();
			}
		});
		expect(
			messages.filter((m) => m.startsWith("fan: correlated pwm1 unreadable"))
				.length,
		).toBe(1);
	});

	test("a cooling device with no correlating hwmon is logged once, not every tick", async () => {
		resetFanUnreadableLog();
		const h = makeHarness(
			buildBacklinklessBoard({
				coolingIndex: 11,
				hwmons: [{ index: 3, name: "cpu_thermal" }],
			}),
		);
		const coolingDir = `${THERMAL}/cooling_device11`;
		const messages = await debugMessages(async () => {
			for (let tick = 0; tick < 5; tick++) {
				expect(await readFanDuty(h.deps, coolingDir, HWMON)).toBeNull();
			}
		});
		expect(
			messages.filter((m) =>
				m.startsWith("fan: no hwmon correlates to the pwm-fan cooling device"),
			).length,
		).toBe(1);
	});
});
