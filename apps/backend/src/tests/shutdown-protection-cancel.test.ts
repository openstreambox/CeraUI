import { expect, test } from "bun:test";
import {
	ensureEncoderShutdownProtection,
	initShutdownProtection,
	setShutdownProtection,
} from "../modules/system/shutdown-protection.ts";

test("cancelled asynchronous admission releases only its newly introduced owner", async () => {
	let finish!: (close: () => void) => void;
	let closed = 0,
		current = true;
	initShutdownProtection(
		() =>
			new Promise<() => void>((resolve) => {
				finish = resolve;
			}),
	);
	const admission = ensureEncoderShutdownProtection(() => current);
	current = false;
	finish(() => {
		closed++;
	});
	expect(await admission).toBe(false);
	expect(closed).toBe(1);
	expect(setShutdownProtection("carrying", false)).toBe(true);
});

test("Stop releases a confirmed admission before its caller resumes", async () => {
	// Reuse the installed async acquirer with a separate pending resolver in a
	// fresh process so the production singleton has its normal boot lifetime.
	const module = new URL(
		"../modules/system/shutdown-protection.ts",
		import.meta.url,
	).pathname;
	const program = `import {initShutdownProtection,ensureEncoderShutdownProtection,setShutdownProtection} from ${JSON.stringify(module)};
 let finish,closed=0;
 initShutdownProtection(()=>new Promise(resolve=>{finish=resolve}));
 const controller=new AbortController();
 const admission=ensureEncoderShutdownProtection(()=>true,controller.signal);
 finish(()=>closed++);
 await admission;
 controller.abort();
 if(closed!==1 || !setShutdownProtection('carrying',false)) process.exit(1);`;
	const child = Bun.spawn([process.execPath, "-e", program], {
		stdout: "ignore",
		stderr: "inherit",
	});
	expect(await child.exited).toBe(0);
});
