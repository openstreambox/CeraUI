import { describe, expect, it } from "bun:test";
import { ALL_LOCALES, readCatalog } from "./helpers/catalog";

// Home on a box without an encoder runs on phones, tablets, computers and the
// box's own screen, and the carrying check measures client uplink traffic, not
// the device showing the page. So the copy never assumes the sender or the
// reader is a phone. It also only says what the box itself sees and sends,
// never what viewers get. The keys keep their historical `live.phone` prefix.
//
// These lists catch the common words for a phone and for viewers. They are a
// terminology check, not a proof that a string makes no claim beyond what the
// box measures; that still needs a reading of the status and health strings.
type Locale = (typeof ALL_LOCALES)[number];

const PHONE_TERMS: Record<Locale, RegExp> = {
	en: /\b(?:smart|cell|i)?phones?\b/i,
	ar: /هاتف|هواتف|جوال|موبايل/,
	de: /Telefon(?!isch)|Handy|Smartphone|iPhone/i,
	es: /tel[eé]fono|celular|smartphone|(?<!datos )\bm[oó]vil(?:es)?(?![a-zá-ú])/i,
	fr: /t[eé]l[eé]phone(?!r)|smartphone|iphone/i,
	hi: /फ़?ोन|मोबाइल(?!\s*डेटा)/,
	ja: /スマートフォン|スマホ|ケータイ|携帯(?!用)|電話/,
	ko: /휴대폰|핸드폰|스마트폰|전화(?!번호)/,
	"pt-BR": /(?<!(?:modems|modem|rede|dados) )\bcelular(?:es)?\b|telefone|smartphone/i,
	zh: /手机|手機|电话(?!号码)|電話(?!號碼)/,
};

const VIEWER_TERMS: Record<Locale, RegExp> = {
	en: /\bviewers?\b|\baudience\b/i,
	ar: /المشاهدين|المشاهدون|مشاهدين|مشاهدون|الجمهور/,
	de: /Zuschauer|Publikum/i,
	es: /espectador|audiencia/i,
	fr: /spectateur|public\b/i,
	hi: /दर्शक/,
	ja: /視聴者/,
	ko: /시청자/,
	"pt-BR": /espectador|audiência|público/i,
	zh: /观众|觀眾/,
};

// Quote pairs the catalogs use around a quoted UI label.
const QUOTE_PAIRS: [string, string][] = [
	['"', '"'],
	["“", "”"],
	["„", "“"],
	["«", "»"],
	["「", "」"],
];

const normalize = (value: string) => value.normalize("NFC");

function homeCopy(locale: Locale): [string, string][] {
	return Object.entries(readCatalog(locale))
		.filter(([key]) => key.startsWith("live.phone."))
		.map(([key, value]) => [key, normalize(typeof value === "string" ? value : JSON.stringify(value))]);
}

describe("the term lists themselves", () => {
	const hits: [Locale, string][] = [
		["en", "Connect your smartphone"],
		["de", "Dein iPhone"],
		["es", "tu móvil"],
		["pt-BR", "3 celulares no Wi-Fi"],
		["ja", "ケータイで配信"],
		["ko", "핸드폰 연결"],
		["zh", "手機"],
		["ar", "موبايل"],
		["es", "dos móviles"],
		["hi", "\u092b\u093c\u094b\u0928"],
		["hi", "\u095e\u094b\u0928"],
	];
	const misses: [Locale, string][] = [
		["de", "telefonisch erreichbar"],
		["es", "datos móviles"],
		["pt-BR", "modems celulares"],
		["pt-BR", "rede celular"],
		["ja", "携帯用"],
		["ko", "전화번호"],
		["zh", "电话号码"],
		["zh", "電話號碼"],
		["hi", "मोबाइल डेटा"],
	];
	for (const [locale, text] of hits) {
		it(`${locale} flags ${JSON.stringify(text)}`, () => {
			expect(PHONE_TERMS[locale].test(normalize(text))).toBe(true);
		});
	}
	for (const [locale, text] of misses) {
		it(`${locale} leaves ${JSON.stringify(text)} alone`, () => {
			expect(PHONE_TERMS[locale].test(normalize(text))).toBe(false);
		});
	}
	it("Arabic viewer terms do not match the word for viewing", () => {
		expect(VIEWER_TERMS.ar.test("المشاهدة")).toBe(false);
	});
	const viewerHits: [Locale, string][] = [
		["en", "what viewers get"],
		["ar", "ما يصل إلى المشاهدين"],
		["de", "was die Zuschauer bekommen"],
		["es", "lo que reciben los espectadores"],
		["fr", "ce que reçoivent les spectateurs"],
		["hi", "दर्शकों तक"],
		["ja", "視聴者に届いている"],
		["ko", "시청자에게"],
		["pt-BR", "o que os espectadores recebem"],
		["zh", "观众收到的内容"],
	];
	for (const [locale, text] of viewerHits) {
		it(`${locale} viewer terms flag ${JSON.stringify(text)}`, () => {
			expect(VIEWER_TERMS[locale].test(normalize(text))).toBe(true);
		});
	}
});

describe("Home copy on a box without an encoder", () => {
	for (const locale of ALL_LOCALES) {
		it(`${locale} uses no word for a phone`, () => {
			const copy = homeCopy(locale);
			expect(copy.length).toBeGreaterThan(100);
			const offenders = copy.filter(([, value]) => PHONE_TERMS[locale].test(value)).map(([key]) => key);
			expect(offenders).toEqual([]);
		});

		it(`${locale} uses no word for viewers`, () => {
			const offenders = homeCopy(locale)
				.filter(([, value]) => VIEWER_TERMS[locale].test(value))
				.map(([key]) => key);
			expect(offenders).toEqual([]);
		});

		it(`${locale} quotes the carrying title exactly where it says what Home will show`, () => {
			const catalog = readCatalog(locale);
			const title = normalize(catalog["live.phone.active"] as string);
			for (const key of ["live.phone.tryBody", "live.phone.internetTry", "live.phone.srtTry"]) {
				const hint = normalize(catalog[key] as string);
				const pairs = QUOTE_PAIRS.filter(([open, close]) => hint.includes(`${open}${title}${close}`));
				expect(pairs.length).toBe(1);
			}
		});
	}
});
