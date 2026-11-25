/**
 * Live asks Network to open Devices. The flag survives the navigation,
 * because Network may not be mounted yet.
 */
let requested = $state(false);

export function requestDevicesOpen(): void {
	requested = true;
}

export function consumeDevicesOpen(): boolean {
	if (!requested) return false;
	requested = false;
	return true;
}
