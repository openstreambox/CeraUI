// @vitest-environment jsdom
/**
 * "Connected, but sending nothing": a link in the bond whose sender reports
 * show no stream data going out (`carrying: false` from the backend) says so,
 * on Live's per-link list and on Network's Bonded Links card. No claim
 * (`carrying` absent) and a stale row show nothing.
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

const TEXT = "Connected, but sending nothing";

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
	it("speaks only for a positive 'carries nothing'", () => {
		for (const [props, shown] of [
			[entry("usb0", { carrying: false }), true],
			[entry("usb0", { carrying: true }), false],
			[entry("usb0"), false],
			[entry("usb0", { carrying: false, stale: true }), false],
			[undefined, false],
		] as const) {
			const { container, unmount } = render(LinkCarryingNote, {
				props: { entry: props },
			});
			expect(notes(container).length, JSON.stringify(props)).toBe(
				shown ? 1 : 0,
			);
			if (shown) {
				expect(notes(container)[0]?.textContent?.trim()).toBe(TEXT);
				expect(notes(container)[0]?.getAttribute("role")).toBe("status");
			}
			unmount();
		}
	});
});

describe("Live: per-link list", () => {
	it("names the link that carries nothing and drops its 'Stable' pill", () => {
		const { container } = render(IngestStats, {
			props: {
				telemetry: feed(
					entry("usb0", { carrying: false }),
					entry("wlan0", { carrying: true }),
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
	});
});

describe("Network: Bonded Links", () => {
	it("puts the line on that link's card only", () => {
		const { container } = render(BondedLinksSection, {
			props: {
				links: [linkFor("usb0", 0), linkFor("wlan0", 1)],
				modemEntries: [],
				linkTelemetry: feed(
					entry("usb0", { carrying: false }),
					entry("wlan0", { carrying: true }),
				),
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
