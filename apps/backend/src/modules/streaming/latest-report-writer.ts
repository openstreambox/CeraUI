/** One active write and one replaceable pending value, regardless of I/O latency. */
export function createLatestReportWriter<T>(
	write: (value: T) => Promise<void>,
	onError: () => void = () => {
		/* Diagnostic writers may ignore failed observations. */
	},
) {
	let pending: { value: T } | undefined;
	let draining: Promise<void> | undefined;
	async function drain(): Promise<void> {
		try {
			while (pending) {
				const next = pending.value;
				pending = undefined;
				try {
					await write(next);
				} catch {
					onError();
				}
			}
		} finally {
			draining = undefined;
		}
	}
	return {
		submit(value: T): void {
			pending = { value };
			if (!draining) draining = drain();
		},
		discardPending(): void {
			pending = undefined;
		},
		async flush(): Promise<void> {
			await draining;
		},
	};
}
