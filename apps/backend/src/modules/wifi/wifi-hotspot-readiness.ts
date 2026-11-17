import type { HotspotActivationDeps } from "./wifi-hotspot-types.ts";

// Readiness can lag activation by several seconds. Allow 20 s after NM confirms,
// with a hard deadline even when an individual reconciliation never resolves.
export const HOTSPOT_READINESS_TIMEOUT_MS = 20_000;
export const HOTSPOT_READINESS_POLL_MS = 500;

export type HotspotReadinessResult =
	| { success: true }
	| { success: true; pending: true; reason: "steering-readiness-timeout" };

export async function waitForHotspotReadiness(
	ifname: string,
	confirm: HotspotActivationDeps["confirmSteering"],
	clock = {
		now: () => performance.now(),
		wait: (ms: number) => Bun.sleep(ms),
	},
): Promise<HotspotReadinessResult> {
	if (!confirm) return { success: true };
	const deadline = clock.now() + HOTSPOT_READINESS_TIMEOUT_MS;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expired = new Promise<false>((resolve) => {
		timer = setTimeout(() => resolve(false), HOTSPOT_READINESS_TIMEOUT_MS);
	});
	try {
		while (clock.now() < deadline) {
			// A failed read is not proof that the AP failed. Reconcile again until
			// the deadline, then leave the authoritative live state pending.
			if (await Promise.race([confirm(ifname).catch(() => false), expired]))
				return { success: true };
			if (clock.now() >= deadline) break;
			await Promise.race([
				clock.wait(Math.min(HOTSPOT_READINESS_POLL_MS, deadline - clock.now())),
				expired,
			]);
		}
		return {
			success: true,
			pending: true,
			reason: "steering-readiness-timeout",
		};
	} finally {
		clearTimeout(timer);
	}
}
