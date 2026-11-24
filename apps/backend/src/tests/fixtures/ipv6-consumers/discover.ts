import { test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
	getNetworkInterfaces,
	parseIpAddrShow,
	processIfconfigOutput,
} from "../../../modules/network/network-interfaces.ts";
import { genSrtlaIpList } from "../../../modules/streaming/srtla.ts";

test("discover synthetic link", () => {
	processIfconfigOutput(
		"wan0: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500\n",
		parseIpAddrShow(execFileSync("ip", ["addr", "show"], { encoding: "utf8" })),
	);
	const entry = getNetworkInterfaces().wan0;
	process.stdout.write(
		`${JSON.stringify({
			ips: genSrtlaIpList().filter(
				(ip) => ip === entry?.ip || ip === entry?.ipv6,
			),
			ipv6Only: Boolean(entry?.ipv6 && !entry.ip),
		})}\n`,
	);
});
