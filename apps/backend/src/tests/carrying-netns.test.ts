import { expect, test } from "bun:test";
import { CarryingTracker } from "../modules/system/carrying.ts";
import {
	netnsPrivilegePrefix,
	netnsUnshareFlag,
} from "./helpers/netns-privilege.ts";

test.skipIf(process.env.CERALIVE_NETNS_ISOLATED !== "1")(
	"a phone's shaped forwarded upload establishes carrying without an engine",
	async () => {
		const path = new URL("./fixtures/carrying-netns.sh", import.meta.url)
			.pathname;
		const prefix = await netnsPrivilegePrefix(path);
		const proc = Bun.spawn(
			[...prefix, "unshare", netnsUnshareFlag(prefix), "--mount", "bash", path],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const [out, err, exit] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(exit, err).toBe(0);
		const samples = JSON.parse(out) as { now: number; bytes: number }[];
		const tracker = new CarryingTracker();
		for (const sample of samples)
			tracker.upload(sample.now, { client0: sample.bytes });
		const last = samples.at(-1);
		if (!last) throw new Error("No upload samples");
		expect(tracker.read(last.now)).toBe("streaming");
	},
	40_000,
);
