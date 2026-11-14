import { dlopen, JSCallback, type Pointer, ptr } from "bun:ffi";

// Fixed-signature sd-bus functions avoid a variadic ABI at the FFI boundary.
function loadSystemd() {
	return dlopen("libsystemd.so.0", {
		sd_bus_new: { args: ["ptr"], returns: "i32" },
		sd_bus_set_address: { args: ["ptr", "cstring"], returns: "i32" },
		sd_bus_set_bus_client: { args: ["ptr", "i32"], returns: "i32" },
		sd_bus_start: { args: ["ptr"], returns: "i32" },
		sd_bus_process: { args: ["ptr", "ptr"], returns: "i32" },
		sd_bus_call_async: {
			args: ["ptr", "ptr", "ptr", "ptr", "ptr", "u64"],
			returns: "i32",
		},
		sd_bus_slot_unref: { args: ["ptr"], returns: "ptr" },
		sd_bus_message_ref: { args: ["ptr"], returns: "ptr" },
		sd_bus_message_is_method_error: { args: ["ptr", "ptr"], returns: "i32" },
		sd_bus_set_method_call_timeout: { args: ["ptr", "u64"], returns: "i32" },
		sd_bus_message_new_method_call: {
			args: ["ptr", "ptr", "cstring", "cstring", "cstring", "cstring"],
			returns: "i32",
		},
		sd_bus_message_append_basic: {
			args: ["ptr", "i32", "ptr"],
			returns: "i32",
		},
		sd_bus_message_read_basic: { args: ["ptr", "i32", "ptr"], returns: "i32" },
		sd_bus_message_unref: { args: ["ptr"], returns: "ptr" },
		sd_bus_close_unref: { args: ["ptr"], returns: "ptr" },
	});
}
let library: ReturnType<typeof loadSystemd> | undefined;
const cstring = (text: string) => Buffer.from(`${text}\0`);
function checked(result: number): void {
	if (result < 0)
		throw new Error(`Shutdown protection unavailable (${result})`);
}

/** Nonblocking sd-bus exchange. The deadline starts before connect/auth/Hello,
 * not just Inhibit. Never flush or wait synchronously on the control loop.
 * The reply owns a close-on-exec descriptor; exit/crash releases it in-kernel. */
export async function acquireLogindInhibitor(): Promise<() => void> {
	const deadline = performance.now() + 200;
	const busAddress =
		process.env.DBUS_SYSTEM_BUS_ADDRESS ??
		"unix:path=/run/dbus/system_bus_socket";
	// Only local Unix transports are valid for logind. Other sd-bus transports
	// can invoke synchronous DNS or helper programs while starting a connection.
	if (!busAddress.startsWith("unix:") || busAddress.includes(";"))
		throw Error("Shutdown protection requires a local Unix bus");
	library ??= loadSystemd();
	const api = library.symbols;
	const bus = new BigUint64Array(1),
		request = new BigUint64Array(1),
		slot = new BigUint64Array(1);
	const address = (value: BigUint64Array) => Number(value[0]) as Pointer;
	let reply: Pointer | null = null;
	let closed = false;
	const close = () => {
		if (closed) return;
		closed = true;
		if (reply) api.sd_bus_message_unref(reply);
		if (request[0]) api.sd_bus_message_unref(address(request));
		if (bus[0]) api.sd_bus_close_unref(address(bus));
	};
	let failure: Error | undefined;
	let complete = false;
	const callback = new JSCallback(
		(message: Pointer) => {
			// Retain the reply beyond the callback: it owns the received descriptor.
			const retained = api.sd_bus_message_ref(message);
			reply = retained ? (Number(retained) as Pointer) : null;
			complete = true;
			return 1;
		},
		{ args: ["ptr", "ptr", "ptr"], returns: "i32" },
	);
	try {
		checked(api.sd_bus_new(ptr(bus)));
		checked(api.sd_bus_set_address(address(bus), cstring(busAddress)));
		checked(api.sd_bus_set_bus_client(address(bus), 1));
		checked(api.sd_bus_set_method_call_timeout(address(bus), 200_000));
		checked(api.sd_bus_start(address(bus)));
		checked(
			api.sd_bus_message_new_method_call(
				address(bus),
				ptr(request),
				cstring("org.freedesktop.login1"),
				cstring("/org/freedesktop/login1"),
				cstring("org.freedesktop.login1.Manager"),
				cstring("Inhibit"),
			),
		);
		for (const text of [
			"shutdown",
			"CeraUI",
			"Streaming or carrying client traffic",
			"block",
		])
			checked(
				api.sd_bus_message_append_basic(
					address(request),
					115,
					ptr(cstring(text)),
				),
			);
		checked(
			api.sd_bus_call_async(
				address(bus),
				ptr(slot),
				address(request),
				callback.ptr,
				null,
				200_000,
			),
		);
		while (!complete) {
			if (performance.now() >= deadline)
				throw Error("Shutdown protection acquisition timed out");
			// Bound work per turn even when the bus has a continuous stream of messages.
			for (let i = 0; i < 16 && !complete; i++) {
				const processed = api.sd_bus_process(address(bus), null);
				checked(processed);
				if (processed === 0) break;
			}
			if (!complete) await Bun.sleep(5);
		}
		if (performance.now() >= deadline)
			throw Error("Shutdown protection acquisition timed out");
		if (!reply || api.sd_bus_message_is_method_error(reply, null) > 0)
			failure = Error("Shutdown protection unavailable");
		const fd = new Int32Array([-1]);
		if (
			failure ||
			!reply ||
			api.sd_bus_message_read_basic(reply, 104, ptr(fd)) <= 0 ||
			(fd[0] ?? -1) < 0
		)
			throw failure ?? Error("Shutdown protection returned no descriptor");
		return close;
	} catch (error) {
		close();
		throw error;
	} finally {
		if (slot[0]) api.sd_bus_slot_unref(address(slot));
		callback.close();
	}
}
