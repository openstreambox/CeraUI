import { emitDeviceEvent } from "../modules/events/device-emit.ts";
import { cancelDisruptiveRetries } from "../modules/system/disruptive-retry.ts";
import { logger } from "./logger.ts";
import {
	beginShutdown,
	resetShutdownStateForTest,
	settleGuardedWork,
} from "./shutdown-state.ts";

export interface BackendShutdownDeps {
	/** Cancels background retry owners so none starts work during teardown. */
	readonly stopRecoveryRetries?: () => void;
	readonly terminateWifiObservation?: () => void;
	readonly terminateWifiDiscovery?: () => void;
	readonly gracefulShutdown: () => Promise<void>;
	readonly stopSrtIngest: () => Promise<void>;
	readonly stopDmesgWatchers: () => void;
	readonly stopUplinkShaper?: () => Promise<void>;
	readonly stopGatewayRoutes?: () => Promise<void>;
	/**
	 * Stops the long-lived monitor children (nmcli, udevadm) with SIGTERM and a
	 * bounded wait. Started at the signal and awaited before exit, so it runs
	 * alongside the streaming teardown instead of delaying it.
	 */
	readonly stopMonitors?: () => Promise<void>;
	/**
	 * Releases the flock guardians the backend holds for its whole life. Runs
	 * last: after the teardown above and after guarded work has finished, so
	 * no guardian is released while the write it protects is still running.
	 */
	readonly releaseGuardians?: () => Promise<void>;
	/** Bound on waiting for guarded work; defaults to the shared budget. */
	readonly guardedWorkGraceMs?: number;
	readonly exit: (code: number) => void;
}

let shuttingDown = false;

async function settleCleanup(
	name: string,
	cleanup: () => Promise<void> | void,
): Promise<void> {
	try {
		await cleanup();
	} catch (error) {
		logger.error(`shutdown: ${name} cleanup failed`, { err: error });
	}
}

export function resetShutdownForTest(): void {
	shuttingDown = false;
	resetShutdownStateForTest();
}

export function handleTerminationSignal(
	signal: NodeJS.Signals,
	deps: BackendShutdownDeps,
): void {
	if (shuttingDown) return;
	shuttingDown = true;
	// First, synchronously: supervisors check this before every spawn.
	beginShutdown();
	if (signal === "SIGTERM" || signal === "SIGINT")
		emitDeviceEvent("service_stopping", { signal });
	cancelDisruptiveRetries();
	deps.terminateWifiObservation?.();
	deps.terminateWifiDiscovery?.();
	logger.info(`received ${signal}; shutting down streaming processes`);
	const monitorsStopped = deps.stopMonitors
		? settleCleanup("monitors", deps.stopMonitors)
		: Promise.resolve();
	void (async () => {
		if (deps.stopRecoveryRetries)
			await settleCleanup("recovery retries", deps.stopRecoveryRetries);
		if (deps.stopGatewayRoutes)
			await settleCleanup("host route preference", deps.stopGatewayRoutes);
		await settleCleanup("SRT ingest", deps.stopSrtIngest);
		await settleCleanup("dmesg watchers", deps.stopDmesgWatchers);
		if (deps.stopUplinkShaper)
			await settleCleanup("uplink shaper", deps.stopUplinkShaper);
		await settleCleanup("streaming processes", deps.gracefulShutdown);
		await monitorsStopped;
		if (!(await settleGuardedWork(deps.guardedWorkGraceMs)))
			logger.warn("shutdown: guarded work still running; exiting anyway");
		if (deps.releaseGuardians)
			await settleCleanup("lock guardians", deps.releaseGuardians);
		deps.exit(0);
	})();
}
