import { isIPv4 } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { isSafeIfname } from "../modules/network/safe-ifname.ts";

export interface SourceBoundHttpsPath {
	readonly device: string;
	readonly source: string;
	readonly ifindex?: number;
	readonly signal?: AbortSignal;
}
export type SourceBoundHttpsResult = "ok" | "failed" | "unavailable";
const OPTION = {
	URL: 10002,
	PROXY: 10004,
	NOBODY: 44,
	FOLLOWLOCATION: 52,
	INTERFACE: 10062,
	VERIFY_PEER: 64,
	CAINFO: 10065,
	MAXREDIRS: 68,
	FRESH_CONNECT: 74,
	FORBID_REUSE: 75,
	HEADERFUNCTION: 20079,
	VERIFY_HOST: 81,
	NOSIGNAL: 99,
	IPRESOLVE: 113,
	SOCKOPTFUNCTION: 20148,
	TIMEOUT_MS: 155,
	CONNECTTIMEOUT_MS: 156,
	NOPROXY: 10177,
	PROTOCOLS: 181,
	REDIR_PROTOCOLS: 182,
} as const;
async function loadHttpsLibrary() {
	if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch))
		throw new Error("Bound HTTPS requires 64-bit Linux");
	const ffi = await import("bun:ffi"),
		{ FFIType } = ffi;
	const curl = ffi.dlopen("libcurl.so.4", {
		curl_global_init: { args: [FFIType.i64], returns: FFIType.i32 },
		curl_easy_init: { args: [], returns: FFIType.ptr },
		curl_easy_cleanup: { args: [FFIType.ptr], returns: FFIType.void },
		// All used variadic values are Linux LP64 longs or pointers, passed in GP
		// registers. No double/float option crosses this deliberately narrow ABI.
		curl_easy_setopt: {
			args: [FFIType.ptr, FFIType.i32, FFIType.i64],
			returns: FFIType.i32,
		},
		curl_easy_getinfo: {
			args: [FFIType.ptr, FFIType.i32, FFIType.ptr],
			returns: FFIType.i32,
		},
		curl_multi_init: { args: [], returns: FFIType.ptr },
		curl_multi_add_handle: {
			args: [FFIType.ptr, FFIType.ptr],
			returns: FFIType.i32,
		},
		curl_multi_remove_handle: {
			args: [FFIType.ptr, FFIType.ptr],
			returns: FFIType.i32,
		},
		curl_multi_cleanup: { args: [FFIType.ptr], returns: FFIType.i32 },
		curl_multi_perform: {
			args: [FFIType.ptr, FFIType.ptr],
			returns: FFIType.i32,
		},
		curl_multi_info_read: {
			args: [FFIType.ptr, FFIType.ptr],
			returns: FFIType.ptr,
		},
	});
	const libc = ffi.dlopen("libc.so.6", {
		if_nametoindex: { args: [FFIType.ptr], returns: FFIType.u32 },
		getsockopt: {
			args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr],
			returns: FFIType.i32,
		},
		setsockopt: {
			args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.u32],
			returns: FFIType.i32,
		},
	});
	if (curl.symbols.curl_global_init(3) !== 0)
		throw new Error("HTTPS runtime initialization failed");
	return { ffi, curl, libc };
}
let library: ReturnType<typeof loadHttpsLibrary> | undefined;
export async function sourceBoundHttpsAvailable(): Promise<boolean> {
	try {
		library ??= loadHttpsLibrary();
		await library;
		return true;
	} catch {
		return false;
	}
}

/** Fixed HTTPS HEAD, literal destination, certificate/IP verification, both
 * source bind and SO_BINDTODEVICE. libcurl's nonblocking multi API keeps the
 * event loop responsive. A socket callback works on older supported libcurl;
 * it does not depend on the newer combined-interface command-line syntax.
 */
