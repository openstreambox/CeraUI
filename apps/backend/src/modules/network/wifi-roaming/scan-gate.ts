/**
 * Radios that carry the stream must not scan. NetworkManager scans of a
 * connected radio stall its traffic for seconds on some drivers, and it honours
 * explicit scans in AP mode too, which stalls hotspot clients. So while the
 * roaming coordinator runs, every scan CeraUI itself requests skips the radios
 * it protects: holders, assisters, the hotspot radio and a radio that is
 * searching or joining. A device-less rescan becomes a rescan of every other
 * radio.
 *
 * The protected set is published on every role change, but it is still a
 * picture from the coordinator's last look. So a scan is dispatched only after
 * a fresh read of the target's mode and phy, taken by the caller under the
 * radio's per-adapter Wi-Fi lock right before the scan: a radio that is in AP
 * mode now, carries an AP leg on its phy, or shares a phy with a protected
 * radio is not scanned. A read that fails refuses the scan.
 */

export type RadioMode = Readonly<{
	/** The wiphy the interface belongs to, `null` when unknown. */
	phy: string | null;
	/** The interface or another one on its phy is in AP mode; `null` unknown. */
	apOnPhy: boolean | null;
}>;

let protectedIfnames: ReadonlySet<string> = new Set();
let protectedPhys: ReadonlySet<string> = new Set();
let modeReader: ((ifname: string) => Promise<RadioMode | undefined>) | null =
	null;

/** Publish the protected radios and the phys they sit on. */
export function protectRadiosFromScans(
	ifnames: Iterable<string>,
	phys: Iterable<string> = [],
): void {
	protectedIfnames = new Set(ifnames);
	protectedPhys = new Set(phys);
}

export function scanProtectedRadios(): ReadonlySet<string> {
	return protectedIfnames;
}

/**
 * Register the fresh mode read the gate uses at dispatch, or `null` when the
 * coordinator stops. While none is registered, the gate is inactive.
 */
export function setScanGateModeReader(
	reader: ((ifname: string) => Promise<RadioMode | undefined>) | null,
): void {
	modeReader = reader;
}

/** The coordinator runs and CeraUI's rescans go through this gate. */
export function scanGateActive(): boolean {
	return modeReader !== null || protectedIfnames.size > 0;
}

/**
 * Whether CeraUI may scan `ifname` right now. Call it under the radio's
 * per-adapter Wi-Fi lock, immediately before dispatching the scan.
 */
export async function mayScanNow(ifname: string): Promise<boolean> {
	if (protectedIfnames.has(ifname)) return false;
	if (!scanGateActive()) return true;
	if (!modeReader) return true;
	let mode: RadioMode | undefined;
	try {
		mode = await modeReader(ifname);
	} catch {
		return false;
	}
	if (mode?.apOnPhy !== false) return false;
	// Re-read the set: it may have changed while the mode was read.
	if (protectedIfnames.has(ifname)) return false;
	return !(mode.phy !== null && protectedPhys.has(mode.phy));
}
