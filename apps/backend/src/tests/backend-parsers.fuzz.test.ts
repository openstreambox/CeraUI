import { expect } from "bun:test";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
	loginInputSchema,
	setPasswordInputSchema,
	wifiConnectInputSchema,
} from "@ceraui/rpc/schemas";
import { readTelemetry } from "@ceraui/srtla-send";
import {
	createControlClient,
	senderStatsSchema,
	senderStatsToTelemetry,
} from "@ceraui/srtla-send/control";
import * as fc from "fast-check";
import {
	loadJsonConfig,
	writeFileAtomicSync,
} from "../helpers/config-loader.ts";
import {
	RUNTIME_CONFIG_DEFAULTS,
	runtimeConfigSchema,
} from "../helpers/config-schemas.ts";
import { parseRecord } from "../modules/device-logs/parse.ts";
import { nmcliParseSep } from "../modules/network/network-manager-output.ts";
import { FileJournal } from "../modules/network/two-radio/journal.ts";
import { FrameSchema } from "../modules/remote-control/protocol.ts";
import {
	buildBindMapDocument,
	renderIpsFile,
} from "../modules/streaming/bind-map.ts";
import {
	ipForConnId,
	registerSrtlaIpList,
	resetConnIdRegistry,
} from "../modules/streaming/link-telemetry-rows.ts";
import { classifyCapabilityDocument } from "../modules/streaming/srtla-capabilities.ts";
import { NotificationDismissalStore } from "../modules/ui/notification-dismissals.ts";
import { parseMessage } from "../rpc/adapter.ts";
import type { AppWebSocket } from "../rpc/types.ts";
import { fuzz, json, scratch, text } from "./helpers/property.ts";

const ws = { remoteAddress: "127.0.0.1", data: {} } as AppWebSocket;

fuzz("RPC input schemas", fc.tuple(text, json), ([value, wrongType]) => {
	const password = setPasswordInputSchema.safeParse({ password: value });
	// zod counts code points, not UTF-16 units
	expect(password.success).toBe([...value].length >= 8);
	expect(loginInputSchema.parse({ password: value }).persistent_token).toBe(
		false,
	);
	if (typeof wrongType !== "string") {
		expect(loginInputSchema.safeParse({ token: wrongType }).success).toBe(
			false,
		);
		expect(wifiConnectInputSchema.safeParse({ uuid: wrongType }).success).toBe(
			false,
		);
	}
});

fuzz("RPC adapter frames", fc.tuple(text, json), ([id, input]) => {
	const frame = { id, path: ["streaming", "setConfig"], input };
	expect(parseMessage(JSON.stringify(frame), ws)).toEqual(frame);
	expect(parseMessage(JSON.stringify({ pong: id }), ws)).toBeNull();
	expect(parseMessage(JSON.stringify(frame).slice(0, -1), ws)).toBeNull();
});

fuzz(
	"config load and atomic replacement",
	fc.tuple(text, fc.nat()),
	([source, cut]) =>
		scratch(async (dir) => {
			const path = join(dir, "config.json");
			const valid = JSON.stringify({ source, autostart: true });
			// cut the encoded bytes: slicing a string could split a surrogate pair
			const bytes = Buffer.from(valid);
			const partial = bytes.subarray(0, cut % bytes.length);
			await Bun.write(path, partial);
			const read = () =>
				loadJsonConfig(path, runtimeConfigSchema, RUNTIME_CONFIG_DEFAULTS);
			expect((await read()).loaded).toBe(false);
			expect(Buffer.from(await Bun.file(path).arrayBuffer())).toEqual(partial);
			writeFileAtomicSync(path, JSON.stringify({ source, autostart: [] }), {
				mode: 0o600,
			});
			const salvaged = await read();
			expect(salvaged.invalidFields).toContain("autostart");
			expect(salvaged.data).toMatchObject({ source, autostart: false });
			writeFileAtomicSync(path, valid);
			expect((await read()).data).toMatchObject({ source, autostart: true });
			expect((await stat(path)).mode & 0o777).toBe(0o600);
			expect(await readdir(dir)).toEqual(["config.json"]);
		}),
);

fuzz(
	"network-change journal",
	fc.tuple(fc.nat(), json),
	([cut, unknownField]) =>
		scratch(async (dir) => {
			const path = join(dir, "journal.json");
			const journal = new FileJournal(path);
			const snapshot = {
				version: 1 as const,
				session: "test-session",
				operations: [],
			};
			expect(await journal.load()).toBeNull();
			await journal.save(snapshot);
			expect(await journal.load()).toEqual(snapshot);
			const raw = await Bun.file(path).text();
			await Bun.write(path, raw.slice(0, cut % raw.length));
			await expect(journal.load()).rejects.toBeInstanceOf(SyntaxError);
			await Bun.write(path, JSON.stringify({ ...snapshot, unknownField }));
			await expect(journal.load()).rejects.toBeInstanceOf(Error);
		}),
);

const ipv4 = fc
	.tuple(fc.nat(255), fc.nat(255), fc.nat(255), fc.nat(255))
	.map((octets) => octets.join("."));

