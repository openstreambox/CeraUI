// A scanned setup QR opens the box URL with `#claim=<code>`. The code must leave
// the address bar (history, sync, screenshots, the hash router) before anything
// renders, whether or not this box still offers setup.
import { localClaimCodeSchema } from "@ceraui/rpc/schemas";

const PREFIX = "#claim=";
let scanned = $state<string | undefined>(undefined);

/** Strip a setup code from the URL and keep a well-formed one in memory. */
export function captureClaimFragment(
	location: Location = window.location,
	history: History = window.history,
): void {
	if (!location.hash.startsWith(PREFIX)) return;
	const value = location.hash.slice(PREFIX.length);
	history.replaceState(history.state, "", location.pathname + location.search);
	scanned = localClaimCodeSchema.safeParse(value.trim().toLowerCase()).data;
}

export function getScannedClaimCode(): string | undefined {
	return scanned;
}

/** Hand the code to its one consumer, or drop it. */
export function takeScannedClaimCode(): string | undefined {
	const code = scanned;
	scanned = undefined;
	return code;
}

export function installClaimFragmentScrub(): void {
	captureClaimFragment();
	// Capture runs first so the hash router never routes to the code.
	window.addEventListener("hashchange", () => captureClaimFragment(), {
		capture: true,
	});
	window.addEventListener("pagehide", () => {
		scanned = undefined;
	});
}
