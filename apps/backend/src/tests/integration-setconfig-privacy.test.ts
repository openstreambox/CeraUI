// Installed in apps/backend/src/tests by the train's explicit regression step.
import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { call } from "@orpc/server";
import { logRedact } from "../helpers/logger.ts";
import * as mockService from "../mocks/mock-service.ts";
import { getConfig } from "../modules/config.ts";
import {
	projectRemoteConfig,
	projectRemoteStatus,
} from "../modules/remote/remote-status.ts";
import { setApplyNowGateForTest } from "../modules/streaming/config-change-bridge.ts";
import {
	clearStagedConfigChange,
	defaultStagingDeps,
	getStagedConfigChange,
} from "../modules/streaming/config-change-staging.ts";
import { setConfigProcedure } from "../rpc/procedures/streaming.procedure.ts";
import { makeRpcContext } from "./helpers/bond-toggle-fixture.ts";
import { usePrivacyConfig } from "./helpers/remote-privacy-config.ts";
import { event, exported } from "./support/journal-records.ts";

const ids = {
	srt_streamid: "publish:SYNTHETIC-manual-key",
	relay_streamid_override: "publish:SYNTHETIC-managed-key",
};
usePrivacyConfig();
beforeEach(() => {
	spyOn(mockService, "shouldUseMocks").mockReturnValue(false);
	spyOn(defaultStagingDeps, "writeMarker").mockImplementation(() => {});
	spyOn(defaultStagingDeps, "removeMarker").mockImplementation(() => {});
	clearStagedConfigChange();
	getConfig().resolution = "1080p";
	getConfig().source = undefined;
	getConfig().input_mode = undefined;
	getConfig().video_codec = undefined;
});
afterEach(() => {
	clearStagedConfigChange();
	setApplyNowGateForTest(null);
	mock.restore();
});
function privateEcho(applied: unknown) {
	for (const id of Object.values(ids))
		expect(JSON.stringify(applied)).not.toContain(id);
	expect(applied).not.toHaveProperty("srt_streamid");
	expect(applied).not.toHaveProperty("relay_streamid_override");
	expect(applied).toMatchObject({
		srt_streamid_configured: true,
		relay_streamid_override_configured: true,
	});
}

test("ordinary save keeps write-only IDs out of its applied echo", async () => {
	const result = await call(
		setConfigProcedure,
		{ ...ids, srt_latency: 3000 },
		{ context: makeRpcContext() },
	);
	expect(result.success).toBe(true);
	privateEcho(result.applied);
	expect(getConfig().srt_streamid).toBe(ids.srt_streamid);
	expect(getConfig().relay_streamid_override).toBe(ids.relay_streamid_override);
});

test("overlapping apply-now refuses the second stage, redacts busy and preserves the first attempt", async () => {
	let finish!: (result: { result: "applied"; attemptId: string }) => void;
	let entered!: () => void;
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	let dispatches = 0;
	setApplyNowGateForTest({
		isStreamLive: () => true,
		dispatch: () => {
			dispatches++;
			entered();
			return new Promise((resolve) => {
				finish = resolve;
			});
		},
	});
	const first = call(
		setConfigProcedure,
		{ ...ids, resolution: "2160p", apply_now: true },
		{ context: makeRpcContext() },
	);
	await started;
	const held = structuredClone(getStagedConfigChange());
	try {
		expect(held?.candidate.resolution).toBe("2160p");
		expect(getConfig().resolution).toBe("1080p");
		const second = await call(
			setConfigProcedure,
			{ ...ids, resolution: "720p", apply_now: true },
			{ context: makeRpcContext() },
		);
		expect(second.success).toBe(false);
		expect(second.configChange).toEqual({ result: "busy" });
		privateEcho(second.applied);
		expect(getStagedConfigChange()).toEqual(held);
		expect(dispatches).toBe(1);
		expect(getConfig().resolution).toBe("1080p");
	} finally {
		finish({ result: "applied", attemptId: held?.attemptId ?? "missing" });
	}
	const result = await first;
	expect(result.success).toBe(true);
	privateEcho(result.applied);
	expect(getConfig().resolution).toBe("2160p");
	expect(getStagedConfigChange()).toBeUndefined();
});

test("stored publish IDs stay private in logs, remote projections and support journal", () => {
	Object.assign(getConfig(), ids);
	const outputs = [
		JSON.stringify(logRedact({ ...ids, nested: ids })),
		JSON.stringify(projectRemoteConfig(getConfig())),
		JSON.stringify(projectRemoteStatus({ ...ids, is_streaming: true })),
		exported(event({ msg: "Failed to start stream", meta: { ...ids } })),
	];
	for (const output of outputs)
		for (const id of Object.values(ids)) expect(output).not.toContain(id);
});
