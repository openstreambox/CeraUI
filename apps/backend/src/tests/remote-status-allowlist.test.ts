import { afterEach, expect, test } from "bun:test";
import { strictParseFrame } from "@ceralive/control-protocol/parse";
import { projectRemoteStatus } from "../modules/remote/remote-status.ts";
import {
	RELAYABLE_TYPES,
	relayStatusToGateway,
	resetStatusRelay,
	setControlChannel,
} from "../modules/remote-control/status-relay.ts";

afterEach(resetStatusRelay);
const secret = "PRIVATE_SSID_BSSID_MAC_IP_HOST_MODEM_SIM_PATH_STREAM_ACCOUNT";
test("all status types reject identifiers in keys, values and future fields", () => {
	const frames: unknown[] = [];
	setControlChannel({
		isConnected: () => true,
		sendFrame: (f) => {
			frames.push(f);
		},
	});
	for (const type of RELAYABLE_TYPES) {
		const poison = {
			[secret]: secret,
			name: secret,
			password: secret,
			ifname: secret,
			ip: secret,
			status: secret,
			config: { password: secret },
			wifi: {
				[secret]: {
					hw: secret,
					ifname: secret,
					conn: secret,
					saved: { [secret]: secret },
					available: [{ ssid: secret }],
					hotspot: { name: secret, password: secret },
				},
			},
			modems: {
				[secret]: {
					name: secret,
					config: { apn: secret, username: secret, password: secret },
					status: { connection: secret },
				},
			},
		};
		relayStatusToGateway(type, poison, 1);
	}
	expect(frames.length).toBeGreaterThan(0);
	for (const frame of frames) {
		expect(JSON.stringify(frame)).not.toContain(secret);
		expect(() => strictParseFrame(frame)).not.toThrow();
	}
});
test("network labels stay stable across updates and do not mutate local state", () => {
	const local = {
		is_streaming: true,
		wifi: {
			privateRadio: {
				ifname: secret,
				hw: secret,
				conn: secret,
				saved: { [secret]: secret },
				available: [
					{
						ssid: secret,
						active: true,
						signal: 80,
						freq: 5200,
						security: secret,
					},
				],
			},
		},
	};
	const before = JSON.stringify(local);
	const a = projectRemoteStatus(local);
	expect(JSON.stringify(a)).not.toContain(secret);
	expect(JSON.stringify(a)).toMatch(/Wi-Fi \d+/);
	expect(projectRemoteStatus(local)).toEqual(a);
	expect(JSON.stringify(local)).toBe(before);
});

test("closed modem radio technology labels survive without operator text", () => {
	const frames: unknown[] = [];
	setControlChannel({
		isConnected: () => true,
		sendFrame: (f) => {
			frames.push(f);
		},
	});
	relayStatusToGateway(
		"modems",
		{
			privateModem: {
				status: {
					connection: "registered",
					network_type: "5G",
					signal: 78,
					operator: "private-operator",
				},
			},
		},
		1,
	);
	const payload = (
		frames[0] as { payload: Record<string, { status: unknown }> }
	).payload;
	expect(Object.values(payload)[0]?.status).toEqual({
		connection: "registered",
		network_type: "5G",
		signal: 78,
	});
	expect(JSON.stringify(frames)).not.toContain("private-");
});
