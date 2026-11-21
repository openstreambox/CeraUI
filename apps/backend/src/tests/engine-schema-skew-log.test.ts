import { beforeEach, expect, test } from "bun:test";
import {
	type CerastreamClient,
	CerastreamConnectionError,
	SCHEMA_VERSION,
} from "@ceralive/cerastream";
import {
	type CapabilitiesLogger,
	clearCapabilitiesCache,
	getCapabilities,
	invalidateCapabilities,
} from "../modules/streaming/capabilities.ts";
import { CerastreamBackend } from "../modules/streaming/cerastream-backend.ts";

// The box this was seen on: engine schema 0.21 against bindings 0.24. Each
// probe and capability read sees the same hello, several times per start.
const ENGINE_SCHEMA = "0.0.1-older";

function logSpy() {
	const warns: Array<{ msg: string; meta?: unknown }> = [];
	const logger: CapabilitiesLogger = {
		debug: () => {},
		info: () => {},
		warn: (msg, meta) => warns.push({ msg, meta }),
		error: () => {},
	};
	return {
		logger,
		skewWarnings: () => warns.filter((w) => w.msg.includes("schema_version")),
	};
}

function helloClient(schemaVersion: string): CerastreamClient {
	return {
		hello: {
			protocol: "cerastream-ipc/1",
			schema_version: schemaVersion,
			engine_version: "2026.9.8",
		},
		close: async () => {},
	} as unknown as CerastreamClient;
}

function readCapabilities(logger: CapabilitiesLogger, schemaVersion: string) {
	return getCapabilities({
		fetchEngineCapabilities: async () => ({
			caps: {
				platform: {
					supports_h265: false,
					hardware_accelerated: false,
					max_resolution: "1920x1080",
				},
				encoder: {
					codecs: ["H264"],
					bitrate_range: { min: 500, max: 6000, unit: "kbps" },
				},
				sources: [],
			},
			schemaVersion,
		}),
		fetchEngineDevices: async () => ({ devices: [] }),
		bindingsSchemaVersion: SCHEMA_VERSION,
		logger,
	});
}

beforeEach(() => {
	clearCapabilitiesCache();
});

test("one engine connection logs the schema skew once, with both versions", async () => {
	const spy = logSpy();
	const backend = new CerastreamBackend({
		connect: async () => helloClient(ENGINE_SCHEMA),
		logger: spy.logger,
	});

	await backend.probeEngine();
	await backend.probeEngine();
	const caps = await readCapabilities(spy.logger, ENGINE_SCHEMA);
	await readCapabilities(spy.logger, ENGINE_SCHEMA);

	// The flag the UI reads is not affected by the quieter log.
	expect(caps.schemaVersionMismatch).toBe(true);
	expect(spy.skewWarnings()).toHaveLength(1);
	expect(spy.skewWarnings()[0]?.meta).toMatchObject({
		engine: ENGINE_SCHEMA,
		bindings: SCHEMA_VERSION,
	});
});

test("an engine that comes back after a failed probe logs the skew again", async () => {
	const spy = logSpy();
	let reachable = true;
	const backend = new CerastreamBackend({
		connect: async () => {
			if (!reachable) throw new CerastreamConnectionError("no socket");
			return helloClient(ENGINE_SCHEMA);
		},
		logger: spy.logger,
	});

	await backend.probeEngine();
	reachable = false;
	expect((await backend.probeEngine()).status).toBe("unreachable");
	reachable = true;
	await backend.probeEngine();

	expect(spy.skewWarnings()).toHaveLength(2);
});

test("a lost session connection re-arms the skew warning", async () => {
	const spy = logSpy();
	await readCapabilities(spy.logger, ENGINE_SCHEMA);
	await readCapabilities(spy.logger, ENGINE_SCHEMA);
	invalidateCapabilities();
	await readCapabilities(spy.logger, ENGINE_SCHEMA);

	expect(spy.skewWarnings()).toHaveLength(2);
});

test("a capability read that finds the engine gone re-arms the skew warning", async () => {
	const spy = logSpy();
	await readCapabilities(spy.logger, ENGINE_SCHEMA);
	await getCapabilities({
		fetchEngineCapabilities: async () => {
			throw new CerastreamConnectionError("engine restarting");
		},
		bindingsSchemaVersion: SCHEMA_VERSION,
		logger: spy.logger,
	});
	await readCapabilities(spy.logger, ENGINE_SCHEMA);

	expect(spy.skewWarnings()).toHaveLength(2);
});

test("a different engine schema is logged at once", async () => {
	const spy = logSpy();
	await readCapabilities(spy.logger, ENGINE_SCHEMA);
	await readCapabilities(spy.logger, "0.0.2-older");

	expect(spy.skewWarnings()).toHaveLength(2);
	expect(spy.skewWarnings()[1]?.meta).toMatchObject({
		engine: "0.0.2-older",
		bindings: SCHEMA_VERSION,
	});
});

test("matching schemas log nothing", async () => {
	const spy = logSpy();
	await readCapabilities(spy.logger, SCHEMA_VERSION);
	expect(spy.skewWarnings()).toHaveLength(0);
});
