/**
 * Radios that carry the stream must not scan. NetworkManager scans of a
 * connected radio stall its traffic for seconds on some drivers, so while the
 * roaming coordinator runs, every scan CeraUI itself requests skips the
 * holders. A device-less rescan becomes a rescan of every other radio.
 */
let protectedIfnames: ReadonlySet<string> = new Set();

export function protectRadiosFromScans(ifnames: Iterable<string>): void {
	protectedIfnames = new Set(ifnames);
}

export function scanProtectedRadios(): ReadonlySet<string> {
	return protectedIfnames;
}
