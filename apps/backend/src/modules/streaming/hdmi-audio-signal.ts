import { execFileP } from "../../helpers/exec.ts";

/** Only an explicit DV-timing no-link verdict proves missing HDMI video. */
export function parseHdmiNoSignal(diagnostic: string): boolean | undefined {
	return /VIDIOC_QUERY_DV_TIMINGS.*(?:Link has been severed|No link|No locks available)/s.test(
		diagnostic,
	)
		? false
		: undefined;
}

export async function readHdmiVideoSignal(): Promise<boolean | undefined> {
	try {
		await execFileP("v4l2-ctl", ["-d", "/dev/hdmirx", "--query-dv-timings"], {
			timeout: 2000,
		});
		return true;
	} catch (error) {
		const result = error as { stdout?: string; stderr?: string };
		return parseHdmiNoSignal(`${result.stdout ?? ""} ${result.stderr ?? ""}`);
	}
}
