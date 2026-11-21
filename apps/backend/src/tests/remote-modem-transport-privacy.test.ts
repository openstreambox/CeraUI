import { expect, test } from "bun:test";
import { expectNoSourceStrings } from "./helpers/remote-outbound-assert.ts";
import {
	AUTH_KEY,
	collections,
	expectNoPairingSecret,
	secrets,
	UNRELATED,
} from "./helpers/remote-privacy-cases.ts";
import { usePrivacyConfig } from "./helpers/remote-privacy-config.ts";
import {
	authenticateRemote,
	useRemotePrivacySocket,
} from "./helpers/remote-privacy-socket.ts";

usePrivacyConfig();
useRemotePrivacySocket();

for (const row of collections) {
	test(`legacy config and modem frame withhold private owner values: ${row.name}`, async () => {
		const remote = await authenticateRemote();
		const config = {
			first: 1,
			...secrets,
			remote_key: AUTH_KEY,
			last: undefined,
		};
		const status = {
			first: "status-first",
			modems: row.value,
			diagnostic: { password: UNRELATED },
		};
		const frame = { config, status, modems: row.value, last: undefined };
		const before = JSON.stringify(frame);
		remote.sent.length = 0;

		remote.send(before);

		expectNoSourceStrings(remote.sent.join("\n"), frame);
		expectNoPairingSecret(remote.sent.join("\n"));
		expect(remote.sent.join("\n")).not.toContain(AUTH_KEY);
		expect(remote.sent.join("\n")).not.toContain(UNRELATED);
		expect(JSON.stringify(frame)).toBe(before);
	});
}
