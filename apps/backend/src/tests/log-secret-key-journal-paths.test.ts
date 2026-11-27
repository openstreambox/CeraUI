import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { updateSettingsSchema } from "@ceraui/rpc/schemas";
import * as config from "../modules/config.ts";
import * as identity from "../modules/device-logs/boot-id.ts";
import {
	abortLogBundles,
	createBundle,
	handleLogBundleRequest,
} from "../modules/device-logs/bundle.ts";
import {
	abortLogExports,
	createExport,
	handleLogExportRequest,
} from "../modules/device-logs/export.ts";
import { queryLogs } from "../modules/device-logs/query.ts";
import * as stored from "../modules/events/store.ts";
import * as updates from "../modules/system/update-settings.ts";
import * as versions from "../modules/system/version-context.ts";
import {
	bootId,
	journal,
	queryFixture,
	record,
} from "./helpers/device-query.ts";

// Synthetic values. The SSH password now held differs from the one an older
// build wrote into the journal before it was changed, and the backend never
// holds the shadow hash in the form the export matches against.
const currentSshPass = "current-ssh-pass-31";
const staleSshPass = "stale-ssh-pass-62";
const sshPassHash = "$6$fixturesalt$fixturehashfixturehash";
const staleRemoteKey = "stale-remote-key-93";
const leaked = [staleSshPass, sshPassHash, staleRemoteKey, currentSshPass];

// The exact record shape a 5.1 to 6.2 build writes on every start.
const legacyConfigLoaded = JSON.stringify({
	ts: "2026-11-27T00:00:00.000Z",
	level: "debug",
	msg: "config loaded",
	meta: {
		password_hash: "[REDACTED]",
		ssh_pass: staleSshPass,
		ssh_pass_hash: sshPassHash,
		remote_key: staleRemoteKey,
		max_br: 5000,
	},
});

let fixture: ReturnType<typeof queryFixture>;
const restores: Array<() => void> = [];
function restore(spy: { mockRestore(): void }) {
	restores.push(() => spy.mockRestore());
}
beforeEach(() => {
	fixture = queryFixture();
	restore(spyOn(identity, "currentBootId").mockReturnValue(bootId));
	restore(
		spyOn(versions, "collectVersionContext").mockResolvedValue({
			bootId,
			osImage: null,
			slot: null,
			board: null,
			boardModel: null,
			ceraui: "ui",
			engine: null,
			senderVersion: null,
			kernel: null,
			bun: null,
		}),
	);
	restore(
		spyOn(updates, "readUpdateChannel").mockResolvedValue(
			updateSettingsSchema.parse({ channel: "stable" }).channel,
		),
	);
	restore(spyOn(stored, "readEvents").mockReturnValue([]));
	restore(spyOn(stored, "readBoots").mockReturnValue([]));
	restore(
		spyOn(config, "getConfig").mockReturnValue({ ssh_pass: currentSshPass }),
	);
	fixture.scan.mockImplementation(
		journal([
			record(1, { MESSAGE: legacyConfigLoaded }),
			record(2, { MESSAGE: "an ordinary line" }),
		]),
	);
});
afterEach(async () => {
	await abortLogBundles();
	await abortLogExports();
	for (const reset of restores.splice(0)) reset();
	fixture.restore();
});

test("the log viewer query shows a stored config loaded line without credentials", async () => {
	const result = await queryLogs({}, {});
	const text = JSON.stringify(result);
	for (const secret of leaked) expect(text).not.toContain(secret);
	expect(text).toContain("config loaded");
	expect(text).toContain('\\"max_br\\":5000');
});

test("the log view export carries no credential an older build logged", async () => {
	const created = await createExport({}, { filter: {} });
	if (!created.ok) throw new Error(created.error);
	const text = await (
		await handleLogExportRequest(new Request(`http://device${created.url}`))
	).text();
	for (const secret of leaked) expect(text).not.toContain(secret);
	expect(text).toContain("config loaded");
	expect(text).toEndWith("# complete: 2 entries\n");
});

test("the support bundle carries no credential an older build logged", async () => {
	const created = await createBundle({});
	if (!created.ok) throw new Error(created.error);
	const response = await handleLogBundleRequest(
		new Request(`http://device${created.url}`),
	);
	expect(response.status).toBe(200);
	if (!response.body) throw new Error("missing bundle body");
	const text = await new Response(
		response.body.pipeThrough(new DecompressionStream("gzip")),
	).text();
	for (const secret of leaked) expect(text).not.toContain(secret);
	expect(text).toContain("config loaded");
});
