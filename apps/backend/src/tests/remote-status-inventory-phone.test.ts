import { expect, spyOn, test } from "bun:test";
import { strictParseFrame } from "@ceralive/control-protocol/parse";
import inventory from "../../../../docs/remote-status-inventory.json";
import { logger } from "../helpers/logger.ts";
import {
	getRemoteProjectionDrops,
	projectRemoteLegacyFrame,
} from "../modules/remote/remote-status.ts";
import {
	isRelayable,
	relayStatusToGateway,
	resetStatusRelay,
	setControlChannel,
} from "../modules/remote-control/status-relay.ts";
import { setup } from "../modules/setup.ts";
import { usePrivacyConfig } from "./helpers/remote-privacy-config.ts";
import {
	authenticateRemote,
	useRemotePrivacySocket,
} from "./helpers/remote-privacy-socket.ts";

usePrivacyConfig();
useRemotePrivacySocket();
test("phone box: identifiers planted at every inventoried source leaf never reach either status transport", async () => {
	const previous = setup.engine;
	setup.engine = "none";
	const legacy = await authenticateRemote();
	legacy.sent.length = 0;
	legacy.send(
		JSON.stringify({
			remote: {
				"auth/encoder": {
					key: "AUTH_KEY_OK",
					version: 16,
					extra: "PRIVATE_EXTRA",
				},
			},
		}),
	);
	expect(legacy.sent.join("\n")).toContain("AUTH_KEY_OK");
	expect(legacy.sent.join("\n")).not.toContain("PRIVATE_EXTRA");
	legacy.sent.length = 0;
	const secret = "PRIVATE_IDENTIFIER_8b7321";
	const frames: unknown[] = [];
	setControlChannel({
		isConnected: () => true,
		sendFrame: (f) => {
			frames.push(f);
		},
	});
	try {
		for (const call of inventory.calls) {
			const type = call.message.replaceAll('"', "");
			for (const field of call.fields) {
				const parts = field.path
					.replaceAll("[]", ".0")
					.split(".")
					.filter(Boolean);
				function plant(index: number): unknown {
					if (index === parts.length) return secret;
					const part = parts[index];
					if (part === "0") return [plant(index + 1)];
					return { [part === "*" ? secret : String(part)]: plant(index + 1) };
				}
				const payload = plant(0);
				const local = JSON.stringify(payload);
				expect(
					JSON.stringify(
						projectRemoteLegacyFrame({ [type]: payload }, "legacy", true),
					),
				).not.toContain(secret);
				legacy.send(JSON.stringify({ [type]: payload }));
				expect(legacy.sent.join("\n")).not.toContain(secret);
				if (isRelayable(type)) relayStatusToGateway(type, payload, 1);
				expect(JSON.stringify(payload)).toBe(local);
			}
		}
		expect(frames.length).toBeGreaterThan(0);
		for (const frame of frames)
			expect((frame as { type: string }).type).toBe("status");
		for (const frame of frames) {
			expect(JSON.stringify(frame)).not.toContain(secret);
			expect(() => strictParseFrame(frame)).not.toThrow();
		}
	} finally {
		setup.engine = previous;
		resetStatusRelay();
	}
});
test("phone box: withheld frames complete their callback and are not counted as drops", async () => {
	const previous = setup.engine;
	setup.engine = "none";
	const warning = spyOn(logger, "warn");
	try {
		const legacy = await authenticateRemote();
		legacy.sent.length = 0;
		const before = getRemoteProjectionDrops();
		const done: string[] = [];
		// Real broadcasts carry a per-type seq; a withheld frame must not go out
		// as a bare {"seq":N} either.
		const invalid = JSON.stringify({
			notification: { show: [], remove: [], epoch: "invalid", full: true },
			seq: 7,
		});
		legacy.send(invalid, () => done.push("notification"));
		legacy.send(JSON.stringify({ config: { max_br: 1 }, seq: 42 }), {}, () =>
			done.push("config"),
		);
		legacy.send(JSON.stringify({ netif: {}, seq: 0 }), () =>
			done.push("netif"),
		);
		expect(legacy.sent).toHaveLength(0);
		expect(done).toEqual(["notification", "config", "netif"]);
		expect(getRemoteProjectionDrops()).toBe(before);
		expect(
			warning.mock.calls.filter(([text]) =>
				String(text).includes("rejected by projection"),
			),
		).toHaveLength(0);
	} finally {
		warning.mockRestore();
		setup.engine = previous;
	}
});
