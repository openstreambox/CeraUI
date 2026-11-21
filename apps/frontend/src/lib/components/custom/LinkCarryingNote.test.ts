// @vitest-environment jsdom
/**
 * "No stream data on this link": a link in the bond whose sender reports show
 * no stream data going out says so. Live's per-link row reads its own
 * `carrying: false`; Network's card reads the feed's per-device
 * `not_carrying_ifaces`. No claim and a stale row show nothing.
 */

import type {
	LinkTelemetryEntry,
	LinkTelemetryMessage,
} from "@ceraui/rpc/schemas";
import { render } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import type { LinkSignal } from "$lib/types/hud";
import BondedLinksSection from "../../../main/network/BondedLinksSection.svelte";

import IngestStats from "./IngestStats.svelte";
import LinkCarryingNote from "./LinkCarryingNote.svelte";

const TEXT = "No stream data on this link";

function entry(
	iface: string,
	extra: Partial<LinkTelemetryEntry> = {},
): LinkTelemetryEntry {
	return {
		conn_id: iface,
		iface,
		rtt_ms: 31,
		nak_count: 0,
		weight_percent: 50,
		stale: false,
		...extra,
	};
}

const feed = (...links: LinkTelemetryEntry[]): LinkTelemetryMessage => ({
	links,
});

function linkFor(id: string, index: number): LinkSignal {
	return {
		id,
		type: id.startsWith("wlan") ? "wifi" : "modem",
		linkIndex: index,
		signal: 60,
		label: id,
		isConnected: true,
		isStale: false,
		throughputKbps: id === "usb0" ? 0 : 4000,
		enabled: true,
		connectionState: "connected",
	};
}

const notes = (root: HTMLElement) =>
	Array.from(
		root.querySelectorAll<HTMLElement>('[data-testid="link-carrying-nothing"]'),
	);

describe("LinkCarryingNote", () => {
	it("speaks only when asked to, as a status line", () => {
		const shown = render(LinkCarryingNote, {
			props: { show: true, iface: "usb0" },
		});
		expect(notes(shown.container).map((n) => n.textContent?.trim())).toEqual([
			TEXT,
		]);
		expect(notes(shown.container)[0]?.getAttribute("role")).toBe("status");
		shown.unmount();
		const hidden = render(LinkCarryingNote, { props: { show: false } });
		expect(notes(hidden.container)).toHaveLength(0);
	});
});

describe("Live: per-link list", () => {
	it("names the link that carries nothing and drops its 'Stable' pill", () => {
		const { container } = render(IngestStats, {
			props: {
				telemetry: feed(
					entry("usb0", { carrying: false }),
					entry("wlan0", { carrying: true }),
					entry("wlan1"),
					entry("eth0", { carrying: false, stale: true }),
				),
			},
		});
		const row = (iface: string) =>
			container.querySelector<HTMLElement>(
				`[data-testid="ingest-row"][data-iface="${iface}"]`,
			) as HTMLElement;
		expect(notes(row("usb0")).map((n) => n.textContent?.trim())).toEqual([
			TEXT,
		]);
		expect(
			row("usb0").querySelector('[data-testid="ingest-health"]'),
		).toBeNull();
		expect(notes(row("wlan0"))).toHaveLength(0);
		expect(
			row("wlan0").querySelector('[data-testid="ingest-health"]'),
		).not.toBeNull();
		// No claim, or a stale row: nothing is said.
		expect(notes(row("wlan1"))).toHaveLength(0);
		expect(notes(row("eth0"))).toHaveLength(0);
	});
});

describe("Network: Bonded Links", () => {
	it("follows the per-device answer, not one of the device's rows", () => {
		const { container } = render(BondedLinksSection, {
			props: {
				links: [linkFor("usb0", 0), linkFor("wlan0", 1)],
				modemEntries: [],
				// usb0's only row is a translator row the card cannot match by
				// name; wlan0 has a row that says false and a sibling that carries.
				linkTelemetry: {
					...feed(
						entry("clat0", { carrying: false }),
						entry("wlan0", { carrying: false, link_id: "a" }),
						entry("wlan0", { carrying: true, link_id: "b" }),
					),
					not_carrying_ifaces: ["usb0"],
				},
			},
		});
		const card = (id: string) =>
			container.querySelector<HTMLElement>(
				`[data-testid="bonded-link-card"][data-link-id="${id}"]`,
			) as HTMLElement;
		expect(notes(card("usb0")).map((n) => n.textContent?.trim())).toEqual([
			TEXT,
		]);
		expect(notes(card("wlan0"))).toHaveLength(0);
	});
});
