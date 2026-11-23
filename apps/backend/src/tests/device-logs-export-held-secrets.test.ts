import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { LogExportInput, VersionContext } from "@ceraui/rpc/schemas";
import * as identity from "../modules/device-logs/boot-id.ts";
import * as data from "../modules/device-logs/bundle-data.ts";
import {
	abortLogExports,
	createExport,
	handleLogExportRequest,
} from "../modules/device-logs/export.ts";
import * as versions from "../modules/system/version-context.ts";
import {
	bootId,
	journal,
	queryFixture,
	record,
} from "./helpers/device-query.ts";

// Quote, backslash and spaces give distinct JSON and percent forms; its base64
// holds "+", so base64url differs too.
const secret = 'held "key"\\ ~?>> x';
const jsonForm = JSON.stringify(secret).slice(1, -1);
const percentForm = encodeURIComponent(secret);
const lowerPercentForm = percentForm.replace(/%[0-9A-F]{2}/g, (hex) =>
	hex.toLowerCase(),
);
const base64Form = Buffer.from(secret).toString("base64");
const base64UrlForm = Buffer.from(secret).toString("base64url");
const currentVersions: VersionContext = {
	bootId,
	osImage: "current-os",
	slot: "A",
	board: "board",
	boardModel: null,
	ceraui: "ui",
	engine: "engine",
	senderVersion: "sender",
	kernel: "kernel",
	bun: "bun",
};
let fixture: ReturnType<typeof queryFixture>;
let held: ReturnType<typeof spyOn<typeof data, "collectHeldSecrets">>;
let context: ReturnType<typeof spyOn<typeof versions, "collectVersionContext">>;
let boot: ReturnType<typeof spyOn<typeof identity, "currentBootId">>;
beforeEach(() => {
	boot = spyOn(identity, "currentBootId").mockReturnValue(bootId);
	fixture = queryFixture();
	held = spyOn(data, "collectHeldSecrets").mockReturnValue([
		{ kind: "key", value: secret },
	]);
	context = spyOn(versions, "collectVersionContext").mockResolvedValue(
		currentVersions,
	);
});
afterEach(async () => {
	await abortLogExports();
	boot.mockRestore();
	context.mockRestore();
	held.mockRestore();
	fixture.restore();
});
async function download(input: LogExportInput = { filter: {} }) {
	const created = await createExport({}, input);
	if (!created.ok) throw new Error(created.error);
	return (
		await handleLogExportRequest(new Request(`http://device${created.url}`))
	).text();
}

test("held credentials are redacted from every exported line, in any unit and encoding", async () => {
	expect(new Set([secret, jsonForm, percentForm, lowerPercentForm]).size).toBe(
		4,
	);
	expect(base64Form).not.toBe(base64UrlForm);
	fixture.scan.mockImplementation(
		journal([
			record(1, { MESSAGE: `caller uri ?passphrase=${secret}&latency=120` }),
			record(2, {
				_SYSTEMD_UNIT: "srtla-send.service",
				MESSAGE: `json ${JSON.stringify({ key: secret })} uri ${percentForm} lower ${lowerPercentForm}`,
			}),
			record(3, { MESSAGE: `first line\nsecond ${secret} line` }),
			record(4, { MESSAGE: `b64 ${base64Form} b64url ${base64UrlForm}` }),
			record(5, { MESSAGE: "nothing held here" }),
		]),
	);
	const text = await download();
	for (const form of [
		secret,
		jsonForm,
		percentForm,
		lowerPercentForm,
		base64Form,
		base64UrlForm,
	])
		expect(text).not.toContain(form);
	expect(text).toContain("caller uri ?passphrase=[REDACTED:key]&latency=120");
	expect(text).toContain(
		'srtla-send: json {"key":"[REDACTED:key]"} uri [REDACTED:key] lower [REDACTED:key]',
	);
	expect(text).toContain("second [REDACTED:key] line");
	expect(text).toContain("b64 [REDACTED:key] b64url [REDACTED:key]");
	expect(text).toContain("nothing held here");
	expect(text).toEndWith("# complete: 5 entries\n");
});

