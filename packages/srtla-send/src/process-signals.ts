/** One boundary for process-name signalling. Development owns no host processes. */
export type ProcessSignalRunner = (
	binary: string,
	args: readonly string[],
) => Promise<void>;

/** Set by the development/E2E safety preload; a compiled binary never loads it. */
export const DEV_HARNESS_MARKER = Symbol.for("ceraui.devHarness");

/**
 * True when this process runs against mocks and therefore owns no host
 * processes: the development harness is loaded, or the backend's mock gate
 * (`isDevelopment()` in mocks/mock-config.ts) is on. The env reads stay literal
 * so a production build inlines NODE_ENV exactly as it does for the mocks.
 */
export function ownsNoHostProcesses(): boolean {
	return (
		(globalThis as Record<symbol, unknown>)[DEV_HARNESS_MARKER] === true ||
		process.env.NODE_ENV === "development" ||
		process.env.MOCK_MODE === "true"
	);
}

export function createProcessSignaller(
	hostless: () => boolean = ownsNoHostProcesses,
	runner?: ProcessSignalRunner,
) {
	return (
		binary: string,
		args: readonly string[],
		execute: () => void | Promise<void>,
	): void | Promise<void> => {
		if (runner) return runner(binary, args);
		if (hostless()) return;
		return execute();
	};
}

let signal = createProcessSignaller();
export function setProcessSignalRunnerForTest(
	runner: ProcessSignalRunner,
): void {
	signal = createProcessSignaller(undefined, runner);
}
export const signalProcessName: ReturnType<typeof createProcessSignaller> = (
	...args
) => signal(...args);
