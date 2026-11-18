import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { YAML } from 'bun';

const workflow = YAML.parse(readFileSync('.github/workflows/fork-build.yml', 'utf8'));

test('development artifacts depend on the complete check job', () => {
	expect(workflow.permissions).toEqual({ contents: 'read' });
	expect(workflow.jobs.artifacts.needs).toBe('check');
	expect(
		workflow.jobs.check.steps.find((step) => step.uses?.startsWith('actions/checkout@')).with[
			'fetch-depth'
		],
	).toBe(0);
	expect(Object.keys(workflow.jobs).sort()).toEqual(['artifacts', 'check']);
	expect(workflow.jobs.artifacts.strategy.matrix.architecture).toEqual(['amd64', 'arm64']);
	const runs = workflow.jobs.check.steps.map((step) => step.run ?? '').join('\n');
	expect(runs).not.toMatch(/scripts\/esim|esim-helper|lpac/);
	for (const command of [
		'bun install --frozen-lockfile',
		'bun run lint',
		'bun run test',
		'bun run check:tech-debt',
		'bun run test:release-package-contracts',
	]) {
		expect(runs).toContain(command);
	}
	expect(runs).toContain('496217e93cde36eeac0bde1b742c21fed6347a198f05a8cd898be116946b1eb8');
});

test('delivery fails on missing artifacts and uses the reviewed packaging entrypoint', () => {
	const steps = workflow.jobs.artifacts.steps;
	expect(steps.some((step) => step.run === 'scripts/fork/package.sh artifacts')).toBe(true);
	for (const job of ['artifacts']) {
		const uploads = workflow.jobs[job].steps.filter((step) =>
			step.uses?.startsWith('actions/upload-artifact@'),
		);
		expect(uploads.length).toBe(1);
		expect(uploads[0].with['if-no-files-found']).toBe('error');
	}
});

test('all fork job runtimes agree with the repository Bun pin', () => {
	const pin = readFileSync('.bun-version', 'utf8').trim();
	for (const job of Object.values(workflow.jobs)) {
		for (const step of job.steps.filter((step) => step.uses?.startsWith('oven-sh/setup-bun@'))) {
			expect(step.with['bun-version']).toBe(pin);
		}
	}
});
