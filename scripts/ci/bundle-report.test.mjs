import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('matches URL-safe chunk hashes without consuming hyphenated stems or admitting unknown chunks', () => {
	const root = mkdtempSync(join(tmpdir(), 'bundle-report-'));
	try {
		mkdirSync(join(root, 'dist/public/assets'), { recursive: true });
		mkdirSync(join(root, 'dist/federation/test'), { recursive: true });
		writeFileSync(join(root, 'package.json'), '{"version":"test"}');
		writeFileSync(join(root, 'dist/public/index.html'), '<script src="/assets/app.js"></script>');
		writeFileSync(join(root, 'dist/public/assets/app.js'), 'export {};');
		writeFileSync(join(root, 'dist/public/sw.js'), 'precacheAndRoute([{url:"assets/app.js"}])');
		for (const name of [
			'InfoPopover-CVamhe-I.js',
			'InfoPopover-B5mx-_3j.js',
			'toast-host-duUb1s03.js',
			'sources-view-model-aB_cD-12.js',
			'audio.js',
		]) {
			writeFileSync(join(root, 'dist/federation/test', name), 'export {};');
		}
		const run = () =>
			spawnSync(process.execPath, [join(import.meta.dir, 'bundle-report.mjs')], {
				cwd: root,
				encoding: 'utf8',
			});
		const valid = run();
		expect(valid.status).toBe(0);
		expect(valid.stdout).toContain('federation InfoPopover.js');
		expect(valid.stdout).toContain('federation toast-host.js');
		expect(valid.stdout).toContain('federation sources-view-model.js');
		writeFileSync(join(root, 'dist/federation/test/audio.js'), randomBytes(8000));
		const oversized = run();
		expect(oversized.status).toBe(1);
		expect(oversized.stderr).toContain('federation audio.js:');
		expect(oversized.stderr).toContain('7725 B budget');
		writeFileSync(join(root, 'dist/federation/test/audio.js'), 'export {};');
		writeFileSync(join(root, 'dist/federation/test/unknown-B5mx-_3j.js'), 'export {};');
		const unknown = run();
		expect(unknown.status).toBe(1);
		expect(unknown.stderr).toContain('no baseline for stem unknown.js');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
