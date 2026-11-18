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
	})
	.strict();
export type UsbDeviceWireNode = z.infer<typeof usbDeviceWireNodeSchema>;

export const usbDevicesWireSchema = z
	.object({
		status: usbTreeStatusSchema,
		board: usbTreeBoardSchema,
		nodes: z.array(usbDeviceWireNodeSchema).max(64),
	})
	.strict();
export type UsbDevicesWire = z.infer<typeof usbDevicesWireSchema>;
