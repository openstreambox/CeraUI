import snapshot from "./carriers.json";

export interface MvnoEvidence {
	readonly homePlmn?: string | undefined;
	readonly spn?: string | undefined;
	readonly gid1?: string | undefined;
}
export interface ApnEntry {
	readonly plmn: string;
	readonly apn: string;
	readonly source: string;
	readonly origin?: string;
	readonly name?: string;
	readonly mvno?: string;
	readonly match?: string;
	readonly protocol?: string;
	readonly roamingProtocol?: string;
}

/** Android GID1 prefix or case-insensitive full SPN match; never a host fallback. */
export function matchMvnoApn(
	evidence: MvnoEvidence,
	rows: readonly ApnEntry[] = snapshot,
): ApnEntry | undefined {
	const home = evidence.homePlmn?.trim();
	if (!home || !/^\d{5,6}$/.test(home)) return undefined;
	return rows.find((row) => {
		if (row.plmn !== home || !row.match) return false;
		if (row.mvno === "gid")
			return (
				!!evidence.gid1?.trim() &&
				evidence.gid1.trim().toUpperCase().startsWith(row.match.toUpperCase())
			);
		if (row.mvno === "spn")
			return (
				!!evidence.spn?.trim() &&
				evidence.spn.trim().toLowerCase() === row.match.toLowerCase()
			);
		return false;
	});
}
