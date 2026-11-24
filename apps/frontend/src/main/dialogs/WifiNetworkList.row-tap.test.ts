// @vitest-environment jsdom
/**
 * WifiNetworkList: the row is the Connect control, and Forget lives in the
 * network's details, away from it.
 *
 * On a phone the old row ended in a 38x28 plug icon with a 36x36 trash icon
 * right beside it, so a missed tap on Connect could land on Forget, and both
 * targets were under the 44 px minimum (`DESIGN.md` §6). Now a tap on the row
 * joins (or opens the password prompt), and a saved network's Forget, Change
 * password and Disconnect sit behind its Manage control.
 */
import type { AvailableWifiNetwork, WifiInterface } from "@ceraui/rpc/schemas";
import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";

import WifiNetworkList from "./WifiNetworkList.svelte";

const net = (
	ssid: string,
	over: Partial<AvailableWifiNetwork> = {},
): AvailableWifiNetwork => ({
	active: false,
	ssid,
	signal: 72,
	security: "WPA2",
	freq: 5180,
	...over,
});

const ACTIVE = net("HomeNetwork", { active: true, signal: 92 });
const SAVED = net("Cafe-Guest");
const NEW_SECURED = net("Neighbour-5G");
const NEW_OPEN = net("Library-Free", { security: "" });

function iface(networks: AvailableWifiNetwork[]): WifiInterface {
	return {
		ifname: "wlan0",
		conn: "uuid-home",
		hw: "",
		saved: { HomeNetwork: "uuid-home", "Cafe-Guest": "uuid-cafe" },
		available: networks,
	};
}

function setup(
	networks: AvailableWifiNetwork[],
	over: Record<string, unknown> = {},
) {
	const handlers = {
		onScan: vi.fn(),
		onConnectSaved: vi.fn(),
		onDisconnect: vi.fn(),
		onConnectNew: vi.fn(),
		onForget: vi.fn(),
		onConfirmForget: vi.fn(),
		onSubmitNew: vi.fn(),
		onResetInteraction: vi.fn(),
	};
	const result = render(WifiNetworkList, {
		props: {
			iface: iface(networks),
			networks,
			ifaceBusy: false,
			scanning: false,
			deviceId: "0",
			connecting: undefined,
			disconnecting: undefined,
			forgetting: undefined,
			pendingNew: undefined,
			confirmForget: undefined,
			passwordMin: 8,
			password: "",
			showPassword: false,
			...handlers,
			...over,
		},
	});
	return { ...result, handlers };
}

const button = (name: string) =>
	screen.getByRole("button", { name }) as HTMLButtonElement;
const noButton = (name: string) => screen.queryByRole("button", { name });

describe("a tap on the row joins", () => {
	it("connects a saved network from its row", async () => {
		const { handlers } = setup([SAVED]);
		const row = button(`Connect ${SAVED.ssid}`);
		// The row carries the network's name, so the whole row is the target.
		expect(row.textContent).toContain(SAVED.ssid);
		await fireEvent.click(row);
		expect(handlers.onConnectSaved).toHaveBeenCalledWith("uuid-cafe", SAVED);
	});

	it("opens the password prompt for a new secured network", async () => {
		const { handlers } = setup([NEW_SECURED]);
		const row = button(`Connect ${NEW_SECURED.ssid}`);
		expect(row.textContent).toContain(NEW_SECURED.ssid);
		await fireEvent.click(row);
		expect(handlers.onConnectNew).toHaveBeenCalledWith(NEW_SECURED);
	});

	it("joins a new open network from its row", async () => {
		const { handlers } = setup([NEW_OPEN]);
		await fireEvent.click(button(`Connect ${NEW_OPEN.ssid}`));
		expect(handlers.onConnectNew).toHaveBeenCalledWith(NEW_OPEN);
	});

	it("disables the row while the adapter is busy", () => {
		setup([SAVED], { ifaceBusy: true });
		expect(button(`Connect ${SAVED.ssid}`).disabled).toBe(true);
	});
});

