import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { esimErrorSchema } from "@ceraui/rpc/schemas";
import { expect, it } from "vitest";

it("every typed eSIM refusal has operator copy in every locale", () => {
	for (const locale of [
		"en",
		"es",
		"de",
		"fr",
		"ar",
		"hi",
		"ja",
		"ko",
		"pt-BR",
		"zh",
	]) {
		const path = fileURLToPath(
			new URL(
				`../../../../../packages/i18n/messages/${locale}.json`,
				import.meta.url,
			),
		);
		const catalog = JSON.parse(readFileSync(path, "utf8")) as Record<
			string,
			unknown
		>;
		for (const error of esimErrorSchema.options) {
			expect(
				catalog[`network.esim.errors.${error}`],
				`${locale}/${error}`,
			).toBeTypeOf("string");
		}
	}
});
