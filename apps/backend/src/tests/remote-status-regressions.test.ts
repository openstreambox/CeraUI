import { expect, test } from "bun:test";
import { strictParseFrame } from "@ceralive/control-protocol/parse";
import {
	modemListSchema,
	netifMessageSchema,
	statusResponseSchema,
} from "@ceraui/rpc/schemas";
import {
	projectRemoteLegacyFrame,
	projectRemotePayload,
	projectRemoteStatus,
} from "../modules/remote/remote-status.ts";
import {
	relayStatusToGateway,
	resetStatusRelay,
	setControlChannel,
} from "../modules/remote-control/status-relay.ts";

const link = (iface: string, conn_id = "0") => ({
	iface,
	conn_id,
	link_id: `physical-${iface}`,
	rtt_ms: 20,
	nak_count: 0,
	weight_percent: 50,
	stale: false,
});
test("projected bonded status satisfies the published schema with unique stable row keys", () => {
	const a = statusResponseSchema.parse(
		projectRemoteStatus({
			linkTelemetry: { links: [link("private-a"), link("private-b", "1")] },
		}),
	);
	const b = statusResponseSchema.parse(
		projectRemoteStatus({
			linkTelemetry: { links: [link("private-b"), link("private-a", "1")] },
		}),
	);
	expect(new Set(a.linkTelemetry?.links.map((r) => r.conn_id)).size).toBe(2);
	expect(a.linkTelemetry?.links[0]?.conn_id).toBe(
		b.linkTelemetry?.links[1]?.conn_id,
	);
	expect(JSON.stringify(a)).not.toContain("private-");
});
test("interfaces at the same position never collide and adapter counters exclude saved networks", () => {
	projectRemoteStatus({ linkTelemetry: { links: [link("collision-a")] } });
	projectRemoteStatus({ linkTelemetry: { links: [link("collision-b")] } });
	const net = projectRemotePayload("netif", {
		"collision-a": { tx_bps: 111, tp: 111, enabled: true },
		"collision-b": { tx_bps: 222, tp: 222, enabled: true },
	});
	expect(Object.keys(net as object)).toHaveLength(2);
	netifMessageSchema.parse(net);
	modemListSchema.parse(projectRemotePayload("modems", {}));
	const out = projectRemoteStatus({
		wifi: {
			a: { ifname: "radio-a", saved: { one: "1", two: "2", three: "3" } },
			b: { ifname: "radio-b" },
		},
	}) as { wifi: Record<string, unknown> };
	expect(Object.keys(out.wifi).map((k) => Number(k.split(" ").at(-1)))).toEqual(
		[1, 2],
	);
});
test("telemetry traverses the relay with numeric metrics and neutral link IDs", () => {
	const frames: unknown[] = [];
	setControlChannel({
		isConnected: () => true,
		sendFrame: (f) => {
			frames.push(f);
		},
	});
	relayStatusToGateway(
		"telemetry",
		{
			samples: [
				{
					linkId: "private-a",
					rttMs: 10,
					nakCount: 0,
					weightPercent: 50,
					packetLoss: 0,
					jitterMs: 0,
					tsMs: 42,
				},
			],
		},
		1,
	);
	resetStatusRelay();
	expect(frames).toHaveLength(1);
	strictParseFrame(frames[0]);
	expect(JSON.stringify(frames)).not.toContain("private-a");
});
test("legacy notification boundary rejects arbitrary producer text", () => {
	expect(
		projectRemoteLegacyFrame({
			notification: { show: [{ msg: "private-text" }] },
		}),
	).toEqual({});
});

