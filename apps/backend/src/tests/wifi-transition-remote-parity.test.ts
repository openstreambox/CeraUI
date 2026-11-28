import { expect, spyOn, test } from "bun:test";
import WebSocket from "ws";
import { getConfig } from "../modules/config.ts";
import { projectRemoteStatus } from "../modules/remote/remote-status.ts";
import { PROTOCOL_VERSION } from "../modules/remote-control/protocol.ts";
import {
	resetStatusRelay,
	setControlChannel,
} from "../modules/remote-control/status-relay.ts";
import {
	type StatusResponseMessage,
	sendStatus,
} from "../modules/ui/status.ts";
import { rememberHotspotCredentials } from "../modules/wifi/hotspot-credentials.ts";
import { broadcastWifiState } from "../modules/wifi/wifi.ts";
import { cancelWifiAdapterReconciliation } from "../modules/wifi/wifi-adapter-reconcile-retry.ts";
import * as capabilities from "../modules/wifi/wifi-capabilities.ts";
import { wifiHotspotStart } from "../modules/wifi/wifi-hotspot-activation.ts";
import { handleHotspotConn } from "../modules/wifi/wifi-hotspot-discovery.ts";
import { settlePending } from "../modules/wifi/wifi-hotspot-monitor.ts";
import * as compat from "../rpc/compat.ts";
import { addClient, removeClient } from "../rpc/events.ts";
import { buildInitialStatus } from "../rpc/procedures/status.procedure.ts";
import { StubRemoteSocket, statusClient } from "./helpers/status-client.ts";
import { firstAp, MAC } from "./helpers/wifi-first-ap-fixture.ts";
import {
	caps,
	connectRemoteWifiStatus,
	stubRemoteWifiStatus,
	wifiStatusFrames,
} from "./helpers/wifi-remote-status-fixture.ts";

const cid = "00000000-0000-4000-8000-000000000001";

