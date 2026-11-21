import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getConfigFilePath,
	saveConfig,
	setConfigFilePath,
} from "../modules/config.ts";
import {
	bootRuntimeConfig,
	stopRuntimeConfigRecovery,
} from "../modules/config-boot.ts";
import { updateCachedRelays } from "../modules/remote/remote-relays.ts";
import {
	defaultArmedStreamMarkerDeps,
	writeArmedStreamMarker,
} from "../modules/streaming/armed-stream-marker.ts";
import {
	forgetHotspotCredentials,
	initHotspotCredentials,
	rememberHotspotCredentials,
	resetHotspotCredentialsForTest,
} from "../modules/wifi/hotspot-credentials.ts";
import { PersistentTokenStore } from "../rpc/state/persistent-token-store.ts";

let root: string;
let cwd: string;
let configPath: string;
let mask: number;
const mac = "02:00:00:00:00:01";
const credentials = { ssid: "test-hotspot", password: "test-password" };

beforeEach(() => {
	cwd = process.cwd();
	configPath = getConfigFilePath();
	mask = process.umask(0o022);
	root = fs.mkdtempSync(join(tmpdir(), "private-callers-"));
	process.chdir(root);
});
afterEach(() => {
	stopRuntimeConfigRecovery();
	resetHotspotCredentialsForTest();
	setConfigFilePath(configPath);
	process.chdir(cwd);
	process.umask(mask);
	fs.rmSync(root, { recursive: true, force: true });
});

const writers = [
	{
		name: "config.json save",
		file: "config.json",
		save: async () => {
			setConfigFilePath(join(root, "config.json"));
			saveConfig();
		},
	},
	{
		name: "config.json boot reset",
		file: "config.json",
		save: async () => {
			const file = join(root, "config.json");
			fs.writeFileSync(file, "{damaged");
			fs.chmodSync(file, 0o644);
			setConfigFilePath(file);
			expect(
				await bootRuntimeConfig({
					sleep: async () => {},
					onDamagedReset: () => {},
				}),
			).toBe("first-run-after-damage");
		},
	},
	{
		name: "relays_cache.json",
		file: "relays_cache.json",
		save: async () => {
			expect(
				await updateCachedRelays({ bcrp_key: root, servers: {}, accounts: {} }),
			).toBe(true);
		},
	},
	{
		name: "hotspot credentials remember",
		file: "hotspot_credentials.json",
		save: async () => {
			await initHotspotCredentials();
			rememberHotspotCredentials(mac, credentials);
		},
	},
	{
		name: "hotspot credentials forget",
		file: "hotspot_credentials.json",
		save: async () => {
			await initHotspotCredentials();
			rememberHotspotCredentials(mac, credentials);
			// Make the removal path prove its own mode, independently of remember.
			fs.chmodSync("hotspot_credentials.json", 0o644);
			forgetHotspotCredentials(mac);
		},
	},
	{
		name: "stream armed marker",
		file: "stream.armed.json",
		save: async () => {
			writeArmedStreamMarker(
				{ armedAt: 1, bootId: "test-boot", config: {} },
				{
					...defaultArmedStreamMarkerDeps,
					markerPath: join(root, "stream.armed.json"),
				},
			);
		},
	},
	{
		name: "auth_tokens.json",
		file: "auth_tokens.json",
		save: async () => {
			const store = await PersistentTokenStore.open(
				join(root, "auth_tokens.json"),
			);
			try {
				expect(store.prepareWrite()).toBe(true);
				store.records["a".repeat(64)] = true;
				store.save();
			} finally {
				store.stop();
			}
		},
	},
];

for (const writer of writers) {
	for (const previous of [undefined, 0o644]) {
		test(`${writer.name} saves owner-only over ${previous === undefined ? "new" : "0644"} file`, async () => {
			if (previous !== undefined) {
				fs.writeFileSync(writer.file, "{}");
				fs.chmodSync(writer.file, previous);
			}
			await writer.save();
			expect(fs.statSync(writer.file).mode & 0o777).toBe(0o600);
			expect(() =>
				JSON.parse(fs.readFileSync(writer.file, "utf8")),
			).not.toThrow();
		});
	}
}
