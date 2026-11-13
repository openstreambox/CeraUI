import { describe, expect, test } from "bun:test";
import {
	boundRedactedSupportJournal,
	carrierSupportRows,
	modemTac,
} from "../modules/system/support-export.ts";
import { ceralive, event, exported } from "./support/journal-records.ts";

describe("support export disclosure", () => {
	test("strips RPC correlation ids without erasing the diagnostic event", () => {
		const line = JSON.stringify({
			msg: "RPC system.getLog err",
			meta: { cid: "351756051523999", args: { service: "diagnostic-marker" } },
		});
		const output = exported(ceralive(line), ceralive(`service[42]: ${line}`));
		expect(output).toContain("RPC system.getLog err");
		expect(output).not.toContain("diagnostic-marker");
		expect(output).not.toContain("351756051523999");
	});

	test("caps exported text after redaction, leaving room for the carrier summary", () => {
		const output = boundRedactedSupportJournal(
			`oldest marker\n${(`${"a".repeat(1024)}\n`).repeat(10240)}latest marker`,
		);
		expect(new TextEncoder().encode(output).byteLength).toBeLessThan(
			10 * 1024 * 1024,
		);
		expect(output).toContain("truncated at 9 MiB");
		expect(output).toContain("latest marker");
		expect(output).not.toContain("oldest marker");
	});

	test("keeps APN and TAC only; never serializes subscriber or cell identities", () => {
		const imei = "351756051523999";
		const secrets = [
			imei,
			"8934071100003862105",
			"214075550001234",
			"+34600111222",
			"0xabc123",
		];
		const row = {
			config: { apn: "internet.example", password: "secret-password" },
			tac: modemTac(imei),
			imei,
			iccid: secrets[1],
			imsi: secrets[2],
			phone: secrets[3],
			cell_id: secrets[4],
		};
		const output = JSON.stringify(carrierSupportRows([row]));
		expect(output).toContain("internet.example");
		expect(output).toContain("35175605");
		for (const value of [...secrets, "secret-password"])
			expect(output).not.toContain(value);
	});
	test("malformed IMEI and APN cannot smuggle identifiers or credentials", () => {
		for (const v of ["35175605", "351756051523999x", "3517560515239999", ""])
			expect(modemTac(v)).toBeUndefined();
		expect(
			JSON.stringify(
				carrierSupportRows([
					{ config: { apn: "user:password@example" }, tac: "351756051523999" },
				]),
			),
		).not.toContain("password");
		expect(
			JSON.stringify(
				carrierSupportRows([{ config: { apn: "214075550001234.example" } }]),
			),
		).not.toContain("214075550001234");
	});
	test("raw journal fields, numbers and credential lines are removed before download", () => {
		const output = exported(
			...[
				"boot one",
				"imei=351756051523999",
				"iccid=8934071100003862105",
				"imsi=214075550001234",
				"phone=+34600111222",
				"cell_id=0xabc123",
				"password=example-secret",
				"raw 351756051523999",
				"boot two",
			].map((msg) => event({ msg })),
		);
		expect(output).toContain("boot one");
		expect(output).toContain("boot two");
		for (const v of [
			"351756051523999",
			"8934071100003862105",
			"214075550001234",
			"+34600111222",
			"0xabc123",
			"example-secret",
		])
			expect(output).not.toContain(v);
	});
});
