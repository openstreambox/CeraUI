/** One boundary for process-name signalling. Development owns no host processes. */
export type ProcessSignalRunner = (
	binary: string,
	args: readonly string[],
) => Promise<void>;

export function createProcessSignaller(
	nodeEnv = () => process.env.NODE_ENV,
	runner?: ProcessSignalRunner,
) {
	return (
		binary: string,
		args: readonly string[],
		execute: () => void | Promise<void>,
	): void | Promise<void> => {
		if (runner) return runner(binary, args);
		if (nodeEnv() === "development") return;
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
