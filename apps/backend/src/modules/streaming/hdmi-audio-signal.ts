import { realpath } from "node:fs/promises";

import { execFileP } from "../../helpers/exec.ts";

/** Only an explicit DV-timing no-link verdict proves missing HDMI video. */
export function parseHdmiVideoSignal(diagnostic: string): boolean | undefined {
	return /VIDIOC_QUERY_DV_TIMINGS[^\r\n]*(?:Link has been severed|No link|No locks available)/.test(
		diagnostic,
	)
		? false
		: undefined;
}

/** Other inputs cannot be judged by the fixed onboard receiver's timings. */
export async function isOnboardHdmiInput(
	inputId: string | undefined,
	resolvePath: (path: string) => Promise<string> = realpath,
): Promise<boolean> {
	if (inputId === undefined || inputId === "/dev/hdmirx") return true;
	try {
		const [selected, receiver] = await Promise.all([
			resolvePath(inputId),
			resolvePath("/dev/hdmirx"),
		]);
		return selected === receiver;
	} catch {
		return false;
	}
}

export async function readHdmiVideoSignal(): Promise<boolean | undefined> {
	try {
		await execFileP("v4l2-ctl", ["-d", "/dev/hdmirx", "--query-dv-timings"], {
			timeout: 2000,
		});
		return true;
	} catch (error) {
		const result = error as { stdout?: string; stderr?: string };
		return parseHdmiVideoSignal(
			`${result.stdout ?? ""}\n${result.stderr ?? ""}`,
		);
	}
}
