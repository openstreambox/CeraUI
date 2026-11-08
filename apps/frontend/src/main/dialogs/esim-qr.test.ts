// @vitest-environment jsdom
import QRCode from "qrcode";
import { afterEach, expect, it, vi } from "vitest";

import { decodeEsimQrImage } from "./esim-qr";

function imageFor(text: string): {
	data: Uint8ClampedArray;
	width: number;
	height: number;
} {
	const qr = QRCode.create(text);
	const scale = 6;
	const width = (qr.modules.size + 8) * scale;
	const data = new Uint8ClampedArray(width * width * 4).fill(255);
	for (let y = 0; y < qr.modules.size; y++) {
		for (let x = 0; x < qr.modules.size; x++) {
			if (!qr.modules.get(y, x)) continue;
			for (let dy = 0; dy < scale; dy++) {
				for (let dx = 0; dx < scale; dx++) {
					const offset =
						(((y + 4) * scale + dy) * width + (x + 4) * scale + dx) * 4;
					data[offset] = 0;
					data[offset + 1] = 0;
					data[offset + 2] = 0;
				}
			}
		}
	}
	return { data, width, height: width };
}

function mockBitmap(text: string): ReturnType<typeof vi.fn> {
	const pixels = imageFor(text);
	const close = vi.fn();
	vi.stubGlobal(
		"createImageBitmap",
		vi.fn(async () => ({ ...pixels, close })),
	);
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
		drawImage: vi.fn(),
		getImageData: () => pixels,
	} as unknown as CanvasRenderingContext2D);
	return close;
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

it("decodes a synthetic activation QR locally and closes the bitmap", async () => {
	const code = "LPA:1$rsp.example.com$SYNTHETIC-CODE";
	const close = mockBitmap(code);
	expect(
		await decodeEsimQrImage(
			new File(["test"], "code.png", { type: "image/png" }),
		),
	).toBe(code);
	expect(close).toHaveBeenCalledOnce();
});

it("rejects unrelated QR content and still closes the bitmap", async () => {
	const close = mockBitmap("https://example.com");
	await expect(
		decodeEsimQrImage(new File(["test"], "code.png", { type: "image/png" })),
	).rejects.toThrow("activation QR required");
	expect(close).toHaveBeenCalledOnce();
});

it("rejects unsupported images before opening a bitmap", async () => {
	const create = vi.fn();
	vi.stubGlobal("createImageBitmap", create);
	await expect(
		decodeEsimQrImage(
			new File(["test"], "code.svg", { type: "image/svg+xml" }),
		),
	).rejects.toThrow("unsupported image");
	expect(create).not.toHaveBeenCalled();
});
