// @vitest-environment jsdom
import { render, screen } from "@testing-library/svelte";
import { expect, it, vi } from "vitest";
import MainView from "./MainView.svelte";
import { links } from "./network/connected-idle-fixture";

vi.mock("$lib/config", () => ({ siteName: "Demo", liveNavElement: {} }));
const state = vi.hoisted(() => ({ network: false }));
const noop = vi.hoisted(() => async () => ({
	default: (await import("../tests/fixtures/Noop.svelte")).default,
}));
vi.mock("$lib/components/custom/pwa", async () => ({
	PullToRefresh: (await import("../tests/fixtures/Passthrough.svelte")).default,
}));
vi.mock("$lib/components/custom/locale-selector.svelte", noop);
vi.mock("$lib/components/custom/mode-toggle.svelte", noop);
vi.mock("./HudRegion.svelte", noop);
vi.mock("./navigation/MainNav.svelte", noop);
vi.mock("./navigation/MobileNav.svelte", noop);
vi.mock("./navigation/NavigationRenderer.svelte", noop);
vi.mock("./notifications/NotificationsPanel.svelte", noop);
vi.mock("./notifications/PersistentNotices.svelte", noop);
vi.mock("$lib/stores/navigation.svelte", () => ({
	getCurrentNavigation: () => (state.network ? { network: {} } : { live: {} }),
	navigateTo: vi.fn(),
}));
vi.mock("$lib/stores/hud.svelte", () => ({
	getHudState: () => ({ connectedIdleLinks: [links[0]] }),
}));
it.each([false, true])(
	"shows the shared notice only outside Network (network=%s)",
	(network) => {
		state.network = network;
		const view = render(MainView);
		expect(screen.queryAllByTestId("live-connected-idle-notice")).toHaveLength(
			network ? 0 : 1,
		);
		view.unmount();
	},
);
