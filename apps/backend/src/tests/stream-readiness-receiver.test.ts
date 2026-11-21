import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	expect,
	spyOn,
	test,
} from "bun:test";
import type { RelaysCache } from "../helpers/config-schemas.ts";
import { initMockService, stopMockService } from "../mocks/mock-service.ts";
import { getConfig } from "../modules/config.ts";
import {
	getRelays,
	setRelaysCacheMock,
} from "../modules/remote/remote-relays.ts";
import * as srtla from "../modules/streaming/srtla.ts";
import {
	currentCandidates,
	currentReceiver,
} from "../modules/streaming/stream-readiness.ts";
import { resolveStreamEndpoint } from "../modules/streaming/transport/resolve-endpoint.ts";

// currentReceiver must accept exactly what Start's endpoint resolver accepts.

const RELAYS = {
	servers: {
		managed: {
			type: "srtla",
			name: "Managed",
			addr: "relay.example",
			port: 7000,
		},
	},
	accounts: {},
} as unknown as RelaysCache;

const FIELDS = [
	"relay_server",
	"relay_account",
	"srtla_addr",
	"srtla_port",
	"srt_streamid",
	"relay_streamid_override",
	"relay_protocol",
] as const;
let saved: Record<string, unknown>;
let savedRelays: RelaysCache | undefined;
const savedMockMode = process.env.MOCK_MODE;

beforeAll(() => {
	process.env.MOCK_MODE = "true";
	initMockService("caps-full");
});

afterAll(() => {
	stopMockService();
	if (savedMockMode === undefined) delete process.env.MOCK_MODE;
	else process.env.MOCK_MODE = savedMockMode;
});

beforeEach(() => {
	const config = getConfig() as Record<string, unknown>;
	saved = Object.fromEntries(FIELDS.map((f) => [f, config[f]]));
	savedRelays = getRelays();
	setRelaysCacheMock(structuredClone(RELAYS));
});

afterEach(() => {
	Object.assign(getConfig(), saved);
	setRelaysCacheMock(savedRelays);
});

function configure(fields: Record<string, unknown>) {
	const config = getConfig() as Record<string, unknown>;
	for (const f of FIELDS) config[f] = undefined;
	Object.assign(config, { relay_protocol: "srtla", ...fields });
}

test("a manual SRTLA endpoint with a stream ID is configured, keyed by host and port", () => {
	configure({
		srtla_addr: "Receiver.Example",
		srtla_port: 5000,
		srt_streamid: "key",
	});
	expect(currentReceiver()).toEqual({
		configured: "yes",
		key: "receiver.example:5000",
		local: false,
		address: "Receiver.Example",
	});
});

test("an empty manual stream ID is accepted like Start accepts it", () => {
	configure({ srtla_addr: "203.0.113.7", srtla_port: 5000, srt_streamid: "" });
	expect(() =>
		resolveStreamEndpoint(
			{ srtla_addr: "203.0.113.7", srtla_port: 5000, srt_streamid: "" },
			getRelays(),
			"srtla",
		),
	).not.toThrow();
	expect(currentReceiver().configured).toBe("yes");
});

test("a catalog relay with a custom stream ID resolves to the catalog endpoint", () => {
	configure({
		relay_server: "managed",
		srt_streamid: "",
		relay_streamid_override: "custom",
	});
	expect(currentReceiver()).toMatchObject({
		configured: "yes",
		key: "relay.example:7000",
	});
});

test("an unknown relay id is invalid, nothing set is not set", () => {
	configure({ relay_server: "gone" });
	expect(currentReceiver().configured).toBe("invalid");
	configure({});
	expect(currentReceiver().configured).toBe("no");
});

test("a private receiver literal takes Start's local path", () => {
	configure({
		srtla_addr: "192.168.42.20",
		srtla_port: 5000,
		srt_streamid: "k",
	});
	expect(currentReceiver()).toMatchObject({
		local: true,
		address: "192.168.42.20",
	});
});

test("candidates come from Start's own bond-entry collectors", () => {
	const local = spyOn(
		srtla,
		"genSrtlaBondEntriesForLocalIpAddress",
	).mockReturnValue([]);
	const bond = spyOn(srtla, "genSrtlaBondEntries").mockReturnValue([
		{ iface: "wwan0", ip: "10.0.0.2" } as never,
		{ iface: "wwan0", ip: "10.0.0.3" } as never,
	]);
	try {
		// An unsettled or unmappable same-subnet link is absent from Start's
		// local list, so the flag has no candidate either.
		expect(
			currentCandidates({
				configured: "yes",
				local: true,
				address: "192.168.42.20",
			}),
		).toEqual([]);
		expect(local).toHaveBeenCalledWith("192.168.42.20");
		expect(
			currentCandidates({
				configured: "yes",
				local: false,
				address: "relay.example",
			}).map((c) => c.iface),
		).toEqual(["wwan0"]);
		expect(bond).toHaveBeenCalled();
	} finally {
		local.mockRestore();
		bond.mockRestore();
	}
});