test("command DTOs keep safe pipeline capabilities and config controls", async () => {
	const { projectCommandResult } = await import(
		"../modules/remote-control/command-result-dto.ts"
	);
	const p = projectCommandResult("streaming.getPipelines", {
		ok: true,
		applied: {
			hardware: "private-hardware",
			pipelines: {
				hdmi: {
					name: "private-name",
					supportsAudio: true,
					supportsResolutionOverride: true,
					supportsFramerateOverride: true,
				},
				"private-id": {},
			},
		},
	});
	expect(p.ok).toBe(true);
	expect(p.applied).toHaveProperty("pipelines.hdmi.supportsAudio", true);
	expect(JSON.stringify(p)).not.toContain("private-");
	const c = projectCommandResult("streaming.getConfig", {
		ok: true,
		applied: {
			pipeline: "hdmi",
			acodec: "aac",
			max_br: 5000,
			source: "private-source",
			password: "private-secret",
		},
	});
	expect(c.applied).toHaveProperty("pipeline", "hdmi");
	expect(c.applied).toHaveProperty("source_configured", true);
	expect(JSON.stringify(c)).not.toContain("private-");
	expect(
		projectCommandResult("streaming.getPipelines", {
			ok: true,
			applied: { pipelines: { "private-id": {} } },
		}),
	).toEqual({ ok: false, applied: null, error: "withheld" });
});
test("exact legacy notification wire format passes and mutations fail closed", () => {
	const n = {
		name: "a".repeat(64),
		type: "warning",
		msg: "A cellular connection is roaming.",
		revision: 1,
		is_persistent: true,
		is_dismissable: false,
		duration: 0,
	};
	const payload = {
		show: [n],
		remove: [],
		epoch: "12345678-1234-4234-8234-123456789abc",
		full: true,
	};
	expect(
		projectRemoteLegacyFrame({
			notification: {
				...payload,
				remove: [{ id: "remote-overflow", revision: 2 }],
			},
		}),
	).toHaveProperty("notification.remove.0.id", "remote-overflow");
	expect(projectRemoteLegacyFrame({ notification: payload })).toEqual({
		notification: payload,
	});
	for (const change of [
		{ full: false },
		{ extra: "private" },
		{ show: [{ ...n, msg: "private-text" }] },
		{ show: [{ ...n, name: "private-name" }] },
		{ show: [{ ...n, action: "private-action" }] },
	])
		expect(
			projectRemoteLegacyFrame({ notification: { ...payload, ...change } }),
		).toEqual({});
});
test("helper diagnostics are plain flags with explicit warning retractions", () => {
	const a = projectRemoteStatus({
		asrcs: ["private-audio"],
		ssh: { user: "private-user", active: true, enabled: false },
		policy_route_missing: true,
		available_updates: { package_count: 2 },
		bond_mapping: {
			state: "degraded",
			disposition: "legacy_unique_only",
			source: "writer",
			collisions: [{ ip: "private-ip" }],
		},
	}) as {
		remote_diagnostics: {
			audio_present: boolean;
			ssh: unknown;
			policy_route_missing: boolean;
		};
	};
	statusResponseSchema.parse(a);
	expect(a.remote_diagnostics.audio_present).toBe(true);
	expect(a.remote_diagnostics.ssh).toEqual({ active: true, enabled: false });
	expect(a.remote_diagnostics.policy_route_missing).toBe(true);
	expect(JSON.stringify(a)).not.toContain("private-");
	expect(
		(
			projectRemoteStatus({
				policy_route_missing: false,
				bond_mapping: null,
			}) as { remote_diagnostics: { policy_route_missing: boolean } }
		).remote_diagnostics.policy_route_missing,
	).toBe(false);
});

test("cloud command router sends pipeline and config result DTOs rather than status projections", async () => {
	const { routeCommand } = await import(
		"../modules/remote-control/command-router.ts"
	);
	const frames: unknown[] = [];
	for (const type of ["streaming.getPipelines", "streaming.getConfig"]) {
		await routeCommand(
			{ v: 1, kind: "command", type, cid: crypto.randomUUID(), role: "owner" },
			{
				sendResult: (f) => {
					frames.push(f);
					return true;
				},
				sendDeliveryAck: () => true,
				dispatch: {
					[type]: async () =>
						type.endsWith("getPipelines")
							? {
									hardware: "generic",
									pipelines: { hdmi: { supportsAudio: true } },
								}
							: {
									pipeline: "hdmi",
									resolution: "1080p",
									max_br: 4000,
									password: "private-secret",
								},
				},
			},
		);
	}
	expect(frames).toHaveLength(2);
	expect(frames[0]).toHaveProperty(
		"payload.applied.pipelines.hdmi.supportsAudio",
		true,
	);
	expect(frames[1]).toHaveProperty("payload.applied.pipeline", "hdmi");
	expect(frames[1]).toHaveProperty("payload.applied.resolution", "1080p");
	expect(JSON.stringify(frames)).not.toContain("private-secret");
});
