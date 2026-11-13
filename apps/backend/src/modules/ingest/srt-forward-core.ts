/** Keep unadmitted phone traffic away from an existing encoder sender. */
export function forwardSenderPort(encoderPort: number): number {
	return encoderPort === 65535 ? 8999 : encoderPort + 1;
}

/** SRT termination only: payload bytes are never decoded or encoded here. */
export function forwardUrls(
	input: { host: string; port: number; passphrase: string },
	output: {
		port: number;
		streamid: string;
		latency: number;
		passphrase?: string;
	},
): { input: string; output: string } {
	const query = (values: Record<string, string | number>) =>
		Object.entries(values)
			.map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
			.join("&");
	return {
		input: `srt://${input.host}:${input.port}?${query({ mode: "listener", transtype: "live", latency: 120, passphrase: input.passphrase, enforcedencryption: 1 })}`,
		output: `srt://127.0.0.1:${output.port}?${query({ mode: "caller", transtype: "live", latency: output.latency, streamid: output.streamid, ...(output.passphrase ? { passphrase: output.passphrase } : {}) })}`,
	};
}

export interface ForwardSender {
	stop(): Promise<void>;
}
export interface ForwardDeps {
	report(state: boolean | null): void;
	admit(): Promise<() => void>;
	start(): Promise<ForwardSender>;
}

/** Serial ownership; stale async completions can clean up but cannot publish active. */
export function createSrtForwardController(deps: ForwardDeps) {
	let epoch = 0;
	let closed = false;
	let observed = false;
	let tail = Promise.resolve();
	let sender: ForwardSender | undefined;
	let release: (() => void) | undefined;
	deps.report(null);
	const cleanup = async () => {
		const owned = sender;
		sender = undefined;
		try {
			await owned?.stop();
		} finally {
			release?.();
			release = undefined;
		}
	};
	const enqueue = (run: () => Promise<void>) => {
		const result = tail.then(run);
		tail = result.catch(() => {
			/* Failure is returned to the caller; keep the ownership queue usable. */
		});
		return result;
	};
	const publisher = (connected: boolean) => {
		observed = true;
		const mine = ++epoch;
		deps.report(connected ? null : false);
		return enqueue(async () => {
			if (mine !== epoch || closed) return;
			await cleanup();
			if (!connected) return;
			try {
				release = await deps.admit();
				if (mine !== epoch || closed) {
					await cleanup();
					return;
				}
				sender = await deps.start();
				if (mine !== epoch || closed) {
					await cleanup();
					return;
				}
				deps.report(true);
			} catch (error) {
				if (mine === epoch) deps.report(null);
				await cleanup();
				throw error;
			}
		});
	};
	return {
		listening() {
			if (!closed && !observed) deps.report(false);
		},
		publisher,
		fault() {
			observed = true;
			++epoch;
			deps.report(null);
			return enqueue(cleanup);
		},
		stop() {
			closed = true;
			++epoch;
			deps.report(false);
			return enqueue(cleanup);
		},
	};
}
