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
const events = new EventEmitter();
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
	events.emit("change");
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
	events.emit("change");
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
		events.emit("change");
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
	events.emit("change");
}
export function releaseCellularSource(
	owner: string,
	epoch: string,
	iface: string,
): void {
	const before = sources.get(iface);
	if (before?.owner !== owner || before.epoch !== epoch) return;
	sources.delete(iface);
	events.emit("change");
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
	events.emit("change");
}
