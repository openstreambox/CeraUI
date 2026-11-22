import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { UplinkHealthRecord } from "../modules/network/uplink-health/model.ts";
import {
	ACTIVE_UPLINK_CONFIG,
	ActiveUplinkSelector,
	applyClientUplinkPolicy,
} from "../modules/network/uplink-steering/active-uplink.ts";
import type { SteeringUplink } from "../modules/network/uplink-steering/contracts.ts";
import { DEFAULT_SHARING_POLICY } from "../modules/network/uplink-steering/policy.ts";
import {
	buildShareRuleset,
	stableUplinkMark,
} from "../modules/network/uplink-steering/ruleset.ts";
import {
	netnsPrivilegePrefix,
	netnsUnshareFlag,
} from "./helpers/netns-privilege.ts";

/**
 * Same isolation gate as uplink-steering-netns.test.ts: it needs network
 * namespaces and runs in the dedicated netns step, not inside the bundle.
 *
 *   CERALIVE_NETNS_ISOLATED=1 bun test apps/backend/src/tests/active-uplink-netns.test.ts
 */
const NETNS_ISOLATED = process.env.CERALIVE_NETNS_ISOLATED === "1";

const ZONE = { ifname: "client0", ipv4Cidr: "10.42.0.0/24" } as const;
// The selector ranks by kind, which it reads from the interface name. The
// fixture's links are wan0/wan1, so the plan uses eth0 (wired) and wwan0
// (cellular) and the rulesets are renamed onto the fixture links.
const FIXTURE_NAME: Record<string, string> = { eth0: "wan0", wwan0: "wan1" };

/**
 * `successes` probe rounds observed by `now`, in an unbroken probe run since
 * `since`; fresh unless down.
 */
function record(
	iface: string,
	state: UplinkHealthRecord["state"],
	successes: number,
	now = 0,
	since = now,
): UplinkHealthRecord {
	return {
		iface,
		kind: iface === "eth0" ? "ethernet" : "cellular",
		state,
		weight: state === "down" ? 0 : 100,
		lastTransition: 0,
		staleAt: now + 15_000,
		probes: { successes, failures: 0 },
		// Confirmed by the general-internet probe at `now` unless down.
		signals: state === "down" ? {} : { activeAt: now, probeSince: since },
	} as UplinkHealthRecord;
}

function uplink(identity: string, ifname: string): SteeringUplink {
	return {
		identity,
		ifname,
		mark: stableUplinkMark(identity),
		selectable: true,
		weight: 100,
	};
}

