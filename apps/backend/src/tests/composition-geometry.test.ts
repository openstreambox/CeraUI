/**
 * Free placement of the second picture input (`composition.rect`).
 *
 * The device decides the composition a placement writes: a `composition_rect`
 * delta is composed on the composition the device has saved at that moment, in
 * the same synchronous write, so quick placements and a stale second tab
 * compose with every other change instead of overwriting it. A rectangle is
 * accepted only with the `custom` layout, only when the engine advertises
 * `composition-geometry`, and only when it fits the frame.
 */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ChangeConfigParams,
	type GetCapabilitiesResult,
	SCHEMA_VERSION,
} from "@ceralive/cerastream";
import type { StreamingSetConfigInput } from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";
import {
	getConfig,
	getConfigFilePath,
	setConfigFilePath,
} from "../modules/config.ts";
import {
	clearCapabilitiesCache,
	invalidateCapabilities,
} from "../modules/streaming/capabilities.ts";
import { cerastreamBackend } from "../modules/streaming/cerastream-backend.ts";
import {
	changeEngineRuntimeConfig,
	createApplyNowGate,
	setApplyNowGateForTest,
} from "../modules/streaming/config-change-bridge.ts";
import {
	clearStagedConfigChange,
	defaultStagingDeps,
} from "../modules/streaming/config-change-staging.ts";
import { initPipelines } from "../modules/streaming/pipelines.ts";
import {
	postStartFeatureNotice,
	resetStartFeatureNoticeForTest,
	START_FEATURES_NOTIFICATION,
	type StartFeatureNoticeBridge,
} from "../modules/streaming/start-feature-notice.ts";
import { setConfigProcedure } from "../rpc/procedures/streaming.procedure.ts";
import { makeRpcContext } from "./helpers/bond-toggle-fixture.ts";

const CAPS: GetCapabilitiesResult = {
	platform: {
		supports_h265: true,
		hardware_accelerated: true,
		max_resolution: "2160p",
	},
	encoder: {
		codecs: ["h264", "h265"],
		bitrate_range: { min: 500, max: 50000, unit: "kbps" },
	},
	sources: [],
};
const GEOMETRY = ["composition", "composition-geometry"];

const SAVED = {
	secondary_input_id: "camera-b",
	layout: "pip-top-right",
	alpha: 0.4,
} as const;
const PLACED = { x: 0.05, y: 0.45, width: 0.5, height: 0.5 };
const placedAt = (rect: typeof PLACED) =>
	({ ...SAVED, layout: "custom", rect }) as const;

let directory: string;
let previousPath: string;
let previousConfig: ReturnType<typeof getConfig>;

async function engineFeatures(features: string[]): Promise<void> {
	clearCapabilitiesCache();
	await initPipelines({
		fetchEngineCapabilities: async () => ({
			caps: { ...CAPS, features },
			schemaVersion: SCHEMA_VERSION,
		}),
		fetchEngineDevices: async () => ({ devices: [] }),
	});
}

const save = (input: StreamingSetConfigInput) =>
	call(setConfigProcedure, input, { context: makeRpcContext() });
const disk = async () =>
	(await Bun.file(getConfigFilePath()).exists())
		? ((await Bun.file(getConfigFilePath()).json()) as Record<string, unknown>)
		: {};

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "composition-geometry-"));
	previousPath = getConfigFilePath();
	previousConfig = structuredClone(getConfig());
	setConfigFilePath(join(directory, "config.json"));
	getConfig().composition = { ...SAVED };
	spyOn(defaultStagingDeps, "writeMarker").mockImplementation(() => {});
	spyOn(defaultStagingDeps, "removeMarker").mockImplementation(() => {});
	await engineFeatures(GEOMETRY);
});

afterEach(async () => {
	setApplyNowGateForTest(null);
	clearStagedConfigChange();
	spyOn(defaultStagingDeps, "writeMarker").mockRestore();
	spyOn(defaultStagingDeps, "removeMarker").mockRestore();
	clearCapabilitiesCache();
	for (const key of Object.keys(getConfig()))
		Reflect.deleteProperty(getConfig(), key);
	Object.assign(getConfig(), previousConfig);
	setConfigFilePath(previousPath);
	await rm(directory, { recursive: true, force: true });
});

