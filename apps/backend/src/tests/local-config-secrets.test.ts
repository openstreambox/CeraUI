/**
 * No local `config` frame carries a device-only secret.
 *
 * Every signed-in local tab receives `config` frames: the login snapshot, each
 * writer's broadcast, and a single-socket push. Those frames used to be the
 * runtime config with only the SRT passphrase and the Stream IDs projected, so
 * the pairing claim-code seed (and any other secret-named key, at any depth)
 * reached every tab, and an Autostart toggle echoed all of it again. Add-on
 * state carried its owner-typed `userConfig` the same way. The owner's
 * `ssh_pass` and `remote_key` stay: the SSH and cloud-remote dialogs read them.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { AddonDescriptorSchema } from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";
import { runtimeConfigSchema } from "../helpers/config-schemas.ts";
import {
	OWNER_READABLE_CONFIG_KEYS,
	publicLocalConfig,
} from "../helpers/local-config-projection.ts";
import { isSensitiveKey } from "../helpers/logger.ts";
import { ADDON_EVENT } from "../modules/addons/manager.ts";
import { getConfig } from "../modules/config.ts";
import {
	resetStatusRelay,
	setControlChannel,
} from "../modules/remote-control/status-relay.ts";
import { setAutostart } from "../modules/streaming/streamloop/autostart.ts";
import { broadcastMsg, buildMsg } from "../rpc/compat.ts";
import { broadcastConfig } from "../rpc/config-broadcast.ts";
import { createContext } from "../rpc/context.ts";
import { buildMessage, sendToClient } from "../rpc/events.ts";
import {
	getAddonStatusProcedure,
	listAddonsProcedure,
	resetAddonProcedureDeps,
	setAddonProcedureDeps,
} from "../rpc/procedures/addons.procedure.ts";
import { captivePortalProcedure } from "../rpc/procedures/captive-portal.procedure.ts";
import type { AppWebSocket } from "../rpc/types.ts";
import { useConfigClient } from "./helpers/config-client.ts";

const SEED = "SYNTHETIC_PAIRING_SEED_5d1e";
const SSH = "SYNTHETIC_SSH_PASS_77c0";
const REMOTE = "SYNTHETIC_REMOTE_KEY_a913";
const STREAM = "SYNTHETIC_STREAM_ID_0b4f";
const ADDON_TOKEN = "SYNTHETIC_ADDON_TOKEN_e2c8";

const { tab, frames } = useConfigClient();

afterEach(() => {
	setControlChannel(null);
	resetStatusRelay();
});

/** A stored config holding every kind of secret the runtime config can hold. */
function storeSecrets(): void {
	Object.assign(getConfig(), {
		max_br: 6000,
		autostart: false,
		pairing_secret: SEED,
		ssh_pass: SSH,
		remote_key: REMOTE,
		srt_streamid: STREAM,
		srt_passphrase: "SYNTHETIC_SRT_PASSPHRASE_61aa",
		password: "SYNTHETIC_LEGACY_PASSWORD_93fd",
		modem_capabilities: { ussd: true, sms: false },
		addons: {
			example: {
				enabled: true,
				phase: "active",
				autoDisabled: false,
				userConfig: { api_token: ADDON_TOKEN, label: "kept" },
			},
		},
	});
}

const lastConfig = () => frames().at(-1)?.config as Record<string, unknown>;

describe("Autostart echoes only its own setting", () => {
	test("toggling Autostart sends no pairing seed and no other setting", () => {
		storeSecrets();
		tab.sent = [];

		setAutostart(true);

		expect(tab.sent.join("\n")).not.toContain(SEED);
		expect(frames()).toHaveLength(1);
		expect(lastConfig()).toEqual({
			autostart: true,
			srt_streamid_configured: true,
			relay_streamid_override_configured: false,
		});
	});

	test("the cloud relay still gets its allowlisted settings, not a partial frame", () => {
		storeSecrets();
		const relayed: unknown[] = [];
		setControlChannel({
			isConnected: () => true,
			sendFrame: (frame) => relayed.push(frame),
		});

		setAutostart(true);

		expect(relayed).toHaveLength(1);
		expect(JSON.stringify(relayed)).not.toContain(SEED);
		expect((relayed[0] as { payload: unknown }).payload).toMatchObject({
			autostart: true,
			max_br: 6000,
		});
	});
});

test("enabling the hotel sign-in echoes only that setting", async () => {
	storeSecrets();
	tab.sent = [];
	const ws = {
		remoteAddress: "::ffff:10.42.0.2",
		data: { isAuthenticated: true, lastActive: 0 },
	} as unknown as AppWebSocket;

	await call(
		captivePortalProcedure,
		{ action: "configure", enabled: true },
		{ context: createContext(ws) },
	);

	expect(tab.sent.join("\n")).not.toContain(SEED);
	expect(lastConfig()).toEqual({
		captive_portal_enabled: true,
		srt_streamid_configured: true,
		relay_streamid_override_configured: false,
	});
});

