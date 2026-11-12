import { expect, test } from "bun:test";
import { bondMappingSchema } from "@ceraui/rpc/schemas";
import { telemetrySchema } from "@ceraui/srtla-send/telemetry";
import { bindMapBandMessage } from "../modules/streaming/bind-map-notification.ts";
import {
	type BindMapSpawnDeps,
	resolveCellularBindMapArgs,
	resolveRequiredBindMapArgs,
} from "../modules/streaming/bind-map-spawn.ts";
import type { PublishedBond } from "../modules/streaming/srtla.ts";
import {
	classifyCapabilityDocument,
	supportsRequiredCellularBinding,
} from "../modules/streaming/srtla-capabilities.ts";

test("required binding is an exact capability, never a version guess or duplicate-key claim", () => {
	for (const value of [true, false, "true", 1, null]) {
		const parsed = classifyCapabilityDocument(
			0,
			JSON.stringify({
				capabilities: { bind_map: true, bind_map_required: value },
			}),
		);
		expect(parsed.bindMap && parsed.bindMapRequired === true).toBe(
			value === true,
		);
	}
	for (const value of [true, false, "true", 1, null]) {
		const parsed = classifyCapabilityDocument(
			0,
			JSON.stringify({
				capabilities: {
					bind_map: true,
					bind_map_required: true,
					bind_map_required_empty_reload: value,
				},
			}),
		);
		expect(parsed.bindMap && parsed.bindMapRequiredEmptyReload === true).toBe(
			value === true,
		);
	}
	expect(
		classifyCapabilityDocument(
			0,
			'{"capabilities":{"bind_map":true,"bind_map_required":false,"bind_map_required":true}}',
		).bindMap,
	).toBe(false);
	expect(
		classifyCapabilityDocument(
			0,
			'{"capabilities":{"bind_map":true,"bind_map_required":true,"bind_map_required_empty_reload":false,"bind_map_required_empty_reload":true}}',
		).bindMap,
	).toBe(false);
});
test("required paths get both flags or a typed refusal; a failed recheck never falls back to source-only", async () => {
	const good: PublishedBond = {
		entries: [],
		publication: {
			ok: true,
			generation: 1,
			changed: true,
			sidecarPath: "/synthetic/bind-map.json",
		},
	};
	let bond: PublishedBond | undefined = good,
		capable = true,
		probes = 0;
	const announcements: string[] = [];
	const deps: BindMapSpawnDeps = {
		getBond: () => bond,
		probe: async () => {
			probes++;
			return {
				bindMap: true,
				bindMapSchemaVersion: 1,
				...(capable
					? {
							bindMapRequired: true as const,
							bindMapRequiredEmptyReload: true as const,
							bindMapContract: 1,
						}
					: {}),
			};
		},
		announce: (cause) => {
			announcements.push(cause);
		},
	};
	expect(await resolveRequiredBindMapArgs("/synthetic/sender", deps)).toEqual({
		ok: true,
		args: ["--bind-map", "/synthetic/bind-map.json", "--require-bind-map"],
	});
	for (const incomplete of [
		{
			bindMapRequired: true as const,
			bindMapRequiredEmptyReload: true as const,
		},
		{ bindMapRequired: true as const },
		{ bindMapRequiredEmptyReload: true as const },
		{},
	]) {
		expect(
			await resolveRequiredBindMapArgs("/synthetic/sender", {
				...deps,
				probe: async () => ({
					bindMap: true,
					bindMapSchemaVersion: 1,
					...incomplete,
				}),
			}),
		).toEqual({ ok: false, reason: "capability-unavailable" });
	}
	capable = false;
	expect(await resolveRequiredBindMapArgs("/synthetic/sender", deps)).toEqual({
		ok: false,
		reason: "capability-unavailable",
	});
	bond = undefined;
	const count = probes;
	expect(await resolveRequiredBindMapArgs("/synthetic/sender", deps)).toEqual({
		ok: false,
		reason: "mapping-unavailable",
	});
	expect(probes).toBe(count);
	bond = good;
	expect(
		await resolveRequiredBindMapArgs("/synthetic/sender", {
			...deps,
			probe: async () => {
				bond = undefined;
				return {
					bindMap: true,
					bindMapSchemaVersion: 1,
					bindMapRequired: true,
					bindMapRequiredEmptyReload: true,
					bindMapContract: 1,
				};
			},
		}),
	).toEqual({ ok: false, reason: "mapping-unavailable" });
	expect(announcements).toEqual(["bind-map-passed"]);
});

