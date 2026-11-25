// @vitest-environment jsdom
/**
 * Restart modem on the cellular rows: offered only for bench-qualified models,
 * reachable from the row's Details and from Radio health's "no data" next step,
 * confirmed with its cost first, and its progress and result shown above the
 * rows (the restarted modem's own row unmounts while it is gone).
 */
import type {
	Modem,
	RadioHealth,
	RadioMetric,
	RestartModemOutput,
} from "@ceraui/rpc/schemas";
import { fireEvent, render, waitFor } from "@testing-library/svelte";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import CellularSection from "./CellularSection.svelte";

const restart = vi.fn<(input: unknown) => Promise<RestartModemOutput>>();
let streaming = false;

vi.mock("$lib/rpc/client", () => ({
	rpc: {
		network: { configure: vi.fn() },
		modems: { restart: (input: unknown) => restart(input) },
	},
}));
vi.mock("svelte-sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getConnectionState: () => "connected",
	getIsStreaming: () => streaming,
}));

beforeAll(() => {
	if (!window.matchMedia)
		window.matchMedia = vi.fn().mockImplementation((query: string) => ({
			matches: true,
			media: query,
			onchange: null,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			addListener: vi.fn(),
			removeListener: vi.fn(),
			dispatchEvent: vi.fn(),
		}));
});

beforeEach(() => {
	restart.mockReset();
	streaming = false;
});

const metric = (value: number | string | null): RadioMetric => ({
	value,
	source: "ModemManager",
	unit: "",
	technology: "lte",
	capturedAt: 1_700_000_000_000,
});

function radio(kind: "unknown" | "data-path"): RadioHealth {
	return {
		capturedAt: 1_700_000_000_000,
		registration: metric("home"),
		layer: metric("LTE"),
		band: metric("LTE B3"),
		metrics: {},
		neighbours: [],
		usb: { available: true, events: [] },
		finding: {
			kind,
			confidence: kind === "unknown" ? "unknown" : "likely",
			evidence: [],
		},
		timeline: [],
	};
}

function modem(
	model: string,
	ifname: string,
	extra: Partial<Modem> = {},
): Modem {
	return {
		ifname,
		name: model,
		model,
		network_type: { supported: [], active: null },
		device_class: "usb",
		stable_key: `key-${ifname}`,
		status: {
			connection: "connected",
			network: "Carrier",
			roaming: false,
			network_type: "4g",
			signal: 60,
		},
		...extra,
	} as unknown as Modem;
}

function renderRoster(entries: [string, Modem][]) {
	return render(CellularSection, {
		props: {
			modemEntries: entries,
			netif: {},
			isFullyStale: false,
			staleInterfaces: new Set<string>(),
			onConfigure: vi.fn(),
		},
	});
}

const rowOf = (view: ReturnType<typeof renderRoster>, id: string) => {
	const row = view.container.querySelector<HTMLElement>(
		`[data-testid="modem-row"][data-modem-id="${id}"]`,
	);
	if (!row) throw new Error(`no row ${id}`);
	return row;
};

const confirmBody = () =>
	document.body.querySelector<HTMLElement>(
		'[data-testid="modem-restart-confirm"]',
	);

