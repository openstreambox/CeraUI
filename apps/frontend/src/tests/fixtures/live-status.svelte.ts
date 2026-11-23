// A reactive stand-in for the device status that LiveView reads, so a test can
// change what the backend reports and watch the view follow without a reload.
let status = $state<Record<string, unknown>>({});

export function liveStatus(): Record<string, unknown> {
	return status;
}

export function setLiveStatus(next: Record<string, unknown>): void {
	status = next;
}