export async function probeSourceBoundHttps(
	path: SourceBoundHttpsPath,
	trust?: { readonly caFile: string },
): Promise<SourceBoundHttpsResult> {
	if (
		!isSafeIfname(path.device) ||
		!isIPv4(path.source) ||
		(path.ifindex !== undefined &&
			(!Number.isInteger(path.ifindex) ||
				path.ifindex < 1 ||
				path.ifindex > 0x7fffffff))
	)
		throw new Error("Invalid HTTPS source/device identity");
	if (path.signal?.aborted) return "unavailable";
	let loaded: Awaited<ReturnType<typeof loadHttpsLibrary>>;
	try {
		library ??= loadHttpsLibrary();
		loaded = await library;
	} catch {
		return "unavailable";
	}
	const { ffi, curl, libc } = loaded,
		c = curl.symbols;
	const easy = c.curl_easy_init(),
		multi = c.curl_multi_init();
	if (!easy || !multi) {
		if (easy) c.curl_easy_cleanup(easy);
		if (multi) c.curl_multi_cleanup(multi);
		return "unavailable";
	}
	let socket = -1;
	let bindingApplied = false,
		bindingFailed = false,
		headers = 0,
		added = false;
	const keepAlive: Uint8Array[] = [],
		device = Buffer.from(`${path.device}\0`);
	keepAlive.push(device);
	let bind: InstanceType<typeof ffi.JSCallback> | undefined;
	let header: InstanceType<typeof ffi.JSCallback> | undefined;
	try {
		bind = new ffi.JSCallback(
			(_opaque, fd, purpose) => {
				const index = libc.symbols.if_nametoindex(ffi.ptr(device)),
					option = new Uint32Array([index]);
				if (
					!index ||
					(path.ifindex !== undefined && index !== path.ifindex) ||
					purpose !== 0 ||
					path.signal?.aborted ||
					libc.symbols.setsockopt(
						fd,
						1,
						62,
						ffi.ptr(option),
						option.byteLength,
					) !== 0
				) {
					bindingFailed = true;
					return 1;
				}
				socket = fd;
				bindingApplied = true;
				return 0;
			},
			{
				args: [ffi.FFIType.ptr, ffi.FFIType.i32, ffi.FFIType.i32],
				returns: ffi.FFIType.i32,
			},
		);
		header = new ffi.JSCallback(
			(_data, size, count) => {
				const length = Number(size) * Number(count);
				const bound = new Uint8Array(16),
					boundLength = new Uint32Array([16]);
				if (
					socket < 0 ||
					libc.symbols.getsockopt(
						socket,
						1,
						25,
						ffi.ptr(bound),
						ffi.ptr(boundLength),
					) !== 0 ||
					Buffer.from(bound).toString("ascii").split("\0")[0] !== path.device
				) {
					bindingFailed = true;
					return 0;
				}
				if (
					!Number.isSafeInteger(length) ||
					length < 0 ||
					headers + length > 4096 ||
					path.signal?.aborted
				)
					return 0;
				headers += length;
				return length;
			},
			{
				args: [
					ffi.FFIType.ptr,
					ffi.FFIType.u64,
					ffi.FFIType.u64,
					ffi.FFIType.ptr,
				],
				returns: ffi.FFIType.u64,
			},
		);
		const set = (option: number, value: number | bigint) => {
			if (c.curl_easy_setopt(easy, option, BigInt(value)) !== 0)
				throw new Error("HTTPS binding option unavailable");
		};
		const text = (option: number, value: string) => {
			const bytes = Buffer.from(`${value}\0`);
			keepAlive.push(bytes);
			set(option, ffi.ptr(bytes));
		};
		text(OPTION.URL, "https://1.1.1.1/");
		text(OPTION.INTERFACE, path.source);
		text(OPTION.PROXY, "");
		text(OPTION.NOPROXY, "*");
		if (trust) {
			if (!trust.caFile.startsWith("/") || trust.caFile.includes("\0"))
				return "unavailable";
			text(OPTION.CAINFO, trust.caFile);
		}
		for (const [option, value] of [
			[OPTION.NOBODY, 1],
			[OPTION.FOLLOWLOCATION, 0],
			[OPTION.MAXREDIRS, 0],
			[OPTION.PROTOCOLS, 2],
			[OPTION.REDIR_PROTOCOLS, 2],
			[OPTION.VERIFY_PEER, 1],
			[OPTION.VERIFY_HOST, 2],
			[OPTION.IPRESOLVE, 1],
			[OPTION.NOSIGNAL, 1],
			[OPTION.FRESH_CONNECT, 1],
			[OPTION.FORBID_REUSE, 1],
			[OPTION.TIMEOUT_MS, 4000],
			[OPTION.CONNECTTIMEOUT_MS, 2000],
		] as const)
			set(option, value);
		if (!bind.ptr || !header.ptr) return "unavailable";
		set(OPTION.SOCKOPTFUNCTION, bind.ptr);
		set(OPTION.HEADERFUNCTION, header.ptr);
		if (c.curl_multi_add_handle(multi, easy) !== 0) return "unavailable";
		added = true;
		const running = new Int32Array(1),
			queued = new Int32Array(1),
			deadline = performance.now() + 4500;
		while (performance.now() < deadline && !path.signal?.aborted) {
			const status = c.curl_multi_perform(multi, ffi.ptr(running));
			if (status !== 0 && status !== -1) return "failed";
			const message = c.curl_multi_info_read(multi, ffi.ptr(queued));
			if (message) {
				// CURLMsg on the admitted Linux LP64 architectures: enum at 0, easy
				// pointer at 8, result union at 16. Require our own completed handle.
				if (ffi.read.i32(message) !== 1 || ffi.read.ptr(message, 8) !== easy)
					return "unavailable";
				if (bindingFailed || !bindingApplied) return "unavailable";
				const result = ffi.read.i32(message, 16);
				if (result === 45 || result === 77) return "unavailable";
				if (result !== 0) return "failed";
				const code = new BigInt64Array(1),
					local = new BigUint64Array(1);
				if (
					c.curl_easy_getinfo(easy, 0x200002, ffi.ptr(code)) !== 0 ||
					c.curl_easy_getinfo(easy, 0x100029, ffi.ptr(local)) !== 0 ||
					!local[0]
				)
					return "unavailable";
				const address = new ffi.CString(
					Number(local[0]) as typeof easy,
				).toString();
				return address === path.source &&
					Number(code[0]) >= 200 &&
					Number(code[0]) < 400
					? "ok"
					: "failed";
			}
			if (running[0] === 0) return bindingFailed ? "unavailable" : "failed";
			await delay(10);
		}
		return path.signal?.aborted ? "unavailable" : "failed";
	} catch {
		return "unavailable";
	} finally {
		if (added) c.curl_multi_remove_handle(multi, easy);
		c.curl_easy_cleanup(easy);
		c.curl_multi_cleanup(multi);
		bind?.close();
		header?.close();
		keepAlive.length = 0;
	}
}
