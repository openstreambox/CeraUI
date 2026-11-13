import { mount } from "svelte";
import PhoneHome from "../../main/PhoneHome.svelte";

/** Browser-only presentation fixture: no production route, RPC or device effects. */
export function mountPhoneHomeFixture(kiosk = false, moblin = false) {
	document.getElementById("app")?.setAttribute("hidden", "");
	const target = document.createElement("main");
	target.dataset.testid = "phone-home-fixture";
	target.style.cssText = "max-width:1100px;margin:20px auto;padding:16px";
	document.body.append(target);
	return mount(PhoneHome, {
		target,
		props: {
			kiosk,
			carrying: "idle",
			moblink: { available: true, configured: false },
			oncredential: async () => ({ success: true }),
			settings: {
				way: moblin ? "moblin" : "srt",
				srt: {
					address: "srt://192.0.2.1:4000",
					passphrase: "example-passphrase",
				},
			},
			wifi: {
				name: "Example;Wifi",
				password: "example-wifi-password",
				clients: 1,
			},
			links: [{ id: "L1", label: "Wi-Fi", internet: "yes" }],
		},
	});
}

export async function decodePhoneQrCodes() {
	const { default: jsQR } = await import("jsqr");
	return [
		...document.querySelectorAll<HTMLImageElement>(
			'[data-testid="phone-home-fixture"] img',
		),
	].map((img) => {
		const canvas = document.createElement("canvas");
		canvas.width = img.naturalWidth;
		canvas.height = img.naturalHeight;
		const ctx = canvas.getContext("2d");
		if (!ctx) throw Error("canvas unavailable");
		ctx.drawImage(img, 0, 0);
		return jsQR(
			ctx.getImageData(0, 0, canvas.width, canvas.height).data,
			canvas.width,
			canvas.height,
		)?.data;
	});
}
