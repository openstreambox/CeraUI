import { expect, test } from "bun:test";
import type { CellularDataGrant } from "./cellular-grant.ts";
import type { CellularPathSession } from "./cellular-path-owner.ts";
import { CellularRuntimeSession } from "./cellular-runtime-session.ts";

function fixture(translated = true) {
	const events: string[] = [];
	let current = true,
		clean = true,
		released = true,
		failInstall = false,
		failBootstrap = false,
		prefix: string | undefined = "64:ff9b::/96",
		dnsPrefix: string | undefined = prefix,
		index = 23;
	let consumer: () => Promise<boolean> = async () => false;
	let https: (signal: AbortSignal) => Promise<"ok"> = async () => "ok";
	const grant: CellularDataGrant = {
		family: "ipv6",
		source: "2001:db8:1::2",
		gateway: "fe80::1",
		prefixLength: 64,
		physical: {
			ifname: "wwan0",
			ifindex: "17",
			usbDevice: "synthetic-usb",
			netDevice: "synthetic-net",
			generation: "usb-one",
		},
		mtu: 1428,
		dns: ["2001:db8::53"],
		generation: "one",
	};
	const selected: CellularDataGrant = translated
		? grant
		: { ...grant, family: "ipv4", source: "192.0.2.2", dns: ["192.0.2.53"] };
	const host: CellularPathSession & { install(): Promise<void> } = {
		binding: {
			source: translated ? "198.18.255.1" : "192.0.2.2",
			device: translated ? "cclat1" : "wwan0",
			generation: "session-one",
			translated,
		},
		dns: { source: selected.source, device: "wwan0", dns: selected.dns },
		install: async () => {
			events.push("host-install");
			if (failInstall) throw new Error("uncertain host reply");
		},
		valid: async () => current && !failInstall,
		prepareProbe: async () => {
			events.push("probe-fence");
			return true;
		},
		setReady: async (ready) => {
			events.push(`fence-${ready}`);
			return true;
		},
		cancelProbe: () => {},
		cleanup: async () => {
			events.push("host-deny");
			if (!clean || !(await consumer())) return false;
			events.push("host-remove");
			return true;
		},
	};
	const session = new CellularRuntimeSession(selected, 1, "session-one", {
		current: async () => current,
		currentNow: () => current,
		withdraw: () => {
			events.push("withdraw");
		},
		bootstrap: async () => {
			events.push("bootstrap-retain");
			return {
				install: async () => {
					events.push("bootstrap-install");
					if (failBootstrap) throw new Error("uncertain bootstrap reply");
				},
				discover: async () => {
					events.push("bootstrap-probe");
					return prefix;
				},
				cancelProbe: () => {
					events.push("bootstrap-cancel");
				},
				cleanup: async () => {
					events.push("bootstrap-cleanup");
					return clean;
				},
			};
		},
		host: async (prefix, consumersReleased) => {
			events.push(`host-retain-${prefix ?? "native"}`);
			consumer = consumersReleased;
			return host;
		},
		consumersReleased: async () => released,
		httpsPath: async () =>
			index
				? {
						source: host.binding.source,
						device: host.binding.device,
						ifindex: index,
					}
				: undefined,
		dns: async (path, signal) => {
			events.push(`dns-${path.device}-${path.ifindex}`);
			return signal.aborted
				? { ok: false }
				: { ok: true, ...(dnsPrefix ? { nat64: dnsPrefix } : {}) };
		},
		https: async (path, signal) => {
			events.push(`https-${path.device}-${path.ifindex}`);
			return https(signal);
		},
	});
	return {
		session,
		events,
		set: (options: {
			current?: boolean;
			clean?: boolean;
			released?: boolean;
			failInstall?: boolean;
			failBootstrap?: boolean;
			prefix?: string;
			dnsPrefix?: string;
			index?: number;
			https?: typeof https;
		}) => {
			if (options.current !== undefined) current = options.current;
			if (options.clean !== undefined) clean = options.clean;
			if (options.released !== undefined) released = options.released;
			if (options.failInstall !== undefined) failInstall = options.failInstall;
			if (options.failBootstrap !== undefined)
				failBootstrap = options.failBootstrap;
			if (options.prefix !== undefined) prefix = options.prefix;
			if (options.dnsPrefix !== undefined) dnsPrefix = options.dnsPrefix;
			if (options.index !== undefined) index = options.index;
			if (options.https !== undefined) https = options.https;
		},
	};
}
test("runtime completely retires DNS discovery before retaining final translated authority", async () => {
	const f = fixture();
	await f.session.install();
	expect(f.events).toEqual([
		"bootstrap-retain",
		"bootstrap-install",
		"bootstrap-probe",
		"bootstrap-cleanup",
		"host-retain-64:ff9b::/96",
		"host-install",
	]);
	expect(await f.session.valid()).toBe(true);
	expect(await f.session.prepareProbe()).toBe(true);
	expect(await f.session.probe()).toBe("ok");
	expect(f.events).toContain("dns-wwan0-17");
	expect(f.events).toContain("https-cclat1-23");
});
test("native runtime uses the indexed physical device without discovery or a translator", async () => {
	const f = fixture(false);
	f.set({ index: 17 });
	await f.session.install();
	expect(f.events).toEqual(["host-retain-native", "host-install"]);
	expect(await f.session.probe()).toBe("ok");
	expect(f.events).toContain("https-wwan0-17");
});
test("uncertain discovery cleanup retains the stage and never constructs the final host", async () => {
	const f = fixture();
	f.set({ clean: false });
	await expect(f.session.install()).rejects.toThrow("withdrawal incomplete");
	expect(await f.session.valid()).toBe(false);
	expect(f.events.some((event) => event.startsWith("host-"))).toBe(false);
	expect(await f.session.cleanup()).toBe(false);
	f.set({ clean: true });
	expect(await f.session.cleanup()).toBe(true);
	await expect(f.session.install()).rejects.toThrow("unavailable");
});
test("failed bootstrap and final install keep their actual retained owner for inverse retry", async () => {
	for (const stage of ["bootstrap", "host"] as const) {
		const f = fixture();
		f.set(
			stage === "bootstrap" ? { failBootstrap: true } : { failInstall: true },
		);
		await expect(f.session.install()).rejects.toThrow("uncertain");
		f.set({ clean: false });
		expect(await f.session.cleanup()).toBe(false);
		f.set({ clean: true });
		expect(await f.session.cleanup()).toBe(true);
		expect(f.events).toContain(
			stage === "bootstrap" ? "bootstrap-cleanup" : "host-remove",
		);
	}
});
test("changed DNS64 prefix denies and invalidates the session without running HTTPS", async () => {
	const f = fixture();
	await f.session.install();
	f.set({ dnsPrefix: "2001:db8:64::/96" });
	expect(await f.session.probe()).toBe("unavailable");
	expect(await f.session.valid()).toBe(false);
	expect(f.events.slice(-2)).toEqual(["withdraw", "fence-false"]);
	expect(f.events.some((event) => event.startsWith("https-"))).toBe(false);
	expect(await f.session.cleanup()).toBe(true);
});
test("missing positive born-device proof never opens a source-only HTTPS socket", async () => {
	const f = fixture();
	await f.session.install();
	f.set({ index: 0 });
	expect(await f.session.probe()).toBe("unavailable");
	expect(f.events.some((event) => event.startsWith("https-"))).toBe(false);
});
test("abort is not socket closure: denial proceeds while inverse waits for the actual probe settlement", async () => {
	const f = fixture();
	await f.session.install();
	let settle: (value: "ok") => void = () => {},
		started: () => void = () => {};
	const pending = new Promise<"ok">((resolve) => {
			settle = resolve;
		}),
		opened = new Promise<void>((resolve) => {
			started = resolve;
		});
	let signal: AbortSignal | undefined;
	f.set({
		https: async (input) => {
			signal = input;
			started();
			return pending;
		},
	});
	const probe = f.session.probe();
	await opened;
	expect(await f.session.probe()).toBe("unavailable");
	expect(await f.session.cleanup()).toBe(false);
	expect(signal?.aborted).toBe(true);
	expect(f.events).toContain("host-deny");
	expect(f.events).not.toContain("host-remove");
	settle("ok");
	expect(await probe).toBe("unavailable");
	f.set({ released: false });
	expect(await f.session.cleanup()).toBe(false);
	f.set({ released: true });
	expect(await f.session.cleanup()).toBe(true);
	expect(f.events.at(-1)).toBe("host-remove");
});
