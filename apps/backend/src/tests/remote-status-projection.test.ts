import { afterEach, expect, spyOn, test } from "bun:test";
import { projectRemoteStatus } from "../modules/remote/remote-status.ts";
import { StatusSchema } from "../modules/remote-control/protocol.ts";
import {
	relayStatusToGateway,
	resetStatusRelay,
	setControlChannel,
} from "../modules/remote-control/status-relay.ts";
import { expectNoSourceStrings } from "./helpers/remote-outbound-assert.ts";
import {
	OTHER_PASSWORD,
	remoteStatusCases,
} from "./helpers/remote-status-cases.ts";

afterEach(() => {
	resetStatusRelay();
});

for (const row of remoteStatusCases) {
	test(`projection withholds unknown fields and preserves local state: ${row.name}`, () => {
		const local = {
			first: "status-first",
			wifi: row.local,
			modems: { lte: { config: { password: OTHER_PASSWORD } } },
			last: undefined,
		};

		const original = structuredClone(local);

		const remote = projectRemoteStatus(local);

		expectNoSourceStrings(remote, local);
		expect(remote).not.toHaveProperty("first");
		expect(JSON.stringify(remote)).not.toContain(OTHER_PASSWORD);
		expect(local).toStrictEqual(original);
	});

	test(`v2 serialized frame withholds identity and credentials: ${row.name}`, () => {
		const frames: unknown[] = [];
		const cid = "00000000-0000-4000-8000-000000000001";
		const uuid = spyOn(crypto, "randomUUID").mockReturnValue(cid);
		const local = {
			first: "status-first",
			wifi: row.local,
			modems: { lte: { config: { password: OTHER_PASSWORD } } },
			last: undefined,
		};
		const original = structuredClone(local);
		setControlChannel({
			isConnected: () => true,
			sendFrame: (frame) => frames.push(frame),
		});
		try {
			relayStatusToGateway("status", local, 7);
		} finally {
			uuid.mockRestore();
		}

		expect(frames).toHaveLength(1);
		expectNoSourceStrings(frames, local);
		expect(StatusSchema.safeParse(frames[0]).success).toBe(true);
		expect(local).toStrictEqual(original);
	});
}

test("an undefined status payload stays undefined", () => {
	expect(projectRemoteStatus(undefined)).toBeUndefined();
});
