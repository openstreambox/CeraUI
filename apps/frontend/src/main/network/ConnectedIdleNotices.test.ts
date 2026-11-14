// @vitest-environment jsdom
import { render, screen } from "@testing-library/svelte";
import { expect, it } from "vitest";
import ConnectedIdleNotices from "./ConnectedIdleNotices.svelte";
import { links } from "./connected-idle-fixture";

it("shows the shared observations immediately after navigating to Live", () => {
	const view = render(ConnectedIdleNotices, { links: [links[0]!] });
	expect(
		screen.getByTestId("live-connected-idle-notice").textContent,
	).toContain("SIM 2");
	view.unmount();
	render(ConnectedIdleNotices, { links: [links[0]!] });
	expect(
		screen.getByTestId("live-connected-idle-notice").textContent,
	).toContain("still live on other links");
});
