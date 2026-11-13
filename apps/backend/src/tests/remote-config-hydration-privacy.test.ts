import { beforeEach, expect, spyOn, test } from "bun:test";
import WebSocket from "ws";
import { getConfig } from "../modules/config.ts";
import * as modemStatus from "../modules/modems/modem-status.ts";
import { sendInitialStatus } from "../modules/ui/status.ts";
import {
	APN_PASSWORD,
	AUTH_KEY,
	expectedBytes,
	expectNoPairingSecret,
	modem,
	secrets,
} from "./helpers/remote-privacy-cases.ts";
import { usePrivacyConfig } from "./helpers/remote-privacy-config.ts";
import {
	authenticateRemote,
	useRemotePrivacySocket,
} from "./helpers/remote-privacy-socket.ts";
import { StubRemoteSocket } from "./helpers/status-client.ts";

usePrivacyConfig();
useRemotePrivacySocket();
beforeEach(() => {
	spyOn(modemStatus, "buildModemsWireMessage").mockReturnValue({ lte: modem });
});

for (const provider of ["ceralive", "belabox", "custom"] as const) {
	test(`${provider} initial config and modem status omit pairing seed only while local hydration is byte-identical`, async () => {
		getConfig().remote_provider = provider;
		getConfig().custom_provider = {
			name: "Private provider",
			host: "remote.example",
			path: "/ws/remote",
			secure: true,
		};
		const local = new WebSocket("ws://localhost:12345");
		if (!(local instanceof StubRemoteSocket)) throw new Error("missing local");
		sendInitialStatus(local);
		const before = [...local.sent];
		const config = getConfig();
		const sourceBytes = JSON.stringify(config);

		const remote = await authenticateRemote();

		expect(remote.sent).toEqual(
			before.map((bytes) => {
				const frame = JSON.parse(bytes);
				if (frame.notification) frame.notification.remove = [];
				return expectedBytes(frame, frame.config);
			}),
		);
		expectNoPairingSecret(remote.sent.join("\n"));
		expect(remote.sent.join("\n")).toContain(AUTH_KEY);
		expect(before.join("\n")).toContain(secrets.ssh_pass);
		expect(before.join("\n")).toContain(APN_PASSWORD);
		local.sent.length = 0;
		sendInitialStatus(local);
		expect(local.sent).toEqual(before);
		expect(JSON.stringify(config)).toBe(sourceBytes);
	});
}

test("legacy encoder authentication fields remain byte-identical", async () => {
	const remote = await authenticateRemote();
	const frame =
		'{ "remote": { "auth/encoder": { "key": "P2S_REMOTE_AUTH_KEEP_72ba", "version": 16 } } }\n';
	remote.sent.length = 0;

	remote.send(frame);

	expect(remote.sent).toEqual([frame]);
});

test("legacy fake relay receives redacted persistent lifecycle and clears missed while offline", async () => {
	const { notificationBroadcast, notificationRemove } = await import(
		"../modules/ui/notifications.ts"
	);
	notificationBroadcast(
		"modem_roaming:PRIVATE-IMEI",
		"warning",
		"PRIVATE streamid passphrase address",
		0,
		true,
		true,
		true,
		"PRIVATE",
		{ passphrase: "PRIVATE" },
	);
	try {
		const first = await authenticateRemote();
		const notification = () =>
			first.sent
				.map((s) => JSON.parse(s))
				.filter((f) => f.notification)
				.at(-1)?.notification;
		const shown = notification().show[0];
		expect(shown.msg).toBe("A cellular connection is roaming.");
		expect(JSON.stringify(notification())).not.toContain("PRIVATE");
		first.sent.length = 0;
		notificationBroadcast(
			"modem_roaming:PRIVATE-IMEI",
			"error",
			"PRIVATE updated",
			0,
			true,
		);
		await Bun.sleep(300);
		expect(notification().show[0]).toMatchObject({
			name: shown.name,
			type: "error",
		});
		first.readyState = 3;
		notificationRemove("modem_roaming:PRIVATE-IMEI");
		await Bun.sleep(300);
		expect(notification().show[0].type).toBe("error");
		const second = await authenticateRemote();
		const cleared = second.sent
			.map((s) => JSON.parse(s))
			.filter((f) => f.notification)
			.at(-1)?.notification;
		expect(cleared.show).toEqual([]);
		expect(cleared.remove[0]).toMatchObject({
			id: shown.name,
			revision: expect.any(Number),
		});
	} finally {
		notificationRemove("modem_roaming:PRIVATE-IMEI");
	}
});
