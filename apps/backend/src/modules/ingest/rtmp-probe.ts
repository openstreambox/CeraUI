import { parseStringPromise } from "xml2js";

const ERROR_HOLD_MS = 120_000;
const PROBE_TIMEOUT_MS = 2000;

function refused(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	if ("code" in error && error.code === "ECONNREFUSED") return true;
	return "cause" in error && refused(error.cause);
}

/** Legacy nginx statistics are optional. Errors get one bounded grace period,
 * not a new grace period on every poll. Other carrying sources remain authoritative. */
export function createRtmpStatsPoller(
	report: (active: boolean | null) => void,
	clock: () => number = () => performance.now(),
	request: (signal: AbortSignal) => Promise<Response> = (signal) =>
		fetch("http://127.0.0.1:1936/", { signal }),
) {
	let errorSince: number | null = null;
	let running = false;
	return async (): Promise<Record<string, number> | null> => {
		if (running) return null;
		running = true;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const controller = new AbortController();
		try {
			const stats = await Promise.race([
				(async () => {
					const response = await request(controller.signal);
					if (response.status === 404 || response.status === 410) return {};
					if (response.status !== 200)
						throw new Error("RTMP statistics unavailable");
					const xml = await parseStringPromise(await response.text());
					const live = xml?.rtmp?.server?.[0]?.application?.[0]?.live?.[0];
					if (!live || typeof live !== "object")
						throw new Error("Invalid RTMP statistics");
					const counters: Record<string, number> = {};
					for (const stream of live.stream ?? []) {
						const bytes = Number(stream.bytes_in?.[0]);
						const name = stream.name?.[0];
						if (
							typeof name !== "string" ||
							!Number.isSafeInteger(bytes) ||
							bytes < 0
						)
							throw new Error("Invalid RTMP stream");
						counters[`RTMP ingest - ${name}`] = bytes;
					}
					return counters;
				})(),
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => {
						controller.abort();
						reject(new Error("RTMP probe timed out"));
					}, PROBE_TIMEOUT_MS);
				}),
			]);
			errorSince = null;
			report(Object.keys(stats).length > 0);
			return stats;
		} catch (error) {
			if (refused(error)) {
				errorSince = null;
				report(false);
				return {};
			}
			errorSince ??= clock();
			report(clock() - errorSince < ERROR_HOLD_MS ? null : false);
			return null;
		} finally {
			clearTimeout(timer);
			running = false;
		}
	};
}
