import { describe, expect, it } from "vitest";

import { helperActionButtons, helperActionNote } from "./devices-actions";

const row = { kind: "modem" as const, helperTypec: true };

describe("helper action buttons", () => {
	it("hides both actions when the units are absent", () => {
		expect(
			helperActionButtons(
				{ retryPort: false, rearmExhausted: false, usb2: false },
				row,
			),
		).toEqual({ retry: false, exhausted: false, usb2: false });
	});

	it("hides everything when there is no local offer", () => {
		expect(helperActionButtons(null, row)).toEqual({
			retry: false,
			exhausted: false,
			usb2: false,
		});
	});

	it("shows the spent budget instead of a retry button", () => {
		expect(
			helperActionButtons(
				{ retryPort: false, rearmExhausted: true, usb2: false },
				{ kind: "other", helperTypec: true },
			),
		).toEqual({ retry: false, exhausted: true, usb2: false });
	});

	it("offers USB 2 only on a modem row", () => {
		const offer = { retryPort: false, rearmExhausted: false, usb2: true };
		expect(
			helperActionButtons(offer, { kind: "wifi", helperTypec: false }).usb2,
		).toBe(false);
		expect(helperActionButtons(offer, row).usb2).toBe(true);
	});

	it("does not treat confirmation as a way past a stream", () => {
		expect(helperActionNote(false, "streaming_active")).toBe("streaming");
		expect(helperActionNote(false, "budget_exhausted")).toBe("exhausted");
		expect(helperActionNote(false, "cooldown")).toBe("busy");
	});
});
