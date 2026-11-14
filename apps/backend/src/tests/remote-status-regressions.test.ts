import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { strictParseFrame } from "@ceralive/control-protocol/parse";
import { ActiveProfilePayloadSchema } from "@ceralive/control-protocol/schemas";
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

function required<T>(value: T | undefined): T {
	if (value === undefined)
		throw new Error("required test fixture value is absent");
	return value;
}
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
			linkTelemetry: { links: [link("private-b", "1"), link("private-a")] },
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
			"counter-radio-a": {
				ifname: "radio-a",
				saved: { one: "1", two: "2", three: "3" },
			},
			"counter-radio-b": { ifname: "radio-b" },
		},
	}) as { wifi: Record<string, unknown> };
	const ids = Object.keys(out.wifi).map((k) => Number(k.split(" ").at(-1)));
	expect(ids[1]).toBe(required(ids[0]) + 1);
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
test("helper diagnostics retain producer flags and omit unused fields", () => {
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
		};
	};
	statusResponseSchema.parse(a);
	expect(a.remote_diagnostics.audio_present).toBe(true);
	expect(a.remote_diagnostics.ssh).toEqual({ active: true, enabled: false });
	expect(a.remote_diagnostics).not.toHaveProperty("policy_route_missing");
	expect(JSON.stringify(a)).not.toContain("private-");
	expect(
		projectRemoteStatus({ policy_route_missing: false, bond_mapping: null }),
	).not.toHaveProperty("remote_diagnostics");
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

test("connections sharing interfaces or physical links keep distinct stable keys", () => {
	for (const rows of [
		[
			{ ...link("same", "a"), link_id: undefined },
			{ ...link("same", "b"), link_id: undefined },
		],
		[link("same", "a"), link("same", "b")],
	]) {
		const read = (links: unknown[]) =>
			required(
				statusResponseSchema.parse(
					projectRemoteStatus({ linkTelemetry: { links } }),
				).linkTelemetry,
			).links;
		const a = read(rows),
			b = read([...rows].reverse());
		expect(new Set(a.map((r) => r.conn_id)).size).toBe(2);
		expect(required(a[0]).conn_id).toBe(required(b[1]).conn_id);
	}
});

test("transport and legacy provider keys are independent and reconnect stable", () => {
	const read = (transport: string) =>
		required(
			required(
				statusResponseSchema.parse(
					projectRemotePayload(
						"status",
						{ linkTelemetry: { links: [link("secret")] } },
						transport,
					),
				).linkTelemetry,
			).links[0],
		);
	const a = read("legacy:a"),
		b = read("cloud"),
		c = read("legacy:b");
	expect(a.conn_id).not.toBe(b.conn_id);
	expect(a.link_id).not.toBe(b.link_id);
	expect(a.conn_id).not.toBe(c.conn_id);
	expect(a).toEqual(read("legacy:a"));
});

test("command DTOs retain registry pipelines and published control enums", async () => {
	const { projectCommandResult } = await import(
		"../modules/remote-control/command-result-dto.ts"
	);
	const { videoPassthroughSchema } = await import("@ceraui/rpc/schemas");
	expect(
		projectCommandResult("streaming.getPipelines", {
			ok: true,
			applied: { pipelines: { decklink: {} } },
		}),
	).toHaveProperty("applied.pipelines.decklink");
	for (const mode of videoPassthroughSchema.options) {
		expect(
			projectCommandResult("streaming.getConfig", {
				ok: true,
				applied: { pipeline: "decklink", video_passthrough: mode },
			}).applied,
		).toEqual({ pipeline: "decklink", video_passthrough: mode });
	}
});

test("rejected nonempty legacy frames are counted without recording payload text", async () => {
	const { getRemoteProjectionDrops } = await import(
		"../modules/remote/remote-status.ts"
	);
	const before = getRemoteProjectionDrops();
	projectRemoteLegacyFrame({
		notification: {
			show: [{ msg: "secret" }],
			remove: [],
			epoch: crypto.randomUUID(),
			full: true,
		},
	});
	projectRemoteLegacyFrame({
		notification: {
			show: [{ msg: "secret" }],
			remove: [],
			epoch: crypto.randomUUID(),
			full: true,
		},
	});
	expect(getRemoteProjectionDrops()).toBe(before + 2);
});

test("every emitted message type validates against its published payload schema", async () => {
	const s = await import("@ceraui/rpc/schemas");
	const cases = [
		[
			"pipelines",
			{ hardware: "generic", pipelines: {} },
			s.pipelinesMessageSchema,
		],
		["sources", { hardware: "generic", sources: [] }, s.sourcesMessageSchema],
		["relays", { servers: {}, accounts: {} }, s.relayMessageSchema],
		["acodecs", { aac: { name: "AAC" } }, s.audioCodecsMessageSchema],
		["status", {}, s.statusResponseSchema],
		["config", {}, s.configMessageSchema],
		["sensors", {}, s.sensorsStatusSchema],
		["device-stats", {}, s.deviceStatsSchema],
		["netif", {}, s.netifMessageSchema],
		["modems", {}, s.modemListSchema],
	] as const;
	for (const [type, input, schema] of cases)
		expect(
			schema.safeParse(projectRemotePayload(type, input)).success,
			type,
		).toBe(true);
	for (const [type, input] of [
		["sensors", {}],
		["device-stats", {}],
		["telemetry", { samples: [] }],
		[
			"device.activeProfile",
			{
				config: {
					presetId: "classic",
					latencyMs: 200,
					fecEnabled: false,
					recoveryMode: "standard",
				},
			},
		],
	] as const) {
		strictParseFrame({
			v: 1,
			kind: "status",
			type,
			cid: crypto.randomUUID(),
			seq: 1,
			payload: projectRemotePayload(type, input),
		});
	}
	ActiveProfilePayloadSchema.parse(
		projectRemotePayload("device.activeProfile", {
			config: {
				presetId: "classic",
				latencyMs: 200,
				fecEnabled: false,
				recoveryMode: "standard",
			},
		}),
	);
	const notification = {
		show: [],
		remove: [],
		epoch: crypto.randomUUID(),
		full: true,
	};
	expect(
		s.notificationsMessageSchema.safeParse(
			projectRemotePayload("notification", notification),
		).success,
	).toBe(true);
});

const relayPath = `${import.meta.dir}/../modules/remote/notification-relay.ts`;
test.skipIf(!existsSync(relayPath))(
	"notification relay summaries and the legacy validator stay synchronized on integration",
	async () => {
		// The notification relay is an independently mergeable change. Once present,
		// compare its entire catalog and validate every producer summary at this boundary.
		const relay = await import(relayPath);
		const { NOTIFICATION_SUMMARIES } = await import(
			"../modules/remote/legacy-notification-dto.ts"
		);
		expect(relay.NOTIFICATION_SUMMARIES).toEqual(NOTIFICATION_SUMMARIES);
		for (const msg of Object.values(relay.NOTIFICATION_SUMMARIES)) {
			const payload = {
				show: [
					{
						name: "a".repeat(64),
						type: "warning",
						msg,
						revision: 1,
						is_persistent: true,
						is_dismissable: false,
						duration: 0,
					},
				],
				remove: [],
				epoch: crypto.randomUUID(),
				full: true,
			};
			expect(projectRemotePayload("notification", payload)).toEqual(payload);
		}
	},
);
