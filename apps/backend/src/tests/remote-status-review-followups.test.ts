import { expect, test } from "bun:test";
import { statusResponseSchema } from "@ceraui/rpc/schemas";
import {
	getRemoteProjectionDrops,
	projectRemoteLegacyFrame,
	projectRemotePayload,
	projectRemoteStatus,
} from "../modules/remote/remote-status.ts";
import { projectCommandResult } from "../modules/remote-control/command-result-dto.ts";
import { AUDIO_CODECS } from "../modules/streaming/pipeline-sources.ts";

test("designed withholds do not consume rejection diagnostics", () => {
	const before = getRemoteProjectionDrops();
	projectRemoteLegacyFrame({
		"encoder-load": {},
		fan: {},
		cpu: {},
		bluetooth: {},
		revisions: {},
		notification: { show: [] },
	});
	expect(getRemoteProjectionDrops()).toBe(before);
	projectRemoteLegacyFrame({
		notification: { show: [], remove: [], epoch: "bad", full: true },
	});
	expect(getRemoteProjectionDrops()).toBe(before + 1);
});
test("missing row id has a separate fallback namespace", () => {
	const result = projectRemoteStatus({
		linkTelemetry: { links: [{ conn_id: "1", iface: "a" }, { iface: "b" }] },
	}) as { linkTelemetry: { links: { conn_id: string }[] } };
	expect(new Set(result.linkTelemetry.links.map((r) => r.conn_id)).size).toBe(
		2,
	);
});
test("audio catalog projection follows the producer registry", () => {
	AUDIO_CODECS.review = { name: "Review codec" };
	try {
		expect(projectRemotePayload("acodecs", {})).toEqual(AUDIO_CODECS);
	} finally {
		delete AUDIO_CODECS.review;
	}
});
test("failed commands never pass through applied objects", () => {
	const out = projectCommandResult("streaming.setConfig", {
		ok: false,
		applied: { ssid: "private-network" },
		error: "rejected",
	});
	expect(out.applied).toBeNull();
	expect(JSON.stringify(out)).not.toContain("private-network");
});
test("unmappable identity remains explicit, absent policy diagnostics stay absent", () => {
	const out = statusResponseSchema.parse(
		projectRemoteStatus({
			linkTelemetry: {
				links: [
					{
						conn_id: "1",
						iface: "a",
						identity_state: "unmappable",
						rtt_ms: 0,
						nak_count: 0,
						weight_percent: 100,
						stale: false,
					},
				],
			},
			policy_route_missing: true,
		}),
	);
	expect(out.linkTelemetry?.links[0]?.identity_state).toBe("unmappable");
	expect(out).not.toHaveProperty("remote_diagnostics.policy_route_missing");
});
