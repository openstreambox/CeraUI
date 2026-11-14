import { z } from "zod";

export const srtForwardConfigSchema = z.object({
	host: z
		.ipv4()
		.refine(
			(value) =>
				value.startsWith("10.") ||
				value.startsWith("192.168.") ||
				/^172\.(1[6-9]|2[0-9]|3[01])\./.test(value) ||
				value.startsWith("127."),
		),
	port: z.number().int().min(1).max(65535).default(4000),
	passphrase: z
		.string()
		.min(10)
		.max(79)
		.default(() => crypto.randomUUID().replaceAll("-", "")),
	maxbw: z.number().int().min(125000).max(12500000).default(2500000),
	relay_passphrase: z.string().min(10).max(79).optional(),
});
