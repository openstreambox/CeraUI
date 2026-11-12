import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DurableInverseRecord } from "../../helpers/durable-inverse.ts";
import {
	writePrivateJson,
	writePrivateText,
} from "../../helpers/private-json-state.ts";
import {
	cellularClatHostSteps,
	parseCellularClatHostPlan,
} from "./cellular-clat-host-plan.ts";
import { CellularClatReceipt } from "./cellular-clat-receipt.ts";
import { cellularClatBirthKey } from "./cellular-clat-session.ts";
import { inventoryCellularHosts } from "./cellular-host-inventory.ts";
import {
	cellularNativeHostSteps,
	cellularUplinkSlotKey,
	parseCellularNativeHostPlan,
} from "./cellular-native-host-plan.ts";
import { planCellularRoutes } from "./cellular-route-plan.ts";
import { cellularTranslatorConfigKey } from "./cellular-translator.ts";
import { cellularTranslatorConfig } from "./cellular-translator-config.ts";
import { cellularTunAlias } from "./cellular-tun.ts";

const owner = "a".repeat(64),
	epoch = "grant-one",
	bootId = "11111111-1111-1111-1111-111111111111";
function native() {
	return parseCellularNativeHostPlan({
		input: {
			owner,
			epoch,
			slot: 1,
			iface: "wwan0",
			mtu: 1428,
			ipv4: "192.0.2.2",
		},
		bootId,
		ifindex: 17,
		dns: ["192.0.2.53"],
	});
}
function clat() {
	const tunEpoch = "b".repeat(64);
	return parseCellularClatHostPlan({
		input: {
			owner,
			epoch,
			slot: 2,
			iface: "wwan1",
			mtu: 1280,
			ipv6: "2001:db8:1::2",
			ipv6PrefixLength: 64,
			ipv6Gateway: "fe80::1",
			nat64: "2001:db8:64::/96",
		},
		physical: {
			ifname: "wwan1",
			ifindex: "18",
			usbDevice: "synthetic-usb",
			netDevice: "synthetic-net",
			generation: "usb-one",
		},
		tun: {
			name: "cclat2",
			index: 19,
			alias: cellularTunAlias(owner, tunEpoch),
			persistent: true,
		},
		tunEpoch,
		birth: "c".repeat(32),
		bootId,
		globalForwarding: "0",
		physicalBefore: {
			accept_ra: "1",
			accept_ra_defrtr: "0",
			forwarding: "0",
			proxy_ndp: "0",
			force_forwarding: "0",
		},
		dns: ["2001:db8::53"],
	});
}
function inverse<T>(
	plan: T,
	steps: readonly string[],
): DurableInverseRecord<T> {
	return {
		version: 1,
		owner,
		epoch,
		plan,
		steps,
		cursor: steps.length,
		phase: "active",
	};
}
async function fixture() {
	const dir = await mkdtemp(join(tmpdir(), "cellular-host-inventory-"));
	let faults = 0;
	const store = {
		dir,
		readFault: () => {
			faults++;
		},
	};
	return {
		store,
		faults: () => faults,
		close: () => rm(dir, { recursive: true, force: true }),
	};
}
test("a closed census includes native, staged birth, CLAT inverse, receipt and exact generated configuration", async () => {
	const f = await fixture();
	try {
		expect(await inventoryCellularHosts(f.store)).toEqual([]);
		const n = native(),
			c = clat(),
			{ tun, ...birthPlan } = c;
		await writePrivateJson(
			f.store,
			cellularUplinkSlotKey(1),
			inverse(n, cellularNativeHostSteps(n)),
		);
		await writePrivateJson(f.store, cellularClatBirthKey(2), {
			version: 1,
			plan: birthPlan,
			childSubmitted: false,
			withdrawing: false,
		});
		expect(
			(await inventoryCellularHosts(f.store)).map((row) => row.kind),
		).toEqual(["native", "clat"]);
		await writePrivateJson(f.store, cellularClatBirthKey(2), {
			version: 1,
			plan: birthPlan,
			tun,
			childSubmitted: true,
			withdrawing: false,
		});
		await writePrivateJson(
			f.store,
			cellularUplinkSlotKey(2),
			inverse(c, cellularClatHostSteps(c)),
		);
		const receipt = new CellularClatReceipt(c, f.store, () => true);
		await receipt.create();
		await receipt.markTunConfiguration(true);
		await receipt.markTranslatorSubmission();
		await receipt.rememberInvocation("d".repeat(32));
		const routes = planCellularRoutes(c.input);
		if (!routes) throw new Error("Synthetic translated route missing");
		await writePrivateText(
			f.store,
			cellularTranslatorConfigKey({ ...c.input, birth: c.birth }),
			cellularTranslatorConfig(routes),
		);
		expect(await inventoryCellularHosts(f.store)).toMatchObject([
			{ kind: "native", slot: 1 },
			{ kind: "clat", slot: 2, inverse: { phase: "active" } },
		]);
		expect(f.faults()).toBe(0);
	} finally {
		await f.close();
	}
});
test("misplaced and mismatched outer authority refuses the whole census and preserves its bytes", async () => {
	for (const change of ["slot", "owner", "epoch", "steps", "cursor"] as const) {
		const f = await fixture();
		try {
			const plan = native(),
				value = inverse(plan, cellularNativeHostSteps(plan)),
				key = cellularUplinkSlotKey(change === "slot" ? 2 : 1);
			const damaged = {
				...value,
				...(change === "owner"
					? { owner: "b".repeat(64) }
					: change === "epoch"
						? { epoch: "other" }
						: change === "steps"
							? { steps: ["unknown"] }
							: change === "cursor"
								? { cursor: 99 }
								: {}),
			};
			await writePrivateJson(f.store, key, damaged);
			const path = join(f.store.dir, `${key}.json`),
				bytes = await readFile(path);
			await expect(inventoryCellularHosts(f.store)).rejects.toThrow();
			expect(await readFile(path)).toEqual(bytes);
			expect(f.faults()).toBeGreaterThan(0);
		} finally {
			await f.close();
		}
	}
});
test("an orphan configuration, unknown file and auxiliary authority beyond the write-ahead cursor cannot be ignored", async () => {
	const f = await fixture();
	try {
		const c = clat(),
			{ tun, ...plan } = c,
			configKey = cellularTranslatorConfigKey({ ...c.input, birth: c.birth });
		await writePrivateText(f.store, configKey, "tun-device cclat2\n");
		await expect(inventoryCellularHosts(f.store)).rejects.toThrow(
			"Unrecognized",
		);
		await writePrivateText(f.store, configKey, undefined);
		await writeFile(join(f.store.dir, "unknown"), "preserve", { mode: 0o600 });
		await expect(inventoryCellularHosts(f.store)).rejects.toThrow(
			"Unknown private",
		);
		expect(await readFile(join(f.store.dir, "unknown"), "utf8")).toBe(
			"preserve",
		);
		await rm(join(f.store.dir, "unknown"));
		await writePrivateJson(f.store, cellularClatBirthKey(2), {
			version: 1,
			plan,
			tun,
			childSubmitted: true,
			withdrawing: false,
		});
		const record = inverse(c, cellularClatHostSteps(c));
		await writePrivateJson(f.store, cellularUplinkSlotKey(2), {
			...record,
			phase: "applying",
			cursor: 1,
		});
		const receipt = new CellularClatReceipt(c, f.store, () => true);
		await receipt.create();
		await receipt.markTranslatorSubmission();
		await expect(inventoryCellularHosts(f.store)).rejects.toThrow(
			"exceeds retained cursor",
		);
		await writePrivateJson(f.store, cellularUplinkSlotKey(2), record);
		expect(await inventoryCellularHosts(f.store)).toHaveLength(1);
		// Submission flags are historical while reversing. A crash after translator
		// removal must not make its retained receipt look like a new submission.
		await writePrivateJson(f.store, cellularUplinkSlotKey(2), {
			...record,
			phase: "withdrawing",
			cursor: 1,
		});
		expect(await inventoryCellularHosts(f.store)).toHaveLength(1);
		await writePrivateJson(f.store, cellularUplinkSlotKey(2), record);
		await writePrivateJson(f.store, cellularClatBirthKey(2), {
			version: 1,
			plan: { ...plan, birth: "e".repeat(32) },
			tun,
			childSubmitted: true,
			withdrawing: false,
		});
		await expect(inventoryCellularHosts(f.store)).rejects.toThrow("disagree");
	} finally {
		await f.close();
	}
});
