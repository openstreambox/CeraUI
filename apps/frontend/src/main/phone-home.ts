import { m } from "@ceraui/i18n/svelte";
export function phoneState(state?: "streaming" | "idle" | "unknown") {
	return state === "streaming"
		? "active"
		: state === "idle"
			? "ready"
			: "checking";
}
export function showPhoneQr(width: number, kiosk: boolean) {
	return width >= 1024 && !kiosk;
}
export function remotePhoneState(
	state?: "streaming" | "idle" | "unknown",
	reachable = true,
) {
	if (!reachable) return m["live.phone.remoteUnreachable"]();
	return state === "streaming"
		? m["live.phone.remoteActive"]()
		: state === "idle"
			? m["live.phone.remoteReady"]()
			: m["live.phone.remoteChecking"]();
}
