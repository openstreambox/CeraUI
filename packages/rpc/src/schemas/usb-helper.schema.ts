/**
 * Helper-only read of J11, the Type-C rebind marker, and the RM520 USB 2 hold.
 *
 * Local status only. Remote frames drop the whole object. The fields are an
 * allowlist: a role, a partner yes/no, VBUS on/off, a marker token, a re-arm
 * count, a stored "20", and a hold outcome. No raw log line, no modem identity.
 */
import { z } from 'zod';

export const USB_HELPER_POWER_ROLES = ['source', 'sink', 'dual', 'unknown'] as const;
export const USB_HELPER_DATA_ROLES = ['host', 'device', 'dual', 'unknown'] as const;
export const USB_HELPER_VBUS = ['on', 'off', 'unknown'] as const;

export const USB_HELPER_REPROBE_OUTCOMES = [
	'recovered',
	'no-partner',
	'skipped',
	'failed-unbind',
	'failed-bind',
	'attempted',
	'port-missing',
] as const;

/** Phases written by the RM520 USB 2 oneshot. Anything else is dropped. */
export const USB_HELPER_HOLD_OUTCOMES = [
	'no-modemmanager',
	'other-model',
	'unit-handled',
	'gave-up',
	'no-at-port',
	'attempting',
	'inhibit-failed',
	'port-busy',
	'port-failed',
	'read-failed',
	'writing',
	'write-failed',
	'stored-no-reset',
	'reset-sent',
	'reset-refused',
	'not-reset',
	'verified',
	'failed',
	'not-back',
	'returned-ambiguous',
	'unattributed',
] as const;

/**
 * These phases are written only after the stored speed is already "20",
 * or after that write was read back. The original value stays off the wire.
 */
export const USB_HELPER_STORED_PHASES = [
	'stored-no-reset',
	'reset-sent',
	'reset-refused',
	'verified',
	'failed',
	'not-reset',
	'not-back',
	'returned-ambiguous',
	'unattributed',
] as const;

export const usbHelperTypecSchema = z
	.object({
		powerRole: z.enum(USB_HELPER_POWER_ROLES),
		dataRole: z.enum(USB_HELPER_DATA_ROLES),
		partner: z.boolean(),
		vbus: z.enum(USB_HELPER_VBUS),
	})
	.strict();
export type UsbHelperTypec = z.infer<typeof usbHelperTypecSchema>;

export const usbHelperReprobeSchema = z
	.object({
		outcome: z.enum(USB_HELPER_REPROBE_OUTCOMES),
		rearm: z.union([z.literal(1), z.literal(2), z.literal(3)]).nullable(),
	})
	.strict();
export type UsbHelperReprobe = z.infer<typeof usbHelperReprobeSchema>;

export const usbHelperHoldSchema = z
	.object({
		key: z.string().min(1).max(120).nullable(),
		stored: z.literal('20').nullable(),
		outcome: z.enum(USB_HELPER_HOLD_OUTCOMES),
	})
	.strict();
export type UsbHelperHold = z.infer<typeof usbHelperHoldSchema>;

export const usbHelperSchema = z
	.object({
		typec: usbHelperTypecSchema.nullable(),
		reprobe: usbHelperReprobeSchema.nullable(),
		holds: z.array(usbHelperHoldSchema).max(8),
	})
	.strict();
export type UsbHelperWire = z.infer<typeof usbHelperSchema>;