test("cleanup debt keeps all legacy Wi-Fi status bytes without relocking local peers", async () => {
	const f = await firstAp();
	// Exercise the compat bridge and both real remote status senders, with no socket or DNS I/O.
	stubRemoteWifiStatus();
	const telemetry = spyOn(
		capabilities,
		"refreshWifiLinkTelemetry",
	).mockResolvedValue(undefined);
	const config = getConfig();
	const previousKey = config.remote_key;
	config.remote_key = "synthetic-remote-key";
	const local: string[] = [];
	const relay: string[] = [];
	const terminal: unknown[] = [];
	const client = statusClient((bytes) => local.push(bytes));
	addClient(client);
	resetStatusRelay();
	setControlChannel({
		isConnected: () => true,
		sendFrame: (frame) => relay.push(JSON.stringify(frame)),
	});
	const ordinary = () => {
		const uuid = spyOn(crypto, "randomUUID").mockReturnValue(cid);
		try {
			broadcastWifiState();
		} finally {
			uuid.mockRestore();
		}
	};
	try {
		const { remote, authenticate } = await connectRemoteWifiStatus();
		f.faults.afterAdd = async () => {
			authenticate();
		};
		f.faults.upTimeout = f.faults.downFails = f.faults.deleteFails = true;
		const failure = {
			success: false,
			error: "activation-failed",
			reason: "cleanup-pending",
		} as const;
		expect(
			await wifiHotspotStart(
				{ device: f.row.id },
				{
					...f.deps,
					broadcastState: ordinary,
					publishOutcome: (...args) => terminal.push(args),
				},
			),
		).toEqual(failure);
		expect(terminal).toEqual([["start", f.row.id, failure]]);
		expect(f.row.hotspot.transition).toBe("activating");
		expect(f.active()).toBeString();
		ordinary();
		authenticate();
		const initial = buildInitialStatus().status;
		const legacy = {
			ifname: "wlan0",
			conn: "",
			hw: "Frame test radio",
			saved: {},
			available: [],
			supports_hotspot: true,
			mode: "station",
			observed_mode: "station",
			transition: "activating",
			capabilities: caps,
		};
		const { transition: _transition, ...settled } = legacy;
		const { ifname, conn, hw, saved, ...remaining } = settled;
		const { capabilities: trailing, ...presentation } = remaining;
		const localBase = {
			ifname,
			conn,
			hw,
			saved,
			incarnation: f.before,
			...presentation,
		};
		const busy = {
			...localBase,
			transition: "activating",
			leaving: "station",
			capabilities: trailing,
		};
		const completing = {
			...localBase,
			leaving: "station",
			capabilities: trailing,
		};
		const idle = { ...localBase, capabilities: trailing };
		const localBytes = wifiStatusFrames(local);
		const legacyBytes = wifiStatusFrames(remote.sent);
		expect(localBytes).toHaveLength(5);
		const firstSeq: number = JSON.parse(localBytes[0] ?? "").seq;
		// Authentication may also send local-only non-Wi-Fi status between these rows.
		// The train sends two more local-only status frames while the remote
		// authenticates, so later rows keep their order but not upstream's offsets.
		expect(localBytes.map((bytes) => JSON.parse(bytes).status)).toEqual(
			[busy, busy, completing, idle, idle].map((row) => ({ wifi: { 0: row } })),
		);
		const seqs = localBytes.map((bytes): number => JSON.parse(bytes).seq);
		expect(seqs.slice(0, 2)).toEqual([firstSeq, firstSeq + 1]);
		expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
		expect(JSON.stringify(initial.wifi)).toBe(JSON.stringify({ 0: idle }));
		const localInitial = new WebSocket("ws://localhost:12345");
		if (!(localInitial instanceof StubRemoteSocket))
			throw new Error("Missing fake local socket");
		sendStatus(localInitial);
		const frames = wifiStatusFrames(localInitial.sent);
		expect(frames).toHaveLength(1);
		const { status: initialWire }: { status: StatusResponseMessage } =
			JSON.parse(frames[0] ?? "");
		expect(JSON.stringify(initialWire.wifi)).toBe(JSON.stringify({ 0: idle }));
		expect(telemetry).toHaveBeenCalledTimes(7);
		// Both remote transports get the train's projection of the same rows: a
		// labelled row with no transition, mode witness or radio token.
		// The relay also carries the projected local-only frames ({ remote_status }).
		const relayWifi = relay.filter(
			(bytes) => "wifi" in (JSON.parse(bytes).payload ?? {}),
		);
		expect({ relay: relayWifi, legacy: legacyBytes }).toEqual({
			relay: relayWifi.map((bytes) =>
				JSON.stringify({
					v: PROTOCOL_VERSION,
					kind: "status",
					type: "status",
					cid,
					seq: JSON.parse(bytes).seq,
					payload: projectRemoteStatus({ wifi: { 0: legacy } }),
				}),
			),
			legacy: [1, 2].map(() =>
				JSON.stringify({
					status: projectRemoteStatus({ ...initialWire, wifi: { 0: legacy } }),
				}),
			),
		});
		expect(relayWifi.length).toBeGreaterThanOrEqual(3);
	} finally {
		removeClient(client);
		resetStatusRelay();
		cancelWifiAdapterReconciliation();
		config.remote_key = previousKey;
		await f.restore();
	}
});

