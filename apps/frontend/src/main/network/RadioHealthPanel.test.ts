// @vitest-environment jsdom

import type { RadioHealth, RadioMetric } from "@ceraui/rpc/schemas";
import { render } from "@testing-library/svelte";
import { describe, expect, test } from "vitest";
import RadioHealthPanel from "./RadioHealthPanel.svelte";

const at = 1_700_000_000_000;
const absent: RadioMetric = {
	value: null,
	source: "ModemManager",
	unit: "dB",
	technology: "unknown",
	capturedAt: 1000,
};
const known = (
	value: number | string,
	unit = "",
	source = "QENG servingcell",
): RadioMetric => ({ value, unit, source, technology: "lte", capturedAt: at });

function radio(overrides: Partial<RadioHealth> = {}): RadioHealth {
	return {
		capturedAt: at,
		registration: absent,
		layer: absent,
		band: absent,
		metrics: { sinr: absent },
		neighbours: [],
		usb: { available: false, events: [] },
		finding: { kind: "unknown", confidence: "unknown", evidence: [] },
		timeline: [],
		...overrides,
	};
}

const registered = {
	registration: known("home", "state", "ModemManager 3GPP"),
	layer: known("LTE + NR (NSA)", "", "QENG servingcell"),
	band: known("LTE B3 + NR n78", "band"),
	metrics: {
		"lte.rsrp": known(-95, "dBm"),
		"nr.rsrp": known(-112, "dBm"),
	},
	usb: { available: true, events: [] },
} satisfies Partial<RadioHealth>;

function show(record: RadioHealth, props: Record<string, unknown> = {}) {
	const view = render(RadioHealthPanel, {
		radio: record,
		id: "1",
		network: "Example",
		...props,
	});
	const panel = view.getByTestId("radio-health");
	return {
		...view,
		panel,
		status: panel.dataset.status,
		chip: view.getByTestId("radio-health-status").textContent?.trim(),
		summary: view.getByTestId("radio-health-summary").textContent?.trim(),
		next: view.queryByTestId("radio-health-next")?.textContent?.trim(),
	};
}

test("unavailable readings and words remain visible without modem action controls", () => {
	const { container, panel, status, chip, summary } = show(radio());
	expect(status).toBe("unchecked");
	expect(chip).toBe("Not checked");
	expect(summary).toBe("Couldn’t check this time.");
	expect(panel.textContent).toContain("Unavailable");
	expect(container.querySelectorAll("button,input,select").length).toBe(0);
	expect(container.textContent).not.toContain("Weak signal");
});

describe("status first", () => {
	test("a registered modem without a finding reads OK with no next step", () => {
		const { status, chip, summary, next } = show(radio(registered));
		expect(status).toBe("ok");
		expect(chip).toBe("OK");
		expect(summary).toBe("No problems found.");
		expect(next).toBeUndefined();
	});

	test("a refused SIM names the network and the next step", () => {
		const { status, chip, summary, next } = show(
			radio({
				finding: {
					kind: "sim-account",
					confidence: "likely",
					evidence: ["home-network-refused-registration"],
				},
			}),
		);
		expect(status).toBe("sim-account");
		expect(chip).toBe("SIM refused");
		expect(summary).toBe("Example refuses this SIM.");
		expect(next).toContain("try the SIM in another modem");
	});

	test("a refused SIM without a carrier name still reads as a sentence", () => {
		const { summary } = show(
			radio({
				finding: { kind: "sim-account", confidence: "likely", evidence: [] },
			}),
			{ network: undefined },
		);
		expect(summary).toBe("The network refuses this SIM.");
	});

	test("a broken data path suggests a restart with its cost", () => {
		const { chip, summary, next } = show(
			radio({
				...registered,
				finding: { kind: "data-path", confidence: "likely", evidence: [] },
			}),
		);
		expect(chip).toBe("No data");
		expect(summary).toBe("Registered, but no data gets through.");
		expect(next).toContain("about a minute");
	});

	test("possible interference names the other modem by its row label", () => {
		const { chip, summary } = show(
			radio({
				...registered,
				finding: {
					kind: "disturbed",
					confidence: "possible",
					neighbour: "2",
					evidence: [],
				},
			}),
			{ modemName: (id: string) => `Slot ${id}` },
		);
		expect(chip).toBe("Possible interference");
		expect(summary).toBe("May be affected while Slot 2 sends.");
	});

	test("no SIM leads, and the readings it cannot have are not listed", () => {
		const { status, chip, queryByTestId } = show(radio(), { noSim: true });
		expect(status).toBe("no-sim");
		expect(chip).toBe("No SIM");
		expect(queryByTestId("radio-health-readings")).toBeNull();
	});

	test("searching and refused registration are not registered, not a SIM verdict", () => {
		const searching = show(
			radio({ registration: known("searching", "state") }),
		);
		expect(searching.status).toBe("not-registered");
		expect(searching.summary).toBe("Searching for a network.");
		searching.unmount();
		const denied = show(radio({ registration: known("denied", "state") }));
		expect(denied.status).toBe("not-registered");
		expect(denied.summary).toContain("The cause is unknown");
		expect(denied.chip).not.toBe("SIM refused");
	});

	test("the status chip carries an icon and a word, not colour alone", () => {
		const { getByTestId } = show(radio(registered));
		const chip = getByTestId("radio-health-status");
		expect(chip.querySelector("svg")).not.toBeNull();
		expect(chip.textContent?.trim()).not.toBe("");
	});
});

