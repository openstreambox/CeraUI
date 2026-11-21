import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { updateSettingsSchema } from "@ceraui/rpc/schemas";
import * as config from "../modules/config.ts";
import * as identity from "../modules/device-logs/boot-id.ts";
import {
	abortLogBundles,
	createBundle,
	handleLogBundleRequest,
	previewBundle,
} from "../modules/device-logs/bundle.ts";
import { collectHeldSecrets } from "../modules/device-logs/bundle-data.ts";
import {
	abortLogExports,
	createExport,
	handleLogExportRequest,
} from "../modules/device-logs/export.ts";
import { buildRedactor } from "../modules/device-logs/redaction.ts";
import * as stored from "../modules/events/store.ts";
import { setup } from "../modules/setup.ts";
import * as updates from "../modules/system/update-settings.ts";
import * as versions from "../modules/system/version-context.ts";
import {
	bootId,
	journal,
	queryFixture,
	record,
} from "./helpers/device-query.ts";

// Synthetic values, one per SRT credential the train adds beside upstream's.
// The Moblin relay password is written to its own file on save and never read
// back, so the backend holds no value to match; the moblink-owner and
// moblink-relay tests pin that it has no route into the journal either.
const passphrase = "train srt pass!71";
const forward = 'fwd "listener"\\52';
const relay = "train-forward-relay-key-38";
// Values from an earlier configuration, no longer held anywhere.
const stale = ["old-srt-pass-11", "old-forward-22", "old-relay-33"];
const formEncoded = new URLSearchParams({ v: passphrase }).toString().slice(2);
const doubleUri = encodeURIComponent(encodeURIComponent(passphrase));
const doubleJson = JSON.stringify(JSON.stringify(forward)).slice(1, -1);
const leaked = [
	passphrase,
	encodeURIComponent(passphrase),
	formEncoded,
	doubleUri,
	forward,
	JSON.stringify(forward).slice(1, -1),
	doubleJson,
	relay,
	...stale,
];

let fixture: ReturnType<typeof queryFixture>;
const restores: Array<() => void> = [];
function restore(spy: { mockRestore(): void }) {
	restores.push(() => spy.mockRestore());
}
const savedForward = setup.srt_forward;
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
		spyOn(config, "getConfig").mockReturnValue({ srt_passphrase: passphrase }),
	);
	setup.srt_forward = {
		host: "192.168.1.20",
		port: 4000,
		passphrase: forward,
		maxbw: 2500000,
		relay_passphrase: relay,
	};
	// Another unit's lines, which the backend logger never saw.
	fixture.scan.mockImplementation(
		journal([
			record(1, {
				_SYSTEMD_UNIT: "srtla-send.service",
				MESSAGE: `caller srt://127.0.0.1:9000?passphrase=${encodeURIComponent(passphrase)}&latency=120`,
			}),
			record(2, {
				_SYSTEMD_UNIT: "srtla-send.service",
				MESSAGE: `form ${formEncoded} double ${doubleUri}`,
			}),
			record(3, {
				_SYSTEMD_UNIT: "srtla.service",
				MESSAGE: `listener ${doubleJson} relay ${relay}`,
			}),
			record(4, {
				_SYSTEMD_UNIT: "srtla.service",
				MESSAGE: `restart ?passphrase=${stale[0]} cfg {"passphrase":"${stale[1]}"} wrapped "{\\"relay_passphrase\\":\\"${stale[2]}\\"}"`,
			}),
			record(5, { MESSAGE: "already passphrase=[REDACTED] by the logger" }),
		]),
	);
});
afterEach(async () => {
	await abortLogBundles();
	await abortLogExports();
	setup.srt_forward = savedForward;
	for (const reset of restores.splice(0)) reset();
	fixture.restore();
});

test("the train's SRT output and forwarding credentials are held for redaction", () => {
	const held = collectHeldSecrets();
	expect(held).toEqual(
		expect.arrayContaining([
			{ kind: "srt_passphrase", value: passphrase },
			{ kind: "srt_forward", value: forward },
			{ kind: "srt_forward", value: relay },
		]),
	);
	setup.srt_forward = undefined;
	expect(
		collectHeldSecrets().filter((secret) => secret.kind === "srt_forward"),
	).toEqual([]);
});

test("a support bundle never carries a train credential from another unit's journal line", async () => {
	const manifest = await previewBundle();
	const journalSection = manifest.sections.find(
		(section) => section.id === "journal",
	);
	expect(journalSection?.entries).toBe(5);
	expect(journalSection?.redactions).toBe(REDACTIONS);
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
	const messages = text
		.trimEnd()
		.split("\n")
		.map((line) => JSON.parse(line))
		.filter((line) => line.section === "journal" && line.entry)
		.map((line) => line.entry.message);
	expect(messages).toEqual(EXPECTED.toReversed());
});

test("the log view export never carries a train credential either", async () => {
	const created = await createExport({}, { filter: {} });
	if (!created.ok) throw new Error(created.error);
	const text = await (
		await handleLogExportRequest(new Request(`http://device${created.url}`))
	).text();
	for (const secret of leaked) expect(text).not.toContain(secret);
	for (const message of EXPECTED) expect(text).toContain(`: ${message}\n`);
	expect(text).toEndWith("# complete: 5 entries\n");
});

const REDACTIONS = 8;
const EXPECTED = [
	"caller srt://127.0.0.1:9000?passphrase=[REDACTED:srt_passphrase]&latency=120",
	"form [REDACTED:srt_passphrase] double [REDACTED:srt_passphrase]",
	'listener \\"[REDACTED:srt_forward]\\" relay [REDACTED:srt_forward]',
	'restart ?passphrase=[REDACTED:srt_passphrase] cfg {"passphrase":"[REDACTED:srt_passphrase]"} wrapped "{\\"relay_passphrase\\":\\"[REDACTED:srt_passphrase]\\"}"',
	"already passphrase=[REDACTED] by the logger",
];

test.each([
	[
		'restart passphrase="old quoted pass"',
		'restart passphrase="[REDACTED:srt_passphrase]"',
	],
	[
		"restart SRT_PASSPHRASE='old single'",
		"restart SRT_PASSPHRASE=[REDACTED:srt_passphrase]",
	],
	[
		'cfg {"Passphrase" : "old spaced"}',
		'cfg {"Passphrase" : "[REDACTED:srt_passphrase]"}',
	],
	[
		String.raw`wrapped "{\"passphrase\" : \"old\\\"quoted\\\\tail\"}"`,
		String.raw`wrapped "{\"passphrase\" : \"[REDACTED:srt_passphrase]\"}"`,
	],
	[
		"already passphrase=[REDACTED], retrying",
		"already passphrase=[REDACTED], retrying",
	],
	[
		'already {"passphrase":"[REDACTED]"}',
		'already {"passphrase":"[REDACTED]"}',
	],
	['empty {"passphrase":""}', 'empty {"passphrase":""}'],
])(
	"named passphrase fields are masked without a held value: %s",
	(line, masked) => {
		const redactor = buildRedactor([]);
		const changed = line === masked ? 0 : 1;
		expect(redactor.known(line)).toEqual({ text: masked, redactions: changed });
		expect(redactor.text(line)).toEqual({ text: masked, redactions: changed });
	},
);
