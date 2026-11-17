import { expect, test } from "bun:test";
import {
	ENGINE_UNIT,
	engineUnitStopped,
	parseEngineUnitStopped,
} from "../modules/streaming/engine-unit-state.ts";

const show = (rows: Record<string, string>) =>
	Object.entries(rows)
		.map(([key, value]) => `${key}=${value}`)
		.join("\n");

test("only a known unit without a process proves a stopped engine", () => {
	for (const [rows, stopped] of [
		[
			{
				LoadState: "loaded",
				ActiveState: "inactive",
				SubState: "dead",
				MainPID: "0",
			},
			true,
		],
		[
			{
				LoadState: "loaded",
				ActiveState: "failed",
				SubState: "failed",
				MainPID: "0",
			},
			true,
		],
		[
			{
				LoadState: "loaded",
				ActiveState: "activating",
				SubState: "auto-restart",
				MainPID: "0",
			},
			true,
		],
		// Running, starting or stopping: a process exists or may.
		[
			{
				LoadState: "loaded",
				ActiveState: "active",
				SubState: "running",
				MainPID: "812",
			},
			false,
		],
		[
			{
				LoadState: "loaded",
				ActiveState: "activating",
				SubState: "start",
				MainPID: "812",
			},
			false,
		],
		[
			{
				LoadState: "loaded",
				ActiveState: "deactivating",
				SubState: "stop-sigterm",
				MainPID: "812",
			},
			false,
		],
		// A process that outlived a failed state is still a process.
		[
			{
				LoadState: "loaded",
				ActiveState: "failed",
				SubState: "failed",
				MainPID: "812",
			},
			false,
		],
		// Not installed under this name: the engine may run elsewhere.
		[
			{
				LoadState: "not-found",
				ActiveState: "inactive",
				SubState: "dead",
				MainPID: "0",
			},
			false,
		],
		[{ ActiveState: "inactive", MainPID: "0" }, false],
	] as const) {
		expect(parseEngineUnitStopped(show(rows))).toBe(stopped);
	}
	expect(parseEngineUnitStopped("")).toBe(false);
	expect(parseEngineUnitStopped("garbage")).toBe(false);
});

test("a failing systemctl proves nothing", async () => {
	expect(
		await engineUnitStopped(async () => {
			throw new Error("systemctl unavailable");
		}),
	).toBe(false);
	expect(
		await engineUnitStopped(async () =>
			show({ LoadState: "loaded", ActiveState: "failed", MainPID: "0" }),
		),
	).toBe(true);
	expect(ENGINE_UNIT).toBe("cerastream.service");
});
