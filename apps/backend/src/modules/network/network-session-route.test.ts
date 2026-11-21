import { describe, expect, it } from "bun:test";
import {
	createSessionRouteLookup,
	isTunnelInterface,
} from "./network-session-route.ts";

/** `ip -j route get` and `ip -j route show default table all`, as iproute2 6.x prints them. */
function ip(table: {
	get?: Record<string, string>;
	default4?: Array<{ dev: string; type?: string }>;
	default6?: Array<{ dev: string; type?: string }>;
}) {
	const calls: string[][] = [];
	const runner = async (bin: string, args: string[]) => {
		expect(bin).toBe("ip");
		calls.push(args);
		if (args[1] === "route" && args[2] === "get") {
			const dev = table.get?.[args[3] as string];
			if (!dev) throw new Error("RTNETLINK answers: Network is unreachable");
			return JSON.stringify([{ dst: args[3], dev, prefsrc: "192.0.2.1" }]);
		}
		const rows = args[1] === "-6" ? table.default6 : table.default4;
		return JSON.stringify(
			(rows ?? []).map((row) => ({ dst: "default", gateway: "x", ...row })),
		);
	};
	return { calls, lookup: createSessionRouteLookup(runner).lookup };
}

describe("the box's route back to a session", () => {
	it("a peer reached directly depends on that one interface", async () => {
		const r = ip({ get: { "198.51.100.9": "eth0" } });
		expect(await r.lookup("198.51.100.9")).toEqual({
			carriers: ["eth0"],
			tunnel: false,
		});
		expect(await r.lookup("::ffff:198.51.100.9")).toEqual({
			carriers: ["eth0"],
			tunnel: false,
		});
	});

	it("a tailnet peer depends on every uplink with a default route", async () => {
		const r = ip({
			get: { "100.64.0.7": "tailscale0" },
			default4: [
				{ dev: "wwan0" },
				{ dev: "eth0" },
				{ dev: "tailscale0" },
				{ dev: "eth0" },
				{ dev: "lo", type: "unreachable" },
			],
			default6: [{ dev: "wwan0" }],
		});
		expect(await r.lookup("100.64.0.7")).toEqual({
			carriers: ["eth0", "wwan0"],
			tunnel: true,
		});
	});

	it("a loopback peer (the front door's proxy, a local relay agent) is treated like a tunnel", async () => {
		const r = ip({ default4: [{ dev: "eth0" }] });
		expect(await r.lookup("127.0.0.1")).toEqual({
			carriers: ["eth0"],
			tunnel: true,
		});
		expect(r.calls.some((c) => c.includes("get"))).toBe(false);
	});

	it("anything doubtful is undefined, never a guess", async () => {
		const r = ip({ get: { "100.64.0.7": "tailscale0" } });
		// No uplink at all.
		expect(await r.lookup("100.64.0.7")).toBeUndefined();
		// No route, a non-address (the control channel), an option-shaped value.
		expect(await r.lookup("203.0.113.5")).toBeUndefined();
		expect(await r.lookup("control-channel")).toBeUndefined();
		expect(await r.lookup("--help")).toBeUndefined();
		expect(r.calls.flat()).not.toContain("--help");
		const broken = createSessionRouteLookup(async () => "not json");
		expect(await broken.lookup("198.51.100.9")).toBeUndefined();
	});

	it("knows which interfaces are tunnels", () => {
		for (const name of ["lo", "tailscale0", "wg0", "tun0", "ztabcdef"])
			expect(isTunnelInterface(name), name).toBe(true);
		for (const name of ["eth0", "wlan0", "wwan0", "usb0", "enx001122"])
			expect(isTunnelInterface(name), name).toBe(false);
	});
});
