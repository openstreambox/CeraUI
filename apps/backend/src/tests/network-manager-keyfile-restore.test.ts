import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
	existsSync,
	linkSync,
	lstatSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "../helpers/logger.ts";
import {
	type KeyfileNameOps,
	stageKeyfilePublication,
} from "../modules/network/network-manager-keyfile-publication.ts";

const ORIGINAL = Buffer.from("[wifi]\nssid=Old\n");
const SUBMITTED = Buffer.from("[wifi]\nssid=New\n");

let root: string;
let live: string;
const logs: string[] = [];

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "keyfile-restore-"));
	live = join(root, "Hotspot.nmconnection");
	writeFileSync(live, ORIGINAL, { mode: 0o600 });
	logs.length = 0;
	spyOn(logger, "error").mockImplementation((message) => {
		logs.push(String(message));
		return logger;
	});
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Replace the live name atomically, as NM or an editor would. */
function writeSuccessor(bytes: string): void {
	const temporary = join(root, "successor.tmp");
	writeFileSync(temporary, bytes, { mode: 0o600 });
	renameSync(temporary, live);
}

/** Publish the submitted bytes and report the load as started. */
function loaded(ops?: KeyfileNameOps) {
	const stat = lstatSync(live, { bigint: true });
	const staged = join(root, ".Hotspot.nmconnection.staged.tmp");
	writeFileSync(staged, SUBMITTED, { mode: 0o600 });
	const publication = stageKeyfilePublication(
		{
			filename: live,
			device: String(stat.dev),
			inode: String(stat.ino),
			ctime: String(stat.ctimeNs),
		},
		ORIGINAL,
		staged,
		ops,
	);
	expect(publication.publish(SUBMITTED)).toBe(true);
	publication.beginLoad();
	return { publication, inode: stat.ino };
}

test("a restore puts the original inode back and finishing leaves its ctime alone", async () => {
	const { publication, inode } = loaded();
	const restored = publication.restore(SUBMITTED);
	const atRestore = lstatSync(live, { bigint: true });
	await publication.finish(SUBMITTED);
	const after = lstatSync(live, { bigint: true });
	expect({
		inode: after.ino === inode,
		bytes: readFileSync(live).equals(ORIGINAL),
		identity: restored?.inode === String(atRestore.ino),
		ctimeAtRestore: restored?.ctime === String(atRestore.ctimeNs),
		ctimeAfterFinish: after.ctimeNs === atRestore.ctimeNs,
		leftovers: readdirSync(root).filter(
			(name) => name !== "Hotspot.nmconnection",
		),
		logs,
	}).toEqual({
		inode: true,
		bytes: true,
		identity: true,
		ctimeAtRestore: true,
		ctimeAfterFinish: true,
		leftovers: [],
		logs: [],
	});
});

test("a successor that lands between the ownership check and the rename goes back live", async () => {
	const { publication } = loaded({
		rename: (from, to) => {
			if (from === live) writeSuccessor("[wifi]\nssid=Successor\n");
			renameSync(from, to);
		},
		link: linkSync,
	});
	expect(publication.restore(SUBMITTED)).toBeUndefined();
	await publication.finish(SUBMITTED);
	const parked = readdirSync(root).filter((name) =>
		name.endsWith(".previous.tmp"),
	);
	expect({
		live: readFileSync(live, "utf8"),
		parkedOriginal: parked.map((name) =>
			readFileSync(join(root, name)).equals(ORIGINAL),
		),
		logs,
	}).toEqual({
		live: "[wifi]\nssid=Successor\n",
		parkedOriginal: [true],
		logs: ["NM profile rollback kept the previous keyfile aside"],
	});
});

test("a second writer that claims the live name before the link is never replaced", async () => {
	const { publication } = loaded({
		rename: renameSync,
		link: (existing, name) => {
			if (name === live) writeSuccessor("[wifi]\nssid=Second\n");
			linkSync(existing, name);
		},
	});
	expect(publication.restore(SUBMITTED)).toBeUndefined();
	await publication.finish(SUBMITTED);
	const kept = (suffix: string) =>
		readdirSync(root)
			.filter((name) => name.endsWith(suffix))
			.map((name) => readFileSync(join(root, name), "utf8"));
	expect({
		live: readFileSync(live, "utf8"),
		previous: kept(".previous.tmp"),
		displaced: kept(".rollback.tmp"),
		logs,
	}).toEqual({
		live: "[wifi]\nssid=Second\n",
		previous: [ORIGINAL.toString()],
		displaced: [SUBMITTED.toString()],
		logs: [
			"NM keyfile restoration failed",
			"NM profile rollback kept the previous keyfile aside",
			"NM profile rollback kept the displaced live keyfile aside",
		],
	});
	expect(existsSync(live)).toBe(true);
});