fuzz(
	"bind-map and IP-list projection",
	fc.array(ipv4, { minLength: 1, maxLength: 8 }),
	(ips) => {
		const lines = [...ips, ...ips];
		const entries = lines.map((ip, index) => ({
			ip,
			iface: `eth${index}`,
			linkId: `fixture-${index}`,
		}));
		const rendered = renderIpsFile(entries);
		const digest = new Bun.CryptoHasher("sha256")
			.update(rendered)
			.digest("hex");
		const doc = buildBindMapDocument(entries, 1, digest);
		expect(doc.links.map((link) => link.ip)).toEqual(rendered.split("\n"));
		expect(doc.ips_file_sha256).toBe(digest);
		resetConnIdRegistry();
		try {
			registerSrtlaIpList(
				rendered
					.split("\n")
					.map((ip) => ` ${ip}\r`)
					.concat(""),
			);
			const unique = [...new Set(lines)];
			expect(unique.map((_, index) => ipForConnId(String(index)))).toEqual(
				unique,
			);
			expect(ipForConnId(String(unique.length))).toBeUndefined();
		} finally {
			resetConnIdRegistry();
		}
	},
);

fuzz(
	"sender stats and capability documents",
	fc.tuple(fc.nat(100_000), json),
	([rate, extra]) =>
		scratch(async (dir) => {
			const stats = {
				mode: "classic",
				links: [
					{
						conn_id: 0,
						connected: true,
						timed_out: false,
						window: 20,
						in_flight: 1,
						rtt_ms: 50,
						nak_count: 0,
						bitrate_bytes_per_sec: rate,
						base_score: 10,
						quality_multiplier: 1,
						extra,
					},
				],
			};
			const parsed = senderStatsSchema.parse(stats);
			expect(parsed.links[0]).not.toHaveProperty("extra");
			expect(senderStatsToTelemetry(parsed)?.connections[0]?.bitrate_bps).toBe(
				rate * 8,
			);
			if (typeof extra !== "number") {
				expect(
					senderStatsSchema.safeParse({
						...stats,
						links: [{ ...stats.links[0], bitrate_bytes_per_sec: extra }],
					}).success,
				).toBe(false);
			}
			const path = join(dir, "stats.json");
			await Bun.write(path, JSON.stringify(stats).slice(0, -1));
			expect(await readTelemetry(path)).toBeNull();
			expect(classifyCapabilityDocument(1, JSON.stringify(extra)).bindMap).toBe(
				false,
			);
		}),
);

fuzz(
	"sender control protocol",
	fc.tuple(text, fc.boolean()),
	([noise, quality]) =>
		scratch(async (dir) => {
			const socketPath = join(dir, "control.sock");
			const server = Bun.listen<{ input: string }>({
				unix: socketPath,
				socket: {
					open(socket) {
						socket.data = { input: "" };
					},
					data(socket, chunk) {
						socket.data.input += chunk.toString();
						if (!socket.data.input.endsWith("\n")) return;
						const { id } = JSON.parse(socket.data.input);
						socket.data.input = "";
						socket.write(`?${JSON.stringify(noise)}\n`);
						socket.write(
							`${JSON.stringify({
								jsonrpc: "2.0",
								id,
								result: { mode: "classic", quality_enabled: quality },
							})}\n`,
						);
					},
				},
			});
			const client = await createControlClient({ socketPath, timeoutMs: 1000 });
			try {
				expect(client).not.toBeNull();
				expect(await client?.getStatus()).toEqual({
					mode: "classic",
					quality_enabled: quality,
				});
			} finally {
				client?.close();
				server.stop(true);
			}
		}),
);

fuzz("remote control envelope", json, (input) => {
	expect(
		FrameSchema.safeParse({ v: 2, kind: "unregistered-frame", payload: input })
			.success,
	).toBe(false);
	const result = FrameSchema.safeParse(input);
	if (result.success)
		expect(FrameSchema.safeParse(result.data).success).toBe(true);
});

fuzz(
	"notification and journal text",
	fc.tuple(text, fc.nat(), fc.uint8Array({ maxLength: 128 })),
	([key, timestamp, bytes]) => {
		const entry = { key: `notice:${key}`, dismissedAt: timestamp };
		let raw = JSON.stringify({ version: 1, entries: [entry] });
		let quarantines = 0;
		const store = new NotificationDismissalStore({
			path: "unused",
			deps: {
				readText: () => raw,
				now: () => 0,
				quarantine: () => {
					quarantines++;
				},
				logCorruption: () => {},
			},
		});
		store.load();
		expect(store.keys()).toEqual([entry.key]);
		raw = raw.slice(0, -1);
		store.load();
		expect(store.size()).toBe(0);
		expect(quarantines).toBe(1);
		const record = {
			__CURSOR: "test-cursor",
			__REALTIME_TIMESTAMP: String(timestamp),
			_BOOT_ID: "a".repeat(32),
		};
		expect(
			parseRecord({ ...record, MESSAGE: Array.from(bytes) }),
		).toMatchObject({
			ts: Math.floor(timestamp / 1000),
			message: new TextDecoder().decode(bytes),
		});
		expect(
			parseRecord({ ...record, __REALTIME_TIMESTAMP: `x${timestamp}` }),
		).toBeNull();
	},
);

fuzz(
	"NetworkManager escaped fields",
	fc.array(text, { minLength: 1, maxLength: 8 }),
	(fields) => {
		const escaped = fields.map((field) =>
			field.replaceAll("\\", "\\\\").replaceAll(":", "\\:"),
		);
		expect(nmcliParseSep(escaped.join(":"))).toEqual(fields);
	},
);
