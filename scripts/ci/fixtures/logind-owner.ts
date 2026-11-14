// The contract runner copies this fixture beside the two production modules.
import { dlopen, ptr } from 'bun:ffi';
import { acquireLogindInhibitor } from './logind-inhibitor.ts';
import { startServiceWatchdog } from './systemd-watchdog.ts';

if (process.argv[2] === 'probe') {
	const start = performance.now();
	let failed = false;
	try {
		acquireLogindInhibitor()();
	} catch {
		failed = true;
	}
	if (!failed || performance.now() - start >= 1000) process.exit(1);
	process.stdout.write(`bounded failure: ${Math.round(performance.now() - start)} ms\n`);
} else {
	acquireLogindInhibitor();
	const lib = dlopen('libsystemd.so.0', {
		sd_notify: { args: ['i32', 'cstring'], returns: 'i32' },
	});
	lib.symbols.sd_notify(0, ptr(Buffer.from('READY=1\0')));
	startServiceWatchdog();
	setInterval(() => {
		/* Keep the descriptor-owning fixture alive. */
	}, 1000);
}
