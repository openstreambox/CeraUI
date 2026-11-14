/** Leaf seam: Wi-Fi admission wakes before dispatch, without importing composition. */
let wake: (key: string) => Promise<void> = async () => undefined;
export function installHeatWifiWake(fn: typeof wake): void {
	wake = fn;
}
export function demandHeatWifi(key: string): Promise<void> {
	return wake(key);
}
