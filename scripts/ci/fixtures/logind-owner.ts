// The contract runner copies this fixture beside the two production modules.
import { dlopen, ptr } from 'bun:ffi';
import { acquireLogindInhibitor } from './logind-inhibitor.ts';
import { startServiceWatchdog } from './systemd-watchdog.ts';

if (process.argv[2] === 'probe') {
	const start = performance.now();
	let failed = false;
	let ticks = 0;
	let pulses = 0;
	const timer = setInterval(() => ticks++, 10);
	const stop = startServiceWatchdog({
		env: { NODE_ENV: 'production', NOTIFY_SOCKET: '/unused', WATCHDOG_USEC: '40000' },
		notify: () => {
			pulses++;
		},
	});
	try {
		(await acquireLogindInhibitor())();
	} catch {
		failed = true;
	}
	stop();
	clearInterval(timer);
	if (!failed || ticks < 5 || pulses < 3 || performance.now() - start >= 1000) process.exit(1);
	process.stdout.write(
		`bounded failure: ${Math.round(performance.now() - start)} ms, ${ticks} ticks, ${pulses} watchdog pulses\n`,
	);
} else {
	await acquireLogindInhibitor();
	const lib = dlopen('libsystemd.so.0', {
		sd_notify: { args: ['i32', 'cstring'], returns: 'i32' },
	});
	lib.symbols.sd_notify(0, ptr(Buffer.from('READY=1\0')));
	startServiceWatchdog();
	setInterval(() => {
		/* Keep the descriptor-owning fixture alive. */
	}, 1000);
}
