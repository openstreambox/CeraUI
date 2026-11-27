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
// Earlier values that only begin with the redaction marker.
const markerPrefixed = [
	"[REDACTED]old-prefixed-44",
	"[REDACTED:srt_passphrase]-55",
];
// Earlier values that are a marker plus punctuation, inside JSON fields.
const markerPunctuated = ["[REDACTED]!?;", "[REDACTED]),"];
// Earlier values in URI query fields, where a query delimiter ends the value.
const markerInQuery = [
	"[REDACTED],",
	"[REDACTED];",
	"[REDACTED],secret-77",
	"[REDACTED];secret-88",
];
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
	"old-prefixed-44",
	"[REDACTED:srt_passphrase]-55",
	...markerPunctuated,
	"[REDACTED],&",
	"[REDACTED];\n",
	"secret-77",
	"secret-88",
	"secret-99",
	"prose-98",
	"oldjson-61",
	"tail-62",
	"oldjson-63",
	"tail-64",
	"quoted tail",
	"oldfirst-71",
	"oldsecond-72",
	"oldsingle-73",
	"words-81",
	"oldend-82",
	"oldtab-83",
	"oldprose-84",
];
// Valid JSON with a tab between colon and value, serialized into a string field.
const tabbed = (value: string) =>
	JSON.stringify({ msg: `{"passphrase":\t"${value}","latency":125}` });

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
			record(6, {
				_SYSTEMD_UNIT: "srtla.service",
				MESSAGE: `restart ?passphrase=${markerPrefixed[0]} cfg {"passphrase":"${markerPrefixed[1]}"}`,
			}),
			record(7, {
				_SYSTEMD_UNIT: "srtla.service",
				MESSAGE: `wrapped "{\\"passphrase\\":\\"${markerPunctuated[0]}\\"}" cfg {"passphrase":"${markerPunctuated[1]}"}`,
			}),
			record(8, {
				_SYSTEMD_UNIT: "srtla-send.service",
				MESSAGE: `caller srt://127.0.0.1:9000?streamid=a&passphrase=${markerInQuery[0]}&latency=120 old srt://127.0.0.1:9000?passphrase=${markerInQuery[2]}&latency=120 srt://127.0.0.1:9000?streamid=b&passphrase=${markerInQuery[3]} srt://127.0.0.1:9000?passphrase=${markerInQuery[1]}`,
			}),
			record(9, {
				_SYSTEMD_UNIT: "srtla-send.service",
				MESSAGE: `caller srt://127.0.0.1:9000?streamid=c&passphrase=[REDACTED]'secret-99&latency=120 note passphrase=[REDACTED]'prose-98 end`,
			}),
			record(10, {
				_SYSTEMD_UNIT: "srtla.service",
				MESSAGE: `cfg {"passphrase":"oldjson-61&passphrase=[REDACTED]tail-62","latency":120} done`,
			}),
			record(11, {
				_SYSTEMD_UNIT: "srtla.service",
				MESSAGE: `cfg {"passphrase":"oldjson-63?passphrase=[REDACTED]tail-64","latency":121} next`,
			}),
			record(12, {
				_SYSTEMD_UNIT: "srtla-send.service",
				MESSAGE: `caller srt://127.0.0.1:9000?passphrase="old quoted tail"&latency=120`,
			}),
			record(13, {
				_SYSTEMD_UNIT: "srtla.service",
				MESSAGE: `cfg {"passphrase":"oldfirst-71?passphrase=x","url":"srt://127.0.0.1:9000?passphrase=oldsecond-72&latency=120"} two`,
			}),
			record(14, {
				_SYSTEMD_UNIT: "srtla.service",
				MESSAGE: `cfg {"url":"srt://127.0.0.1:9000?passphrase='oldsingle-73'","latency":122} three`,
			}),
			record(15, {
				_SYSTEMD_UNIT: "srtla.service",
				// Twelve literal backslashes, and a marker followed by three.
				MESSAGE: `cfg {"passphrase":"${"\\".repeat(24)}","latency":123} {"srt_passphrase":"[REDACTED]${"\\".repeat(6)}","latency":124} four`,
			}),
			record(16, {
				_SYSTEMD_UNIT: "srtla-send.service",
				MESSAGE: `caller "srt://127.0.0.1:9000?passphrase=\\"two words-81\\"" caller "srt://127.0.0.1:9000?streamid=d&passphrase=oldend-82" five`,
			}),
			record(17, {
				_SYSTEMD_UNIT: "srtla.service",
				MESSAGE: `cfg ${tabbed("oldtab-83")} six`,
			}),
			record(18, {
				_SYSTEMD_UNIT: "srtla.service",
				MESSAGE: `note passphrase="oldprose-84",latency=126 seven`,
			}),
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
	expect(journalSection?.entries).toBe(18);
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
	// Each expected line once, so one line cannot stand in for another.
	for (const message of EXPECTED)
		expect(text.split(`: ${message}\n`)).toHaveLength(2);
	expect(text).toEndWith("# complete: 18 entries\n");
});

