/**
 * Read-only USB device tree on the status feed.
 *
 * The object is an allowlist. Interface names are not on it: a name such as
 * `wlx` plus twelve hex digits is a MAC, and `net0` / `net1` are only local
 * placeholders. The payload carries the link id the server joined, or null.
 */
import { z } from 'zod';

export const USB_DEVICE_KINDS = ['modem', 'wifi', 'capture', 'hub', 'other'] as const;
export const usbDeviceKindSchema = z.enum(USB_DEVICE_KINDS);

export const USB_LINK_CLASSES = ['usb3', 'usb2', 'full', 'low', 'unknown'] as const;
export const usbLinkClassSchema = z.enum(USB_LINK_CLASSES);

export const USB_PORT_CLASSES = ['usb2', 'usb3'] as const;
export const usbPortClassSchema = z.enum(USB_PORT_CLASSES);

export const USB_PORT_COLOURS = ['blue', 'black'] as const;
export const usbPortColourSchema = z.enum(USB_PORT_COLOURS);

export const USB_PORT_SCOPES = ['socket', 'hub-port', 'built-in', 'root', 'generic'] as const;
export const usbPortScopeSchema = z.enum(USB_PORT_SCOPES);

export const USB_SOCKET_PRESENCE = ['present', 'nothing-detected'] as const;
export const usbSocketPresenceSchema = z.enum(USB_SOCKET_PRESENCE);

export const USB_TREE_STATUSES = ['ok', 'unavailable'] as const;
export const usbTreeStatusSchema = z.enum(USB_TREE_STATUSES);

export const USB_TREE_BOARDS = ['rock-5b-plus', 'generic'] as const;
export const usbTreeBoardSchema = z.enum(USB_TREE_BOARDS);

const HEX4 = /^[0-9a-f]{4}$/;
const LINK_ID = /^[A-Za-z0-9:._-]{1,80}$/;
const CLOCK = /^\d{2}:\d{2}$/;
const SOURCE_NAME = /^[A-Za-z0-9._-]{1,24}$/;

/**
 * Story fields the sysfs reader does not know yet. The development fixture
 * fills them so the page can show the design. A real tree leaves them unset.
 * They stay on the local status feed. Remote status drops the whole tree.
 */
export const USB_DISPLAY_STATES = ['on', 'resting', 'off', 'not-responding', 'unplugged'] as const;
export const usbDisplayStateSchema = z.enum(USB_DISPLAY_STATES);

export const USB_REASON_KEYS = [
	'in-bond',
	'video-source',
	'hub-own-power',
	'dropped',
	'resting-warm',
	'unused-heat',
	'unplugged-wifi',
	'turned-off',
	'bond-hotspot',
	'bond-venue',
	'not-used',
] as const;
export const usbReasonKeySchema = z.enum(USB_REASON_KEYS);

export const USB_GENERATIONS = ['4g', '5g'] as const;
export const usbGenerationSchema = z.enum(USB_GENERATIONS);

export const usbDeviceWireNodeSchema = z
	.object({
		key: z.string().min(1).max(120),
		parentKey: z.string().min(1).max(120).nullable(),
		controller: z.string().min(1).max(40).nullable(),
		portPath: z.string().min(1).max(32).nullable(),
		socketKey: z.string().min(1).max(120),
		speedClass: usbLinkClassSchema,
		portClass: usbPortClassSchema.nullable(),
		colour: usbPortColourSchema.nullable(),
		scope: usbPortScopeSchema,
		label: z.string().min(1).max(40).nullable(),
		name: z.string().min(1).max(80),
		kind: usbDeviceKindSchema,
		product: z.string().min(1).max(80).nullable(),
		vendorId: z.string().regex(HEX4).nullable(),
		productId: z.string().regex(HEX4).nullable(),
		presence: usbSocketPresenceSchema,
		/** The device's own bcdUSB is 3 or higher. The port class is not this. */
		superspeedCapable: z.boolean(),
		linkId: z.string().regex(LINK_ID).nullable(),
		displayState: usbDisplayStateSchema.optional(),
		reasonKey: usbReasonKeySchema.optional(),
		linkSlot: z.number().int().min(1).max(8).optional(),
		generation: usbGenerationSchema.optional(),
		sourceName: z.string().regex(SOURCE_NAME).optional(),
		clock: z.string().regex(CLOCK).optional(),
		minutesAgo: z.number().int().min(0).max(1440).optional(),
		retry: z.number().int().min(1).max(9).optional(),
		retryMax: z.number().int().min(1).max(9).optional(),
		hubPorts: z.number().int().min(1).max(16).optional(),
		since: z.string().regex(CLOCK).optional(),
		drops: z.number().int().min(0).max(99).optional(),
	})
	.strict();
export type UsbDeviceWireNode = z.infer<typeof usbDeviceWireNodeSchema>;

export const USB_EVENT_REASONS = [
	'appeared',
	'left',
	'resting',
	'retry',
	'dropped',
	'turned-off',
	'usb2',
] as const;
export const usbEventSchema = z
	.object({
		seq: z.number().int().positive(),
		at: z.number().int().nonnegative(),
		reason: z.enum(USB_EVENT_REASONS),
		kind: usbDeviceKindSchema,
		socketName: z.string().min(1).max(80),
		/** Shown instead of the local clock, so a fixture does not depend on the timezone. */
		clock: z.string().regex(CLOCK).optional(),
		linkSlot: z.number().int().min(1).max(8).optional(),
		tempC: z.number().int().min(0).max(120).optional(),
		retry: z.number().int().min(1).max(9).optional(),
		generation: usbGenerationSchema.optional(),
	})
	.strict();
export type UsbEventWire = z.infer<typeof usbEventSchema>;
export const usbEventsWireSchema = z.array(usbEventSchema).max(100);

export const deviceCalmSchema = z
	.object({
		resting: z.number().int().nonnegative().max(64),
		off: z.number().int().nonnegative().max(64),
		/** Which kind the single resting line should name. Absent: a generic device. */
		restingKind: z.enum(['wifi', 'modem']).optional(),
		offKind: z.enum(['modem', 'wifi']).optional(),
		offAt: z.string().regex(CLOCK).optional(),
		/** Faults stay off the calm line. The Devices card can still count them. */
		unresponsive: z.number().int().nonnegative().max(64).optional(),
	})
	.strict();
export type DeviceCalm = z.infer<typeof deviceCalmSchema>;

export const usbDevicesWireSchema = z
	.object({
		status: usbTreeStatusSchema,
		board: usbTreeBoardSchema,
		nodes: z.array(usbDeviceWireNodeSchema).max(64),
	})
	.strict();
export type UsbDevicesWire = z.infer<typeof usbDevicesWireSchema>;
