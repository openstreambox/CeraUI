import { afterEach, expect, test } from "bun:test";
import {
	captureCellularSourcePublication,
	claimCellularSource,
	releaseCellularSource,
	resetCellularSourcesForTest,
	setCellularSourceBinding,
	setCellularSourceReady,
	withdrawCellularSource,
} from "../network/cellular-source-state.ts";
import type { BondEntry } from "./bind-map.ts";
import { resetBindMapWriter } from "./bind-map-writer.ts";
import { BondPublicationQueue } from "./bond-publication-queue.ts";

afterEach(() => {
	resetBindMapWriter();
	resetCellularSourcesForTest();
});
const owner = "a".repeat(64),
	entry: BondEntry = { ip: "192.0.2.2", iface: "wwan0", linkId: "link-one" };
function ready(generation = "grant-one") {
	claimCellularSource(owner, "usb-one", "wwan0");
	setCellularSourceBinding(owner, "usb-one", "wwan0", {
		source: entry.ip,
		device: entry.iface,
		translated: false,
		generation,
	});
	setCellularSourceReady(owner, "usb-one", "wwan0", generation, true);
}
function fixture(permit: () => boolean, pause: "write" | "rename" = "write") {
	const files = new Map<string, string>(),
		commits: string[] = [];
	let release: () => void = () => {},
		entered: () => void = () => {},
		hold = true;
	const barrier = new Promise<void>((resolve) => {
			release = resolve;
		}),
		observed = new Promise<void>((resolve) => {
			entered = resolve;
		});
	const queue = new BondPublicationQueue({
		capture: (row) => ({ entry: { ...row }, current: permit }),
		writer: () => ({
			ipsFile: "ips",
			sidecarFile: "map",
			writeFile: async (path, text) => {
				if (pause === "write" && hold) {
					hold = false;
					entered();
					await barrier;
				}
				files.set(path, text);
			},
			renameFile: async (from, to) => {
				if (pause === "rename" && hold) {
					hold = false;
					entered();
					await barrier;
				}
				files.set(to, files.get(from) ?? "");
				files.delete(from);
				commits.push(to);
			},
			removeFile: async (path) => {
				files.delete(path);
			},
		}),
		published: () => {},
	});
	return { queue, files, commits, release, observed };
}
test("withdrawal drains earlier writes and captured callbacks cannot republish an old grant", async () => {
	ready();
	const permit = captureCellularSourcePublication(
			"wwan0",
			entry.ip,
			entry.iface,
		),
		f = fixture(permit);
	const pending = f.queue.publish([entry]);
	await f.observed;
	withdrawCellularSource(owner, "usb-one", "wwan0");
	const withdrawn = f.queue.publish([]),
		stale = f.queue.publish([entry]);
	f.release();
	expect((await pending).ok).toBe(true);
	expect((await withdrawn).ok).toBe(true);
	expect((await stale).ok).toBe(true);
	await f.queue.drain();
	expect(f.files.get("ips")).toBe("");
	expect(JSON.parse(f.files.get("map") ?? "null").links).toEqual([]);
	expect(f.commits).toEqual(["ips", "map", "ips", "map", "ips", "map"]);
	ready("grant-two");
	expect(permit()).toBe(false);
});
test("revocation during an already-submitted rename is followed by restrictive publication before resolution", async () => {
	ready();
	const f = fixture(
		captureCellularSourcePublication("wwan0", entry.ip, entry.iface),
		"rename",
	);
	const pending = f.queue.publish([entry]);
	await f.observed;
	withdrawCellularSource(owner, "usb-one", "wwan0");
	f.release();
	expect((await pending).ok).toBe(true);
	expect(f.files.get("ips")).toBe("");
	expect(JSON.parse(f.files.get("map") ?? "null").links).toEqual([]);
	expect(f.commits).toEqual(["ips", "ips", "map"]);
});
test("an unmanaged capture cannot revive after a managed claim and release on the same name", () => {
	const permit = captureCellularSourcePublication(
		"wwan0",
		entry.ip,
		entry.iface,
	);
	expect(permit()).toBe(true);
	ready();
	releaseCellularSource(owner, "usb-one", "wwan0");
	expect(permit()).toBe(false);
});

test("a retired cleanup lease cannot commit a queued restriction or erase a successor sidecar", async () => {
	let owned = true;
	const f = fixture(() => true);
	f.files.set("ips", "successor");
	f.files.set("map", "successor-map");
	const pending = f.queue.publish([entry], () => owned);
	await f.observed;
	owned = false;
	f.release();
	const result = await pending;
	expect(result.ok).toBe(false);
	expect(f.commits).toEqual([]);
	expect(f.files.get("ips")).toBe("successor");
	expect(f.files.get("map")).toBe("successor-map");
});
