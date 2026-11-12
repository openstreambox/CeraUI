import { EventEmitter } from "node:events";
import { isIPv4 } from "node:net";
import { isSafeIfname } from "./safe-ifname.ts";

export interface CellularSourceBinding {
	readonly source: string;
	readonly device: string;
	readonly translated: boolean;
	readonly generation: string;
}
export interface CellularSourceState {
	readonly owner: string;
	readonly epoch: string;
	readonly iface: string;
	readonly binding?: CellularSourceBinding;
	readonly ready: boolean;
}
const sources = new Map<string, CellularSourceState>();
const observations = new Map<string, symbol>();
const events = new EventEmitter();
function changed(iface: string): void {
	observations.set(iface, Symbol());
	events.emit("change");
}
const safeName = isSafeIfname;
export function onCellularSourceChange(callback: () => void): () => void {
	events.on("change", callback);
	return () => events.off("change", callback);
}
export function claimCellularSource(
	owner: string,
	epoch: string,
	iface: string,
): void {
	if (!/^[a-f0-9]{64}$/.test(owner) || !epoch || !safeName(iface))
		throw new Error("Unresolved cellular source identity");
	const before = sources.get(iface);
	if (before?.owner === owner && before.epoch === epoch) return;
	sources.set(iface, { owner, epoch, iface, ready: false });
	changed(iface);
}
export function setCellularSourceBinding(
	owner: string,
	epoch: string,
	iface: string,
	binding: CellularSourceBinding,
): boolean {
	const before = sources.get(iface);
	if (before?.owner !== owner || before.epoch !== epoch) return false;
	if (
		!isIPv4(binding.source) ||
		!safeName(binding.device) ||
		!binding.generation ||
		(!binding.translated && binding.device !== iface) ||
		(binding.translated && !cellularHiddenInterface(binding.device))
	)
		throw new Error("Invalid cellular source binding");
	if (JSON.stringify(before.binding) === JSON.stringify(binding)) return true;
	sources.set(iface, {
		owner,
		epoch,
		iface,
		binding: { ...binding },
		ready: false,
	});
	changed(iface);
	return true;
}
export function setCellularSourceReady(
	owner: string,
	epoch: string,
	iface: string,
	generation: string,
	ready: boolean,
): boolean {
	const before = sources.get(iface);
	if (
		before?.owner !== owner ||
		before.epoch !== epoch ||
		before.binding?.generation !== generation
	)
		return false;
	if (before.ready !== ready) {
		sources.set(iface, { ...before, ready });
		changed(iface);
	}
	return true;
}
/** Withdraw publication before changing any translator, source address or rule. */
export function withdrawCellularSource(
	owner: string,
	epoch: string,
	iface: string,
): void {
	const before = sources.get(iface);
	if (before?.owner !== owner || before.epoch !== epoch) return;
	if (!before.ready && !before.binding) return;
	sources.set(iface, { owner, epoch, iface, ready: false });
	changed(iface);
}
export function releaseCellularSource(
	owner: string,
	epoch: string,
	iface: string,
): void {
	const before = sources.get(iface);
	if (before?.owner !== owner || before.epoch !== epoch) return;
	sources.delete(iface);
	changed(iface);
}
export function cellularSourceBinding(
	iface: string,
): CellularSourceBinding | undefined {
	const state = sources.get(iface);
	return state?.ready ? state.binding : undefined;
}
export function cellularSourceManaged(iface: string): boolean {
	return sources.has(iface);
}
/** Capture an observation, not just a reusable source/device tuple. A later
 * grant or readiness transition cannot validate a queued publication from it.
 */
export function captureCellularSourcePublication(
	iface: string,
	source: string,
	device: string,
): () => boolean {
	const before = sources.get(iface),
		token = observations.get(iface) ?? Symbol();
	observations.set(iface, token);
	return () =>
		observations.get(iface) === token &&
		(before
			? sources.get(iface) === before &&
				before.ready &&
				before.binding?.source === source &&
				before.binding.device === device
			: !sources.has(iface) && !cellularHiddenInterface(device));
}
/** Cleanup keeps this exact withdrawn observation. A new claim, binding or
 * readiness publication invalidates it even when the source tuple is reused.
 */
export function captureCellularSourceWithdrawal(
	owner: string,
	epoch: string,
	iface: string,
): () => boolean {
	const before = sources.get(iface);
	return () =>
		!!before &&
		sources.get(iface) === before &&
		before.owner === owner &&
		before.epoch === epoch &&
		!before.ready;
}
export function cellularSourceReady(
	iface: string,
	source: string | undefined,
): boolean {
	const state = sources.get(iface);
	return !state || (!!state.ready && state.binding?.source === source);
}
export function cellularSourceIpv4(
	iface: string,
	native: string | undefined,
): string | undefined {
	const state = sources.get(iface);
	// A newly appearing native grant must be inspected; it cannot inherit the
	// readiness of a translator that used the previous IPv6-only generation.
	return native ?? (state?.ready ? state.binding?.source : undefined);
}
export function cellularDefaultEligible(
	iface: string,
	source: string | undefined,
): boolean {
	const state = sources.get(iface);
	return (
		!state ||
		(!!state.ready &&
			state.binding?.source === source &&
			state.binding?.translated === false)
	);
}
export function cellularHiddenInterface(iface: string): boolean {
	// This namespace is reserved for owned translation devices, including crash
	// residue that has not yet been reconciled by startup recovery.
	return /^cclat(?:[1-9]|[12]\d|3[0-2])$/.test(iface);
}
export function resetCellularSourcesForTest(): void {
	sources.clear();
	observations.clear();
	events.emit("change");
}
