import { expect, test } from "bun:test";
import { matchMvnoApn } from "./index.ts";

const rows = [
	{
		plmn: "310410",
		apn: "ereseller",
		source: "android",
		mvno: "gid",
		match: "20FF",
	},
	{
		plmn: "310410",
		apn: "ereseller",
		source: "android",
		mvno: "spn",
		match: "US Mobile",
	},
	{
		plmn: "310260",
		apn: "fast.t-mobile.com",
		source: "android",
		mvno: "gid",
		match: "6910",
	},
	{ plmn: "310410", apn: "host", source: "android" },
];
test("GID1 criteria preserve reseller fixtures without guessing from the host", () => {
	expect(matchMvnoApn({ homePlmn: "310410", gid1: "20ff00" }, rows)?.apn).toBe(
		"ereseller",
	);
	expect(matchMvnoApn({ homePlmn: "310260", gid1: "6910" }, rows)?.apn).toBe(
		"fast.t-mobile.com",
	);
	expect(matchMvnoApn({ homePlmn: "310410" }, rows)).toBeUndefined();
	expect(
		matchMvnoApn({ homePlmn: "310410", gid1: "20FE" }, rows),
	).toBeUndefined();
});
test("SPN is a full name match, not a fuzzy brand match", () => {
	expect(
		matchMvnoApn({ homePlmn: "310410", spn: "us mobile" }, rows)?.apn,
	).toBe("ereseller");
	expect(
		matchMvnoApn({ homePlmn: "310410", spn: "not US Mobile" }, rows),
	).toBeUndefined();
	expect(
		matchMvnoApn({ homePlmn: "310410", spn: "usmobile" }, rows),
	).toBeUndefined();
});
test("missing or invalid home identity never matches another network", () => {
	for (const homePlmn of [undefined, "", "--", "99999", "bad"])
		expect(matchMvnoApn({ homePlmn, gid1: "20FF" }, rows)).toBeUndefined();
	expect(
		matchMvnoApn({ homePlmn: "310260", gid1: "20FF" }, rows),
	).toBeUndefined();
});
test("empty, generic and unsupported matching criteria leave NetworkManager unchanged", () => {
	for (const mvno of [undefined, "imsi", "iccid", "unknown", "gid", "spn"])
		expect(
			matchMvnoApn({ homePlmn: "99999", gid1: "AB", spn: "Example" }, [
				{ plmn: "99999", apn: "bad", source: "android", mvno, match: "" },
			]),
		).toBeUndefined();
});
test("the pinned snapshot supplies a real GID match and no generic fallback", () => {
	expect(matchMvnoApn({ homePlmn: "310260", gid1: "2AC9" })).toMatchObject({
		apn: "wholesale",
		mvno: "gid",
		source: "android",
	});
	expect(matchMvnoApn({ homePlmn: "26201" })).toBeUndefined();
});