describe("Forget is in the network's details, not next to Connect", () => {
	it("shows no Forget, Change password or Disconnect on the row itself", () => {
		setup([ACTIVE, SAVED, NEW_SECURED]);
		for (const ssid of [ACTIVE.ssid, SAVED.ssid, NEW_SECURED.ssid]) {
			expect(noButton(`Forget ${ssid}`)).toBeNull();
			expect(noButton(`Change password ${ssid}`)).toBeNull();
			expect(noButton(`Disconnect ${ssid}`)).toBeNull();
		}
	});

	it("opens a saved network's details with Change password and Forget", async () => {
		setup([SAVED]);
		const details = button(`Manage ${SAVED.ssid}`);
		expect(details.getAttribute("aria-expanded")).toBe("false");
		await fireEvent.click(details);
		expect(details.getAttribute("aria-expanded")).toBe("true");

		const panel = screen.getByTestId("wifi-network-details");
		expect(
			within(panel).getByRole("button", {
				name: `Change password ${SAVED.ssid}`,
			}),
		).toBeTruthy();
		expect(
			within(panel).getByRole("button", { name: `Forget ${SAVED.ssid}` }),
		).toBeTruthy();
		// Connect stays the row; the panel never repeats it next to Forget.
		expect(
			within(panel).queryByRole("button", { name: `Connect ${SAVED.ssid}` }),
		).toBeNull();
	});

	it("asks before forgetting", async () => {
		const { handlers } = setup([SAVED]);
		await fireEvent.click(button(`Manage ${SAVED.ssid}`));
		await fireEvent.click(button(`Forget ${SAVED.ssid}`));
		expect(handlers.onConfirmForget).toHaveBeenCalledWith(SAVED.ssid);
		expect(handlers.onForget).not.toHaveBeenCalled();
	});

	it("keeps the confirm step inside the details", async () => {
		const { handlers } = setup([SAVED], { confirmForget: SAVED.ssid });
		const panel = screen.getByTestId("wifi-network-details");
		await fireEvent.click(
			within(panel).getByRole("button", { name: "Forget" }),
		);
		expect(handlers.onForget).toHaveBeenCalledWith("uuid-cafe", SAVED);
	});

	it("opens the connected network's details from its row, with Disconnect", async () => {
		const { handlers } = setup([ACTIVE]);
		const row = button(`Manage ${ACTIVE.ssid}`);
		expect(row.textContent).toContain(ACTIVE.ssid);
		await fireEvent.click(row);
		const panel = screen.getByTestId("wifi-network-details");
		await fireEvent.click(
			within(panel).getByRole("button", { name: `Disconnect ${ACTIVE.ssid}` }),
		);
		expect(handlers.onDisconnect).toHaveBeenCalledWith("uuid-home", ACTIVE);
		expect(handlers.onConnectSaved).not.toHaveBeenCalled();
	});

	it("never offers a password change for the connected network", async () => {
		setup([ACTIVE]);
		await fireEvent.click(button(`Manage ${ACTIVE.ssid}`));
		const panel = screen.getByTestId("wifi-network-details");
		expect(
			within(panel).queryByRole("button", { name: /^Change password / }),
		).toBeNull();
	});

	it("offers no details for a network that is not saved", () => {
		setup([NEW_SECURED]);
		expect(noButton(`Manage ${NEW_SECURED.ssid}`)).toBeNull();
	});
});

describe("a network the scan marks active but this radio has no profile for", () => {
	// The backend copies one scan, active flags included, to every radio, while
	// each radio has its own saved map. A network another radio is on arrives
	// here active with no saved profile, so there is nothing to manage: the row
	// must keep joining on this radio instead of turning into a Manage control
	// that opens nothing.
	const ELSEWHERE = net("Office-WPA2", { active: true, signal: 80 });

	it("joins from the row", async () => {
		const { handlers } = setup([ELSEWHERE]);
		const row = button(`Connect ${ELSEWHERE.ssid}`);
		expect(row.disabled).toBe(false);
		expect(row.getAttribute("aria-expanded")).toBeNull();
		await fireEvent.click(row);
		expect(handlers.onConnectNew).toHaveBeenCalledWith(ELSEWHERE);
		expect(noButton(`Manage ${ELSEWHERE.ssid}`)).toBeNull();
		expect(screen.queryByTestId("wifi-network-details")).toBeNull();
	});

	it("stays disabled while the adapter is busy, like any other join", () => {
		setup([ELSEWHERE], { ifaceBusy: true });
		expect(button(`Connect ${ELSEWHERE.ssid}`).disabled).toBe(true);
	});
});

describe("long network names", () => {
	it("wraps the name instead of cutting it to one line", () => {
		const long = net("Hotel-Grand-Conference-Floor3-5G");
		setup([long]);
		const name = screen.getByText(long.ssid);
		expect(name.className).not.toContain("truncate");
		expect(name.className).toContain("break-words");
	});
});