const REDACTIONS = 30;
const EXPECTED = [
	"caller srt://127.0.0.1:9000?passphrase=[REDACTED:srt_passphrase]&latency=120",
	"form [REDACTED:srt_passphrase] double [REDACTED:srt_passphrase]",
	'listener \\"[REDACTED:srt_forward]\\" relay [REDACTED:srt_forward]',
	'restart ?passphrase=[REDACTED:srt_passphrase] cfg {"passphrase":"[REDACTED:srt_passphrase]"} wrapped "{\\"relay_passphrase\\":\\"[REDACTED:srt_passphrase]\\"}"',
	"already passphrase=[REDACTED] by the logger",
	'restart ?passphrase=[REDACTED:srt_passphrase] cfg {"passphrase":"[REDACTED:srt_passphrase]"}',
	'wrapped "{\\"passphrase\\":\\"[REDACTED:srt_passphrase]\\"}" cfg {"passphrase":"[REDACTED:srt_passphrase]"}',
	"caller srt://127.0.0.1:9000?streamid=a&passphrase=[REDACTED:srt_passphrase]&latency=120 old srt://127.0.0.1:9000?passphrase=[REDACTED:srt_passphrase]&latency=120 srt://127.0.0.1:9000?streamid=b&passphrase=[REDACTED:srt_passphrase] srt://127.0.0.1:9000?passphrase=[REDACTED:srt_passphrase]",
	"caller srt://127.0.0.1:9000?streamid=c&passphrase=[REDACTED:srt_passphrase]&latency=120 note passphrase=[REDACTED:srt_passphrase] end",
	// The enclosing field wins: its neighbour and closing brace stay intact.
	'cfg {"passphrase":"[REDACTED:srt_passphrase]","latency":120} done',
	'cfg {"passphrase":"[REDACTED:srt_passphrase]","latency":121} next',
	'caller srt://127.0.0.1:9000?passphrase="[REDACTED:srt_passphrase]"&latency=120',
	// Two credentials in one compact message: the second is masked too.
	'cfg {"passphrase":"[REDACTED:srt_passphrase]","url":"srt://127.0.0.1:9000?passphrase=[REDACTED:srt_passphrase]&latency=120"} two',
	'cfg {"url":"srt://127.0.0.1:9000?passphrase=[REDACTED:srt_passphrase]","latency":122} three',
	// Only the values change; delimiters and neighbours stay.
	'cfg {"passphrase":"[REDACTED:srt_passphrase]","latency":123} {"srt_passphrase":"[REDACTED:srt_passphrase]","latency":124} four',
	'caller "srt://127.0.0.1:9000?passphrase=\\"[REDACTED:srt_passphrase]\\"" caller "srt://127.0.0.1:9000?streamid=d&passphrase=[REDACTED:srt_passphrase]" five',
	`cfg ${tabbed("[REDACTED:srt_passphrase]")} six`,
	'note passphrase="[REDACTED:srt_passphrase]",latency=126 seven',
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
	[
		"srt://h:1?streamid=a&passphrase=[REDACTED]&latency=120",
		"srt://h:1?streamid=a&passphrase=[REDACTED]&latency=120",
	],
	[
		"srt://h:1?passphrase=[REDACTED],&latency=120",
		"srt://h:1?passphrase=[REDACTED:srt_passphrase]&latency=120",
	],
	[
		"srt://h:1?streamid=a&passphrase=[REDACTED]; then",
		"srt://h:1?streamid=a&passphrase=[REDACTED:srt_passphrase] then",
	],
	[
		'quoted passphrase=[REDACTED],"next"',
		"quoted passphrase=[REDACTED:srt_passphrase]",
	],
	[
		"srt://h:1?streamid=a&passphrase=[REDACTED]'tail&latency=120",
		"srt://h:1?streamid=a&passphrase=[REDACTED:srt_passphrase]&latency=120",
	],
	[
		'srt://h:1?passphrase=[REDACTED]"tail#frag',
		"srt://h:1?passphrase=[REDACTED:srt_passphrase]#frag",
	],
	[
		'srt://h:1?passphrase="old quoted tail"&latency=120',
		'srt://h:1?passphrase="[REDACTED:srt_passphrase]"&latency=120',
	],
	[
		'cfg {"passphrase":"old&passphrase=[REDACTED]tail","latency":120}',
		'cfg {"passphrase":"[REDACTED:srt_passphrase]","latency":120}',
	],
	[
		"note passphrase=[REDACTED]'tail end",
		"note passphrase=[REDACTED:srt_passphrase] end",
	],
	[
		"restart passphrase=[REDACTED]old-tail",
		"restart passphrase=[REDACTED:srt_passphrase]",
	],
	[
		'cfg {"passphrase":"[REDACTED:srt_passphrase] old tail"}',
		'cfg {"passphrase":"[REDACTED:srt_passphrase]"}',
	],
	[
		String.raw`wrapped "{\"passphrase\":\"[REDACTED],\"}"`,
		String.raw`wrapped "{\"passphrase\":\"[REDACTED:srt_passphrase]\"}"`,
	],
	[
		'cfg {"passphrase":"[REDACTED];"}',
		'cfg {"passphrase":"[REDACTED:srt_passphrase]"}',
	],
	[
		String.raw`wrapped "{\"passphrase\":\"[REDACTED]old\"}"`,
		String.raw`wrapped "{\"passphrase\":\"[REDACTED:srt_passphrase]\"}"`,
	],
])(
	"named passphrase fields are masked without a held value: %s",
	(line, masked) => {
		const redactor = buildRedactor([]);
		const changed = line === masked ? 0 : 1;
		expect(redactor.known(line)).toEqual({ text: masked, redactions: changed });
		expect(redactor.text(line)).toEqual({ text: masked, redactions: changed });
	},
);