test("new launches prefer strict capability for future hotplug and refuse a late managed row without it", async () => {
	let required = false,
		capable = true,
		duringProbe = () => {};
	const deps: BindMapSpawnDeps = {
		getBond: () => ({
			entries: [],
			publication: {
				ok: true,
				generation: 1,
				changed: true,
				sidecarPath: "/synthetic/map",
			},
		}),
		probe: async () => {
			duringProbe();
			return {
				bindMap: true,
				bindMapSchemaVersion: 1,
				...(capable
					? {
							bindMapRequired: true as const,
							bindMapRequiredEmptyReload: true as const,
							bindMapContract: 1,
						}
					: {}),
			};
		},
		announce: () => {},
	};
	expect(
		await resolveCellularBindMapArgs("/synthetic/sender", deps, () => required),
	).toEqual({
		ok: true,
		args: ["--bind-map", "/synthetic/map", "--require-bind-map"],
		required: true,
	});
	capable = false;
	expect(
		await resolveCellularBindMapArgs("/synthetic/sender", deps, () => required),
	).toEqual({
		ok: true,
		args: ["--bind-map", "/synthetic/map"],
		required: false,
	});
	duringProbe = () => {
		required = true;
	};
	expect(
		await resolveCellularBindMapArgs("/synthetic/sender", deps, () => required),
	).toEqual({ ok: false, reason: "capability-unavailable" });
	expect(
		await resolveCellularBindMapArgs(
			"/synthetic/sender",
			{ ...deps, getBond: () => undefined },
			() => required,
		),
	).toEqual({ ok: false, reason: "mapping-unavailable" });
});
test("producer-required refusal survives telemetry, RPC projection and operator copy without claiming a legacy link", async () => {
	const bytes = await Bun.file(
		`${import.meta.dir}/../../../../packages/srtla-send/tests/fixtures/telemetry-required-binding-refused.json`,
	).text();
	const snapshot = telemetrySchema.parse(JSON.parse(bytes));
	expect(JSON.stringify(snapshot)).toBe(bytes);
	expect(snapshot.connections).toEqual([]);
	if (!snapshot.bind_map_status || !snapshot.disposition)
		throw new Error("Required producer fixture fields missing");
	const report = {
		status: snapshot.bind_map_status,
		disposition: snapshot.disposition,
		source: "sender" as const,
	};
	expect(
		bondMappingSchema.parse({
			state: report.status.state,
			reason: report.status.reason,
			disposition: report.disposition.state,
			source: "sender",
		}).disposition,
	).toBe("required_binding_refused");
	expect(bindMapBandMessage(report)).toContain("No links are sending");
});

test("pending apply survives telemetry and RPC projection while withdrawal remains unacknowledged", async () => {
	const bytes = await Bun.file(
		`${import.meta.dir}/../../../../packages/srtla-send/tests/fixtures/telemetry-pending-apply.json`,
	).text();
	const snapshot = telemetrySchema.parse(JSON.parse(bytes));
	expect(JSON.stringify(snapshot)).toBe(bytes);
	const report = bondMappingSchema.parse({
		state: snapshot.bind_map_status?.state,
		disposition: snapshot.disposition?.state,
		source: "sender",
	});
	expect(report.disposition).toBe("pending_apply");
	expect(
		bindMapBandMessage({
			status: { state: report.state },
			disposition: { state: report.disposition },
			source: "sender",
		}),
	).toContain("confirm");
});

test("joined binding requires an integer monotonic contract revision and both exact booleans", () => {
	for (const revision of [
		undefined,
		null,
		false,
		true,
		"1",
		0,
		-1,
		0.5,
		1.5,
		1,
		2,
		99,
	]) {
		for (const required of [true, false, "true", 1])
			for (const empty of [true, false, "true", 1]) {
				const parsed = classifyCapabilityDocument(
					0,
					JSON.stringify({
						capabilities: {
							bind_map: true,
							bind_map_contract: revision,
							bind_map_required: required,
							bind_map_required_empty_reload: empty,
						},
					}),
				);
				expect(supportsRequiredCellularBinding(parsed)).toBe(
					typeof revision === "number" &&
						Number.isInteger(revision) &&
						revision >= 1 &&
						required === true &&
						empty === true,
				);
			}
	}
	expect(
		classifyCapabilityDocument(
			0,
			'{"capabilities":{"bind_map":true,"bind_map_required":true,"bind_map_required_empty_reload":true,"bind_map_contract":0,"bind_map_contract":1}}',
		).bindMap,
	).toBe(false);
});
