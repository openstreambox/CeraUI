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
	hi: /(?<!माइक्रो)फ़?ोन|मोबाइल(?!\s*डेटा)/,
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

function copyWhere(locale: Locale, keep: (key: string) => boolean): [string, string][] {
	return Object.entries(readCatalog(locale))
		.filter(([key]) => keep(key))
		.map(([key, value]) => [key, normalize(typeof value === "string" ? value : JSON.stringify(value))]);
}

function homeCopy(locale: Locale): [string, string][] {
	return copyWhere(locale, (key) => key.startsWith("live.phone."));
}

// Copy outside Home that talks about the device the reader holds or the one
// that sends a stream: hotel Wi-Fi sign-in, LAN ingest, cloud pairing, the
// offline page, the hotspot confirmation and the carrying status line. Each
// family must stay non-empty so a rename cannot silently drop it from the check.
const DEVICE_FAMILIES: readonly string[] = [
	"network.portal.",
	"settings.portal.",
	"live.networkIngest.",
	"settings.networkIngest.",
	"settings.dialogs.sources.",
	"settings.pairing.",
	"offline.",
	"hotspotConfirm.",
	"carrying.",
];

// Keys this rewording touched, so renaming one of them fails here instead of
// slipping out of its family unnoticed.
const REWORDED_KEYS: readonly string[] = [
	"network.portal.intro",
	"network.portal.waiting",
	"network.portal.duration",
	"network.portal.closing",
	"network.portal.closed",
	"network.portal.busy_other_phone",
	"network.portal.privacyHint",
	"settings.portal.experimentalDescription",
	"live.networkIngest.infoBody",
	"live.networkIngest.instructions",
	"live.networkIngest.subtitle",
	"settings.networkIngest.desc",
	"settings.networkIngest.explanation",
	"settings.dialogs.sources.description",
	"settings.pairing.scanToPair",
	"offline.unreachableCheckNetwork",
	"hotspotConfirm.bodyKeepsStation",
	"network.hotspot.newPasswordStreaming",
	"carrying.active",
	"carrying.idle",
	"live.phone.checkingBody",
	"live.phone.remoteChecking",
	"live.phone.update-orchestrator-maintenance",
	"live.phone.powerOffCost",
	"live.phone.moblink",
	"live.phone.cellular",
	"live.phone.srt-forward",
	"live.phone.hotspot",
	"live.phone.internetChoice",
	"live.phone.unsure",
	"live.phone.srtChoice",
	"live.phone.small",
];

// Japanese used the word for a mobile phone (携帯電話) for these cellular labels.
const JA_CELLULAR_KEYS: readonly string[] = [
	"network.sharing.policy.cellular",
	"network.sharing.policy.cellularPriority",
	"network.esim.confirm_disable",
];

// English phrasings that promise something about the stream or about other
// paths, which the box cannot know. Home and hotel sign-in describe what the box
// does instead. Like the term lists, this catches wording, not every claim.
const REASSURANCE =
	/\b(?:isn't|is not|not) affected\b|doesn't change (?:your|the) stream|nothing change[sd]? for your stream|stream is unchanged|still works?\b|works with (?:any|every)/i;

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
		["hi", "\u092e\u093e\u0907\u0915\u094d\u0930\u094b\u092b\u093c\u094b\u0928"],
		["hi", "\u092e\u093e\u0907\u0915\u094d\u0930\u094b\u095e\u094b\u0928"],
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

describe("Copy about the reader's or the sender's device", () => {
	for (const locale of ALL_LOCALES) {
		it(`${locale} quotes the hotel sign-in button exactly in the sign-in intro`, () => {
			const catalog = readCatalog(locale);
			const label = normalize(catalog["network.portal.open"] as string);
			const intro = normalize(catalog["network.portal.intro"] as string);
			const pairs = QUOTE_PAIRS.filter(([open, close]) => intro.includes(`${open}${label}${close}`));
			expect(pairs.length).toBe(1);
		});

		it(`${locale} still has every reworded key, free of phone and viewer words`, () => {
			const catalog = readCatalog(locale);
			const missing = REWORDED_KEYS.filter((key) => typeof catalog[key] !== "string");
			expect(missing).toEqual([]);
			const offenders = REWORDED_KEYS.filter((key) => {
				const value = normalize(catalog[key] as string);
				return PHONE_TERMS[locale].test(value) || VIEWER_TERMS[locale].test(value);
			});
			expect(offenders).toEqual([]);
		});

		for (const family of DEVICE_FAMILIES) {
			it(`${locale} ${family}* uses no word for a phone or for viewers`, () => {
				const copy = copyWhere(locale, (key) => key.startsWith(family));
				expect(copy.length).toBeGreaterThan(0);
				const offenders = copy
					.filter(([, value]) => PHONE_TERMS[locale].test(value) || VIEWER_TERMS[locale].test(value))
					.map(([key]) => key);
				expect(offenders).toEqual([]);
			});
		}
	}
});

describe("Japanese cellular labels", () => {
	it("name the cellular connection, not a phone", () => {
		const catalog = readCatalog("ja");
		for (const key of JA_CELLULAR_KEYS) {
			expect(typeof catalog[key]).toBe("string");
			expect(PHONE_TERMS.ja.test(normalize(catalog[key] as string))).toBe(false);
		}
	});
});

describe("English Home and sign-in copy makes no promise about the stream", () => {
	it("flags the phrasings it is meant to catch", () => {
		for (const text of ["Your stream isn't affected.", "Wi-Fi and Ethernet links still work.", "Works with any app"]) {
			expect(REASSURANCE.test(text)).toBe(true);
		}
		expect(REASSURANCE.test("Restarting the box usually fixes it.")).toBe(false);
	});

	it("has none in live.phone.*, network.portal.* or the sign-in setting", () => {
		const offenders = copyWhere(
			"en",
			(key) => key.startsWith("live.phone.") || key.startsWith("network.portal.") || key.startsWith("settings.portal."),
		)
			.filter(([, value]) => REASSURANCE.test(value))
			.map(([key]) => key);
		expect(offenders).toEqual([]);
	});
});
