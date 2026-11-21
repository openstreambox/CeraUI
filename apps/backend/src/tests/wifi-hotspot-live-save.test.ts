import { expect, spyOn, test } from "bun:test";
import * as exec from "../helpers/exec.ts";
import * as runner from "../helpers/run.ts";
import { nmConnSetFields } from "../modules/network/network-manager.ts";
import {
	getHotspotCredentialOwners,
	getPendingHotspotCreation,
} from "../modules/wifi/hotspot-credentials.ts";
import {
	defaultHotspotConfigDeps,
	wifiHotspotConfig,
} from "../modules/wifi/wifi-hotspot-config.ts";
import { settlePending } from "../modules/wifi/wifi-hotspot-monitor.ts";
import { statusClient } from "./helpers/status-client.ts";
import { firstAp } from "./helpers/wifi-first-ap-fixture.ts";

type Fixture = Awaited<ReturnType<typeof firstAp>>;

/**
 * Real NM resets a property given an empty value and prints an unset uint as
 * `0`: `nmcli --offline connection modify 802-11-wireless.channel ""` drops the
 * keyfile's `channel=` line, and a later read of the channel returns `0`.
 */
function nmPropertyDefaults(f: Fixture): void {
	const offline = spyOn(runner, "runWithStdin").getMockImplementation();
	const platform = spyOn(exec, "execFileP").getMockImplementation();
	if (!offline || !platform) throw new Error("Missing fake platform");
	spyOn(runner, "runWithStdin").mockImplementation(
		async (bin, args, input, options) => {
			const output = await offline(bin, args, input, options);
			const reset = new Set<string>();
			for (let i = 3; i < args.length; i += 2)
				if (args[i + 1] === "") reset.add(args[i] ?? "");
			if (!reset.size) return output;
			const lines = output.split("\n").filter((line) => {
				const key = line.slice(0, line.indexOf("="));
				return !(
					(reset.has("802-11-wireless.channel") && key === "channel") ||
					(reset.has("802-11-wireless.band") && key === "band")
				);
			});
			return lines.join("\n");
		},
	);
	// `connection load` stores exactly the decoded keyfile, so a dropped line stays unset.
	spyOn(exec, "execFileP").mockImplementation(async (bin, args, options) => {
		const output = await platform(bin, args, options);
		const named = args?.includes("multiline") && args.includes("--fields");
		if (bin !== "nmcli" || !named || !args?.includes("connection"))
			return output;
		const stored = f.settings.get(args.at(-1) ?? "")?.[
			"802-11-wireless.channel"
		];
		if (stored !== undefined && stored !== "") return output;
		return {
			...output,
			stdout: output.stdout.replace(
				/^802-11-wireless\.channel:$/m,
				"802-11-wireless.channel:0",
			),
		};
	});
}

async function liveSave(f: Fixture, password: string) {
	const frames: string[] = [];
	f.commands.length = 0;
	const remembered: { ssid: string; password: string }[] = [];
	const connects: string[] = [];
	await wifiHotspotConfig(
		statusClient((frame) => frames.push(frame)),
		{
			device: 0,
			name: "Saved AP",
			password,
			channel: "auto",
		},
		{
			...defaultHotspotConfigDeps,
			nmConnSetFields,
			nmConnect: async (uuid) => {
				connects.push(uuid);
				return true;
			},
			wifiUpdateSavedConns: async () => undefined,
			broadcastState: () => undefined,
			rememberCredentials: (_owner, credentials) => {
				remembered.push({
					ssid: credentials.ssid,
					password: credentials.password,
				});
			},
			getCapabilities: () => undefined,
		},
	);
	return { frames, remembered, connects };
}

async function runningAp(): Promise<{ f: Fixture; uuid: string }> {
	const f = await firstAp();
	expect((await f.start()).success).toBe(true);
	await settlePending("wlan0", true);
	const uuid = f.created();
	if (!uuid) throw new Error("Missing running AP");
	f.row.hotspot.channel = "auto";
	nmPropertyDefaults(f);
	f.commands.length = 0;
	return { f, uuid };
}

test("a live Save with an auto channel verifies against NM's unset channel and reactivates", async () => {
	const { f, uuid } = await runningAp();
	try {
		const owners = getHotspotCredentialOwners(uuid);
		const creation = owners.map((owner) => getPendingHotspotCreation(owner));
		const secret = `${f.secret}-live`;
		const { frames, remembered, connects } = await liveSave(f, secret);
		const settings = f.settings.get(uuid);
		expect({
			ssid: settings?.["802-11-wireless.ssid"],
			credentialSaved: settings?.["802-11-wireless-security.psk"] === secret,
			reactivated: connects,
			remembered: remembered.map((entry) => ({
				ssid: entry.ssid,
				passwordSaved: entry.password === secret,
			})),
			rejected: f.logs.filter((line) => line.startsWith('{"reason":')),
			retired: f.logs.includes("Wi-Fi profile authority retired"),
			creation: owners.map((owner) => getPendingHotspotCreation(owner)),
			success: frames.some((frame) => frame.includes('"success":true')),
		}).toEqual({
			ssid: "Saved AP",
			credentialSaved: true,
			reactivated: [uuid],
			remembered: [{ ssid: "Saved AP", passwordSaved: true }],
			rejected: [],
			retired: false,
			creation,
			success: true,
		});
		expect(f.logs.some((line) => line.includes(secret))).toBe(false);
	} finally {
		await f.restore();
	}
});
