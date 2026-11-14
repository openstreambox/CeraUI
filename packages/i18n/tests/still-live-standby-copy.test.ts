import { expect, test } from "bun:test";

const recoveryCopy = {
	en: "It resumes automatically when a camera feed returns.",
	es: "Se reanuda automáticamente cuando vuelve la señal de una cámara.",
	ar: "يُستأنف البث تلقائيًا عند عودة إشارة إحدى الكاميرات.",
	de: "Die Übertragung wird automatisch fortgesetzt, sobald ein Kamerasignal zurückkehrt.",
	fr: "La diffusion reprend automatiquement dès que le signal d’une caméra revient.",
	hi: "किसी कैमरे का फ़ीड वापस आने पर प्रसारण अपने आप फिर शुरू हो जाता है।",
	ja: "カメラ映像が戻ると自動的に再開します。",
	ko: "카메라 영상이 돌아오면 자동으로 재개됩니다.",
	"pt-BR":
		"A transmissão é retomada automaticamente quando o sinal de uma câmera volta.",
	zh: "摄像头画面恢复后，直播会自动继续。",
};

for (const [locale, recovery] of Object.entries(recoveryCopy)) {
	test(`${locale}: standby explains automatic camera recovery`, async () => {
		const catalog = await Bun.file(
			new URL(`../messages/${locale}.json`, import.meta.url),
		).json();
		expect(catalog["notifications.stillLiveStandby"]).toContain(recovery);
	});
}