test("a rectangle without the composition-geometry capability is refused before anything is written", async () => {
	await engineFeatures(["composition"]);
	for (const input of [
		{ composition_rect: PLACED },
		{ composition: { ...SAVED, layout: "custom", rect: PLACED } },
		{ composition: { ...SAVED, layout: "custom" } },
	] satisfies StreamingSetConfigInput[]) {
		expect(await save(input)).toMatchObject({
			success: false,
			error: "composition_geometry_unsupported",
		});
	}
	expect(getConfig().composition).toEqual(SAVED);
	expect(await disk()).toEqual({});
});

test("a placement is composed on the device's own saved composition", async () => {
	const result = await save({ composition_rect: PLACED });
	const placed = placedAt(PLACED);
	expect(result).toMatchObject({
		success: true,
		applied: { composition: placed },
	});
	expect(getConfig().composition).toEqual(placed);
	expect((await disk()).composition).toEqual(placed);
});

test("quick placements and a stale second tab compose with the device's newer saved values", async () => {
	await save({ composition_rect: PLACED });
	// Another tab changes the opacity and the second input after this one last heard the config.
	await save({
		composition: {
			secondary_input_id: "camera-c",
			layout: "custom",
			alpha: 0.9,
		},
	});
	// The stale tab's next placement, then a quicker one right behind it.
	await save({ composition_rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.3 } });
	await save({ composition_rect: { x: 0.6, y: 0.6, width: 0.4, height: 0.4 } });
	expect(getConfig().composition).toEqual({
		secondary_input_id: "camera-c",
		layout: "custom",
		alpha: 0.9,
		rect: { x: 0.6, y: 0.6, width: 0.4, height: 0.4 },
	});
});

test("a custom write without a rectangle keeps the one the device saved", async () => {
	await save({ composition_rect: PLACED });
	const result = await save({
		composition: { secondary_input_id: "camera-b", layout: "custom", alpha: 1 },
	});
	expect(result).toMatchObject({
		success: true,
		applied: {
			composition: {
				secondary_input_id: "camera-b",
				layout: "custom",
				alpha: 1,
				rect: PLACED,
			},
		},
	});
});

test("a preset drops the saved rectangle", async () => {
	await save({ composition_rect: PLACED });
	await save({ composition: { ...SAVED, layout: "pbp-left-right" } });
	expect(getConfig().composition).toEqual({
		...SAVED,
		layout: "pbp-left-right",
	});
});

test("a rectangle the engine would refuse is refused with its own token and nothing is written", async () => {
	for (const input of [
		{ composition_rect: { x: 0.6, y: 0, width: 0.5, height: 0.5 } },
		{ composition_rect: { x: 0, y: 0, width: 0.1, height: 0.5 } },
		{ composition: { ...SAVED, rect: PLACED } },
		{ composition: { ...SAVED, layout: "custom" } },
	] satisfies StreamingSetConfigInput[]) {
		expect(await save(input)).toMatchObject({
			success: false,
			error: "composition_rect_invalid",
		});
	}
	getConfig().composition = undefined;
	expect(await save({ composition_rect: PLACED })).toMatchObject({
		success: false,
		error: "composition_off",
	});
	expect(await disk()).toEqual({});
});

test("a rectangle beside an explicitly stated preset contradicts itself and is refused, changing nothing", async () => {
	for (const input of [
		{
			composition: { ...SAVED, layout: "pbp-left-right" },
			composition_rect: PLACED,
		},
		{
			composition_patch: { layout: "pbp-top-bottom" },
			composition_rect: PLACED,
		},
	] satisfies StreamingSetConfigInput[]) {
		expect(await save(input)).toMatchObject({
			success: false,
			error: "composition_rect_invalid",
		});
	}
	expect(getConfig().composition).toEqual(SAVED);
	expect(await disk()).toEqual({});

	await save({
		composition: { ...SAVED, layout: "custom" },
		composition_rect: PLACED,
	});
	expect(getConfig().composition).toEqual(placedAt(PLACED));
});

test("field changes are merged onto the device's saved composition", async () => {
	await save({ composition_rect: PLACED });
	await save({ composition_patch: { alpha: 0.7 } });
	await save({ composition_patch: { secondary_input_id: "camera-c" } });
	expect(getConfig().composition).toEqual({
		secondary_input_id: "camera-c",
		layout: "custom",
		alpha: 0.7,
		rect: PLACED,
	});
	await save({ composition_patch: { layout: "pip-bottom-left" } });
	expect(getConfig().composition).toEqual({
		secondary_input_id: "camera-c",
		layout: "pip-bottom-left",
		alpha: 0.7,
	});
});

