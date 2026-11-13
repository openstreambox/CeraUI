import { expect, test } from "bun:test";
import { telemetrySchema } from "@ceraui/srtla-send/telemetry";
import { cellularSourceWithdrawalConfirmed } from "./cellular-source-withdrawal.ts";

const snapshot = (connections: unknown[] = [], updated = 1100) =>
	telemetrySchema.parse({
		schema_version: 1,
		last_updated_ms: updated,
		connections,
		bind_map_status: { state: "active" },
		disposition: { state: "mapped" },
	});
const row = {
	conn_id: "0",
	rtt_ms: 10,
	nak_count: 0,
	weight_percent: 100,
	window: 8192,
	in_flight: 0,
	bitrate_bps: 0,
};
test("new publication and stale/legacy telemetry cannot acknowledge closed source sockets", () => {
	const confirm = (value: ReturnType<typeof snapshot>, read = 1200) =>
		cellularSourceWithdrawalConfirmed(
			value,
			true,
			read,
			1200,
			1000,
			"modem-a",
			["wwan0", "cclat1"],
		);
	expect(confirm(snapshot([], 1000))).toBe(false);
	expect(confirm(snapshot([], 1100), 1000)).toBe(false);
	expect(confirm(snapshot([{ ...row }]))).toBe(false);
	expect(
		confirm(snapshot([{ ...row, link_id: "modem-a", iface: "cclat1" }])),
	).toBe(false);
	expect(
		confirm(snapshot([{ ...row, link_id: "modem-b", iface: "wwan0" }])),
	).toBe(false);
	expect(
		confirm(snapshot([{ ...row, link_id: "modem-b", iface: "eth0" }])),
	).toBe(true);
	expect(confirm(snapshot())).toBe(true);
	expect(
		cellularSourceWithdrawalConfirmed(
			snapshot(),
			true,
			1200,
			7000,
			1000,
			"modem-a",
			["cclat1"],
		),
	).toBe(false);
	expect(
		cellularSourceWithdrawalConfirmed(
			snapshot(),
			false,
			1200,
			1200,
			1000,
			"modem-a",
			["cclat1"],
		),
	).toBe(false);
});

test("producer pending_apply is never a withdrawal acknowledgement, even with fresh empty connections", async () => {
	const bytes = await Bun.file(
		`${import.meta.dir}/../../../../../packages/srtla-send/tests/fixtures/telemetry-pending-apply.json`,
	).text();
	const pending = telemetrySchema.parse(JSON.parse(bytes));
	expect(JSON.stringify(pending)).toBe(bytes);
	expect(pending.connections).toEqual([]);
	const fresh = { ...pending, last_updated_ms: 1100 };
	expect(
		cellularSourceWithdrawalConfirmed(
			fresh,
			true,
			1200,
			1200,
			1000,
			"modem-a",
			["wwan0"],
		),
	).toBe(false);
	expect(
		cellularSourceWithdrawalConfirmed(
			{ ...fresh, disposition: { state: "mapped" } },
			true,
			1200,
			1200,
			1000,
			"modem-a",
			["wwan0"],
		),
	).toBe(true);
});

test("required withdrawal needs a positively applied report, not a legacy empty projection", () => {
	const modern = snapshot(),
		{ bind_map_status: _status, disposition: _disposition, ...legacy } = modern;
	const confirm = (value: unknown) =>
		cellularSourceWithdrawalConfirmed(
			telemetrySchema.parse(value),
			true,
			1200,
			1200,
			1000,
			"modem-a",
			["wwan0"],
		);
	expect(confirm(legacy)).toBe(false);
	expect(confirm({ ...legacy, bind_map_status: { state: "active" } })).toBe(
		false,
	);
	expect(confirm({ ...legacy, disposition: { state: "mapped" } })).toBe(false);
	expect(confirm({ ...modern, bind_map_status: { state: "absent" } })).toBe(
		false,
	);
	for (const state of [
		"legacy_unique_only",
		"startup_collision_excluded",
		"pending_apply",
	])
		expect(confirm({ ...modern, disposition: { state } })).toBe(false);
	for (const state of [
		"mapped",
		"retained_last_valid",
		"required_binding_refused",
	])
		expect(confirm({ ...modern, disposition: { state } })).toBe(true);
});