describe("compact readings", () => {
	test("signal shows the value, unit and a level word per layer", () => {
		const { getByTestId } = show(radio(registered));
		const signal = getByTestId("radio-health-signal");
		expect(signal.textContent).toContain("-95 dBm");
		expect(signal.textContent).toContain("Fair");
		expect(signal.textContent).toContain("-112 dBm");
		expect(signal.textContent).toContain("Weak");
		expect(signal.querySelectorAll("[data-signal-level]").length).toBe(2);
	});

	test("network type and band are short", () => {
		const { getByTestId } = show(radio(registered));
		expect(getByTestId("radio-health-readings").textContent).toContain(
			"5G NSA · B3 + n78",
		);
	});

	test("others sending lists only modems seen sending", () => {
		const { getByTestId } = show(
			radio({
				...registered,
				neighbours: [
					{
						id: "2",
						band: absent,
						transmitting: "yes",
						source: "tx_bytes",
						capturedAt: at,
					},
					{
						id: "3",
						band: absent,
						transmitting: "unknown",
						source: "tx_bytes",
						capturedAt: at,
					},
				],
			}),
		);
		const readings = getByTestId("radio-health-readings").textContent ?? "";
		expect(readings).toContain("Modem 2");
		expect(readings).not.toContain("Modem 3");
	});
});

test("the details disclosure starts collapsed and keep every raw reading", () => {
	const { getByTestId } = show(
		radio({
			...registered,
			usb: { available: true, events: [{ at, kind: "reset" }] },
			timeline: [
				{
					at,
					finding: { kind: "unknown", confidence: "unknown", evidence: [] },
				},
			],
		}),
	);
	const details = getByTestId("radio-health-sources") as HTMLDetailsElement;
	expect(details.open).toBe(false);
	expect(getByTestId("radio-health-raw").textContent).toContain(
		"QENG servingcell",
	);
	expect(getByTestId("radio-health-raw").textContent).toContain("LTE RSRP");
	expect(getByTestId("radio-health-history").textContent).toContain(
		"USB reset",
	);
});

test("an empty generic slot is dropped once a layer reports that metric", () => {
	const { getByTestId } = show(
		radio({
			...registered,
			metrics: { rsrp: absent, ...registered.metrics },
		}),
	);
	const names = Array.from(
		getByTestId("radio-health-raw").querySelectorAll("dt"),
		(dt) => dt.textContent?.trim(),
	);
	expect(names).toContain("LTE RSRP");
	expect(names).not.toContain("RSRP");
});

test("the raw readings disclosure is labelled Details, not sources", () => {
	const { getByTestId } = show(radio(registered));
	const summary = getByTestId("radio-health-sources").querySelector("summary");
	expect(summary?.textContent?.trim()).toBe("Details");
});

test("the panel is a named region with a screen-reader heading, chip first", () => {
	const { getByRole, getByTestId } = show(radio(registered));
	expect(getByRole("region", { name: "Radio health" })).toBe(
		getByTestId("radio-health"),
	);
	expect(getByRole("heading", { name: "Radio health" }).className).toContain(
		"sr-only",
	);
});