test("profile rejection keeps ordered legacy status bytes but retires the local Start", async () => {
	const f = await firstAp();
	stubRemoteWifiStatus();
	const telemetry = spyOn(
		capabilities,
		"refreshWifiLinkTelemetry",
	).mockResolvedValue(undefined);
	const config = getConfig();
	const previousKey = config.remote_key;
	config.remote_key = "synthetic-remote-key";
	const local: string[] = [];
	const relay: string[] = [];
	const client = statusClient((bytes) => local.push(bytes));
	addClient(client);
	resetStatusRelay();
	setControlChannel({
		isConnected: () => true,
		sendFrame: (frame) => relay.push(JSON.stringify(frame)),
	});
	const ordinary = () => {
		const uuid = spyOn(crypto, "randomUUID").mockReturnValue(cid);
		try {
			broadcastWifiState();
		} finally {
			uuid.mockRestore();
		}
	};
	try {
		const { remote, authenticate } = await connectRemoteWifiStatus();
		f.deps.broadcastState = ordinary;
		expect(await f.start()).toEqual({ success: true });
		authenticate();
		const uuid = f.created();
		const fields = uuid && f.settings.get(uuid);
		if (!uuid || !fields) throw new Error("Missing fixture AP");
		const previous = f.row.hotspot;
		const foreignMac = "dc:a6:32:aa:bb:ff";
		rememberHotspotCredentials(foreignMac, {
			ssid: "Foreign AP",
			password: "foreign-password",
		});
		fields["802-11-wireless.mac-address"] = foreignMac;
		await handleHotspotConn(MAC, uuid);
		expect(f.row.hotspot).not.toBe(previous);
		expect(f.row.hotspot.conn).toBeUndefined();
		authenticate();
		ordinary();
		await settlePending(f.row.ifname, false);
		ordinary();

		const localInitial = new WebSocket("ws://localhost:12345");
		if (!(localInitial instanceof StubRemoteSocket))
			throw new Error("Missing fake local socket");
		sendStatus(localInitial);
		const { status: initial }: { status: StatusResponseMessage } = JSON.parse(
			wifiStatusFrames(localInitial.sent)[0] ?? "",
		);
		const legacy = {
			ifname: "wlan0",
			conn: "",
			hw: "Frame test radio",
			saved: {},
			available: [],
			supports_hotspot: true,
			mode: "station",
			observed_mode: "station",
			transition: "activating",
			capabilities: caps,
		};
		const {
			ifname,
			conn,
			hw,
			saved,
			transition,
			capabilities: trailing,
			...rest
		} = legacy;
		const localRow = {
			ifname,
			conn,
			hw,
			saved,
			incarnation: f.before,
			...rest,
		};
		const busy = {
			...localRow,
			transition,
			leaving: "station",
			capabilities: trailing,
		};
		const idle = { ...localRow, capabilities: trailing };
		const bytes = wifiStatusFrames(local);
		const firstSeq: number = JSON.parse(bytes[0] ?? "").seq;
		// Later rows keep their order behind the train's local-only status frames.
		expect(bytes.map((frame) => JSON.parse(frame).status)).toEqual(
			[busy, busy, idle, idle, idle].map((row) => ({ wifi: { 0: row } })),
		);
		const seqs = bytes.map((frame): number => JSON.parse(frame).seq);
		expect(seqs.slice(0, 2)).toEqual([firstSeq, firstSeq + 1]);
		expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
		expect(JSON.stringify(initial.wifi)).toBe(JSON.stringify({ 0: idle }));
		expect(telemetry).toHaveBeenCalledTimes(7);
		// Both remote transports get the train's projection of the same rows.
		// The relay also carries the projected local-only frames ({ remote_status }).
		const relayWifi = relay.filter(
			(bytes) => "wifi" in (JSON.parse(bytes).payload ?? {}),
		);
		expect({ relay: relayWifi, legacy: wifiStatusFrames(remote.sent) }).toEqual(
			{
				relay: relayWifi.map((bytes) =>
					JSON.stringify({
						v: PROTOCOL_VERSION,
						kind: "status",
						type: "status",
						cid,
						seq: JSON.parse(bytes).seq,
						payload: projectRemoteStatus({ wifi: { 0: legacy } }),
					}),
				),
				legacy: [1, 2].map(() =>
					JSON.stringify({
						status: projectRemoteStatus({ ...initial, wifi: { 0: legacy } }),
					}),
				),
			},
		);
		expect(relayWifi.length).toBeGreaterThanOrEqual(4);
	} finally {
		removeClient(client);
		resetStatusRelay();
		config.remote_key = previousKey;
		await f.restore();
	}
});
