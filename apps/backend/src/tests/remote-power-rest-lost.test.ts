import { expect, test } from "bun:test";
import { powerText } from "@ceraui/i18n/formatters";
import { projectRemotePayload } from "../modules/remote/remote-status.ts";

// A bank that stopped answering while it rested (#149) is the warning a remote
// viewer most needs. An unknown phrase withholds the whole Power summary, so
// both reviewed rest-lost sentences belong to the closed vocabulary.
const lost = powerText("restLost", { bank: "A" });
const lostHot = powerText("restLostHot", { bank: "B" });

test("remote sensors keep both rest-lost warnings and their companions", () => {
	for (const summary of [
		lost,
		lostHot,
		`${powerText("bankHot", { bank: "B" })} ${lostHot} ${powerText("peer", { bank: "A" })}`,
		`${lost} ${powerText("feed", {})}`,
	])
		expect(
			projectRemotePayload("sensors", {
				Power: summary,
				"Bank A": "31.0 °C",
				"Power sample": "4242",
			}),
		).toEqual({
			Power: summary,
			"Bank A": "31.0 °C",
			"SoC temperature": "unavailable",
		});
});

test("the rest-lost phrases admit only a bank letter and nothing appended", () => {
	for (const value of [
		lost.replace("Bank A", "Bank secret"),
		`${lost} secret`,
		lostHot.replace("let it cool", "secret"),
		`${lost}X`,
	])
		expect(projectRemotePayload("sensors", { Power: value })).toEqual({
			"SoC temperature": "unavailable",
		});
});
