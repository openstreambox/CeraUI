/*
    CeraUI - web UI for the CeraLive project
    Copyright (C) 2024-2025 CeraLive project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.
    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

/**
 * In-memory device changes since this process started.
 *
 * The first tree is the baseline and writes nothing. Later differences
 * become one appeared or left event. The plain socket name is stored.
 * Controller addresses, USB ids and product text are not.
 */
import type { UsbDevicesWire, UsbDeviceWireNode } from "@ceraui/rpc/schemas";

export const USB_EVENT_LIMIT = 100;

export type UsbEventReason = "appeared" | "left";

export type UsbEvent = {
	readonly at: number;
	readonly reason: UsbEventReason;
	readonly kind: UsbDeviceWireNode["kind"];
	readonly socketName: string;
};

let baseline: Map<string, UsbEvent> | null = null;
let events: UsbEvent[] = [];

export function getUsbEvents(): readonly UsbEvent[] {
	return events;
}

export function resetUsbEvents(): void {
	baseline = null;
	events = [];
}

export function observeUsbDevices(
	wire: UsbDevicesWire,
	now = Date.now(),
): boolean {
	if (wire.status !== "ok") return false;
	const next = new Map<string, UsbEvent>();
	for (const node of wire.nodes) {
		if (node.presence !== "present") continue;
		const key = `${node.socketKey}\0${node.portPath ?? ""}\0${node.kind}`;
		next.set(key, {
			at: now,
			reason: "appeared",
			kind: node.kind,
			socketName: node.name,
		});
	}
	if (baseline === null) {
		baseline = next;
		return false;
	}
	const fresh: UsbEvent[] = [];
	for (const [key, row] of next) {
		if (!baseline.has(key)) fresh.push(row);
	}
	for (const [key, row] of baseline) {
		if (!next.has(key)) {
			fresh.push({ ...row, at: now, reason: "left" });
		}
	}
	baseline = next;
	if (fresh.length === 0) return false;
	events = [...fresh.reverse(), ...events].slice(0, USB_EVENT_LIMIT);
	return true;
}