describe.skipIf(!NETNS_ISOLATED)("single-active client uplink — kernel", () => {
	test("failover on a silent blackhole, held rejoin and drain of established flows", async () => {
		const wired = uplink("wired-a", "eth0");
		const cellular = uplink("cell-b", "wwan0");
		const selector = new ActiveUplinkSelector();
		const policy = DEFAULT_SHARING_POLICY;
		// Runs the production policy step on the health a reconcile would see.
		const plan = (
			now: number,
			uplinks: readonly SteeringUplink[],
			health: readonly UplinkHealthRecord[],
		) => {
			const candidates = uplinks.map((u) => ({ uplink: u }));
			const result = applyClientUplinkPolicy(candidates, selector, {
				now,
				policy,
				health: new Map(health.map((r) => [r.iface, r])),
				interfaces: new Set(["eth0", "wwan0"]),
			});
			// Each phase's ruleset is applied below, so its plan is committed.
			selector.commit(result.next);
			const selected = result.candidates.map(({ uplink: u }) => ({
				...u,
				ifname: FIXTURE_NAME[u.ifname] ?? u.ifname,
			}));
			return {
				selected: selected
					.filter((u) => u.selectable && u.weight > 0)
					.map((u) => u.ifname),
				ruleset: buildShareRuleset({ clientZones: [ZONE], uplinks: selected }),
			};
		};

		const both = [wired, cellular];
		const active0 = plan(0, both, [
			record("eth0", "up", 5),
			record("wwan0", "up", 5),
		]);
		// Health has withdrawn eth0 (state-builder drops `down` uplinks).
		const failover1 = plan(
			20_000,
			[cellular],
			[record("eth0", "down", 0), record("wwan0", "up", 9, 20_000, 0)],
		);
		// eth0 proven again at 60 s; its hold doubled after the failure.
		const held1 = plan(60_000, both, [
			record("eth0", "up", 5, 60_000),
			record("wwan0", "up", 17, 60_000, 0),
		]);
		const hold = selector.rejoinHoldMs("wired-a");
		expect(hold).toBe(ACTIVE_UPLINK_CONFIG.rejoinHoldMs * 2);
		// Each 5 s probe round publishes health and reconciles.
		for (let round = 5_000; round < hold; round += 5_000) {
			const now = 60_000 + round;
			expect(
				plan(now, both, [
					record("eth0", "up", 5 + round / 5_000, now, 60_000),
					record("wwan0", "up", 17 + round / 5_000, now, 0),
				]).selected,
			).toEqual(["wan1"]);
		}
		const rejoined0 = plan(60_000 + hold, both, [
			record("eth0", "up", 17, 60_000 + hold, 60_000),
			record("wwan0", "up", 29, 60_000 + hold, 0),
		]);
		expect([
			active0.selected,
			failover1.selected,
			held1.selected,
			rejoined0.selected,
		]).toEqual([["wan0"], ["wan1"], ["wan1"], ["wan0"]]);

		const root = join(process.cwd(), "test-results", "active-uplink");
		await mkdir(root, { recursive: true });
		const temp = await mkdtemp(join(root, "netns-"));
		await chmod(temp, 0o711);
		try {
			const paths = ["active0", "failover1", "held1", "rejoined0"].map((n) =>
				join(temp, `${n}.nft`),
			);
			const log0 = join(temp, "wan0.log");
			const log1 = join(temp, "wan1.log");
			await Promise.all([
				...[active0, failover1, held1, rejoined0].map((p, i) =>
					writeFile(paths[i] as string, p.ruleset),
				),
				writeFile(log0, ""),
				writeFile(log1, ""),
			]);
			await Promise.all([chmod(log0, 0o666), chmod(log1, 0o666)]);
			const fixturePath = fileURLToPath(
				new URL("./fixtures/active-uplink-netns.sh", import.meta.url),
			);
			const privilege = await netnsPrivilegePrefix(fixturePath);
			const proc = Bun.spawn(
				[
					...privilege,
					"unshare",
					netnsUnshareFlag(privilege),
					"bash",
					fixturePath,
					...paths,
					log0,
					log1,
					hex(wired.mark),
					hex(cellular.mark),
				],
				{ env: process.env, stdout: "pipe", stderr: "pipe" },
			);
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			expect(exitCode, stderr).toBe(0);
			const result = JSON.parse(stdout.trim());
			// 1. One active uplink: no client flow is spread onto wan1, while a
			//    sender bound to wan1's address keeps its own path.
			expect(result.p1).toEqual({
				result: "ok",
				wan0: 40,
				wan1: 0,
				long: "ok",
				longOn: "wan0",
				host: "ok",
				hostOn: "wan1",
			});
			// 2. The blackhole loses packets with the link up; after the health
			//    withdrawal every new flow and the retired long flow use wan1.
			expect(result.p2).toEqual({
				lost: "timeout",
				result: "ok",
				wan0: 0,
				wan1: 40,
				long: "ok",
				longSource: "198.51.100.1",
				host: "ok",
			});
			// 3. Inside the hold nothing moves back.
			expect(result.p3).toEqual({
				result: "ok",
				wan0: 0,
				wan1: 40,
				long: "ok",
			});
			// 4. New flows rejoin wan0; the established wan1 flow keeps its
			//    mark and NAT on wan1 instead of being cut over.
			expect(result.p4).toEqual({
				result: "ok",
				wan0: 40,
				wan1: 0,
				long: "ok",
				longSource: "198.51.100.1",
				longOnWan0: 0,
			});
		} finally {
			await rm(temp, { recursive: true, force: true });
		}
	}, 30_000);
});

function hex(mark: number): string {
	return `0x${mark.toString(16).padStart(8, "0")}`;
}
