import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import * as relay from "./notification-relay.ts";

const dtoPath = `${import.meta.dir}/legacy-notification-dto.ts`;
test.skipIf(!existsSync(dtoPath))(
	"legacy boundary accepts the full relay catalog, fallbacks and overflow frames on integration",
	async () => {
		const dto = await import(dtoPath);
		expect(relay.NOTIFICATION_SUMMARIES).toEqual(dto.NOTIFICATION_SUMMARIES);
		const messages = [
			...Object.values(relay.NOTIFICATION_SUMMARIES),
			...Object.values(relay.NOTIFICATION_FALLBACKS),
		];
		for (const msg of messages) {
			const payload = {
				show: [
					{
						name: "a".repeat(64),
						type: "warning",
						msg,
						revision: 1,
						is_persistent: true,
						is_dismissable: false,
						duration: 0,
					},
				],
				remove: [],
				epoch: crypto.randomUUID(),
				full: true,
			};
			expect(dto.projectLegacyNotification(payload)).toEqual(payload);
		}
		for (const count of [1, 2, 400, Number.MAX_SAFE_INTEGER]) {
			const payload = {
				show: [
					{
						name: relay.OVERFLOW_NOTICE_NAME,
						type: "warning",
						msg: relay.overflowMessage(count),
						revision: 2,
						is_persistent: true,
						is_dismissable: false,
						duration: 0,
					},
				],
				remove: [],
				epoch: crypto.randomUUID(),
				full: true,
			};
			expect(dto.projectLegacyNotification(payload)).toEqual(payload);
		}
	},
);
