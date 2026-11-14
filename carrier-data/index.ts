import snapshot from "./carriers.json";

export interface MvnoEvidence {
	readonly homePlmn?: string | undefined;
	readonly spn?: string | undefined;
	/** Hex-encoded SIM bytes, without spaces or a 0x prefix. */
	readonly gid1?: string | undefined;
}
export interface ApnEntry {
	readonly plmn: string;
	readonly apn: string;
	readonly source: string;
	readonly origin?: string;
	readonly name?: string;
	readonly mvno?: string | undefined;
	readonly match?: string;
	readonly protocol?: string;
	readonly roamingProtocol?: string;
	readonly types?: readonly string[];
	readonly usage?: string;
	readonly user?: string;
	readonly password?: string;
	readonly authtype?: string;
	readonly proxy?: string;
	readonly port?: string;
	readonly carrierId?: string;
	readonly mtu?: string;
}
export interface ApnMatch {
	readonly candidates: readonly ApnEntry[];
	/** Multiple matching rows, even when they share an APN. Never a selection. */
	readonly ambiguous: boolean;
}

/** Return every eligible GID/SPN candidate in source order; never choose one. */
export function matchMvnoApn(
	evidence: MvnoEvidence,
	rows: readonly ApnEntry[] = snapshot,
): ApnMatch {
	const home = evidence.homePlmn;
	const gid = evidence.gid1;
	const candidates =
		!home || !/^\d{5,6}$/.test(home)
			? []
			: rows
					.filter((row) => {
						if (
							row.plmn !== home ||
							!row.match ||
							row.match !== row.match.trim() ||
							[...row.match].some(
								(c) =>
									c.charCodeAt(0) < 32 ||
									(c.charCodeAt(0) >= 127 && c.charCodeAt(0) <= 159),
							)
						)
							return false;
						if (
							!row.types?.some((t) => t === "default" || t === "*") ||
							(!!row.proxy && /wap/i.test(`${row.name ?? ""} ${row.apn}`))
						)
							return false;
						if (row.mvno === "gid")
							return (
								!!gid &&
								/^[0-9a-f]+$/i.test(gid) &&
								/^[0-9a-f]+$/i.test(row.match) &&
								gid.toUpperCase().startsWith(row.match.toUpperCase())
							);
						if (row.mvno === "spn")
							return (
								!!evidence.spn?.trim() &&
								evidence.spn.trim().toLowerCase() === row.match.toLowerCase()
							);
						return false;
					})
					.map((row) => ({
						...row,
						...(row.types ? { types: [...row.types] } : {}),
					}));
	return { candidates, ambiguous: candidates.length > 1 };
}
