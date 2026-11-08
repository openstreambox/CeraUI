import { parseEsimActivationCode } from "@ceraui/rpc/schemas";

/** Decode locally. The image and its metadata never leave the browser. */
export async function decodeEsimQrImage(file: File): Promise<string> {
	if (
		file.size > 10 * 1024 * 1024 ||
		!["image/png", "image/jpeg", "image/webp"].includes(file.type)
	) {
		throw new Error("unsupported image");
	}
	const bitmap = await createImageBitmap(file);
	try {
		if (bitmap.width * bitmap.height > 12_000_000)
			throw new Error("image too large");
		const canvas = document.createElement("canvas");
		canvas.width = bitmap.width;
		canvas.height = bitmap.height;
		const context = canvas.getContext("2d", { willReadFrequently: true });
		if (!context) throw new Error("canvas unavailable");
		context.drawImage(bitmap, 0, 0);
		const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height);
		const { default: jsQR } = await import("jsqr");
		const result = jsQR(pixels.data, pixels.width, pixels.height);
		if (!result || !parseEsimActivationCode(result.data))
			throw new Error("activation QR required");
		return result.data.trim();
	} finally {
		bitmap.close();
	}
}
