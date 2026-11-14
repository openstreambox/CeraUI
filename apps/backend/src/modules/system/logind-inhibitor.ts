import { dlopen, type Pointer, ptr } from "bun:ffi";

// Fixed-signature sd-bus functions avoid a variadic ABI at the FFI boundary.
function loadSystemd() {
	return dlopen("libsystemd.so.0", {
		sd_bus_open_system: { args: ["ptr"], returns: "i32" },
		sd_bus_set_method_call_timeout: { args: ["ptr", "u64"], returns: "i32" },
		sd_bus_message_new_method_call: {
			args: ["ptr", "ptr", "cstring", "cstring", "cstring", "cstring"],
			returns: "i32",
		},
		sd_bus_message_append_basic: {
			args: ["ptr", "i32", "ptr"],
			returns: "i32",
		},
		sd_bus_call: { args: ["ptr", "ptr", "u64", "ptr", "ptr"], returns: "i32" },
		sd_bus_message_read_basic: { args: ["ptr", "i32", "ptr"], returns: "i32" },
		sd_bus_message_unref: { args: ["ptr"], returns: "ptr" },
		sd_bus_flush_close_unref: { args: ["ptr"], returns: "ptr" },
	});
}
let library: ReturnType<typeof loadSystemd> | undefined;
const cstring = (text: string) => Buffer.from(`${text}\0`);
function checked(result: number): void {
	if (result < 0)
		throw new Error(`Shutdown protection unavailable (${result})`);
}

/** Inhibit returns only after logind owns the shutdown block. The reply owns
 * the received FD: unref closes it, including automatically on process death.
 * sd-bus marks received descriptors close-on-exec, so children cannot retain it. */
export function acquireLogindInhibitor(): () => void {
	library ??= loadSystemd();
	const api = library.symbols;
	const bus = new BigUint64Array(1),
		request = new BigUint64Array(1),
		reply = new BigUint64Array(1);
	const address = (value: BigUint64Array) => Number(value[0]) as Pointer;
	let closed = false;
	const close = () => {
		if (closed) return;
		closed = true;
		if (reply[0]) api.sd_bus_message_unref(address(reply));
		if (request[0]) api.sd_bus_message_unref(address(request));
		if (bus[0]) api.sd_bus_flush_close_unref(address(bus));
	};
	try {
		checked(api.sd_bus_open_system(ptr(bus)));
		checked(api.sd_bus_set_method_call_timeout(address(bus), 200_000));
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
			api.sd_bus_call(
				address(bus),
				address(request),
				200_000,
				null,
				ptr(reply),
			),
		);
		const fd = new Int32Array([-1]);
		if (
			api.sd_bus_message_read_basic(address(reply), 104, ptr(fd)) <= 0 ||
			(fd[0] ?? -1) < 0
		)
			throw new Error("Shutdown protection returned no descriptor");
		return close;
	} catch (error) {
		close();
		throw error;
	}
}
