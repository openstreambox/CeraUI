import { expect, test } from "bun:test";
import { telemetrySchema } from "@ceraui/srtla-send/telemetry";
import { cellularSourceWithdrawalConfirmed } from "./cellular-source-withdrawal.ts";

const snapshot = (connections: unknown[] = [], updated = 1100) =>
	telemetrySchema.parse({
		schema_version: 1,
		last_updated_ms: updated,
		connections,
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