test("a held credential that spans the unit and the message is redacted on the formatted line", async () => {
	held.mockReturnValue([{ kind: "key", value: "srtla-send: cross" }]);
	fixture.scan.mockImplementation(
		journal([
			record(1, {
				_SYSTEMD_UNIT: "srtla-send.service",
				MESSAGE: "cross field",
			}),
		]),
	);
	const text = await download();
	expect(text).not.toContain("srtla-send: cross");
	expect(text).toContain("INFO    [REDACTED:key] field\n");
});

test("a held credential typed into the search filter is redacted from the header", async () => {
	fixture.scan.mockImplementation(journal([record(1, { MESSAGE: secret })]));
	const text = await download({ filter: { text: secret } });
	expect(text).not.toContain(secret);
	expect(text).not.toContain(jsonForm);
	expect(text).toContain('"text":"[REDACTED:key]"');
	expect(text).toEndWith("# complete: 1 entries\n");
});

test("a multi-line held credential is redacted before continuation lines are indented", async () => {
	const multiLine = "first-half-of-key\nsecond-half-of-key";
	held.mockReturnValue([{ kind: "key", value: multiLine }]);
	fixture.scan.mockImplementation(
		journal([
			record(1, { MESSAGE: `before ${multiLine} after` }),
			record(2, { _SYSTEMD_UNIT: `${multiLine}.service`, MESSAGE: "unit" }),
		]),
	);
	const text = await download();
	expect(text).not.toContain("first-half-of-key");
	expect(text).not.toContain("second-half-of-key");
	expect(text).toContain("before [REDACTED:key] after");
	expect(text).toEndWith("# complete: 2 entries\n");
});

test("an unreadable credential holder fails the export closed before any entry", async () => {
	held.mockImplementation(() => {
		throw new Error("Unsafe credential storage");
	});
	fixture.scan.mockImplementation(journal([record(1, { MESSAGE: secret })]));
	const text = await download();
	expect(text).toBe("# incomplete: READ_FAILED\n");
});

test("a held set the redactor refuses also fails the export closed", async () => {
	held.mockReturnValue([{ kind: "key", value: "x".repeat(65 * 1024) }]);
	fixture.scan.mockImplementation(journal([record(1, { MESSAGE: "entry" })]));
	const text = await download();
	expect(text).toBe("# incomplete: READ_FAILED\n");
});

test("config credential fields are redacted by name even when the value is no longer held", async () => {
	held.mockReturnValue([]);
	fixture.scan.mockImplementation(
		journal([
			record(1, {
				MESSAGE: JSON.stringify({
					msg: "config loaded",
					meta: {
						ssh_pass: "old-ssh-pass-a41b",
						ssh_pass_hash: "$6$oldsalt$oldsshhasha41b",
						remote_key: "old-remote-key-a41b",
						pairingSecret: "[REDACTED]old-pairing-tail-a41b",
						autostart: true,
					},
				}),
			}),
		]),
	);
	const text = await download();
	for (const value of [
		"old-ssh-pass-a41b",
		"oldsshhasha41b",
		"old-remote-key-a41b",
		"old-pairing-tail-a41b",
	])
		expect(text).not.toContain(value);
	expect(text).toContain('"ssh_pass":"[REDACTED:ssh]"');
	expect(text).toContain('"ssh_pass_hash":"[REDACTED:ssh]"');
	expect(text).toContain('"remote_key":"[REDACTED:remote_key]"');
	expect(text).toContain('"pairingSecret":"[REDACTED:pairing]"');
	expect(text).toContain('"autostart":true');
	expect(text).toEndWith("# complete: 1 entries\n");
});

test("nested and array credentials are redacted from an export by their parent keys", async () => {
	held.mockReturnValue([]);
	fixture.scan.mockImplementation(
		journal([
			record(1, {
				MESSAGE: JSON.stringify({
					msg: "remote state",
					meta: {
						remote: { key: "nested-remote-e3" },
						relays: [{ ingest_key: "array-object-e3" }],
						raw: JSON.stringify({ ssh: { hash: "$6$s$inner-hash-e3" } }),
					},
				}),
			}),
		]),
	);
	const text = await download();
	for (const value of ["nested-remote-e3", "array-object-e3", "inner-hash-e3"])
		expect(text).not.toContain(value);
	expect(text).toContain("remote state");
	expect(text).toEndWith("# complete: 1 entries\n");
});
