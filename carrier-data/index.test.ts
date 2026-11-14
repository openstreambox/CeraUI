import { expect, test } from "bun:test";
import snapshot from "./carriers.json";
import regression from "./fixtures/android14-regressions.json";
import { matchMvnoApn } from "./index.ts";

test("real DEFF candidates cannot shadow each other and retain source order", () => {
	const evidence = { homePlmn: "310410", gid1: "deffffffffffffff" };
	const result = matchMvnoApn(evidence, regression);
	expect(result.ambiguous).toBe(true);
	expect(result.candidates).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				apn: "tfdata",
				carrierId: "2022",
				protocol: "IP",
			}),
			expect.objectContaining({
				apn: "ereseller",
				carrierId: "10000",
				protocol: "IPV4V6",
			}),
		]),
	);
	expect(result.candidates.map((r) => r.apn)).toContain("tfdata");
	expect(result.candidates.map((r) => r.apn)).toContain("ereseller");
	const reversed = matchMvnoApn(evidence, [...regression].reverse());
	expect(reversed.candidates).toEqual([...result.candidates].reverse());
	expect(reversed.ambiguous).toBe(true);
});
test("real rows preserve authentication, proxy and usage metadata", () => {
	const result = matchMvnoApn({ homePlmn: "23410", spn: "giffgaff" });
	expect(result.candidates.length).toBeGreaterThan(0);
	expect(result.candidates.some((r) => r.user === "gg")).toBe(true);
	for (const row of snapshot.filter(
		(r) => r.user || r.password || r.authtype || r.proxy,
	)) {
		const result = matchMvnoApn({
			homePlmn: row.plmn,
			gid1: row.mvno === "gid" ? row.match : undefined,
			spn: row.mvno === "spn" ? row.match : undefined,
		});
		expect(result.candidates).toContainEqual(row);
	}
});
test("Coriolis WEB and proxy-free WAP remain ambiguous; MMS-only is excluded", () => {
	const result = matchMvnoApn({ homePlmn: "20810", gid1: "12" }, regression);
	expect(result.candidates.map((r) => r.apn)).toContain("internetcoriolis");
	expect(result.candidates.map((r) => r.apn)).toContain("fnetcoriolis");
	expect(result.ambiguous).toBe(true);
	expect(result.candidates.map((r) => r.apn)).not.toContain("mmscoriolis");
});
test("unsupported nonempty criteria and invalid evidence never match", () => {
	for (const mvno of ["imsi", "iccid", "unknown", undefined]) {
		expect(
			matchMvnoApn({ homePlmn: "310410", gid1: "DEFF", spn: "Tracfone" }, [
				{
					plmn: "310410",
					apn: "tfdata",
					source: "android",
					mvno,
					match: "DEFF",
					types: ["default"],
				},
			]),
		).toEqual({ candidates: [], ambiguous: false });
	}
	for (const gid1 of ["0xDEFF", "DE FF", "", "ZZ"]) {
		expect(matchMvnoApn({ homePlmn: "310410", gid1 }).candidates).toEqual([]);
	}
	expect(matchMvnoApn({ gid1: "DEFF" }).candidates).toEqual([]);
	expect(matchMvnoApn({ homePlmn: "26201" }).candidates).toEqual([]);
});
test("all GID and SPN matches are returned without precedence or shared mutations", () => {
	const rows = snapshot.filter(
		(r) =>
			r.plmn === "23415" &&
			((r.mvno === "gid" && r.match === "C1") ||
				(r.mvno === "spn" && r.match.toLowerCase() === "lebara")),
	);
	const result = matchMvnoApn({ homePlmn: "23415", gid1: "C1", spn: "Lebara" });
	expect(result.candidates).toEqual(rows);
	expect(result.ambiguous).toBe(rows.length > 1);
	expect(result.candidates[0]).not.toBe(rows[0]);
});
test("real T-Mobile GID and full SPN matching, no invented US Mobile coverage", () => {
	expect(
		matchMvnoApn({ homePlmn: "310260", gid1: "2ac9" }).candidates.some(
			(r) => r.apn === "wholesale",
		),
	).toBe(true);
	expect(
		matchMvnoApn({ homePlmn: "23410", spn: "not giffgaff" }).candidates,
	).toEqual([]);
});
test("snapshot DEFF is updated, Tracfone data is retained, US Mobile is absent", () => {
	expect(matchMvnoApn({ homePlmn: "310410", gid1: "DEFF" })).toMatchObject({
		ambiguous: false,
		candidates: [{ apn: "ereseller" }],
	});
	expect(
		matchMvnoApn(
			{ homePlmn: "310260", gid1: "DEFF" },
			regression,
		).candidates.map((r) => r.apn),
	).toContain("wap.tracfone");
	expect(
		snapshot.some((r) => /us[ -]?mobile/i.test(`${r.name} ${r.match}`)),
	).toBe(false);
});
test("PLMN width and Unicode SPN use real snapshot identities", () => {
	expect(
		matchMvnoApn({ homePlmn: "72201", gid1: "02" }).candidates.length,
	).toBeGreaterThan(0);
	expect(
		matchMvnoApn({ homePlmn: "722010", gid1: "01" }).candidates.length,
	).toBeGreaterThan(0);
	expect(matchMvnoApn({ homePlmn: "72201", gid1: "01" }).candidates).toEqual(
		[],
	);
	expect(
		matchMvnoApn({ homePlmn: "20404", spn: "中国电信" }).candidates.some(
			(r) => r.apn === "ctnet" && r.protocol === "IPV4V6",
		),
	).toBe(true);
});

test("real empty-type MVNO identities include data candidates", () => {
	for (const evidence of [
		{ homePlmn: "23415", gid1: "B3" },
		{ homePlmn: "23415", spn: "SAINSBURY'S" },
		{ homePlmn: "26201", spn: "DEBITEL" },
		{ homePlmn: "26207", spn: "ALICE" },
		{ homePlmn: "23410", spn: "JUMP" },
		{ homePlmn: "20404", spn: "JUMP" },
	])
		expect(matchMvnoApn(evidence).candidates.length).toBeGreaterThan(0);
});
test("Tracfone on T-Mobile keeps its only data APN for both GIDs", () => {
	for (const homePlmn of ["310240", "310260"])
		for (const gid1 of ["DEFF", "DDFF"])
			expect(
				matchMvnoApn({ homePlmn, gid1 }).candidates.map((r) => r.apn),
			).toContain("wap.tracfone");
});

test("WAP-named HTTP gateways remain excluded using real source rows", () => {
	const gateway = {
		plmn: "20801",
		apn: "ofnew.fr",
		name: "Carrefour WAP",
		mvno: "gid",
		match: "33",
		source: "android",
		types: ["default", "supl"],
		proxy: "192.168.10.100",
		port: "8080",
	};
	expect(
		matchMvnoApn({ homePlmn: "20801", gid1: "33" }, [gateway]).candidates,
	).toEqual([]);
});
