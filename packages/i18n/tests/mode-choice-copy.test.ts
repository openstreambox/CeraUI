import { expect, test } from "bun:test";
import { readCatalog } from "./helpers/catalog";

test("Korean confirmation warns about the interrupted connection", () => {
	expect(readCatalog("ko")["network.modem.fiveG.confirmBody"]).toBe(
		"{modem}은(는) 다시 등록하는 동안 몇 초간 연결이 끊깁니다.",
	);
});

test("busy copy covers a mode write on any modem", () => {
	expect(readCatalog("en")["network.modem.fiveG.error.mutation_in_progress"]).toBe(
		"Another modem change is still running. Nothing changed. Try again in a moment.",
	);
});