test("custom takes the rectangle of the preset the device has saved, or keeps its own", async () => {
	getConfig().composition = { ...SAVED, layout: "pbp-top-bottom" };
	await save({ composition_patch: { layout: "custom" } });
	expect(getConfig().composition).toEqual({
		...SAVED,
		layout: "custom",
		rect: { x: 0, y: 0.5, width: 1, height: 0.5 },
	});
	await save({ composition_rect: PLACED });
	await save({ composition_patch: { layout: "custom" } });
	expect(getConfig().composition).toEqual(placedAt(PLACED));
});

test("a field change while composition is off is refused as composition_off", async () => {
	getConfig().composition = undefined;
	for (const input of [
		{ composition_patch: { layout: "pip-top-left" } },
		{ composition_patch: { alpha: 0.5 } },
	] satisfies StreamingSetConfigInput[]) {
		expect(await save(input)).toMatchObject({
			success: false,
			error: "composition_off",
		});
	}
	expect(getConfig().composition).toBeUndefined();
	expect(await disk()).toEqual({});
});

test("without the composition feature a placement is refused as composition_unsupported", async () => {
	await engineFeatures([]);
	expect(await save({ composition_rect: PLACED })).toMatchObject({
		success: false,
		error: "composition_unsupported",
	});
	expect(getConfig().composition).toEqual(SAVED);
});

test("live, a placement is one apply-now change carrying the composed rectangle to the engine", async () => {
	const sent: ChangeConfigParams[] = [];
	const dispatch = spyOn(cerastreamBackend, "changeConfig").mockImplementation(
		async (params) => {
			sent.push(params);
			expect(getConfig().composition).toEqual(SAVED);
			return {
				attempt_id: "engine-place",
				phase: "applied",
				state: "streaming",
			};
		},
	);
	setApplyNowGateForTest({
		isStreamLive: () => true,
		dispatch: async (delta) => {
			const outcome = await changeEngineRuntimeConfig(delta, "place");
			return {
				result: outcome.phase === "applied" ? "applied" : "reverted",
				attemptId: "place",
			};
		},
	});
	try {
		const result = await save({ composition_rect: PLACED, apply_now: true });
		const placed = placedAt(PLACED);
		expect(sent).toEqual([{ composition: placed }]);
		expect(result).toMatchObject({
			success: true,
			applied: { composition: placed },
			configChange: { result: "applied" },
		});
		expect(getConfig().composition).toEqual(placed);
	} finally {
		dispatch.mockRestore();
	}
});

test("live, a refused placement leaves the running composition saved", async () => {
	setApplyNowGateForTest({
		isStreamLive: () => true,
		dispatch: async () => ({
			result: "reverted",
			attemptId: "place",
			reason: "change_rejected",
		}),
	});
	const result = await save({ composition_rect: PLACED, apply_now: true });
	expect(result.configChange?.result).toBe("reverted");
	expect(getConfig().composition).toEqual(SAVED);
});

// The browser decides `apply_now` when it SENDS a write, from the session at
// that moment. These two pin why that is safe and why it is required.
test("idle, a write that asks to change the running stream is saved like any idle write", async () => {
	let dispatched = 0;
	setApplyNowGateForTest({
		isStreamLive: () => false,
		dispatch: async () => {
			dispatched += 1;
			return { result: "applied", attemptId: "idle" };
		},
	});
	const result = await save({ composition_rect: PLACED, apply_now: true });
	expect(dispatched).toBe(0);
	expect(result.success).toBe(true);
	expect(result).not.toHaveProperty("configChange");
	expect(getConfig().composition).toEqual(placedAt(PLACED));
	expect((await disk()).composition).toEqual(placedAt(PLACED));
});

test("live, a write without apply_now is only saved for the next start: the running stream never gets it", async () => {
	let dispatched = 0;
	setApplyNowGateForTest({
		isStreamLive: () => true,
		dispatch: async () => {
			dispatched += 1;
			return { result: "applied", attemptId: "live" };
		},
	});
	const result = await save({ composition_rect: PLACED });
	expect(dispatched).toBe(0);
	expect(result).not.toHaveProperty("configChange");
	expect(getConfig().composition).toEqual(placedAt(PLACED));
});

