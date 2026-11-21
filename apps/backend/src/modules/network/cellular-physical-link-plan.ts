import { z } from "zod";

const path = z
	.string()
	.min(1)
	.max(4096)
	.refine((value) =>
		Array.from(value).every(
			(char) => (char.codePointAt(0) ?? 0) >= 32 && char.codePointAt(0) !== 127,
		),
	);
export const cellularPhysicalLinkPlanSchema = z
	.object({
		ifname: z.string(),
		ifindex: z.string().regex(/^[1-9]\d{0,9}$/),
		usbDevice: path,
		netDevice: path,
		generation: z.string().min(1).max(256),
	})
	.strict();
