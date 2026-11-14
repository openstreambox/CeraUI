// @vitest-environment jsdom

import { m } from "@ceraui/i18n/svelte";
import { fireEvent, render } from "@testing-library/svelte";
import { expect, it } from "vitest";
import LinkPathStatus from "./LinkPathStatus.svelte";

it.each([
	["ipv6", "Native IPv6"],
	["ipv4", "IPv4"],
	["clat", "IPv4 through translation (CLAT)"],
	[
		"receiver-ipv4-only",
		"Unused: receiver address in use is IPv4; translation unavailable",
	],
	["waiting", "Waiting for a compatible path"],
	["no-source", "Waiting for a link address"],
	["incompatible", "Unused: no compatible address"],
	["unknown", "Receiver path unknown"],
	[undefined, "Receiver path unknown"],
] as const)("quiet status %s has opt-in explanation", async (status, line) => {
	const { container, getByText } = render(LinkPathStatus, { status });
	expect(getByText(line)).toBeTruthy();
	expect(container.querySelector('[role="alert"]')).toBeNull();
	const details = container.querySelector("details");
	expect(details?.open).toBe(false);
	expect(container.querySelector("summary")?.className).toContain(
		"min-h-[var(--touch-target-min)]",
	);
	expect(container.querySelector("summary span")?.className).toContain(
		"whitespace-nowrap",
	);
	await fireEvent.click(getByText("Details"));
	expect(details?.open).toBe(true);
	expect(container.querySelector("p")?.textContent).toBe(
		m[`network.path.${status ?? "unknown"}Why`](),
	);
});
it("replaces a path on withdrawal and labels stale data", async () => {
	const { getByText, rerender } = render(LinkPathStatus, { status: "clat" });
	await rerender({ status: "receiver-ipv4-only" });
	expect(
		getByText(
			"Unused: receiver address in use is IPv4; translation unavailable",
		),
	).toBeTruthy();
	await rerender({ status: "ipv6", stale: true });
	expect(getByText("Receiver path is out of date")).toBeTruthy();
});

it("keeps an unreported path unknown when the device disconnects", () => {
	const { getByText } = render(LinkPathStatus, { stale: true });
	expect(getByText("Receiver path unknown")).toBeTruthy();
});
