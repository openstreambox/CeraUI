import {
	type createDbusTransport,
	type DbusTransport,
	isVariant,
	type SignalEvent,
} from "@ceralive/modem-control/transport";
import { createCellularSystemTransport } from "./modems.ts";

const MM = "org.freedesktop.ModemManager1",
	NM = "org.freedesktop.NetworkManager";
const fields: Readonly<Record<string, readonly string[]>> = {
	[`${MM}.Modem`]: [
		"State",
		"Bearers",
		"Sim",
		"PrimarySimSlot",
		"SimSlots",
		"DeviceIdentifier",
		"EquipmentIdentifier",
		"Ports",
	],
	[`${MM}.Sim`]: [
		"Active",
		"SimIdentifier",
		"Imsi",
		"OperatorIdentifier",
		"OperatorName",
		"Gid1",
		"Gid2",
	],
	[`${MM}.Bearer`]: [
		"Connected",
		"Interface",
		"Ip4Config",
		"Ip6Config",
		"Properties",
	],
	[`${NM}.Device`]: [
		"State",
		"Managed",
		"Interface",
		"IpInterface",
		"ActiveConnection",
		"Ip4Config",
		"Ip6Config",
		"Mtu",
	],
	[`${NM}.Connection.Active`]: [
		"State",
		"Uuid",
		"Devices",
		"Ip4Config",
		"Ip6Config",
	],
	[`${NM}.IP4Config`]: [
		"AddressData",
		"Gateway",
		"NameserverData",
		"Nameservers",
	],
	[`${NM}.IP6Config`]: ["AddressData", "Gateway", "Nameservers"],
};
/** Read-only revocation for one captured MM/NM grant. Signals are installed
 * before capture, so a same-path lease change cannot slip between the snapshot
 * and its watcher. Radio quality and roaming updates do not churn host state.
 * A revoked lifetime is never renewed or adopted after a daemon restart.
 */
export class CellularGrantLifetime {
	private readonly bus: DbusTransport;
	private revoked = false;
	private started = false;
	private selected: ReadonlySet<string> | undefined;
	private owners = new Map<string, string>();
	constructor(
		private readonly withdraw: () => void,
		factory: typeof createDbusTransport = createCellularSystemTransport,
	) {
		this.bus = factory({ reconnect: { enabled: false }, callTimeoutMs: 5000 });
		this.bus.on("disconnected", () => this.revoke());
	}
	private revoke(): void {
		if (this.revoked) return;
		this.revoked = true;
		this.withdraw();
	}
	get current(): boolean {
		return !this.revoked && this.bus.isConnected() && this.owners.size === 2;
	}
	owner(service: typeof MM | typeof NM): string | undefined {
		return this.owners.get(service);
	}
	async start(): Promise<void> {
		if (this.started)
			throw new Error("Cellular grant lifetime already started");
		this.started = true;
		try {
			await this.bus.connect();
			await this.bus.subscribeSignal(
				{
					sender: "org.freedesktop.DBus",
					path: "/org/freedesktop/DBus",
					interface: "org.freedesktop.DBus",
					member: "NameOwnerChanged",
				},
				(event) => {
					if (event.body[0] === MM || event.body[0] === NM) this.revoke();
				},
			);
			for (const service of [MM, NM]) {
				const result = await this.bus.callMethod({
					destination: "org.freedesktop.DBus",
					path: "/org/freedesktop/DBus",
					interface: "org.freedesktop.DBus",
					member: "GetNameOwner",
					signature: "s",
					args: [service],
					timeoutMs: 5000,
				});
				const owner = result.body[0];
				if (
					result.signature !== "s" ||
					result.body.length !== 1 ||
					typeof owner !== "string" ||
					!/^:\d+\.\d+$/.test(owner)
				)
					throw new Error("Cellular grant service owner unavailable");
				this.owners.set(service, owner);
				await this.bus.subscribeSignal(
					{
						sender: owner,
						interface: "org.freedesktop.DBus.Properties",
						member: "PropertiesChanged",
					},
					(event) => this.changed(event),
				);
				await this.bus.subscribeSignal(
					{
						sender: owner,
						interface: "org.freedesktop.DBus.ObjectManager",
						member: "InterfacesRemoved",
					},
					(event) => {
						if (
							!this.selected ||
							typeof event.body[0] !== "string" ||
							this.selected.has(event.body[0])
						)
							this.revoke();
					},
				);
			}
			if (!this.current)
				throw new Error("Cellular grant service changed during capture");
		} catch (error) {
			this.revoke();
			await this.bus.disconnect();
			throw error;
		}
	}
	private changed(event: SignalEvent): void {
		if (this.selected && !this.selected.has(event.path)) return;
		if (
			event.signature !== "sa{sv}as" ||
			event.body.length !== 3 ||
			typeof event.body[0] !== "string" ||
			!Array.isArray(event.body[1]) ||
			!Array.isArray(event.body[2]) ||
			event.body[1].length > 128 ||
			event.body[2].length > 128
		) {
			this.revoke();
			return;
		}
		const relevant = fields[event.body[0]];
		if (!relevant) return;
		const names: string[] = [];
		for (const row of event.body[1]) {
			if (
				!Array.isArray(row) ||
				row.length !== 2 ||
				typeof row[0] !== "string" ||
				!row[1] ||
				!isVariant(row[1])
			) {
				this.revoke();
				return;
			}
			if (names.includes(row[0])) {
				this.revoke();
				return;
			}
			names.push(row[0]);
		}
		for (const name of event.body[2]) {
			if (typeof name !== "string") {
				this.revoke();
				return;
			}
			names.push(name);
		}
		if (names.some((name) => relevant.includes(name))) this.revoke();
	}
	select(paths: readonly string[]): boolean {
		if (
			this.selected ||
			!this.current ||
			paths.length < 4 ||
			paths.length > 8 ||
			paths.some(
				(path) =>
					!/^\/org\/freedesktop\/(?:ModemManager1|NetworkManager)\/[A-Za-z0-9_/]+$/.test(
						path,
					),
			)
		) {
			this.revoke();
			return false;
		}
		this.selected = new Set(paths);
		return this.current;
	}
	async close(): Promise<void> {
		this.revoke();
		await this.bus.disconnect();
	}
}
