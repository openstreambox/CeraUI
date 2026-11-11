import { execFileP } from "../../helpers/exec.ts";

export function isHdmiCaptureAudio(device: string): boolean {
	return /^(?:hw:CARD=)?(HDMIIN|rockchiphdmiin|hdmirx)(?:,|$)/.test(device);
}

/** Missing controls are unknown, never a claim that a source carries audio. */
export function parseHdmiAudioSignal(controls: string): boolean | undefined {
	const present = /^\s*audio_present: ([01])\s*$/m.exec(controls);
	const rate = /^\s*audio_sampling_rate: (\d+)\s*$/m.exec(controls);
	if (!present || !rate) return undefined;
	return present[1] === "1" && Number(rate[1]) > 0;
}

export async function readHdmiAudioSignal(): Promise<boolean | undefined> {
	try {
		const { stdout } = await execFileP(
			"v4l2-ctl",
			["-d", "/dev/hdmirx", "--get-ctrl=audio_present,audio_sampling_rate"],
			{ timeout: 2000 },
		);
		return parseHdmiAudioSignal(stdout);
	} catch {
		// Unsupported drivers keep engine-owned admission and diagnostics.
		return undefined;
	}
}
