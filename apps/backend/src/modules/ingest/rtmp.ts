import { access } from "node:fs/promises";
import { logger } from "../../helpers/logger.ts";
import { carryingTracker } from "../system/carrying.ts";
import { createRtmpStatsPoller } from "./rtmp-probe.ts";

// Define specific types for the RTMP statistics
type StreamBandwidth = `${number} Kbps`;
type StreamName = `RTMP ingest - ${string}`;

// Define more specific record types
type RtmpStats = Record<StreamName, StreamBandwidth>;
type BytesCounter = Record<StreamName, number>;

// Track RTMP server stats
let currentStreamBandwidths: RtmpStats = {};
let previousBytesCounted: BytesCounter = {};

const poll = createRtmpStatsPoller((active) =>
	carryingTracker.session("rtmp-ingest", active, performance.now()),
);

async function updateRtmpStats(): Promise<void> {
	const counters = await poll();
	if (counters === null) return;
	const bandwidths: RtmpStats = {};
	for (const [name, count] of Object.entries(counters)) {
		const stream = name as StreamName;
		const delta = Math.max(0, count - (previousBytesCounted[stream] ?? count));
		bandwidths[stream] = `${Math.round((delta * 8) / 1024)} Kbps`;
	}
	currentStreamBandwidths = bandwidths;
	previousBytesCounted = counters as BytesCounter;
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

export async function initRTMPIngestStats(): Promise<void> {
	// Skip RTMP stats polling in development mode (no RTMP server running)
	const isDevelopment =
		process.env.NODE_ENV === "development" && !(await pathExists("public"));

	if (isDevelopment) {
		logger.debug("Development mode: Skipping RTMP statistics polling");
		return;
	}

	setInterval(async () => {
		try {
			await updateRtmpStats();
		} catch (error) {
			logger.debug("RTMP stats update error", { err: error });
		}
	}, 1000);
}

export function getRTMPIngestStats(): RtmpStats {
	return currentStreamBandwidths;
}
