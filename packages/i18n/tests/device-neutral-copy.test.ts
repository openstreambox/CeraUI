import { describe, expect, it } from "bun:test";
import { ALL_LOCALES, readCatalog } from "./helpers/catalog";

// Home on a box without an encoder runs on phones, tablets, computers and the
// box's own screen, and the carrying check measures client uplink traffic, not
// the device showing the page. So the copy never assumes the sender or the
// reader is a phone. It also only says what the box itself sees and sends,
// never what viewers get. The keys keep their historical `live.phone` prefix.
const DEVICE_WORDS: Record<string, RegExp> = {
	en: /\bphones?\b/i,
	ar: /هاتف|هواتف|جوال/,
	de: /Telefon|Handy|Smartphone/i,
	es: /tel[eé]fono|m[oó]vil|celular/i,
	fr: /t[eé]l[eé]phone|smartphone/i,
	hi: /फ़ोन|फोन|मोबाइल/,
	ja: /スマートフォン|スマホ|携帯|電話/,
	ko: /휴대폰|스마트폰|전화/,
	"pt-BR": /\bcelular\b|telefone|smartphone/i,
	zh: /手机|电话/,
};

const VIEWER_WORDS: Record<string, RegExp> = {
	en: /\bviewers?\b|\baudience\b/i,
	ar: /المشاهد|مشاهدين/,
	de: /Zuschauer/i,
	es: /espectador/i,
	fr: /spectateur/i,
	hi: /दर्शक/,
	ja: /視聴者/,
	ko: /시청자/,
	"pt-BR": /espectador/i,
	zh: /观众/,
};

function homeCopy(locale: (typeof ALL_LOCALES)[number]): [string, string][] {
	return Object.entries(readCatalog(locale))
		.filter(([key]) => key.startsWith("live.phone."))
		.map(([key, value]) => [key, typeof value === "string" ? value : JSON.stringify(value)]);
}

describe("Home copy on a box without an encoder", () => {
	for (const locale of ALL_LOCALES) {
		it(`${locale} names no device type`, () => {
			const copy = homeCopy(locale);
			expect(copy.length).toBeGreaterThan(100);
			const offenders = copy.filter(([, value]) => DEVICE_WORDS[locale].test(value)).map(([key]) => key);
			expect(offenders).toEqual([]);
		});

		it(`${locale} makes no claim about viewers`, () => {
			const offenders = homeCopy(locale)
				.filter(([, value]) => VIEWER_WORDS[locale].test(value))
				.map(([key]) => key);
			expect(offenders).toEqual([]);
		});

		it(`${locale} quotes the carrying title exactly where it tells the reader what Home will say`, () => {
			const catalog = readCatalog(locale);
			const title = catalog["live.phone.active"] as string;
			for (const key of ["live.phone.tryBody", "live.phone.internetTry", "live.phone.srtTry"]) {
				expect(catalog[key] as string).toContain(title);
			}
		});
	}
});