// A live placement goes to the engine running the session. A snapshot retained
// from a retired engine (or from a failed refresh) still lists
// `composition-geometry` and passes the save gate, so the apply-now dispatch
// itself must see evidence from the current connection.
function countingLiveGate(refresh?: () => Promise<void>) {
	const sent: unknown[] = [];
	setApplyNowGateForTest({
		isStreamLive: () => true,
		...(refresh === undefined ? {} : { refreshSessionCapabilities: refresh }),
		dispatch: async (delta) => {
			sent.push(delta);
			return { result: "applied", attemptId: "place" };
		},
	});
	return sent;
}

test("live, a placement authorized only by a retired engine's snapshot is not sent", async () => {
	invalidateCapabilities();
	const sent = countingLiveGate();

	const result = await save({ composition_rect: PLACED, apply_now: true });

	expect(sent).toEqual([]);
	expect(result).toMatchObject({
		success: false,
		configChange: { result: "rejected", reason: "change_config_unsupported" },
	});
	expect(getConfig().composition).toEqual(SAVED);
});

test("live, a placement is refused when the session's own engine only has preset layouts", async () => {
	invalidateCapabilities();
	const sent = countingLiveGate(() => engineFeatures(["composition"]));

	const result = await save({ composition_rect: PLACED, apply_now: true });

	expect(sent).toEqual([]);
	expect(result.configChange).toEqual({
		result: "rejected",
		reason: "change_config_unsupported",
	});
	expect(getConfig().composition).toEqual(SAVED);
});

test("live, a placement goes out once the session's own engine confirms geometry", async () => {
	invalidateCapabilities();
	const sent = countingLiveGate(() => engineFeatures(GEOMETRY));

	const result = await save({ composition_rect: PLACED, apply_now: true });

	expect(sent).toEqual([{ composition: placedAt(PLACED) }]);
	expect(result.configChange?.result).toBe("applied");
});

test("the apply-now gate refuses a custom layout without current geometry evidence", async () => {
	invalidateCapabilities();
	const changes: unknown[] = [];
	const gate = createApplyNowGate({
		snapshot: () => ({ state: "streaming" }) as never,
		changeConfig: async (delta) => {
			changes.push(delta);
			return { result: "applied", attemptId: "gate" };
		},
	});

	const custom = await gate.dispatch({ composition: placedAt(PLACED) });
	const preset = await gate.dispatch({ composition: { ...SAVED } });

	expect(custom).toEqual({
		result: "rejected",
		reason: "change_config_unsupported",
	});
	expect(changes).toEqual([{ composition: { ...SAVED } }]);
	expect(preset.result).toBe("applied");
});

// The start went without its custom layout (its capability read timed out);
// once a live placement is applied on air, the notice must stop saying so.
function noticeBridge() {
	const shown = new Map<string, string>();
	const bridge: StartFeatureNoticeBridge = {
		notify: (name, _type, msg) => {
			shown.set(name, msg);
		},
		notificationExists: (name) => shown.has(name),
		removeNotification: (name) => {
			shown.delete(name);
		},
	};
	return { bridge, shown };
}

test("live, an applied placement clears a notice that the start went without its layout", async () => {
	const { bridge, shown } = noticeBridge();
	postStartFeatureNotice(bridge, ["custom-layout"], false);
	countingLiveGate();
	try {
		const result = await save({ composition_rect: PLACED, apply_now: true });
		expect(result.configChange?.result).toBe("applied");
		expect(shown.has(START_FEATURES_NOTIFICATION)).toBe(false);
	} finally {
		resetStartFeatureNoticeForTest();
	}
});

test("live, a refused placement leaves that notice in place", async () => {
	const { bridge, shown } = noticeBridge();
	postStartFeatureNotice(bridge, ["custom-layout"], false);
	setApplyNowGateForTest({
		isStreamLive: () => true,
		dispatch: async () => ({
			result: "reverted",
			attemptId: "place",
			reason: "change_rejected",
		}),
	});
	try {
		await save({ composition_rect: PLACED, apply_now: true });
		expect(shown.has(START_FEATURES_NOTIFICATION)).toBe(true);
	} finally {
		resetStartFeatureNoticeForTest();
	}
});
