import { expect, spyOn, test } from "bun:test";
import { getConfig } from "../modules/config.ts";
import {
	resetStatusRelay,
	setControlChannel,
} from "../modules/remote-control/status-relay.ts";
import {
	type StatusResponseMessage,
	sendInitialStatus,
} from "../modules/ui/status.ts";
import { rememberHotspotCredentials } from "../modules/wifi/hotspot-credentials.ts";
import { broadcastWifiState, wifiBuildMsg } from "../modules/wifi/wifi.ts";
import { cancelWifiAdapterReconciliation } from "../modules/wifi/wifi-adapter-reconcile-retry.ts";
import {
	defaultHotspotStopDeps,
	stopHotspotForInterfaceLocked,
	wifiHotspotStop,
} from "../modules/wifi/wifi-hotspot-config.ts";
import { handleHotspotConn } from "../modules/wifi/wifi-hotspot-discovery.ts";
import { settlePending } from "../modules/wifi/wifi-hotspot-monitor.ts";
import {
	bindingForRow,
	wifiOperationGuard,
} from "../modules/wifi/wifi-operation-binding.ts";
import { radioIdentityReaders } from "../modules/wifi/wifi-radio-identity.ts";
import { addClient, removeClient } from "../rpc/events.ts";
import { StubRemoteSocket, statusClient } from "./helpers/status-client.ts";
import { firstAp, MAC } from "./helpers/wifi-first-ap-fixture.ts";
import {
	connectRemoteWifiStatus,
	stubRemoteWifiStatus,
	wifiStatusFrames,
} from "./helpers/wifi-remote-status-fixture.ts";

test.each([false, true])(
	"Stop clears its inherited marker on later status and reconnect, post-Down proof unavailable=%s",
	async (guarded) => {
		const f = await firstAp();
		stubRemoteWifiStatus();
		const config = getConfig();
		const previousKey = config.remote_key;
		config.remote_key = "synthetic-remote-key";
		const relay: string[] = [];
		const local: string[] = [];
		const client = statusClient((bytes) => local.push(bytes));
		addClient(client);
		resetStatusRelay();
		const delay = f.delayDown();
		try {
			const { remote, authenticate } = await connectRemoteWifiStatus();
			expect(await f.start()).toEqual({ success: true });
			settlePending(f.row.ifname, true);
			const uuid = f.created();
			const fields = uuid && f.settings.get(uuid);
			if (!uuid || !fields) throw new Error("Missing fixture AP");
			setControlChannel({
				isConnected: () => true,
				sendFrame: (frame) => relay.push(JSON.stringify(frame)),
			});
			spyOn(defaultHotspotStopDeps, "rescan").mockResolvedValue(undefined);
			const binding = bindingForRow(MAC, f.row);
			if (!binding) throw new Error("Missing verified fixture binding");
			const stopping = guarded
				? stopHotspotForInterfaceLocked(
						MAC,
						f.row,
						defaultHotspotStopDeps,
						wifiOperationGuard(binding),
					)
				: wifiHotspotStop({ device: f.row.id }, defaultHotspotStopDeps);
			const rescan = spyOn(defaultHotspotStopDeps, "rescan");
			try {
				expect(
					await Promise.race([
						delay.postReplyRead.then(() => "down in flight"),
						stopping,
					]),
				).toBe("down in flight");
				const before = f.row.hotspot;
				const foreign = "dc:a6:32:aa:bb:ff";
				rememberHotspotCredentials(foreign, {
					ssid: "Foreign AP",
					password: "foreign-password",
				});
				fields["802-11-wireless.mac-address"] = foreign;
				await handleHotspotConn(MAC, uuid);
				expect(f.row.hotspot).not.toBe(before);
				expect(f.row.hotspot.transition).toBe("deactivating");
				authenticate();
				if (guarded) {
					spyOn(radioIdentityReaders, "realpath").mockResolvedValue(undefined);
				}
			} finally {
				delay.finish();
				expect(await stopping).toEqual({ success: true });
				expect(rescan).toHaveBeenCalledTimes(guarded ? 0 : 1);
			}
			authenticate();
			broadcastWifiState();
			// The remote projection names the radio "Wi-Fi 1" and never carries a
			// transition, mode witness or radio token, so no transport has an
			// inherited Stop marker to clear: it sees the AP, then the station.
			const rows = (frames: readonly string[], source: "status" | "payload") =>
				frames.flatMap((bytes) => {
					const frame: {
						status?: StatusResponseMessage;
						payload?: StatusResponseMessage;
					} = JSON.parse(bytes);
					const wifi = frame[source]?.wifi as
						| Record<string, Record<string, unknown>>
						| undefined;
					return wifi === undefined ? [] : [wifi["Wi-Fi 1"]];
				});
			const legacy = wifiStatusFrames(remote.sent);
			for (const bytes of [...legacy, ...relay])
				expect(bytes).not.toMatch(/"(transition|leaving|incarnation)"/);
			expect(rows(legacy, "status").map((row) => row?.mode)).toEqual([
				"station",
				"station",
			]);
			expect(rows(relay, "payload").map((row) => row?.mode)).toEqual(
				guarded ? ["hotspot", "station"] : ["hotspot", "station", "station"],
			);
			// The local wire published the inherited marker and cleared it in the
			// settled status, the reconnect and the later broadcast.
			const localRows = wifiStatusFrames(local).map((bytes) => {
				const row = JSON.parse(bytes).status.wifi?.["0"];
				return [row?.mode, row?.transition];
			});
			expect(localRows).toEqual([
				["hotspot", undefined],
				["hotspot", "deactivating"],
				["station", undefined],
				["station", undefined],
				...(guarded ? [] : [["station", undefined]]),
			]);
			// A local page that signs in now hydrates the settled row.
			const fresh = new StubRemoteSocket();
			sendInitialStatus(fresh as never);
			const hydrated = wifiStatusFrames(fresh.sent);
			expect(hydrated).toHaveLength(1);
			const freshRow = JSON.parse(hydrated[0] ?? "{}").status.wifi?.["0"];
			expect([freshRow?.mode, freshRow?.transition]).toEqual([
				"station",
				undefined,
			]);
			expect(f.row.hotspot.transition).toBeUndefined();
			expect(
				(wifiBuildMsg() as Record<number, { transition?: string }>)[f.row.id]
					?.transition,
			).toBeUndefined();
		} finally {
			delay.finish();
			removeClient(client);
			resetStatusRelay();
			cancelWifiAdapterReconciliation();
			config.remote_key = previousKey;
			await f.restore();
		}
	},
);