describe("Restart modem on the cellular rows", () => {
	it("is offered for a qualified model and not for others", () => {
		const view = renderRoster([
			["0", modem("RM520N-GL", "wwu1i4")],
			["1", modem("EM7455", "wwan1")],
			["2", modem("FM350-GL", "enx1")],
		]);
		expect(
			rowOf(view, "0").querySelector('[data-testid="modem-restart"]'),
		).not.toBeNull();
		expect(rowOf(view, "0").textContent).toContain(
			"Offline for about 55 s while it restarts.",
		);
		expect(
			rowOf(view, "1").querySelector('[data-testid="modem-restart"]'),
		).toBeNull();
		expect(
			rowOf(view, "2").querySelector('[data-testid="modem-restart"]'),
		).toBeNull();
	});

	it("Radio health's no-data step suggests the restart and carries the button once", () => {
		const view = renderRoster([
			[
				"0",
				modem("DW5821e Snapdragon X20 LTE", "wwu1u4c2", {
					radio_health: radio("data-path"),
				}),
			],
			["1", modem("FM350-GL", "enx1", { radio_health: radio("data-path") })],
		]);
		const dell = rowOf(view, "0");
		expect(
			dell.querySelector('[data-testid="radio-health-next"]')?.textContent,
		).toContain("Restart this modem. It’s offline for about 35 s.");
		expect(dell.querySelectorAll('[data-testid="modem-restart"]')).toHaveLength(
			1,
		);
		expect(
			dell.querySelector(
				'[data-testid="radio-health-restart"] [data-testid="modem-restart"]',
			),
		).not.toBeNull();
		const fm = rowOf(view, "1");
		expect(
			fm.querySelector('[data-testid="radio-health-next"]')?.textContent,
		).toContain("Unplug this modem and plug it back in.");
		expect(fm.querySelector('[data-testid="modem-restart"]')).toBeNull();
	});

	it("confirms the cost, restarts, and shows the result above the rows", async () => {
		restart.mockResolvedValue({
			started: true,
			outcome: "back_connected",
			method: "mm-reset",
			elapsedSeconds: 33,
			device: "5",
		});
		const view = renderRoster([
			["4", modem("DW5821e Snapdragon X20 LTE", "wwu1u4c2")],
		]);
		await fireEvent.click(view.getByTestId("modem-restart"));
		expect(restart).not.toHaveBeenCalled();
		await waitFor(() => expect(confirmBody()).not.toBeNull());
		expect(confirmBody()?.textContent).toContain(
			"It drops off for about 35 s while it restarts",
		);
		const primary = [...document.body.querySelectorAll("button")].find(
			(button) => button.textContent?.trim() === "Restart",
		);
		if (!primary) throw new Error("no Restart button in the dialog");
		await fireEvent.click(primary);
		expect(restart).toHaveBeenCalledWith({ device: "4", confirm: true });
		await waitFor(() =>
			expect(view.getByTestId("modem-restart-status").dataset.outcome).toBe(
				"back_connected",
			),
		);
		expect(view.getByTestId("modem-restart-status").textContent).toContain(
			"is back and connected after 33 s.",
		);
	});

	it("while streaming, says the other connections carry on", async () => {
		streaming = true;
		const view = renderRoster([
			["4", modem("DW5821e Snapdragon X20 LTE", "wwu1u4c2")],
		]);
		await fireEvent.click(view.getByTestId("modem-restart"));
		await waitFor(() => expect(confirmBody()).not.toBeNull());
		expect(confirmBody()?.textContent).toContain(
			"Your stream keeps going on your other connections.",
		);
	});

	it("as the only link of a live stream, asks a second time with that cost", async () => {
		streaming = true;
		restart
			.mockResolvedValueOnce({ started: false, refusal: "only_link_live" })
			.mockResolvedValueOnce({
				started: true,
				outcome: "back_connected",
				elapsedSeconds: 34,
			});
		const view = renderRoster([
			["4", modem("DW5821e Snapdragon X20 LTE", "wwu1u4c2")],
		]);
		await fireEvent.click(view.getByTestId("modem-restart"));
		await waitFor(() => expect(confirmBody()).not.toBeNull());
		const first = [...document.body.querySelectorAll("button")].find(
			(b) => b.textContent?.trim() === "Restart",
		);
		if (!first) throw new Error("no Restart button");
		await fireEvent.click(first);
		await waitFor(() => expect(confirmBody()?.dataset.onlyLink).toBe("true"));
		expect(confirmBody()?.textContent).toContain(
			"your stream has no connection for about 35 s",
		);
		const anyway = [...document.body.querySelectorAll("button")].find(
			(b) => b.textContent?.trim() === "Restart anyway",
		);
		if (!anyway) throw new Error("no Restart anyway button");
		await fireEvent.click(anyway);
		expect(restart).toHaveBeenLastCalledWith({
			device: "4",
			confirm: true,
			onlyLinkConfirmed: true,
		});
		await waitFor(() =>
			expect(view.getByTestId("modem-restart-status").dataset.outcome).toBe(
				"back_connected",
			),
		);
	});

	it("names a refusal calmly with its retry time", async () => {
		restart.mockResolvedValue({
			started: false,
			refusal: "cooldown",
			retryAfterSeconds: 140,
		});
		const view = renderRoster([["0", modem("RM520N-GL", "wwu1i4")]]);
		await fireEvent.click(view.getByTestId("modem-restart"));
		await waitFor(() => expect(confirmBody()).not.toBeNull());
		const primary = [...document.body.querySelectorAll("button")].find(
			(b) => b.textContent?.trim() === "Restart",
		);
		if (!primary) throw new Error("no Restart button");
		await fireEvent.click(primary);
		await waitFor(() =>
			expect(view.getByTestId("modem-restart-status").textContent).toContain(
				"This modem restarted a moment ago. Try again in 140 s.",
			),
		);
	});
});
