import { expect, test } from "bun:test";
import { bondMappingSchema } from "@ceraui/rpc/schemas";
import { telemetrySchema } from "@ceraui/srtla-send/telemetry";
import { bindMapBandMessage } from "../modules/streaming/bind-map-notification.ts";
import {
	type BindMapSpawnDeps,
	resolveRequiredBindMapArgs,
} from "../modules/streaming/bind-map-spawn.ts";
import type { PublishedBond } from "../modules/streaming/srtla.ts";
import { classifyCapabilityDocument } from "../modules/streaming/srtla-capabilities.ts";

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
	expect(
		classifyCapabilityDocument(
			0,
			'{"capabilities":{"bind_map":true,"bind_map_required":false,"bind_map_required":true}}',
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
				...(capable ? { bindMapRequired: true as const } : {}),
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
				};
			},
		}),
	).toEqual({ ok: false, reason: "mapping-unavailable" });
	expect(announcements).toEqual(["bind-map-passed"]);
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
