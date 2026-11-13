import { expect, test } from "bun:test";
import { telemetrySchema } from "@ceraui/srtla-send/telemetry";
import { cellularSourceWithdrawalConfirmed } from "./cellular-source-withdrawal.ts";

const identity = { generation: 2, ips_file_sha256: "a".repeat(64) };
const snapshot = (connections: unknown[] = [], updated = 1100) =>
	telemetrySchema.parse({
		schema_version: 1,
		last_updated_ms: updated,
		connections,
		bind_map_status: { state: "active" },
		disposition: { state: "mapped" },
		bind_map_applied: identity,
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
			identity,
		);
	// Producer wall-clock age is not causal acknowledgement.
	expect(confirm(snapshot([], 1000))).toBe(true);
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
			identity,
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
			identity,
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
			identity,
		),
	).toBe(false);
	expect(
		cellularSourceWithdrawalConfirmed(
			{
				...fresh,
				disposition: { state: "mapped" },
				bind_map_applied: identity,
			},
			true,
			1200,
			1200,
			1000,
			"modem-a",
			["wwan0"],
			identity,
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
			identity,
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

test("only the exact applied generation and digest acknowledge the current publication", () => {
	const confirm = (value: ReturnType<typeof snapshot>) =>
		cellularSourceWithdrawalConfirmed(
			value,
			true,
			1200,
			1200,
			1000,
			"modem-a",
			["wwan0"],
			identity,
		);
	const { bind_map_applied: _applied, ...withoutIdentity } = snapshot();
	expect(confirm(withoutIdentity)).toBe(false);
	expect(
		confirm({
			...snapshot(),
			bind_map_applied: { ...identity, generation: 1 },
		}),
	).toBe(false);
	expect(
		confirm({
			...snapshot(),
			bind_map_applied: { ...identity, generation: 3 },
		}),
	).toBe(false);
	expect(
		confirm({
			...snapshot(),
			bind_map_applied: { ...identity, ips_file_sha256: "b".repeat(64) },
		}),
	).toBe(false);
	expect(confirm({ ...withoutIdentity, bind_map_pending: identity })).toBe(
		false,
	);
	expect(
		confirm({
			...snapshot(),
			disposition: { state: "pending_apply" },
			bind_map_pending: identity,
		}),
	).toBe(false);
	expect(confirm(snapshot([], 0))).toBe(true);
	expect(confirm(snapshot([], Number.MAX_SAFE_INTEGER))).toBe(true);
});

test("revision-2 producer fixtures distinguish unknown pending, known pending and joined empty apply", async () => {
	const fixtures = `${import.meta.dir}/../../../../../packages/srtla-send/tests/fixtures`;
	for (const name of [
		"pending-known",
		"pending-unknown",
		"final-empty-applied",
	]) {
		const bytes = await Bun.file(
				`${fixtures}/telemetry-rev2-${name}.json`,
			).text(),
			value = telemetrySchema.parse(JSON.parse(bytes)),
			expected = {
				generation: 2,
				ips_file_sha256:
					"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
			};
		expect(JSON.stringify(value)).toBe(bytes);
		expect(
			cellularSourceWithdrawalConfirmed(
				value,
				true,
				1200,
				1200,
				1000,
				"path-a",
				["lo"],
				expected,
			),
		).toBe(name === "final-empty-applied");
	}
});
