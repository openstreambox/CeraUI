import { afterEach, expect, test } from "bun:test";
import { statusResponseSchema } from "@ceraui/rpc/schemas";
import type WebSocket from "ws";
import {
	getLinkPaths,
	setLinkPaths,
} from "../modules/streaming/link-path-status.ts";
import { sendStatus } from "../modules/ui/status.ts";
import { buildInitialStatus } from "../rpc/procedures/status.procedure.ts";

afterEach(() => setLinkPaths({}));
test("both authentication snapshots and live status retain the selected path map", () => {
	setLinkPaths({ cell0: "clat", cell1: "receiver-ipv4-only" });
	const expected = getLinkPaths();
	expect(buildInitialStatus().status.link_paths).toEqual(expected);
	let frame: { status?: unknown } = {};
	sendStatus({
		send(value: string) {
			frame = JSON.parse(value);
		},
	} as unknown as WebSocket);
	expect(statusResponseSchema.parse(frame.status).link_paths).toEqual(expected);
	setLinkPaths({});
	expect(buildInitialStatus().status.link_paths).toEqual({});
});

test("an idle health inventory read cannot republish a cleared session selection", async () => {
	const { processIfconfigOutput, parseIpAddrShow } = await import(
		"../modules/network/network-interfaces.ts"
	);
	const { resolveSrtla, genSrtlaIpList, genSrtlaBondEntries } = await import(
		"../modules/streaming/srtla.ts"
	);
	processIfconfigOutput(
		"wan0: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500\n",
		parseIpAddrShow("2: wan0: <UP>\n    inet 192.0.2.3/24 scope global\n"),
	);
	await resolveSrtla("192.0.2.2");
	genSrtlaBondEntries(true);
	expect(getLinkPaths()).toEqual({ wan0: "ipv4" });
	setLinkPaths({});
	expect(genSrtlaIpList()).toEqual(["192.0.2.3"]);
	expect(getLinkPaths()).toEqual({});
});

test("the translator stays internal to its physical link in the operator inventory", async () => {
	const {
		processIfconfigOutput,
		parseIpAddrShow,
		netIfBuildMsg,
		getNetworkInterfaces,
	} = await import("../modules/network/network-interfaces.ts");
	processIfconfigOutput(
		"wan0: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500\n\nclat3: flags=4305<UP,POINTOPOINT,RUNNING,NOARP,MULTICAST>  mtu 1500\n",
		parseIpAddrShow(
			"2: wan0: <UP>\n    inet6 2001:db8::3/64 scope global\n3: clat3: <UP>\n    inet 10.254.0.3/32 scope global\n",
		),
	);
	expect(getNetworkInterfaces().clat3?.ip).toBe("10.254.0.3");
	expect(netIfBuildMsg().wan0?.ipv6).toBe("2001:db8::3");
	expect(netIfBuildMsg().clat3).toBeUndefined();
});
