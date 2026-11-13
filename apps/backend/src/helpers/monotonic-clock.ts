import { dlopen, FFIType, ptr } from "bun:ffi";

// glibc 64-bit timespec, shared with the telemetry writer. Keep the handle alive.
let libc: ReturnType<typeof openClock> | undefined;
function openClock() {
	return dlopen("libc.so.6", {
		clock_gettime: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
	});
}
export function monotonicMs(): number {
	if (process.platform !== "linux")
		throw new Error("CLOCK_MONOTONIC unavailable");
	libc ??= openClock();
	const ts = new BigInt64Array(2);
	if (libc.symbols.clock_gettime(1, ptr(ts)) !== 0)
		throw new Error("clock_gettime");
	const [seconds = 0n, nanos = 0n] = ts;
	return Number(seconds * 1000n + nanos / 1_000_000n);
}
