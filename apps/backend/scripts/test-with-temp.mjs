import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const parent = tmpdir();
const root = await mkdtemp(join(parent, 'ceraui-backend-run-'));
try {
	const before = await readdir(root);
	const test = Bun.spawn([process.execPath, 'test', ...process.argv.slice(2)], {
		env: {
			...process.env,
			TMPDIR: root,
			TMP: root,
			TEMP: root,
			CERAUI_TEST_TEMP_ROOT: root,
			CERAUI_TEST_TEMP_TREE: process.env.CERAUI_TEST_TEMP_TREE || root,
			CERAUI_TEST_TEMP_PARENT: process.env.CERAUI_TEST_TEMP_PARENT ?? parent,
		},
		stdin: 'inherit',
		stdout: 'inherit',
		stderr: 'inherit',
	});
	const interrupt = () => test.kill('SIGINT');
	const terminate = () => test.kill('SIGTERM');
	process.on('SIGINT', interrupt);
	process.on('SIGTERM', terminate);
	const status = await test.exited.finally(() => {
		process.off('SIGINT', interrupt);
		process.off('SIGTERM', terminate);
	});
	const after = await readdir(root);
	console.error(`Backend temp root entries before/after: ${before.length}/${after.length}`);
	if (after.length) {
		console.error('Leaked backend test temp entries:', after.slice(0, 20).join(', '));
	}
	if (after.includes('temp-escapes.log')) {
		console.error(await readFile(join(root, 'temp-escapes.log'), 'utf8'));
	}
	process.exitCode = status || (after.length ? 1 : 0);
} finally {
	await rm(root, { recursive: true, force: true });
}
