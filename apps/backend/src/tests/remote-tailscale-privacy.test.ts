import { afterEach, expect, spyOn, test } from "bun:test";
import * as mockService from "../mocks/mock-service.ts";
import { projectRemoteStatus } from "../modules/remote/remote-status.ts";
import {
	relayStatusToGateway,
	resetStatusRelay,
	setControlChannel,
} from "../modules/remote-control/status-relay.ts";
import {
	getTailscaleStatus,
	resetTailscaleForTest,
	setTailscaleDepsForTest,
} from "../modules/system/tailscale.ts";
import { buildMsg } from "../modules/ui/websocket-server.ts";
import { addClient, removeClient } from "../rpc/events.ts";
import type { AppWebSocket } from "../rpc/types.ts";
import { usePrivacyConfig } from "./helpers/remote-privacy-config.ts";
import {
	authenticateRemote,
	useRemotePrivacySocket,
} from "./helpers/remote-privacy-socket.ts";
import { statusClient } from "./helpers/status-client.ts";

// Names a device on its owner's private network. None of these may leave the
// device through either cloud path. Remote status is an allowlisted DTO, and
// remote access is not on it: a cloud remote cannot act on the card, so it
// does not see it either.
const HOSTNAME = "P2S_TS_HOST_5d1e";
const ADDRESS = "100.77.66.55";
const TAILNET = "P2S_TS_TAILNET_a7c0";
const KEY = "tskey-auth-P2STSKEY0000-ffffeeeeddddccccbbbb";

const PRIVATE = [HOSTNAME, ADDRESS, TAILNET, KEY];

function daemonJson(): string {
	return JSON.stringify({
		BackendState: "Running",
		Self: {
			HostName: HOSTNAME,
			DNSName: `${HOSTNAME}.${TAILNET}.ts.net.`,
			TailscaleIPs: [ADDRESS],
		},
		CurrentTailnet: { Name: TAILNET, MagicDNSSuffix: `${TAILNET}.ts.net` },
		MagicDNSSuffix: `${TAILNET}.ts.net`,
		AuthURL: `https://login.example/${KEY}`,
	});
}

usePrivacyConfig();
useRemotePrivacySocket();

let local: AppWebSocket | undefined;
afterEach(() => {
	if (local) removeClient(local);
	local = undefined;
	resetStatusRelay();
	resetTailscaleForTest();
});

function expectNothingPrivate(bytes: string): void {
	for (const value of PRIVATE) expect(bytes).not.toContain(value);
}

test("the projection drops remote access entirely", () => {
	const projected = projectRemoteStatus({
		ssh: { user: "ceralive", active: false, enabled: false },
		tailscale: { state: "connected", hostname: HOSTNAME, address: ADDRESS },
	}) as Record<string, unknown>;
	expect(projected).not.toHaveProperty("tailscale");
	expectNothingPrivate(JSON.stringify(projected));
});

test("the platform relay gets nothing of it, the local UI gets the name", async () => {
	spyOn(mockService, "shouldUseMocks").mockReturnValue(false);
	const relayed: unknown[] = [];
	const localFrames: string[] = [];
	local = statusClient((frame) => localFrames.push(frame));
	addClient(local);
	setControlChannel({
		isConnected: () => true,
		sendFrame: (frame) => relayed.push(frame),
	});
	setTailscaleDepsForTest({
		isInstalled: async () => true,
		isDaemonActive: async () => true,
		statusJson: async () => daemonJson(),
	});

	await getTailscaleStatus();
	// A mixed frame: an allowed sibling must arrive, the Tailscale fields not.
	relayStatusToGateway(
		"status",
		{
			is_streaming: false,
			tailscale: { state: "connected", hostname: HOSTNAME, address: ADDRESS },
		},
		1,
	);

	const relayBytes = JSON.stringify(relayed);
	expect(relayBytes).toContain('"is_streaming":false');
	expectNothingPrivate(relayBytes);
	expect(relayBytes).not.toContain("tailscale");

	expect(localFrames).toHaveLength(1);
	expect(localFrames[0]).toContain(HOSTNAME);
	expect(localFrames[0]).toContain(ADDRESS);
	// The parser never copies the tailnet name or the key, not even locally.
	expect(localFrames[0]).not.toContain(TAILNET);
	expect(localFrames[0]).not.toContain(KEY);
});

test("the cloud remote socket gets nothing of it", async () => {
	const remote = await authenticateRemote();
	remote.sent.length = 0;
	remote.send(
		buildMsg("status", {
			is_streaming: false,
			tailscale: { state: "connected", hostname: HOSTNAME, address: ADDRESS },
		}),
	);
	expect(remote.sent).toHaveLength(1);
	const frame = JSON.parse(remote.sent[0] ?? "{}") as {
		status?: Record<string, unknown>;
	};
	expect(frame.status?.is_streaming).toBe(false);
	expect(frame.status).not.toHaveProperty("tailscale");
	const sent = remote.sent.join("\n");
	expectNothingPrivate(sent);
	expect(sent).not.toContain("tailscale");
});
