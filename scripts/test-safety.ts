import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import { basename } from 'node:path';
import tls from 'node:tls';

// Deliberately empty. Tests supply fake runners before reaching a spawn layer.
const allowedCommands: readonly string[] = [];
const violations: string[] = [];
let processGuardInstalled = false;

export function assertSafeCommand(command: readonly string[]): void {
	const text = command.join(' ');
	const shellFlag = command.findIndex((arg) => /^-[a-z]*c[a-z]*$/.test(arg));
	const shellScript = shellFlag >= 0 ? (command[shellFlag + 1] ?? '') : '';
	const bin = basename(command[0] ?? '');
	if (/^(timeout|env|sudo|nice|nohup|setsid|stdbuf|command)$/.test(bin)) {
		const target = command.findIndex(
			(arg, index) =>
				index > 0 &&
				/^(killall|pkill|kill|skill|fuser|systemctl|systemd-run|service|rc-service|invoke-rc.d|reboot|shutdown|poweroff|halt|sh|bash|dash)$/.test(
					basename(arg),
				),
		);
		if (target > 0) assertSafeCommand(command.slice(target));
	}

	const dangerous =
		/^(killall|pkill|kill|skill|fuser|systemd-run|service|rc-service|invoke-rc.d|reboot|shutdown|poweroff|halt)$/.test(
			bin,
		) ||
		(bin === 'systemctl' &&
			command
				.slice(1)
				.some((arg) =>
					/^(start|stop|restart|try-restart|reload|reload-or-restart|kill|enable|disable|mask|unmask|reset-failed|reboot|poweroff)$/.test(
						arg,
					),
				)) ||
		(/^(sh|bash|dash)$/.test(bin) &&
			/\b(killall|pkill|kill|systemctl|systemd-run|reboot|poweroff)\b/.test(shellScript));
	if (dangerous && !allowedCommands.includes(text)) {
		const message = `Unsafe test process command: ${text}`;
		violations.push(message);
		throw new Error(message);
	}
}

export function takeSafetyViolations(): string[] {
	return violations.splice(0);
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

export function installProcessSafetyGuard(): void {
	if (processGuardInstalled) return;
	processGuardInstalled = true;
	for (const key of globalThis.Bun ? (['spawn', 'spawnSync'] as const) : []) {
		const original = globalThis.Bun[key];
		Object.defineProperty(globalThis.Bun, key, {
			value: (...args: unknown[]) => {
				checkedSpawnArgs(args);
				return Reflect.apply(original, globalThis.Bun, args);
			},
		});
	}
	for (const key of [
		'spawn',
		'spawnSync',
		'exec',
		'execSync',
		'execFile',
		'execFileSync',
	] as const) {
		const original = childProcess[key];
		Object.defineProperty(childProcess, key, {
			configurable: true,
			writable: true,
			value: (...args: unknown[]) => {
				if (key === 'exec' || key === 'execSync') assertSafeCommand(['sh', '-c', String(args[0])]);
				else checkedSpawnArgs(args);
				return Reflect.apply(original, childProcess, args);
			},
		});
	}
	syncBuiltinESMExports();
}

export function assertLoopbackHost(host: string): void {
	if (
		host === 'localhost' ||
		host === '::1' ||
		host === '[::1]' ||
		/^127(?:\.\d{1,3}){3}$/.test(host)
	)
		return;
	const message = `Unsafe test outbound connection: ${host}`;
	violations.push(message);
	throw new Error(message);
}

export function installNetworkSafetyGuard(): void {
	for (const owner of [net, tls]) {
		for (const key of ['connect', 'createConnection'] as const) {
			if (!(key in owner)) continue;
			const original = Reflect.get(owner, key);
			Object.defineProperty(owner, key, {
				configurable: true,
				writable: true,
				value: (...args: unknown[]) => {
					const options = args[0];
					if (options && typeof options === 'object') {
						const { host, path } = options as { host?: string; path?: string };
						if (!path) assertLoopbackHost(host ?? 'localhost');
					} else if (typeof options === 'number')
						assertLoopbackHost(typeof args[1] === 'string' ? args[1] : 'localhost');
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
			const options = Array.isArray(args[0]) ? args[0][0] : args[0];
			if (options && typeof options === 'object') {
				const { host, path } = options as { host?: string; path?: string };
				if (!path) assertLoopbackHost(host ?? 'localhost');
			} else if (typeof options === 'number')
				assertLoopbackHost(typeof args[1] === 'string' ? args[1] : 'localhost');
			return Reflect.apply(socketConnect, this, args);
		},
	});
	syncBuiltinESMExports();
	const RealWebSocket = globalThis.WebSocket;
	globalThis.WebSocket = class extends RealWebSocket {
		constructor(url: string | URL, protocols?: string | string[]) {
			assertLoopbackHost(new URL(url).hostname);
			super(url, protocols);
		}
	} as typeof WebSocket;
	const realFetch = globalThis.fetch;
	globalThis.fetch = Object.assign((...args: Parameters<typeof fetch>) => {
		const target = args[0] instanceof Request ? args[0].url : args[0];
		assertLoopbackHost(new URL(target).hostname);
		return realFetch(...args);
	}, realFetch);
}
