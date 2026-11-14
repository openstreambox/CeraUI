// Synthetic journal records shaped like `journalctl --output=json`, carrying the
// trusted fields journald sets from the sending process. Every value is neutral.
import { renderSupportJournal } from "../../modules/system/support-journal.ts";

export type JournalRecord = Record<string, unknown>;

function record(fields: JournalRecord, message: string): JournalRecord {
	return {
		__REALTIME_TIMESTAMP: "1731528245123400",
		_BOOT_ID: "synthetic-boot-a",
		...fields,
		MESSAGE: message,
	};
}

export const ceralive = (message: string): JournalRecord =>
	record(
		{
			_SYSTEMD_UNIT: "ceralive.service",
			_COMM: "ceralive",
			SYSLOG_IDENTIFIER: "ceralive",
			_TRANSPORT: "stdout",
			_PID: "1234",
			_STREAM_ID: "stream-ceralive",
		},
		message,
	);

/** A structured backend event, as the logger writes it to stdout. */
export const event = (entry: Record<string, unknown>): JournalRecord =>
	ceralive(JSON.stringify(entry));

export const modemManager = (message: string): JournalRecord =>
	record(
		{
			_SYSTEMD_UNIT: "ModemManager.service",
			_COMM: "ModemManager",
			SYSLOG_IDENTIFIER: "ModemManager",
			_TRANSPORT: "syslog",
			_PID: "589",
		},
		message,
	);

export const networkManager = (message: string): JournalRecord =>
	record(
		{
			_SYSTEMD_UNIT: "NetworkManager.service",
			_COMM: "NetworkManager",
			SYSLOG_IDENTIFIER: "NetworkManager",
			_TRANSPORT: "syslog",
			_PID: "612",
		},
		message,
	);

export const wpaSupplicant = (message: string): JournalRecord =>
	record(
		{
			_SYSTEMD_UNIT: "wpa_supplicant.service",
			_COMM: "wpa_supplicant",
			SYSLOG_IDENTIFIER: "wpa_supplicant",
			_TRANSPORT: "syslog",
			_PID: "700",
		},
		message,
	);

export const hostapd = (message: string): JournalRecord =>
	record(
		{
			_SYSTEMD_UNIT: "hostapd.service",
			_COMM: "hostapd",
			SYSLOG_IDENTIFIER: "hostapd",
			_TRANSPORT: "syslog",
			_PID: "800",
		},
		message,
	);

export const kernel = (message: string): JournalRecord =>
	record({ _TRANSPORT: "kernel", SYSLOG_IDENTIFIER: "kernel" }, message);

export const systemd = (message: string): JournalRecord =>
	record(
		{
			_SYSTEMD_UNIT: "init.scope",
			_COMM: "systemd",
			SYSLOG_IDENTIFIER: "systemd",
			_TRANSPORT: "journal",
			_PID: "1",
		},
		message,
	);

/** A process running inside an admitted unit under its own command name. */
export const child = (
	unit: string,
	comm: string,
	identifier: string,
	message: string,
): JournalRecord =>
	record(
		{
			_SYSTEMD_UNIT: unit,
			_COMM: comm,
			SYSLOG_IDENTIFIER: identifier,
			_TRANSPORT: "syslog",
			_PID: "2001",
		},
		message,
	);

export const journal = (...records: JournalRecord[]): string =>
	records.map((entry) => JSON.stringify(entry)).join("\n");

/** Exactly what the production download renders for these records. */
export const exported = (...records: JournalRecord[]): string =>
	renderSupportJournal(journal(...records));
