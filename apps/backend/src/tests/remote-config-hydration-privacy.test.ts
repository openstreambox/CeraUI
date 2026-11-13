import { beforeEach, expect, spyOn, test } from "bun:test";
import WebSocket from "ws";
import { logger } from "../helpers/logger.ts";
import { getConfig } from "../modules/config.ts";
import * as modemStatus from "../modules/modems/modem-status.ts";
import { getRemoteProjectionDrops } from "../modules/remote/remote-status.ts";
import { sendInitialStatus } from "../modules/ui/status.ts";
import { expectNoSourceStrings } from "./helpers/remote-outbound-assert.ts";
import {
	APN_PASSWORD,
	AUTH_KEY,
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

test("real initial hydration causes no rejection warning", async () => {
	const before = getRemoteProjectionDrops();
	const warning = spyOn(logger, "warn");
	const remote = await authenticateRemote();
	expect(getRemoteProjectionDrops()).toBe(before);
	expect(
		warning.mock.calls.filter(([text]) =>
			String(text).includes("rejected by projection"),
		),
	).toHaveLength(0);
	const invalid = JSON.stringify({
		notification: { show: [], remove: [], epoch: "invalid", full: true },
	});
	remote.send(invalid);
	remote.send(invalid);
	expect(getRemoteProjectionDrops()).toBe(before + 2);
	expect(
		warning.mock.calls.filter(([text]) =>
			String(text).includes("rejected by projection"),
		),
	).toHaveLength(1);
	warning.mockRestore();
});

for (const provider of ["ceralive", "belabox", "custom"] as const) {
	test(`${provider} initial config and modem status omit private fields while local hydration is byte-identical`, async () => {
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

		expectNoSourceStrings(remote.sent.join("\n"), config);
		expectNoPairingSecret(remote.sent.join("\n"));
		expect(remote.sent.join("\n")).not.toContain(AUTH_KEY);
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

	expect(JSON.parse(remote.sent[0] ?? "{}")).toEqual(JSON.parse(frame));
});