describe("every full-config path withholds the secrets", () => {
	const paths: ReadonlyArray<[string, () => string]> = [
		[
			"broadcastConfig (every settings writer)",
			() => {
				tab.sent = [];
				broadcastConfig(getConfig());
				return tab.sent.join("\n");
			},
		],
		[
			"sendToClient (the login snapshot)",
			() => {
				const sent: string[] = [];
				sendToClient(
					{ send: (m: string) => sent.push(m) } as unknown as AppWebSocket,
					"config",
					getConfig(),
				);
				return sent.join("\n");
			},
		],
		[
			"buildMsg (the initial status of a legacy socket)",
			() => buildMsg("config", getConfig()),
		],
		["buildMessage", () => buildMessage("config", getConfig(), "id-1")],
	];

	for (const [name, send] of paths) {
		test(name, () => {
			storeSecrets();
			const before = JSON.stringify(getConfig());

			const wire = send();
			const config = (
				JSON.parse(wire.split("\n").at(-1) ?? "{}") as {
					config: Record<string, unknown>;
				}
			).config;

			expect(wire).not.toContain(SEED);
			expect(wire).not.toContain(STREAM);
			expect(wire).not.toContain(ADDON_TOKEN);
			expect(wire).not.toContain("SYNTHETIC_SRT_PASSPHRASE");
			expect(wire).not.toContain("SYNTHETIC_LEGACY_PASSWORD");
			// The owner's dialogs read these back.
			expect(config.ssh_pass).toBe(SSH);
			expect(config.remote_key).toBe(REMOTE);
			// A boolean under a secret-named key is a switch, not a secret.
			expect(config.modem_capabilities).toEqual({ ussd: true, sms: false });
			expect(config.srt_streamid_configured).toBe(true);
			expect(
				(config.addons as Record<string, { userConfig: unknown }>).example
					.userConfig,
			).toEqual({ label: "kept" });
			expect(config.max_br).toBe(6000);
			// The live config is never edited to build a frame.
			expect(JSON.stringify(getConfig())).toBe(before);
		});
	}
});

test("every secret-named key of the config schema is withheld locally", () => {
	const config: Record<string, unknown> = {};
	const withheld: string[] = [];
	for (const key of Object.keys(runtimeConfigSchema.shape)) {
		if (!isSensitiveKey(key) || OWNER_READABLE_CONFIG_KEYS.has(key)) continue;
		config[key] = `SYNTHETIC_${key}`;
		withheld.push(key);
	}
	expect(withheld).toContain("pairing_secret");

	const frame = JSON.stringify(publicLocalConfig(config));

	for (const key of withheld) expect(frame).not.toContain(`SYNTHETIC_${key}`);
});

test("a subtree deeper than any config shape is withheld, not sent raw", () => {
	let deep: Record<string, unknown> = { label: "SYNTHETIC_DEEP_LEAF" };
	for (let i = 0; i < 20; i++) deep = { level: deep };

	const frame = JSON.stringify(publicLocalConfig({ deep, max_br: 1 }));

	expect(frame).not.toContain("SYNTHETIC_DEEP_LEAF");
	expect(frame).toContain('"max_br":1');
});

test("a config payload sent as an array has each element projected", () => {
	const frame = JSON.stringify(
		publicLocalConfig([{ pairing_secret: SEED, max_br: 1 }, "kept"]),
	);

	expect(frame).toBe('[{"max_br":1},"kept"]');
});

const descriptor = AddonDescriptorSchema.parse(
	await Bun.file(
		join(import.meta.dir, "../../tests/fixtures/addons/test-addon-a.json"),
	).json(),
);

describe("add-on state withholds secret-named userConfig fields", () => {
	const state = {
		enabled: true,
		phase: "active",
		autoDisabled: false,
		userConfig: { api_token: ADDON_TOKEN, label: "kept" },
	} as const;

	afterEach(() => resetAddonProcedureDeps());

	test("the addons push (login snapshot and manager broadcast)", () => {
		const sent: string[] = [];
		sendToClient(
			{ send: (m: string) => sent.push(m) } as unknown as AppWebSocket,
			ADDON_EVENT,
			{ [descriptor.id]: state },
		);
		tab.sent = [];
		broadcastMsg(ADDON_EVENT, { [descriptor.id]: state });
		const wire = [...sent, ...tab.sent].join("\n");

		const projected = {
			[descriptor.id]: { ...state, userConfig: { label: "kept" } },
		};
		expect(wire).not.toContain(ADDON_TOKEN);
		expect(JSON.parse(sent[0] ?? "{}")).toEqual({ addons: projected });
		expect(tab.sent).toHaveLength(1);
		expect(JSON.parse(tab.sent[0] ?? "{}")).toMatchObject({
			addons: projected,
		});
		expect(state.userConfig.api_token).toBe(ADDON_TOKEN);
	});

	test("addons.list and addons.getStatus", async () => {
		setAddonProcedureDeps({
			readDescriptors: async () => [descriptor],
			getAddonState: () => state,
		});
		const context = {
			context: createContext({
				data: { isAuthenticated: true, lastActive: 0 },
			} as unknown as AppWebSocket),
		};

		const list = await call(listAddonsProcedure, undefined, context);
		const one = await call(
			getAddonStatusProcedure,
			{ id: descriptor.id },
			context,
		);

		expect(JSON.stringify([list, one])).not.toContain(ADDON_TOKEN);
		expect(one?.state.userConfig).toEqual({ label: "kept" });
		expect(list.addons[0]?.state.userConfig).toEqual({ label: "kept" });
	});
});
