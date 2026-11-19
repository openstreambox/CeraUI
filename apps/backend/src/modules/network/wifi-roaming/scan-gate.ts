/**
 * Radios that carry the stream must not scan. NetworkManager scans of a
 * connected radio stall its traffic for seconds on some drivers, and it honours
 * explicit scans in AP mode too, which stalls hotspot clients. So while the
 * roaming coordinator runs, every scan CeraUI itself requests skips the radios
 * it protects: holders, assisters, the hotspot radio and a radio in the middle
 * of a join. A device-less rescan becomes a rescan of every other radio.
 */
let protectedIfnames: ReadonlySet<string> = new Set();

export function protectRadiosFromScans(ifnames: Iterable<string>): void {
	protectedIfnames = new Set(ifnames);
}

export function scanProtectedRadios(): ReadonlySet<string> {
	return protectedIfnames;
}
