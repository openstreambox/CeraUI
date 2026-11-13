import childProcess from 'node:child_process';
import dgram from 'node:dgram';
import dns from 'node:dns';
import {
	accessSync,
	chmodSync,
	constants,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { basename, delimiter, join } from 'node:path';
import tls from 'node:tls';

// Deliberately empty. Tests supply fake runners before reaching a spawn layer.
const allowedCommands: readonly string[] = [];
const violations: string[] = [];
let processGuardInstalled = false;
let networkGuardInstalled = false;

const SIGNAL_COMMANDS =
	/^(killall|pkill|kill|skill|fuser|systemd-run|service|rc-service|invoke-rc\.d|reboot|shutdown|poweroff|halt)$/;
const COMMAND_WRAPPERS =
	/^(timeout|env|sudo|doas|nice|nohup|setsid|stdbuf|command|exec|xargs|find|busybox|chrt|ionice|taskset|flock|nsenter|unshare|setpriv|runuser|time|watch|strace)$/;
const SHELLS = /^(sh|bash|dash|zsh|ksh|ash)$/;
const READ_ONLY_SYSTEMCTL =
	/^(show|status|is-active|is-enabled|is-failed|is-system-running|list-units|list-unit-files|cat|list-jobs|list-timers|list-sockets|list-dependencies|get-default|help|--version|--help)$/;
const SHELL_SIGNAL_WORDS =
	/\b(killall|pkill|kill|skill|fuser|systemctl|systemd-run|reboot|poweroff|shutdown|halt)\b/;
const ABSOLUTE_SIGNAL_PATH =
	/(?:^|[\s;&|(`'"])\/(?:usr\/)?s?bin\/(killall|pkill|kill|skill|fuser|systemctl|systemd-run|reboot|poweroff|shutdown|halt)\b/m;
const POSITIONAL_PARAMETER = /\$(?:@|\*|\{?[0-9])/;
const STUBBED_COMMANDS = [
	'killall',
	'pkill',
	'kill',
	'skill',
	'fuser',
	'systemctl',
	'systemd-run',
	'service',
	'reboot',
	'shutdown',
	'poweroff',
	'halt',
] as const;

function record(message: string): never {
	violations.push(message);
	throw new Error(message);
}

function findOnPath(command: string): string | undefined {
	for (const dir of (process.env.PATH ?? '').split(delimiter)) {
		if (!dir) continue;
		const candidate = join(dir, command);
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {
			/* keep searching */
		}
	}
	return undefined;
}

/** Every name a command runs under: its own basename and that of its resolved target. */
function commandNames(command: string): string[] {
	const names = [basename(command)];
	try {
		const target = command.includes('/') ? command : findOnPath(command);
		if (target) names.push(basename(realpathSync(target)));
	} catch {
		/* unresolvable: the spoken name is all there is */
	}
	return names;
}

function isName(command: string, pattern: RegExp): boolean {
	return commandNames(command).some((name) => pattern.test(name));
}

/** env -S / --split-string carry a whole command line inside one argument. */
function splitStrings(command: readonly string[]): string[] {
	const out: string[] = [];
	for (let index = 0; index < command.length; index++) {
		const arg = command[index] ?? '';
		const joined = /^(?:-S|--split-string=)(.+)$/.exec(arg);
		if (arg === '-S' || arg === '--split-string')
			out.push(...(command[++index] ?? '').split(/\s+/).filter(Boolean));
		else if (joined?.[1] && index > 0) out.push(...joined[1].split(/\s+/).filter(Boolean));
		else out.push(arg);
	}
	return out;
}

const GUARDED_NAMES =
	/^(killall|pkill|kill|skill|fuser|systemctl|systemd-run|service|rc-service|invoke-rc\.d|reboot|shutdown|poweroff|halt|timeout|env|sudo|doas|nice|nohup|setsid|stdbuf|command|exec|xargs|find|busybox|chrt|ionice|taskset|flock|nsenter|unshare|setpriv|runuser|time|watch|strace|sh|bash|dash|zsh|ksh|ash)$/;

function isExecutable(arg: string): boolean {
	try {
		if (!arg.includes('/')) return findOnPath(arg) !== undefined;
		accessSync(arg, constants.X_OK);
		return statSync(arg).isFile();
	} catch {
		return false;
	}
}

/**
 * Find the command a wrapper runs and judge it. Options, VAR=value, numbers and
 * words that are not executables (option values such as `KILL` or a lock file)
 * are skipped; the first executable is the wrapped command, and anything after
 * it is that command's data (a fixture passing "kill" to Python is not a kill).
 */
function assertWrappedCommand(args: readonly string[], depth: number): void {
	for (let index = 0; index < args.length; index++) {
		const arg = args[index] ?? '';
		if (isName(arg, GUARDED_NAMES)) {
			assertSafeCommand(args.slice(index), depth + 1);
			return;
		}
		if (
			arg.startsWith('-') ||
			/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg) ||
			/^[\d.,:x-]+[smhd]?$/i.test(arg)
		)
			continue;
		if (isExecutable(arg)) return;
	}
}

function readScript(path: string): string {
	try {
		if (statSync(path).size > 1024 * 1024) return '';
		return readFileSync(path, 'utf8');
	} catch {
		return '';
	}
}

export function assertSafeCommand(command: readonly string[], depth = 0): void {
	if (!command.length || depth > 8) return;
	const text = command.join(' ');
	const bin = command[0] ?? '';
	let dangerous = false;

	if (isName(bin, SIGNAL_COMMANDS)) dangerous = true;
	else if (isName(bin, /^systemctl$/)) {
		const verb = command.slice(1).find((arg) => !arg.startsWith('-')) ?? command[1] ?? '';
		dangerous = !READ_ONLY_SYSTEMCTL.test(verb);
	} else if (isName(bin, COMMAND_WRAPPERS)) {
		assertWrappedCommand(splitStrings(command).slice(1), depth);
	} else if (isName(bin, SHELLS)) {
		const flag = command.findIndex((arg, index) => index > 0 && /^-[a-z]*c[a-z]*$/.test(arg));
		if (flag > 0) {
			const script = command[flag + 1] ?? '';
			if (SHELL_SIGNAL_WORDS.test(script)) dangerous = true;
			// `sh -c 'exec "$@"' name cmd …` runs whatever follows the script.
			else if (POSITIONAL_PARAMETER.test(script))
				assertWrappedCommand(command.slice(flag + 2), depth);
		} else {
			// `sh script.sh …`: by-name calls inside hit the PATH stubs; absolute paths do not.
			const fileIndex = command.findIndex((arg, index) => index > 0 && !arg.startsWith('-'));
			const script = fileIndex > 0 ? readScript(command[fileIndex] ?? '') : '';
			if (ABSOLUTE_SIGNAL_PATH.test(script)) dangerous = true;
			else if (POSITIONAL_PARAMETER.test(script))
				assertWrappedCommand(command.slice(fileIndex + 1), depth);
		}
	}

	if (dangerous && !allowedCommands.includes(text)) record(`Unsafe test process command: ${text}`);
}

let stubRecord: string | undefined;
let stubRecordOffset = 0;

function takeStubCalls(): string[] {
	if (!stubRecord) return [];
	let content: string;
	try {
		content = readFileSync(stubRecord, 'utf8');
	} catch {
		return [];
	}
	const fresh = content.slice(stubRecordOffset);
	stubRecordOffset = content.length;
	return fresh
		.split('\n')
		.filter(Boolean)
		.map((line) => `Unsafe test process command reached a PATH stub: ${line}`);
}

export function takeSafetyViolations(): string[] {
	return [...violations.splice(0), ...takeStubCalls()];
}

const ownedPids = new Set<number>();

function trackChild<T>(result: T): T {
	const pid = (result as { pid?: unknown } | undefined)?.pid;
	if (typeof pid === 'number' && pid > 0) ownedPids.add(pid);
	return result;
}

function procStat(pid: number): { ppid: number; pgrp: number } | undefined {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
		// Fields after the command name: state, ppid, pgrp, …
		const [, ppid, pgrp] = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
		return { ppid: Number(ppid), pgrp: Number(pgrp) };
	} catch {
		return undefined;
	}
}

/**
 * Children inherit this process's owner token, so a grandchild that a lost
 * handle left reparented to init still reads as ours; a stranger's sender does not.
 */
const OWNER_VARIABLE = 'CERAUI_TEST_SIGNAL_OWNER';
const ownerToken = `${process.pid}-${Math.random().toString(36).slice(2)}`;

function carriesOwnerToken(pid: number): boolean {
	try {
		return readFileSync(`/proc/${pid}/environ`, 'latin1')
			.split('\0')
			.includes(`${OWNER_VARIABLE}=${ownerToken}`);
	} catch {
		return false;
	}
}

function isOwnedPid(pid: number): boolean {
	if (pid === process.pid || ownedPids.has(pid) || carriesOwnerToken(pid)) return true;
	const first = procStat(pid);
	if (first && ownedPids.has(first.pgrp)) return true;
	let current = first?.ppid;
	for (let hops = 0; current !== undefined && current > 1 && hops < 64; hops++) {
		if (current === process.pid || ownedPids.has(current)) return true;
		current = procStat(current)?.ppid;
	}
	return false;
}

/**
 * Declare a process the test's own fixture started but cannot prove by
 * ancestry: a descendant that escaped with setsid and a clean environment,
 * reported by the fixture's own readiness line or pid file.
 */
export function adoptTestProcess(pid: number): void {
	if (Number.isInteger(pid) && pid > 0) ownedPids.add(pid);
}

/** Tests signal only themselves and processes they spawned (and those processes' groups). */
export function assertOwnedSignalTarget(pid: number, signal?: string | number): void {
	if (signal === 0 || signal === '0') return; // existence probe, delivers nothing
	if (pid !== 0 && pid !== -1 && isOwnedPid(Math.abs(pid))) return;
	record(
		`Unsafe test signal: process.kill(${pid}, ${String(signal ?? 'SIGTERM')}) targets a process this test did not spawn`,
	);
}

function checkedSpawnArgs(args: unknown[]): void {
	const first = args[0];
	if (Array.isArray(first)) assertSafeCommand(first.map(String));
	else if (typeof first === 'string') {
		if (args.some((value) => value && typeof value === 'object' && 'shell' in value && value.shell))
			assertSafeCommand(['sh', '-c', first]);
		assertSafeCommand([first, ...(Array.isArray(args[1]) ? args[1].map(String) : [])]);
	} else if (first && typeof first === 'object' && 'cmd' in first) {
		checkedSpawnArgs([(first as { cmd: unknown }).cmd]);
	}
}

/** Bun.spawn resolves names against the PATH the process started with unless env is passed. */
function withCurrentEnv(args: unknown[]): unknown[] {
	const [first, second] = args;
	if (first && typeof first === 'object' && !Array.isArray(first)) {
		const options = first as { env?: unknown };
		return options.env ? args : [{ ...options, env: process.env }, ...args.slice(1)];
	}
	if (second === undefined) return [first, { env: process.env }];
	if (second && typeof second === 'object') {
		const options = second as { env?: unknown };
		return options.env ? args : [first, { ...options, env: process.env }, ...args.slice(2)];
	}
	return args;
}

function shellText(strings: unknown, values: unknown[]): string {
	const raw = (strings as { raw?: readonly string[] } | undefined)?.raw;
	if (!raw) return String(strings);
	const render = (value: unknown): string =>
		Array.isArray(value)
			? value.map(render).join(' ')
			: value && typeof value === 'object' && 'raw' in value
				? String((value as { raw: unknown }).raw)
				: String(value);
	return raw.reduce(
		(text, part, index) => text + part + (index < values.length ? render(values[index]) : ''),
		'',
	);
}

function guardBunShell(bun: typeof Bun): void {
	const realShell = bun.$;
	const guarded: typeof Bun.$ = new Proxy(realShell, {
		apply(target, thisArg, args: unknown[]) {
			assertSafeCommand(['sh', '-c', shellText(args[0], args.slice(1))]);
			return Reflect.apply(target, thisArg, args);
		},
		get(target, key, receiver) {
			const value = Reflect.get(target, key, receiver);
			// Classes ($.Shell, $.ShellError) are constructed, not called.
			if (typeof value !== 'function' || /^[A-Z]/.test(String(key))) return value;
			// $.cwd()/$.env()/$.nothrow() return the shell itself; keep returning the guarded one.
			return (...args: unknown[]) => {
				const result = Reflect.apply(value, target, args);
				return result === realShell ? guarded : result;
			};
		},
	});
	(bun as { $: typeof Bun.$ }).$ = guarded;
}

/** Shadow name-based signal and unit commands with recording stubs for every child. */
function installPathStubs(): void {
	if (stubRecord || process.platform === 'win32') return;
	const dir = mkdtempSync(join(tmpdir(), 'ceraui-test-stubs-'));
	stubRecord = join(dir, 'calls.log');
	writeFileSync(stubRecord, '');
	const realSystemctl = findOnPath('systemctl');
	const readOnly = READ_ONLY_SYSTEMCTL.source.slice(2, -2);
	for (const name of STUBBED_COMMANDS) {
		const passThrough =
			name === 'systemctl' && realSystemctl
				? `verb=
for arg in "$@"; do case "$arg" in -*) ;; *) verb=$arg; break ;; esac; done
case "\${verb:-$1}" in ${readOnly}) exec '${realSystemctl}' "$@" ;; esac
`
				: '';
		const path = join(dir, name);
		writeFileSync(
			path,
			`#!/bin/sh
# Test backstop: a test process reached a host-global signal or unit command.
${passThrough}printf '%s\\n' "${name} $*" >> '${stubRecord}'
echo "Unsafe test process command reached a PATH stub: ${name} $*" >&2
exit 97
`,
		);
		chmodSync(path, 0o755);
	}
	process.env.PATH = `${dir}${delimiter}${process.env.PATH ?? ''}`;
	process.once('exit', () => rmSync(dir, { recursive: true, force: true }));
}

export function installProcessSafetyGuard(): void {
	if (processGuardInstalled) return;
	processGuardInstalled = true;
	process.env[OWNER_VARIABLE] = ownerToken;
	installPathStubs();
	const bun = globalThis.Bun;
	if (bun) {
		for (const key of ['spawn', 'spawnSync'] as const) {
			const original = bun[key];
			Object.defineProperty(bun, key, {
				value: (...args: unknown[]) => {
					checkedSpawnArgs(args);
					return trackChild(Reflect.apply(original, bun, withCurrentEnv(args)));
				},
			});
		}
		guardBunShell(bun);
	}
	for (const key of [
		'spawn',
		'spawnSync',
		'exec',
		'execSync',
		'execFile',
		'execFileSync',
		'fork',
	] as const) {
		const original = childProcess[key];
		Object.defineProperty(childProcess, key, {
			configurable: true,
			writable: true,
			value: (...args: unknown[]) => {
				if (key === 'exec' || key === 'execSync') assertSafeCommand(['sh', '-c', String(args[0])]);
				else if (key !== 'fork') checkedSpawnArgs(args);
				return trackChild(Reflect.apply(original, childProcess, args));
			},
		});
	}
	syncBuiltinESMExports();
	const realKill = process.kill;
	process.kill = ((pid: number, signal?: string | number) => {
		assertOwnedSignalTarget(pid, signal);
		return realKill.call(process, pid, signal);
	}) as typeof process.kill;
}

function isLoopback(host: string): boolean {
	const bare = host.replace(/^\[(.*)\]$/, '$1').toLowerCase();
	return (
		bare === 'localhost' ||
		bare === '::1' ||
		/^127(?:\.\d{1,3}){3}$/.test(bare) ||
		/^::ffff:127(?:\.\d{1,3}){3}$/.test(bare)
	);
}

// Documentation ranges (RFC 5737, RFC 3849) are never routed on the internet.
const DOCUMENTATION_ADDRESS = /^(?:192\.0\.2|198\.51\.100|203\.0\.113)\.\d{1,3}$|^2001:db8:/i;
const permittedTargets = new Set<string>();

/**
 * Let the current test send to one documentation address (cleared after each
 * test). For probes that must see a routable-but-silent destination; real
 * hosts and names stay refused.
 */
export function permitDocumentationTargetForTest(address: string): void {
	if (!DOCUMENTATION_ADDRESS.test(address))
		throw new Error(`Not a documentation address: ${address}`);
	permittedTargets.add(address.toLowerCase());
}

export function resetPermittedTargets(): void {
	permittedTargets.clear();
}

export function assertLoopbackHost(host: string): void {
	// An empty host is malformed input that fails locally, not a destination.
	if (
		host === '' ||
		isLoopback(host) ||
		permittedTargets.has(host.replace(/^\[(.*)\]$/, '$1').toLowerCase())
	)
		return;
	record(`Unsafe test outbound connection: ${host}`);
}

/** getaddrinfo answers literals locally (dgram looks up 0.0.0.0 to bind). */
function assertLocalLookup(name: unknown): void {
	const host = String(name ?? '');
	if (isLoopback(host) || net.isIP(host.replace(/^\[(.*)\]$/, '$1'))) return;
	record(`Unsafe test DNS query: ${host}`);
}

/** A resolver (c-ares) query goes to the configured DNS server whatever the name. */
function assertLocalQuery(name: unknown): void {
	const host = String(name ?? '');
	if (isLoopback(host)) return;
	record(`Unsafe test DNS query: ${host}`);
}

function assertLoopbackUrl(url: unknown): void {
	assertLoopbackHost(new URL(String(url)).hostname);
}

const DNS_METHODS = [
	'resolve',
	'resolve4',
	'resolve6',
	'resolveAny',
	'resolveCaa',
	'resolveCname',
	'resolveMx',
	'resolveNaptr',
	'resolveNs',
	'resolvePtr',
	'resolveSoa',
	'resolveSrv',
	'resolveTxt',
	'prefetch',
] as const;
const DNS_ADDRESS_METHODS = ['reverse', 'lookupService'] as const;

function wrapMethods(
	owner: object | undefined,
	keys: readonly string[],
	check: (value: unknown) => void,
): void {
	if (!owner) return;
	for (const key of keys) {
		const original = Reflect.get(owner, key);
		if (typeof original !== 'function') continue;
		try {
			Reflect.set(owner, key, function (this: unknown, ...args: unknown[]) {
				check(args[0]);
				return Reflect.apply(original, this === undefined ? owner : this, args);
			});
		} catch {
			/* frozen owner: nothing to wrap */
		}
	}
}

function guardDns(): void {
	const owners = [
		dns,
		dns.promises,
		dns.Resolver.prototype,
		dns.promises.Resolver.prototype,
		globalThis.Bun?.dns,
	] as object[];
	for (const owner of owners) {
		wrapMethods(owner, ['lookup'], assertLocalLookup);
		wrapMethods(owner, DNS_METHODS, assertLocalQuery);
		wrapMethods(owner, DNS_ADDRESS_METHODS, (address) => assertLoopbackHost(String(address)));
	}
}

function checkSocketOptions(options: unknown, second?: unknown): void {
	if (options && typeof options === 'object') {
		const { host, hostname, path, unix } = options as {
			host?: string;
			hostname?: string;
			path?: string;
			unix?: string;
		};
		if (!path && !unix) assertLoopbackHost(hostname ?? host ?? 'localhost');
	} else if (typeof options === 'number' || /^\d+$/.test(String(options ?? '')))
		assertLoopbackHost(typeof second === 'string' ? second : 'localhost');
}

/** dgram.send(msg, [offset, length,] port, [address], [cb]) and connect(port, [address]). */
function dgramAddress(args: unknown[]): string | undefined {
	const rest = args.slice(1);
	const port =
		typeof rest[0] === 'number' && typeof rest[1] === 'number' && typeof rest[2] === 'number'
			? 2
			: 0;
	if (rest[port] === undefined || typeof rest[port] === 'function') return undefined; // connected socket
	const address = rest[port + 1];
	return typeof address === 'string' ? address : 'localhost';
}

function guardUdp(): void {
	const proto = dgram.Socket.prototype;
	const send = proto.send;
	proto.send = function (this: dgram.Socket, ...args: unknown[]) {
		const address = dgramAddress(args);
		if (address !== undefined) assertLoopbackHost(address);
		return Reflect.apply(send, this, args);
	} as typeof proto.send;
	const connect = proto.connect;
	proto.connect = function (this: dgram.Socket, ...args: unknown[]) {
		assertLoopbackHost(typeof args[1] === 'string' ? args[1] : 'localhost');
		return Reflect.apply(connect, this, args);
	} as typeof proto.connect;
	const bun = globalThis.Bun;
	if (!bun) return;
	const udpSocket = bun.udpSocket;
	bun.udpSocket = ((options: Parameters<typeof Bun.udpSocket>[0]) => {
		const target = (options as { connect?: { hostname?: string } }).connect;
		if (target) assertLoopbackHost(target.hostname ?? 'localhost');
		return udpSocket(options).then((socket) => {
			const sendTo = socket.send.bind(socket);
			const sendMany = socket.sendMany.bind(socket);
			Object.defineProperties(socket, {
				send: {
					configurable: true,
					value: (...args: unknown[]) => {
						if (!target) assertLoopbackHost(String(args[2] ?? 'localhost'));
						return Reflect.apply(sendTo, socket, args);
					},
				},
				sendMany: {
					configurable: true,
					value: (packets: unknown[]) => {
						if (!target)
							for (let index = 2; index < packets.length; index += 3)
								assertLoopbackHost(String(packets[index]));
						return sendMany(packets as never);
					},
				},
			});
			return socket;
		});
	}) as typeof Bun.udpSocket;
}

export const OUTBOUND_CHECK = Symbol.for('ceraui.outboundCheck');

function onlyLoopbackInterfaces(): boolean {
	try {
		const names = readFileSync('/proc/net/dev', 'utf8')
			.split('\n')
			.slice(2)
			.map((line) => line.split(':')[0]?.trim())
			.filter(Boolean);
		return names.length > 0 && names.every((name) => name === 'lo');
	} catch {
		return false;
	}
}

function builtinWebSocketClass(): (abstract new (...args: never[]) => unknown) | undefined {
	try {
		return createRequire(import.meta.url)('ws') as abstract new (
			...args: never[]
		) => unknown;
	} catch {
		return undefined;
	}
}

export function installNetworkSafetyGuard(): void {
	if (networkGuardInstalled) return;
	networkGuardInstalled = true;
	// A network namespace that starts with only `lo` (a kernel fixture re-run
	// under `unshare -n`) has no route off the machine; its fixtures address
	// veth peers the test creates itself.
	if (onlyLoopbackInterfaces()) return;
	for (const owner of [net, tls]) {
		for (const key of ['connect', 'createConnection'] as const) {
			if (!(key in owner)) continue;
			const original = Reflect.get(owner, key);
			Object.defineProperty(owner, key, {
				configurable: true,
				writable: true,
				value: (...args: unknown[]) => {
					checkSocketOptions(args[0], args[1]);
					return Reflect.apply(original, owner, args);
				},
			});
		}
	}
	const socketConnect = net.Socket.prototype.connect;
	Object.defineProperty(net.Socket.prototype, 'connect', {
		configurable: true,
		writable: true,
		value: function (this: net.Socket, ...args: unknown[]) {
			checkSocketOptions(Array.isArray(args[0]) ? args[0][0] : args[0], args[1]);
			return Reflect.apply(socketConnect, this, args);
		},
	});
	guardDns();
	guardUdp();
	syncBuiltinESMExports();
	const bun = globalThis.Bun;
	if (bun) {
		const connect = bun.connect;
		bun.connect = ((options: Parameters<typeof Bun.connect>[0]) => {
			checkSocketOptions(options);
			return connect(options);
		}) as typeof Bun.connect;
	}
	// The `ws` package is a Bun builtin that cannot be wrapped from outside; the
	// backend constructs its client sockets through a helper that calls this check.
	const realWs = builtinWebSocketClass();
	(globalThis as Record<symbol, unknown>)[OUTBOUND_CHECK] = (
		url: unknown,
		socketClass?: unknown,
	) => {
		// A test double (mock.module('ws')) opens no connection; the real class and subclasses do.
		if (
			!realWs ||
			socketClass === undefined ||
			socketClass === realWs ||
			(typeof socketClass === 'function' && socketClass.prototype instanceof realWs)
		)
			assertLoopbackUrl(url);
	};
	const RealWebSocket = globalThis.WebSocket;
	globalThis.WebSocket = class extends RealWebSocket {
		constructor(url: string | URL, protocols?: string | string[]) {
			assertLoopbackUrl(url);
			super(url, protocols);
		}
	} as typeof WebSocket;
	const realFetch = globalThis.fetch;
	globalThis.fetch = Object.assign((...args: Parameters<typeof fetch>) => {
		const target = args[0] instanceof Request ? args[0].url : args[0];
		const options = args[1] as { unix?: string } | undefined;
		if (!options?.unix) assertLoopbackUrl(target);
		return realFetch(...args);
	}, realFetch);
}
