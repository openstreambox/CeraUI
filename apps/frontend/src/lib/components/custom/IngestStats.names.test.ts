// @vitest-environment jsdom
/**
 * IngestStats names links for people (link-names.ts) and keeps the interface
 * id as a second line. The session summary is bound to what was measured: a
 * link whose name changed during the session (a SIM that registered on another
 * operator) shows every name it had, not the name at viewing time.
 */
import type { LinkTelemetryMessage } from "@ceraui/rpc/schemas";
import { render } from "@testing-library/svelte";
import { afterEach, describe, expect, it } from "vitest";

import IngestStats from "./IngestStats.svelte";

const frame = (rtt: number): LinkTelemetryMessage => ({
	links: [
		{
			conn_id: "0",
			iface: "usb0",
			rtt_ms: rtt,
			nak_count: 0,
			weight_percent: 100,
			stale: false,
		},
	],
});

let operator = "Northwind";
const linkName = (iface: string) =>
	iface === "usb0" ? `SIM 1 · ${operator}` : iface;

describe("IngestStats link names", () => {
	afterEach(() => {
		operator = "Northwind";
	});

	it("leads with the name and keeps the interface id underneath", () => {
		const { container } = render(IngestStats, {
			props: { telemetry: frame(20), isStreaming: true, linkName },
		});
		const row = container.querySelector<HTMLElement>(
			'[data-testid="ingest-row"]',
		);
		expect(row?.querySelector("[data-link-name]")?.textContent?.trim()).toBe(
			"SIM 1 · Northwind",
		);
		expect(row?.textContent).toContain("usb0");
	});

	it("the session summary lists every name a link had, in order", async () => {
		const { container, rerender } = render(IngestStats, {
			props: {
				telemetry: frame(20),
				isStreaming: true,
				bitrateKbps: 4000,
				linkName,
			},
		});
		await rerender({ telemetry: frame(21) });
		operator = "Harbor Cell";
		await rerender({
			telemetry: frame(22),
			linkName: (iface: string) => linkName(iface),
		});
		await rerender({ telemetry: frame(23) });
		await rerender({ isStreaming: false });
		const names = [
			...container.querySelectorAll("[data-session-link-name]"),
		].map((el) => el.textContent?.trim());
		expect(names).toEqual(["SIM 1 · Northwind → SIM 1 · Harbor Cell"]);
	});
});
