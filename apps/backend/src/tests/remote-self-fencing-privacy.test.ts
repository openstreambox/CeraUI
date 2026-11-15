import { afterEach, expect, test } from "bun:test";
import { getConfig } from "../modules/config.ts";
import {
	PROTOCOL_VERSION,
	type Result,
	ResultSchema,
} from "../modules/remote-control/protocol.ts";
import {
	handleSelfFencingConfirm,
	handleSelfFencingOp,
	resetSelfFencingState,
} from "../modules/remote-control/self-fencing.ts";
import { expectNoSourceStrings } from "./helpers/remote-outbound-assert.ts";
import {
	AUTH_KEY,
	CID,
	expectNoPairingSecret,
} from "./helpers/remote-privacy-cases.ts";
import { usePrivacyConfig } from "./helpers/remote-privacy-config.ts";

usePrivacyConfig();
let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
afterEach(() => {
	resetSelfFencingState();
	clearTimeout(watchdogTimer);
	watchdogTimer = undefined;
});

for (const type of [
	"network.reconfig",
	"modem.reconfig",
	"device.remoteKeyChange",
]) {
	for (const confirm of [false, true]) {
		test(`${type} ${confirm ? "commit" : "rollback"} results omit pairing seed but withhold private device snapshots`, async () => {
			const config = getConfig();
			const snapshot = structuredClone(config);
			const frames: Result[] = [];
			const terminal = Promise.withResolvers<void>();
			let watchdog = () => {};
			const frame = {
				v: PROTOCOL_VERSION,
				kind: "command",
				type,
				cid: CID,
				role: "owner",
				self_fencing: true,
				payload: { max_br: 6000 },
			} as const;

			await handleSelfFencingOp(frame, {
				sendResult: (result) => {
					frames.push(result);
					if (frames.length === 2) terminal.resolve();
					return true;
				},
				isSubsystemReady: async () => true,
				acquireMutationLease: async () => ({ ok: true }),
				admitDisruptiveAction: async () => ({ ok: true }),
				setTimer: (fn, ms) => {
					watchdog = fn;
					watchdogTimer = setTimeout(() => {}, ms);
					return watchdogTimer;
				},
			});
			if (confirm) await handleSelfFencingConfirm(CID);
			else watchdog();
			await terminal.promise;

			const applied = { ...snapshot, max_br: 6000 };
			expect(frames).toHaveLength(2);
			for (const [index, result] of frames.entries()) {
				const state = index === 0 || confirm ? applied : snapshot;
				expectNoSourceStrings(JSON.stringify(frames), state);
				expect(result).toMatchObject({
					v: PROTOCOL_VERSION,
					kind: "result",
					type,
					cid: CID,
					role: "owner",
					payload: {
						ok: true,
						applied:
							typeof state.max_br === "number" ? { max_br: state.max_br } : {},
						...(index === 0 ? {} : { reverted: !confirm }),
					},
				});
				if (index === 0) expect(result.self_fencing).toBe(true);
				expect(ResultSchema.safeParse(result).success).toBe(true);
			}
			expectNoPairingSecret(JSON.stringify(frames));
			expect(JSON.stringify(frames)).not.toContain(AUTH_KEY);
			expect(config).toStrictEqual(confirm ? applied : snapshot);
		});
	}
}
