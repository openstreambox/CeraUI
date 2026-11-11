import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'bun';

const report = join(import.meta.dir, 'bundle-report.mjs');
const version = '2026.11.2';

async function runReport({ build = true, asset, payload, omit } = {}) {
	const root = mkdtempSync(join(tmpdir(), 'ceraui-bundle-report-'));
	try {
		writeFileSync(join(root, 'package.json'), JSON.stringify({ version }));
		if (build) {
			const dir = join(root, 'dist/federation', version);
			mkdirSync(dir, { recursive: true });
			const graph = {};
			for (const name of ['audio.js', 'encoder.js', 'server.js', 'frontend.css']) {
				if (name === omit) continue;
				writeFileSync(join(dir, name), name === asset ? payload : 'export {};');
				graph[name] = { file: name };
			}
			if (asset && !(asset in graph)) {
				writeFileSync(join(dir, asset), payload);
				graph.extra = { file: asset };
				graph['audio.js'].imports = ['extra'];
			}
			writeFileSync(join(dir, 'federation-build.json'), JSON.stringify(graph));
		}
		const child = spawn([process.execPath, report, '--federation-only'], {
			cwd: root,
			env: process.env,
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
		});
		const [stdout, stderr, exit] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		return { stdout, stderr, exit };
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

test('publication checks federation budgets without requiring SPA artifacts', async () => {
	const { exit, stdout, stderr } = await runReport();
	expect(exit, stderr).toBe(0);
	expect(stdout).toContain('federation audio.js');
	expect(stdout).not.toContain('skipped');
});

test('publication fails closed when federation artifacts are absent', async () => {
	const { exit, stderr } = await runReport({ build: false });
	expect(exit).toBe(1);
	expect(stderr).toContain('federation output missing:');
});

test('publication rejects a partial federation build', async () => {
	const { exit, stderr } = await runReport({
		omit: 'audio.js',
	});
	expect(exit).toBe(1);
	expect(stderr).toContain('missing federation entry audio.js');
});

test('publication rejects an executable with no budget baseline', async () => {
	const { exit, stderr } = await runReport({
		asset: 'new-feature-QWERTY12.js',
		payload: 'export {};',
	});
	expect(exit).toBe(1);
	expect(stderr).toContain('no baseline for stem new-feature.js');
});

// Each payload exceeds its absolute allowance while staying below the 10% ratio.
for (const [asset, bytes] of [
	['toast-host-a_bCdE1-.js', 700_000],
	['audio.js', 8_000],
]) {
	test(`publication rejects ${asset} above its gzip budget`, async () => {
		const payload = createHash('shake256', { outputLength: bytes })
			.update('budget fixture')
			.digest();
		const { exit, stderr } = await runReport({ asset, payload });
		expect(exit).toBe(1);
		expect(stderr).toContain(
			`federation ${asset.startsWith('toast-host-') ? 'toast-host.js' : asset}:`,
		);
		expect(stderr).toContain('exceeds the');
	});
}

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
		expect(oversized.stderr).toContain('7881 B budget');
		writeFileSync(join(root, 'dist/federation/test/audio.js'), 'export {};');
		writeFileSync(join(root, 'dist/federation/test/unknown-B5mx-_3j.js'), 'export {};');
		const unknown = run();
		expect(unknown.status).toBe(1);
		expect(unknown.stderr).toContain('no baseline for stem unknown.js');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
