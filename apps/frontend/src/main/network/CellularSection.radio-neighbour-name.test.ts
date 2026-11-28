// @vitest-environment jsdom
import type { Modem, RadioHealth, RadioMetric } from "@ceraui/rpc/schemas";
import { fireEvent, render, within } from "@testing-library/svelte";
import { expect, test, vi } from "vitest";
import CellularSection from "./CellularSection.svelte";

vi.mock("$lib/rpc/client", () => ({
	rpc: { network: { configure: vi.fn() } },
}));
vi.mock("$lib/rpc", () => ({
	rpc: { modems: { getRadioHealth: vi.fn(async () => ({})) } },
}));
vi.mock("svelte-sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getConnectionState: () => "connected",
}));

test("radio health identifies an isolated neighbour by the Cellular row title", async () => {
	const at = Date.now();
	const absent: RadioMetric = {
		value: null,
		source: "ModemManager",
		unit: "",
		technology: "unknown",
		capturedAt: at,
	};
	const radio: RadioHealth = {
		capturedAt: at,
		registration: absent,
		layer: absent,
		band: absent,
		metrics: {},
		neighbours: [
			{
				id: "1000",
				band: absent,
				transmitting: "unknown",
				source: "tx_bytes",
				capturedAt: at,
			},
		],
		usb: { available: false, events: [] },
		finding: { kind: "unknown", confidence: "unknown", evidence: [] },
		timeline: [],
	};
	const modem: Modem = {
		ifname: "wwan0",
		name: "RM520N-GL",
		device_class: "usb",
		network_type: { supported: ["4G"], active: null },
		radio_health: radio,
	};
	const dongle: Modem = {
		ifname: "dg0h",
		name: "dongle0",
		slot_label: "dongle0",
		device_class: "router-ethernet",
		availability_reason: "router_managed",
		network_type: { supported: [], active: null },
	};
	const view = render(CellularSection, {
		props: {
			modemEntries: [
				["0", modem],
				["1000", dongle],
			],
			netif: undefined,
			isFullyStale: false,
			staleInterfaces: new Set(),
			onConfigure: vi.fn(),
		},
	});
	const rows = view.getAllByTestId("modem-row");
	const routerRow = rows.find((row) =>
		row.textContent?.includes("Router dongle 1"),
	);
	expect(routerRow).toBeDefined();
	const nativeRow = rows.find((row) => row !== routerRow);
	if (!nativeRow) throw new Error("missing native row");
	await fireEvent.click(within(nativeRow).getByTestId("modem-details-toggle"));
	await fireEvent.click(within(nativeRow).getByTestId("radio-health-open"));
	const neighbours = await view.findByTestId("radio-health-neighbours");
	expect(neighbours.querySelector("dt")?.textContent?.trim()).toBe(
		"Router dongle 1",
	);
});
