import { describe, expect, test } from "bun:test";

import type {
	CerastreamClient,
	EventParams,
	ListSwitchTargetsResult,
} from "@ceralive/cerastream";
import { CerastreamConnectionError } from "@ceralive/cerastream";
import type { RuntimeConfig } from "../helpers/config-schemas.ts";
import {
	CerastreamBackend,
	type CerastreamBackendDeps,
} from "../modules/streaming/cerastream-backend.ts";
import type { StreamRunOptions } from "../modules/streaming/streaming-backend.ts";

// sessionEvidence() is the engine half of sender adoption evidence: the
// engine's own session id, asked on the session connection the backend
// already holds, and the last state that connection reported. It must stay a
// read: no new connection, no subscription, and a failed question is not
// proof that the session connection died.

const RUN_OPTS: StreamRunOptions = {
	pipeline: "hdmi",
	host: "127.0.0.1",
	port: 9000,
	streamid: "stream-1",
};

const STREAM_CONFIG: RuntimeConfig = {
	max_br: 8000,
	srt_latency: 2000,
	balancer: "adaptive",
	pipeline: "h264_hdmi_1080p",
};

const silentLogger: CerastreamBackendDeps["logger"] = {
	debug() {},
	info() {},
	warn() {},
	error() {},
};

type Targets = () => Promise<ListSwitchTargetsResult>;

function fakeClient(targets: Targets) {
	const calls: string[] = [];
	let listener: ((event: EventParams) => void) | undefined;
	const client = {
		hello: {
			protocol: "cerastream-ipc/1",
			schema_version: "0.9.0",
			engine_version: "test",
		},
		start: async () => {
			calls.push("start");
			return { session_id: "s1", state: "streaming" };
		},
		stop: async () => {
			calls.push("stop");
			return { state: "idle" };
		},
		listSwitchTargets: async () => {
			calls.push("list-switch-targets");
			return targets();
		},
		subscribeEvents: async (
			_params: unknown,
			eventListener: (event: EventParams) => void,
		) => {
			calls.push("subscribe-events");
			listener = eventListener;
			return { result: { subscribed: ["status"] }, close: () => undefined };
		},
		close: async () => {
			calls.push("close");
		},
		rawRequest: async (method: string) => {
			calls.push(method);
			return method === "start" ? { session_id: "s1", state: "streaming" } : {};
		},
	};
	return {
		client: client as unknown as CerastreamClient,
		calls,
		emit: (event: EventParams) => listener?.(event),
	};
}

function harness(targets: Targets) {
	const clients: ReturnType<typeof fakeClient>[] = [];
	const lost: string[] = [];
	const backend = new CerastreamBackend({
		connect: async () => {
			const next = fakeClient(targets);
			clients.push(next);
			return next.client;
		},
		connectOptions: {},
		getConfig: () => STREAM_CONFIG,
		saveConfig: () => undefined,
		bridge: {
			notify: () => undefined,
			notificationExists: () => false,
			removeNotification: () => {},
			broadcastStatus: () => undefined,
			broadcastBuffering: () => undefined,
		},
		execPath: "cerastream",
		configPath: "/tmp/cerastream-session-evidence.json",
		logger: silentLogger,
		onSessionConnectionLost: (site) => {
			lost.push(site);
		},
	});
	return { backend, clients, lost };
}

const streaming = {
	type: "status",
	seq: 1,
	state: "streaming",
	streaming: true,
} as EventParams;

describe("sessionEvidence", () => {
	test("with no session connection it asks nothing and connects nothing", async () => {
		const h = harness(async () => ({ session_id: "s1", switch_targets: [] }));
		expect(await h.backend.sessionEvidence()).toEqual({
			state: "unknown",
			sessionId: null,
		});
		expect(h.clients).toHaveLength(0);
	});

	test("asks the session connection once and reports its last state", async () => {
		const h = harness(async () => ({ session_id: "s1", switch_targets: [] }));
		await h.backend.start(STREAM_CONFIG, RUN_OPTS);
		await h.backend.settle();
		const session = h.clients[0];
		session?.emit(streaming);
		const before = [...(session?.calls ?? [])];
		expect(await h.backend.sessionEvidence()).toEqual({
			state: "streaming",
			sessionId: "s1",
			// The token of the connection that answered, for a takeover's commit.
			connection: 1,
		});
		expect(h.clients).toHaveLength(1);
		expect(session?.calls.slice(before.length)).toEqual([
			"list-switch-targets",
		]);
	});

	test("the Start reply's session id is kept for the current own launch only", async () => {
		const h = harness(async () => ({ session_id: "s1", switch_targets: [] }));
		expect(h.backend.launchedSession()).toBeNull();
		await h.backend.start(STREAM_CONFIG, RUN_OPTS);
		await h.backend.settle();
		expect(h.backend.launchedSession()).toBe("s1");
		h.clients[0]?.emit({
			type: "status",
			seq: 2,
			state: "idle",
			streaming: false,
		} as EventParams);
		expect(h.backend.launchedSession()).toBeNull();
	});

	test("a status that changes while the question is out makes the answer unknown", async () => {
		let emitIdle: (() => void) | undefined;
		const h = harness(async () => {
			emitIdle?.();
			return { session_id: "s1", switch_targets: [] };
		});
		await h.backend.start(STREAM_CONFIG, RUN_OPTS);
		await h.backend.settle();
		const session = h.clients[0];
		session?.emit(streaming);
		emitIdle = () =>
			session?.emit({
				type: "status",
				seq: 3,
				state: "idle",
				streaming: false,
			} as EventParams);
		expect(await h.backend.sessionEvidence()).toEqual({
			state: "unknown",
			sessionId: null,
		});
	});

	test("an engine that reports no session id gives none", async () => {
		const h = harness(async () => ({ switch_targets: [] }));
		await h.backend.start(STREAM_CONFIG, RUN_OPTS);
		await h.backend.settle();
		h.clients[0]?.emit(streaming);
		expect((await h.backend.sessionEvidence()).sessionId).toBeNull();
	});

	test("a failed question gives no id and is not taken as connection loss", async () => {
		const h = harness(async () => {
			throw new CerastreamConnectionError(
				"control connection is not open",
				undefined,
				"closed",
			);
		});
		await h.backend.start(STREAM_CONFIG, RUN_OPTS);
		await h.backend.settle();
		h.clients[0]?.emit(streaming);
		expect(await h.backend.sessionEvidence()).toEqual({
			state: "streaming",
			sessionId: null,
		});
		expect(h.lost).toEqual([]);
	});
});
