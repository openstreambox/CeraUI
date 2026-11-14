import type { StreamingConfigInput } from "@ceraui/rpc/schemas";

declare global {
	interface Window {
		startStreamingWithNotificationClear?: (
			config: Partial<StreamingConfigInput>,
		) => void;
		stopStreamingWithNotificationClear?: () => void;
		__ceraAppMounted?: boolean;
		__ceraDisplayRefreshCount?: number;
	}
}
