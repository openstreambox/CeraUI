// A reactive stand-in for the device status and the start outcome that
// LiveView reads, so a test can change what the backend reports and watch the
// view follow without a reload.
let status = $state<Record<string, unknown>>({});
let stopReason = $state<string | undefined>(undefined);

export function liveStatus(): Record<string, unknown> {
	return status;
}

export function setLiveStatus(next: Record<string, unknown>): void {
	status = next;
}

export function liveStopReason(): string | undefined {
	return stopReason;
}

export function setLiveStopReason(next: string | undefined): void {
	stopReason = next;
}
