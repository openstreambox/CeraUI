import { wifiStatusSchema } from "@ceraui/rpc/schemas";
import { render } from "@testing-library/svelte";
import { expect, it } from "vitest";
import RemoteNetworkStatus from "./RemoteNetworkStatus.svelte";

it("shows neutral labels and connection state without local management controls", () => {
	const wifi = wifiStatusSchema.parse({
		"Wi-Fi 1": {
			ifname: "Wi-Fi 1",
			hw: "Wi-Fi 1",
			conn: "Profile 1",
			saved: {},
		},
	});
	const { container, getByText } = render(RemoteNetworkStatus, {
		props: { wifi, modems: undefined, netif: undefined },
	});
	expect(getByText("Wi-Fi 1")).toBeTruthy();
	expect(getByText("Connected")).toBeTruthy();
	expect(container.querySelectorAll("button,input")).toHaveLength(0);
});
