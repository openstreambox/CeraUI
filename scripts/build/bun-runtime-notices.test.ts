import { afterEach, describe, expect, test } from 'bun:test';
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	truncateSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
	extractPrintedTexts,
	gitBlobId,
	type Inventory,
	isWholeComment,
	type RuntimeIdentity,
	renderSupplement,
	type SupplementPolicy,
	sha256,
	textFile,
	textKey,
	verifySupplement,
} from './bun-runtime-notices.ts';
import {
	compareOutput,
	grantExcerpts,
	headerExcerpt,
	isNamedNotice,
	licenceExcerpts,
	type Rules,
	readAr,
	readTar,
	refresh,
	writeOutput,
} from './bun-runtime-notices-refresh.ts';

const repoRoot = resolve(import.meta.dir, '../..');
const committedPolicy = JSON.parse(
	readFileSync(join(repoRoot, 'scripts/build/third-party-notices.json'), 'utf8'),
) as {
	firstParty: { licenceFiles: string[] };
	runtime: RuntimeIdentity & { file: string; supplement: SupplementPolicy };
};
const committedRules = JSON.parse(
	readFileSync(join(repoRoot, 'scripts/build/bun-runtime-notices.rules.json'), 'utf8'),
) as Rules;

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function scratch(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}
function write(root: string, path: string, data: string | Uint8Array) {
	const full = join(root, path);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, data);
}

// ---------------------------------------------------------------------------
// The committed inventory, checked offline the way every package build does.

describe('committed Bun runtime notices', () => {
	const verify = () =>
		verifySupplement(
			repoRoot,
			committedPolicy.runtime.supplement,
			committedPolicy.runtime,
			committedPolicy.firstParty.licenceFiles,
		);

	test('verify offline against the policy pin and the pinned Bun release', () => {
		const { inventory } = verify();
		expect(inventory.runtime.revision).toBe(committedPolicy.runtime.revision);
		expect(committedPolicy.runtime.supplement.inventory).toBe(
			`${committedRules.output}/inventory.json`,
		);
		const sections = new Set(inventory.texts.map((text) => text.section));
		for (const section of ['linked', 'headers', 'rust-std', 'crates', 'polyfills', 'cxx-runtime']) {
			expect(sections.has(section as never)).toBe(true);
		}
		const has = (origin: string, path: string) =>
			inventory.texts.some((text) => text.origin === origin && text.path === path);
		expect(has('gcc-13-base', 'usr/share/doc/gcc-13-base/copyright')).toBe(true);
		expect(has('webkit', 'Source/JavaScriptCore/COPYING.LIB')).toBe(true);
		expect(has('llvm', 'libcxxabi/LICENSE.TXT')).toBe(true);
		expect(has('icu', 'icu/LICENSE')).toBe(true);
		// Licences of ported projects that Bun keeps beside their test cases.
		expect(has('bun', 'test/cli/lint/conformance/licenses/eslint.txt')).toBe(true);
		expect(has('bun', 'test/cli/check/typescript-go/NOTICE.txt')).toBe(true);
		// Third-party grants in Bun's own runtime sources, including one in mid-file.
		for (const path of [
			'src/js/node/child_process.ts',
			'src/node-fallbacks/path.js',
			'src/jsc/bindings/libuv/uv.h',
			'src/lint/js_plugin/worker/main.js',
			'src/threading/ThreadPool.rs',
		]) {
			expect(has('bun', path)).toBe(true);
		}
		expect(inventory.excluded.every((entry) => entry.reason.trim().length > 10)).toBe(true);
	});

	test('keep every source excerpt to whole comments', () => {
		const { inventory, payload } = verify();
		const excerpts = inventory.texts.filter((text) => text.kind !== 'notice');
		expect(excerpts.length).toBeGreaterThan(0);
		for (const text of excerpts) {
			const bytes = payload.get(textKey(text)) as Uint8Array;
			expect(isWholeComment(bytes)).toBe(true);
		}
	});

	test('are generated from the rules in the tree, not edited by hand', () => {
		const { inventory } = verify();
		expect(inventory.statement).toBe(committedRules.statement);
		expect(inventory.buildOnly).toEqual(committedRules.buildOnly);
		expect(inventory.gaps.slice(0, committedRules.gaps.length)).toEqual(committedRules.gaps);
	});

	test('print every text once, whole and unchanged, in the copyright file', () => {
		const verified = verify();
		const printed = extractPrintedTexts(renderSupplement(verified));
		const unique = new Set(verified.inventory.texts.map((text) => text.sha256));
		expect(printed.size).toBe(unique.size);
		for (const text of verified.inventory.texts) {
			const bytes = printed.get(text.sha256);
			expect(bytes && sha256(bytes)).toBe(text.sha256);
			expect(bytes?.byteLength).toBe(text.size);
		}
	});

	test('the resolved GPL reference is checked against the packaged first-party text', () => {
		const { inventory } = verify();
		const gap = inventory.gaps.find((entry) => entry.id === 'gcc-gpl-3');
		expect(gap?.status).toBe('resolved');
		const evidence = gap?.evidence?.[0];
		expect(evidence?.kind).toBe('first-party');
		if (evidence?.kind === 'first-party') {
			expect(committedPolicy.firstParty.licenceFiles).toContain(evidence.file);
			expect(sha256(readFileSync(join(repoRoot, evidence.file)))).toBe(evidence.official.sha256);
		}
	});
});

// ---------------------------------------------------------------------------
// Red/green controls on a copy of the committed payload.

type Copy = { root: string; dir: string; policy: SupplementPolicy; inventory: Inventory };

function copyCommitted(): Copy {
	const root = scratch('bun-notices-copy-');
	const dir = join(root, 'notices');
	cpSync(join(repoRoot, committedRules.output), dir, { recursive: true });
	for (const file of committedPolicy.firstParty.licenceFiles)
		write(root, file, readFileSync(join(repoRoot, file)));
	const inventory = JSON.parse(readFileSync(join(dir, 'inventory.json'), 'utf8')) as Inventory;
	return {
		root,
		dir,
		policy: {
			inventory: 'notices/inventory.json',
			sha256: committedPolicy.runtime.supplement.sha256,
		},
		inventory,
	};
}

/** Write a changed inventory and pin it again, as a coordinated edit would. */
function repin(copy: Copy, inventory: Inventory) {
	const raw = `${JSON.stringify(inventory)}\n`;
	writeFileSync(join(copy.dir, 'inventory.json'), raw);
	copy.policy.sha256 = sha256(raw);
}

const check = (copy: Copy, runtime: RuntimeIdentity = committedPolicy.runtime) =>
	verifySupplement(copy.root, copy.policy, runtime, committedPolicy.firstParty.licenceFiles);

describe('offline checks reject', () => {
	test('nothing when the copy is unchanged (green control)', () => {
		expect(() => check(copyCommitted())).not.toThrow();
	});

	test('an omitted text', () => {
		const copy = copyCommitted();
		rmSync(join(copy.dir, textFile(copy.inventory.texts[0] as never)));
		expect(() => check(copy)).toThrow(/text missing/);
	});

	test('a truncated text', () => {
		const copy = copyCommitted();
		const text = copy.inventory.texts.find(
			(entry) => entry.size > 100,
		) as Inventory['texts'][number];
		truncateSync(join(copy.dir, textFile(text)), text.size - 1);
		expect(() => check(copy)).toThrow(/changed or truncated/);
	});

	test("a text moved under another entry's name", () => {
		const copy = copyCommitted();
		const [a, b] = [...new Set(copy.inventory.texts.map((text) => text.sha256))];
		writeFileSync(join(copy.dir, `texts/${b}`), readFileSync(join(copy.dir, `texts/${a}`)));
		expect(() => check(copy)).toThrow(/changed or truncated/);
	});

	test('a text the inventory does not list', () => {
		const copy = copyCommitted();
		write(copy.dir, `texts/${'0'.repeat(64)}`, 'stray\n');
		expect(() => check(copy)).toThrow(/not in the inventory/);
	});

	test('an inventory edited without a new policy pin', () => {
		const copy = copyCommitted();
		writeFileSync(join(copy.dir, 'inventory.json'), `${JSON.stringify(copy.inventory)}\n`);
		expect(() => check(copy)).toThrow(/inventory changed/);
	});

	test('texts swapped between two git entries, re-pinned, with their recorded blob ids left', () => {
		const copy = copyCommitted();
		const git = copy.inventory.texts.filter((text) => text.kind === 'notice' && text.gitBlob);
		const a = git[0] as Inventory['texts'][number];
		const b = git.find((text) => text.sha256 !== a.sha256) as Inventory['texts'][number];
		[a.sha256, b.sha256, a.size, b.size] = [b.sha256, a.sha256, b.size, a.size];
		repin(copy, copy.inventory);
		expect(() => check(copy)).toThrow(/does not match its recorded git blob/);
	});

	test('a git text rewritten with its sha256, size and pin but not its recorded blob id', () => {
		const copy = copyCommitted();
		const text = copy.inventory.texts.find(
			(entry) => entry.origin === 'webkit' && entry.kind === 'notice',
		) as Inventory['texts'][number];
		const forged = new TextEncoder().encode('Rewritten licence\n');
		write(copy.dir, `texts/${sha256(forged)}`, forged);
		text.sha256 = sha256(forged);
		text.size = forged.byteLength;
		repin(copy, copy.inventory);
		expect(() => check(copy)).toThrow(/does not match its recorded git blob/);
	});

	test('a source excerpt that runs on into code', () => {
		const copy = copyCommitted();
		const text = copy.inventory.texts.find(
			(entry) => entry.kind === 'header',
		) as Inventory['texts'][number];
		const bytes = new Uint8Array(readFileSync(join(copy.dir, textFile(text))));
		const spilled = Buffer.concat([bytes, Buffer.from('int code_after_the_comment;\n')]);
		write(copy.dir, `texts/${sha256(spilled)}`, spilled);
		text.sha256 = sha256(spilled);
		text.size = spilled.byteLength;
		repin(copy, copy.inventory);
		expect(() => check(copy)).toThrow(/not made of whole comments/);
	});

	test('an origin whose commit changed while its pin still names the old one', () => {
		const copy = copyCommitted();
		const origin = copy.inventory.origins.find(
			(entry) => entry.id === 'dep/zstd',
		) as Inventory['origins'][number];
		origin.commit = 'f'.repeat(40);
		repin(copy, copy.inventory);
		expect(() => check(copy)).toThrow(/dep\/zstd: no pin names its identity/);
	});

	test('an archive whose hash changed while the lockfile pin names the old one', () => {
		const copy = copyCommitted();
		const origin = copy.inventory.origins.find((entry) =>
			entry.id.startsWith('crate/'),
		) as Inventory['origins'][number];
		origin.sha256 = 'e'.repeat(64);
		repin(copy, copy.inventory);
		expect(() => check(copy)).toThrow(/no pin names its identity/);
	});

	test('a pin that does not lead back to the Bun revision', () => {
		const copy = copyCommitted();
		const origin = copy.inventory.origins.find(
			(entry) => entry.id === 'icu',
		) as Inventory['origins'][number];
		(origin.pins[0] as { origin: string }).origin = 'nowhere';
		repin(copy, copy.inventory);
		expect(() => check(copy)).toThrow(/pinned by unknown origin nowhere/);
	});

	test('an inventory for another Bun revision', () => {
		const copy = copyCommitted();
		expect(() => check(copy, { ...committedPolicy.runtime, revision: '1'.repeat(40) })).toThrow(
			/inventory is for Bun/,
		);
	});

	test('a gap marked resolved without evidence, or with evidence that does not check out', () => {
		const copy = copyCommitted();
		const open = copy.inventory.gaps.find(
			(gap) => gap.status === 'open',
		) as Inventory['gaps'][number];
		open.status = 'resolved';
		repin(copy, copy.inventory);
		expect(() => check(copy)).toThrow(/marked resolved without evidence/);

		open.evidence = [
			{
				kind: 'packaged-text',
				origin: 'webkit',
				path: 'Source/WTF/missing',
				sha256: '0'.repeat(64),
			},
		];
		repin(copy, copy.inventory);
		expect(() => check(copy)).toThrow(/is not a packaged text/);

		const gpl = copy.inventory.gaps.find(
			(gap) => gap.id === 'gcc-gpl-3',
		) as Inventory['gaps'][number];
		open.evidence = (gpl.evidence ?? []).map((evidence) =>
			evidence.kind === 'first-party'
				? { ...evidence, official: { ...evidence.official, sha256: '1'.repeat(64) } }
				: evidence,
		);
		repin(copy, copy.inventory);
		expect(() => check(copy)).toThrow(/is not a packaged first-party text/);
	});

	test('an excerpt that claims more bytes than its file has', () => {
		const copy = copyCommitted();
		const text = copy.inventory.texts.find(
			(entry) => entry.kind === 'excerpt',
		) as Inventory['texts'][number];
		text.fileSize = (text.offset ?? 0) + text.size - 1;
		repin(copy, copy.inventory);
		expect(() => check(copy)).toThrow(/does not fit inside its file/);
	});

	test('an excluded file without a reason, or one that is also packaged', () => {
		const copy = copyCommitted();
		const text = copy.inventory.texts[0] as Inventory['texts'][number];
		copy.inventory.excluded.push({ origin: text.origin, path: text.path, reason: 'also here' });
		(copy.inventory.excluded[0] as { reason: string }).reason = ' ';
		repin(copy, copy.inventory);
		expect(() => check(copy)).toThrow(/has no reason[\s\S]*both packaged and excluded/);
	});
});

// What the offline checks cannot see. These pass on purpose: they show that the
// package build and the default tests prove internal consistency only, and that
// relating the texts to their upstream sources needs the refresh `check` with
// the pinned inputs (see "regeneration from pinned inputs" below).

describe('offline checks do not authenticate the inventory', () => {
	test('a coordinated rewrite of a git text, its sha256, size, blob id and the pin passes', () => {
		const copy = copyCommitted();
		const text = copy.inventory.texts.find(
			(entry) => entry.origin === 'bun' && entry.kind === 'notice' && entry.gitBlob,
		) as Inventory['texts'][number];
		const forged = new TextEncoder().encode('Rewritten git licence\n');
		write(copy.dir, `texts/${sha256(forged)}`, forged);
		text.sha256 = sha256(forged);
		text.size = forged.byteLength;
		text.gitBlob = gitBlobId(forged);
		repin(copy, copy.inventory);
		const verified = check(copy);
		expect(new TextDecoder().decode(renderSupplement(verified))).toContain('Rewritten git licence');
	});

	test('a whole text entry dropped and the inventory re-pinned passes', () => {
		const copy = copyCommitted();
		const at = copy.inventory.texts.findIndex(
			(entry) => entry.origin === 'crate/allocator-api2-0.2.21',
		);
		const [dropped] = copy.inventory.texts.splice(at, 1);
		const still = copy.inventory.texts.some((entry) => entry.sha256 === dropped?.sha256);
		if (!still) rmSync(join(copy.dir, textFile(dropped as never)));
		repin(copy, copy.inventory);
		expect(() => check(copy)).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// Regeneration from pinned inputs, on a small synthetic set of them.

const GIT_ENV = {
	PATH: process.env.PATH ?? '/usr/bin:/bin',
	GIT_AUTHOR_NAME: 'Fixture',
	GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
	GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
	GIT_COMMITTER_NAME: 'Fixture',
	GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
	GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
	GIT_CONFIG_NOSYSTEM: '1',
	GIT_CONFIG_GLOBAL: '/dev/null',
};

function git(args: string[], cwd?: string): string {
	const result = Bun.spawnSync(['git', ...args], {
		...(cwd ? { cwd } : {}),
		env: GIT_ENV,
		stderr: 'pipe',
	});
	if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr.toString()}`);
	return result.stdout.toString().trim();
}

/** A bare repository in the cache with one commit of these files. */
function gitRepo(
	cache: string,
	name: string,
	files: Record<string, string>,
	tag?: string,
): { commit: string; tree: string; tagObject?: string } {
	const bare = join(cache, 'git', `${name}.git`);
	const work = mkdtempSync(join(tmpdir(), 'bun-notices-work-'));
	dirs.push(work);
	git(['init', '-q', '--bare', bare]);
	for (const [path, text] of Object.entries(files)) write(work, path, text);
	const g = (args: string[]) => git(['--git-dir', bare, '--work-tree', work, ...args]);
	g(['add', '-A']);
	g(['commit', '-q', '-m', 'fixture']);
	const commit = g(['rev-parse', 'HEAD']);
	const tree = g(['rev-parse', 'HEAD^{tree}']);
	if (!tag) return { commit, tree };
	g(['tag', '-a', tag, '-m', tag]);
	return { commit, tree, tagObject: g(['rev-parse', tag]) };
}

function tar(files: Record<string, string | Uint8Array>): Uint8Array<ArrayBuffer> {
	const blocks: Uint8Array[] = [];
	const enc = new TextEncoder();
	const field = (header: Uint8Array, at: number, text: string) => header.set(enc.encode(text), at);
	for (const [path, data] of Object.entries(files)) {
		const body = typeof data === 'string' ? enc.encode(data) : data;
		const header = new Uint8Array(512);
		const split = path.length > 100 ? path.lastIndexOf('/', path.length - 101 >= 0 ? 154 : 0) : -1;
		field(header, 0, split > 0 ? path.slice(split + 1) : path);
		if (split > 0) field(header, 345, path.slice(0, split));
		field(header, 100, '0000644\0');
		field(header, 108, '0000000\0');
		field(header, 116, '0000000\0');
		field(header, 124, `${body.byteLength.toString(8).padStart(11, '0')}\0`);
		field(header, 136, '00000000000\0');
		field(header, 148, '        ');
		field(header, 156, path.endsWith('/') ? '5' : '0');
		field(header, 257, 'ustar\u000000');
		const sum = header.reduce((total, byte) => total + byte, 0);
		field(header, 148, `${sum.toString(8).padStart(6, '0')}\0 `);
		blocks.push(header, body, new Uint8Array((512 - (body.byteLength % 512)) % 512));
	}
	blocks.push(new Uint8Array(1024));
	return new Uint8Array(Buffer.concat(blocks));
}

function xz(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
	const result = Bun.spawnSync(['xz', '--compress', '--stdout'], { stdin: bytes });
	if (result.exitCode !== 0) throw new Error('xz failed');
	return new Uint8Array(result.stdout);
}

function ar(members: Record<string, Uint8Array>): Uint8Array<ArrayBuffer> {
	const parts: Uint8Array[] = [new TextEncoder().encode('!<arch>\n')];
	for (const [name, body] of Object.entries(members)) {
		const header = `${`${name}/`.padEnd(16)}${'0'.padEnd(12)}${'0'.padEnd(6)}${'0'.padEnd(6)}${'100644'.padEnd(8)}${String(body.byteLength).padEnd(10)}\`\n`;
		parts.push(new TextEncoder().encode(header), body);
		if (body.byteLength % 2) parts.push(new Uint8Array([0x0a]));
	}
	return new Uint8Array(Buffer.concat(parts));
}

function deb(files: Record<string, string>): Uint8Array<ArrayBuffer> {
	return ar({
		'debian-binary': new TextEncoder().encode('2.0\n'),
		'control.tar.xz': xz(tar({ './control': 'Package: fixture\n' })),
		'data.tar.xz': xz(tar({ './': '', ...files })),
	});
}

const integrity = (bytes: Uint8Array) =>
	`sha512-${new Bun.CryptoHasher('sha512').update(bytes).digest('base64')}`;

type Fixture = { root: string; cache: string; rules: Rules };

const RUST_COPYRIGHT =
	'Rust copyright fixture.\nWe use [REUSE](https://reuse.software) to track license information for\n' +
	'in-tree source files - both those authored by the Rust project and those\n' +
	'authored by third parties. See `REUSE.toml`, and more.\n';

/** A CeraUI-shaped root and a cache of synthetic pinned inputs for every kind of origin. */
function fixture(): Fixture {
	const root = scratch('bun-notices-root-');
	const cache = join(root, 'cache');
	const files = (name: string, bytes: Uint8Array) => write(cache, `files/${name}`, bytes);
	const runtimeLicence =
		'Fixture Bun licence.\n| `bun lint` ports [Linty](https://example.invalid/linty) | MIT |\n' +
		'The tests in `test/lint` include test cases from Linty. ' +
		'They are not part of the `bun` binary. Their licenses are next to them.\n';
	write(root, 'apps/backend/LICENSE', 'GPL fixture text\n');
	write(root, 'notices/bun-LICENSE.md', runtimeLicence);

	const alpha = gitRepo(
		cache,
		'example/alpha',
		{
			COPYING: 'Alpha.\nEach file keeps its own statement at the beginning of the file.\n',
			AUTHORS: 'Alice Example\n',
			'tests/LICENSE': 'test data licence\n',
			'lib/x.c':
				'/* Copyright 2020 Alice Example\n * Permission to use this file is granted.\n */\nint x;\n',
			'lib/plain.c': 'int nothing;\n',
		},
		'v1.0',
	);
	const winonly = gitRepo(cache, 'example/winonly', { LICENSE: 'Windows-only licence\n' });
	const icuTar = Bun.gzipSync(
		tar({ 'icu/LICENSE': 'ICU licence\n', 'icu/source/test/LICENSE': 'ICU test\n' }),
	);
	files('icu4c-9.1-sources.tgz', icuTar);
	const webkit = gitRepo(cache, 'example/WebKit', {
		'Source/JavaScriptCore/COPYING.LIB': 'LGPL fixture\n',
		'Source/JavaScriptCore/tests/LICENSE': 'JSC test licence\n',
		'Source/WTF/LICENSE-thing.txt': 'WTF third-party licence\n',
		'Source/bmalloc/heap.cpp':
			'/*\n * Copyright (C) 2020 Fixture Inc.\n * Redistribution and use permitted.\n */\nint heap;\n',
		'Source/bmalloc/mimalloc/LICENSE': 'WebKit mimalloc licence\n',
		'Source/ThirdParty/gtest/LICENSE': 'gtest licence\n',
		'icu/source.json': JSON.stringify({ version: '9.1', sha256: sha256(icuTar) }, null, 2),
		'.github/scripts/lanes.mjs': '// Bun links its own mimalloc.\n',
	});
	const llvm = gitRepo(
		cache,
		'example/llvm-project',
		{ 'libcxxabi/LICENSE.TXT': 'Apache-2.0 WITH LLVM-exception fixture\n' },
		'llvmorg-1.0.0',
	);
	const rust = gitRepo(cache, 'example/rust', {
		COPYRIGHT: RUST_COPYRIGHT,
		'REUSE.toml':
			'version = 1\n[[annotations]]\npath = ["library/**"]\nSPDX-License-Identifier = "MIT OR Apache-2.0"\n[[annotations]]\npath = "compiler/**"\nSPDX-License-Identifier = "GPL-3.0-or-later"\n',
		'LICENSES/MIT.txt': 'MIT text\n',
		'LICENSES/Apache-2.0.txt': 'Apache text\n',
		'LICENSES/GPL-3.0-or-later.txt': 'GPL text\n',
	});

	const crate = (name: string, members: Record<string, string>) => {
		const bytes = Bun.gzipSync(
			tar(Object.fromEntries(Object.entries(members).map(([p, t]) => [`${name}-1.0.0/${p}`, t]))),
		);
		files(`${name}-1.0.0.crate`, bytes);
		return sha256(bytes);
	};
	const keep = crate('keep', {
		'LICENSE-MIT': 'keep MIT\n',
		'Cargo.toml': '[package]\nname = "keep"\nlicense = "MIT"\n',
	});
	const devonly = crate('devonly', { LICENSE: 'dev-only crate licence\n' });
	const bare = crate('bare', { 'Cargo.toml': '[package]\nname = "bare"\nlicense = "MIT"\n' });
	const npm = (name: string, members: Record<string, string>) => {
		const bytes = Bun.gzipSync(
			tar(Object.fromEntries(Object.entries(members).map(([p, t]) => [`package/${p}`, t]))),
		);
		files(`${name}-1.0.0.tgz`, bytes);
		return integrity(bytes);
	};
	const polly = npm('polly', { LICENSE: 'polly licence\n', 'package.json': '{"license":"MIT"}' });
	const readmeOnly = npm('readmeonly', {
		'README.md':
			'# readmeonly\n\n## License\n\nCopyright 2020 Rita\n\nPermission is hereby granted, free of charge.\n',
		'package.json': '{"license":"MIT"}',
	});

	const std = xz(tar({ 'rust-std-nightly-aarch64-unknown-linux-gnu/COPYRIGHT': RUST_COPYRIGHT }));
	const src = xz(
		tar({
			'rust-src-nightly/COPYRIGHT': 'top\n',
			'rust-src-nightly/rust-src/lib/rustlib/src/rust/library/vendor/foo-1.0/LICENSE-MIT':
				'foo MIT\n',
			'rust-src-nightly/rust-src/lib/rustlib/src/rust/library/core/tests/LICENSE': 'core tests\n',
		}),
	);
	files('rust-std-nightly-aarch64-unknown-linux-gnu.tar.xz', std);
	files('rust-src-nightly.tar.xz', src);
	const dist = 'https://static.rust-lang.org/dist/2026-01-02/';
	const manifest = new TextEncoder().encode(
		`date = "2026-01-02"\n[pkg.rustc]\ngit_commit_hash = "${rust.commit}"\n` +
			`[pkg.rust-std.target.aarch64-unknown-linux-gnu]\nxz_url = "${dist}rust-std-nightly-aarch64-unknown-linux-gnu.tar.xz"\nxz_hash = "${sha256(std)}"\n` +
			`[pkg.rust-src.target."*"]\nxz_url = "${dist}rust-src-nightly.tar.xz"\nxz_hash = "${sha256(src)}"\n`,
	);
	files('channel-rust-nightly.toml', manifest);
	files(
		'channel-rust-nightly.toml.sha256',
		new TextEncoder().encode(`${sha256(manifest)}  channel-rust-nightly.toml\n`),
	);
	const gcc = Bun.gzipSync(
		tar({
			'gcc-13-base_1.0_arm64.deb': deb({
				'./usr/share/doc/gcc-13-base/copyright': 'GCC runtime copyright fixture\n',
			}),
			'gcc-9-base_1.0_arm64.deb': deb({
				'./usr/share/doc/gcc-9-base/copyright': 'other GCC branch\n',
			}),
		}),
	);
	files('gcc-13-focal-arm64.tar.gz', gcc);

	const bun = gitRepo(cache, 'example/bun', {
		'LICENSE.md': runtimeLicence,
		'Cargo.toml': '[workspace]\nmembers = ["src/app"]\n',
		'src/app/Cargo.toml':
			'[package]\nname = "app"\nversion = "0.1.0"\n[dependencies]\nkeep = "1"\nbare = "1"\n[dev-dependencies]\ndevonly = "1"\n',
		'Cargo.lock': [
			'version = 4',
			'[[package]]\nname = "app"\nversion = "0.1.0"\ndependencies = ["bare", "devonly", "keep"]',
			`[[package]]\nname = "bare"\nversion = "1.0.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "${bare}"`,
			`[[package]]\nname = "devonly"\nversion = "1.0.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "${devonly}"`,
			`[[package]]\nname = "keep"\nversion = "1.0.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "${keep}"`,
		].join('\n\n'),
		'scripts/build/deps/README.md': 'Recipes for vendored libraries.\n',
		'scripts/build/deps/alpha.ts': `const ALPHA_COMMIT = "${alpha.tagObject}";\nexport const alpha = {\n  source: () => ({\n    kind: "github-archive",\n    repo: "example/alpha",\n    commit: ALPHA_COMMIT,\n  }),\n};\n`,
		'scripts/build/deps/winonly.ts': `const WINONLY_COMMIT = "${winonly.commit}";\nexport const winonly = {\n  enabled: cfg => cfg.windows,\n  source: () => ({\n    kind: "github-archive",\n    repo: "example/winonly",\n    commit: WINONLY_COMMIT,\n  }),\n};\n`,
		'scripts/build/deps/webkit.ts': `export const WEBKIT_VERSION = "${webkit.commit}";\n`,
		'rust-toolchain.toml': '[toolchain]\nchannel = "nightly-2026-01-02"\n',
		'src/node-fallbacks/bun.lock': `{\n  "packages": {\n    "polly": ["polly@1.0.0", "", {}, "${polly}"],\n\n    "readmeonly": ["readmeonly@1.0.0", "", { "dependencies": {} }, "${readmeOnly}"],\n  }\n}\n`,
		'scripts/build/ci-images/spec.ts': `    gccDebs: {\n      url: "https://example.invalid/gcc-debs",\n      sha256: {\n        x64: "${'0'.repeat(64)}",\n        aarch64: "${sha256(gcc)}",\n      },\n    },\n            url: \`\${gccDebs.url}/gcc-13-focal-\${deb}.tar.gz\`,\n`,
		'scripts/build/flags.ts': 'flag: ["-static-libstdc++", "-static-libgcc"],\n',
		'src/jsc/bindings/workaround.cpp':
			'// From https://example.invalid/llvmorg-1.0.0/cxa_thread_atexit.cpp\n',
		'src/jsc/bindings/sqlite/sqlite3.c':
			'/*\n** The author disclaims copyright to this source code.\n*/\nint db;\n' +
			'/*\n** 2002 May 1\n** The author disclaims copyright to this source code.\n*/\nint more;\n',
		'src/node/child.ts':
			'export const a = 1;\n\n// Copyright Joyent, Inc.\n//\n// Permission is hereby granted, free of charge.\n\n' +
			'// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY.\n\n// A note about the code below.\nexport const b = 2;\n',
		'src/core/attrib.rs': '//! A port of thing (MIT, Copyright (c) 2020 Someone).\nfn x() {}\n',
		'src/core/plain.rs': '// Nothing to see.\nfn y() {}\n',
		'src/win/w.c': '/* Copyright 2020 W\n * Permission is hereby granted.\n */\nint w;\n',
		'src/data/list.txt': 'text/plain\ntext/vnd.debian.copyright\n',
		'test/lint/licenses/linty.txt': 'Linty MIT licence\n',
		'test/lint/licenses/fixture-only.txt': 'fixture package licence\n',
		'src/core/LICENSE': 'core licence\n',
		'src/core/test/LICENSE': 'core test licence\n',
		'test/cases/LICENSE': 'test case licence\n',
		'packages/other/LICENSE': 'other package licence\n',
	});

	const rules: Rules = {
		...committedRules,
		output: 'out/bun-notices',
		bun: {
			...committedRules.bun,
			repo: 'example/bun',
			tree: bun.tree,
			ported: {
				quote: {
					origin: 'bun',
					path: 'LICENSE.md',
					quote: 'The tests in `test/lint` include test cases from Linty.',
				},
				texts: { 'test/lint/licenses/linty.txt': 'https://example.invalid/linty' },
			},
		},
		deps: {
			dir: 'scripts/build/deps/',
			enabled: committedRules.deps.enabled,
			notArchive: { 'README.md': 'documentation', 'webkit.ts': 'WebKit' },
			roles: { alpha: 'Alpha library', winonly: 'Windows library' },
			submodules: {},
		},
		webkit: {
			...committedRules.webkit,
			repo: 'example/WebKit',
			skip: {
				'Source/bmalloc/mimalloc/': {
					origin: 'webkit',
					path: '.github/scripts/lanes.mjs',
					quote: 'Bun links its own mimalloc.',
					reason: "WebKit's own mimalloc",
				},
			},
		},
		icu: {
			pinFile: 'icu/source.json',
			url: 'https://example.invalid/icu/icu4c-{version}-sources.tgz',
		},
		rust: {
			...committedRules.rust,
			rustc: rust.commit,
			repo: 'example/rust',
			channel: 'nightly-2026-01-02',
			manifestSha256: sha256(manifest),
		},
		llvm: {
			repo: 'example/llvm-project',
			url: 'https://example.invalid/llvm-project',
			tag: 'llvmorg-1.0.0',
			tagObject: llvm.tagObject as string,
			commit: llvm.commit,
			paths: ['libcxxabi/LICENSE.TXT'],
			cited: {
				origin: 'bun',
				path: 'src/jsc/bindings/workaround.cpp',
				quote: 'llvmorg-1.0.0/cxa_thread_atexit.cpp',
			},
		},
		gcc: { ...committedRules.gcc, runtimeDeb: 'gcc-13-base_1.0_arm64.deb' },
		quotes: [
			{ origin: 'bun', path: 'LICENSE.md', quote: 'They are not part of the `bun` binary.' },
		],
		headers: [
			{
				origin: 'dep/alpha',
				roots: ['lib/'],
				extent: 'leading',
				pointer: {
					origin: 'dep/alpha',
					path: 'COPYING',
					quote: 'Each file keeps its own statement at the beginning of the file.',
				},
			},
			{
				origin: 'bun',
				roots: ['src/'],
				skip: { 'src/win/': 'Windows-only source' },
				extent: 'grants',
				only: "Bun's sources keep third-party licences in comments",
				notNotices: {
					'src/data/list.txt': { quotes: ['text/vnd.debian.copyright'], reason: 'a MIME type' },
				},
				repeated: {
					'src/jsc/bindings/sqlite/sqlite3.c': {
						quote: 'The author disclaims copyright to this source code.',
						reason: 'The amalgamation repeats its dedication',
					},
				},
			},
			{
				origin: 'webkit',
				roots: ['Source/bmalloc/'],
				skip: { 'Source/bmalloc/mimalloc/': "WebKit's own mimalloc" },
				extent: 'leading',
				only: 'bmalloc has no licence file',
			},
		],
		gaps: [
			{ id: 'open-one', status: 'open', text: 'A stated open gap.' },
			{
				id: 'gpl',
				status: 'resolved',
				text: 'A referenced GPL text.',
				evidence: [
					{
						kind: 'first-party',
						file: 'apps/backend/LICENSE',
						sha256: sha256('GPL fixture text\n'),
						official: {
							url: 'https://example.invalid/gpl.txt',
							sha256: sha256('GPL fixture text\n'),
						},
					},
				],
			},
		],
	};
	write(root, 'scripts/build/bun-runtime-notices.rules.json', JSON.stringify(rules, null, '\t'));
	write(
		root,
		'scripts/build/third-party-notices.json',
		JSON.stringify({
			firstParty: { licenceFiles: ['apps/backend/LICENSE'] },
			runtime: {
				name: 'Bun',
				version: '9.9.9',
				revision: bun.commit,
				sha256: sha256(runtimeLicence),
				file: 'notices/bun-LICENSE.md',
			},
		}),
	);
	return { root, cache, rules };
}

function runtimeOf(f: Fixture): RuntimeIdentity {
	return JSON.parse(readFileSync(join(f.root, 'scripts/build/third-party-notices.json'), 'utf8'))
		.runtime;
}

/** Regenerate into the fixture's output directory and verify it offline. */
async function regenerate(f: Fixture) {
	const result = await refresh(f.root, f.cache);
	expect(result.missing).toEqual([]);
	writeOutput(join(f.root, f.rules.output), result.files);
	const policy: SupplementPolicy = {
		inventory: `${f.rules.output}/inventory.json`,
		sha256: sha256(result.files.get('inventory.json') as Uint8Array),
	};
	const verified = verifySupplement(f.root, policy, runtimeOf(f), ['apps/backend/LICENSE']);
	return { result, policy, verified };
}

describe('regeneration from pinned inputs', () => {
	test('packages runtime notices and records every other named file with its reason', async () => {
		const f = fixture();
		const { verified } = await regenerate(f);
		const inv = verified.inventory;
		const packaged = new Set(inv.texts.map((text) => `${text.origin}:${text.path}`));
		const excluded = new Map(
			inv.excluded.map((entry) => [`${entry.origin}:${entry.path}`, entry.reason]),
		);
		for (const key of [
			'bun:src/core/LICENSE',
			'dep/alpha:COPYING',
			'dep/alpha:AUTHORS',
			'webkit:Source/JavaScriptCore/COPYING.LIB',
			'webkit:Source/WTF/LICENSE-thing.txt',
			'icu:icu/LICENSE',
			'llvm:libcxxabi/LICENSE.TXT',
			'rust:REUSE.toml',
			'rust:LICENSES/MIT.txt',
			'rust:LICENSES/Apache-2.0.txt',
			'rust-std:rust-std-nightly-aarch64-unknown-linux-gnu/COPYRIGHT',
			'rust-src:rust-src-nightly/rust-src/lib/rustlib/src/rust/library/vendor/foo-1.0/LICENSE-MIT',
			'crate/keep-1.0.0:keep-1.0.0/LICENSE-MIT',
			'npm/polly-1.0.0:package/LICENSE',
			'npm/readmeonly-1.0.0:package/README.md',
			'gcc-13-base:usr/share/doc/gcc-13-base/copyright',
			'dep/alpha:lib/x.c',
			'bun:src/jsc/bindings/sqlite/sqlite3.c',
			'bun:src/node/child.ts',
			'bun:test/lint/licenses/linty.txt',
			'webkit:Source/bmalloc/heap.cpp',
		]) {
			expect(packaged.has(key)).toBe(true);
		}
		const text = (origin: string, path: string) =>
			inv.texts.filter((entry) => entry.origin === origin && entry.path === path);
		const bytesOf = (entry: Inventory['texts'][number]) =>
			new TextDecoder().decode(verified.payload.get(textKey(entry)));
		// A grant in mid-file, with its warranty after a blank line, without the note after it.
		const [child] = text('bun', 'src/node/child.ts');
		expect(child?.kind).toBe('excerpt');
		expect(child?.offset).toBe('export const a = 1;\n\n'.length);
		expect(bytesOf(child as never)).toBe(
			'// Copyright Joyent, Inc.\n//\n// Permission is hereby granted, free of charge.\n\n' +
				'// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY.\n',
		);
		// The leading header of a pointed-to file stops before the code.
		expect(bytesOf(text('dep/alpha', 'lib/x.c')[0] as never)).toBe(
			'/* Copyright 2020 Alice Example\n * Permission to use this file is granted.\n */\n',
		);
		// A repeated dedication is printed once.
		expect(text('bun', 'src/jsc/bindings/sqlite/sqlite3.c').length).toBe(1);
		expect(text('bun', 'src/jsc/bindings/sqlite/sqlite3.c')[0]?.because).toMatch(
			/1 later copies are not printed/,
		);
		// A ported project's licence, kept beside test cases, with the reason it is in.
		const [linty] = text('bun', 'test/lint/licenses/linty.txt');
		expect(linty?.section).toBe('ported');
		expect(linty?.because).toMatch(/example\.invalid\/linty/);
		expect(excluded.get('bun:test/lint/licenses/fixture-only.txt')).toBe(
			f.rules.bun.excludedRoots['test/'],
		);
		expect(excluded.get('bun:src/win/w.c')).toBe('Windows-only source');
		expect(packaged.has('bun:src/core/plain.rs')).toBe(false);
		expect(packaged.has('bun:src/data/list.txt')).toBe(false);
		expect(excluded.get('bun:LICENSE.md')).toBe(f.rules.licenceExclusion);
		expect(excluded.get('bun:src/core/test/LICENSE')).toBe(f.rules.testReason);
		expect(excluded.get('bun:test/cases/LICENSE')).toBe(f.rules.bun.excludedRoots['test/']);
		expect(excluded.get('bun:packages/other/LICENSE')).toBe(f.rules.bun.excludedRoots['packages/']);
		expect(excluded.get('dep/alpha:tests/LICENSE')).toBe(f.rules.testReason);
		expect(excluded.get('dep/winonly:LICENSE')).toMatch(/only for Windows/);
		expect(excluded.get('webkit:Source/ThirdParty/gtest/LICENSE')).toBe(f.rules.webkit.otherReason);
		expect(excluded.get('webkit:Source/bmalloc/mimalloc/LICENSE')).toBe("WebKit's own mimalloc");
		expect(excluded.get('webkit:Source/JavaScriptCore/tests/LICENSE')).toBe(f.rules.testReason);
		expect(excluded.get('icu:icu/source/test/LICENSE')).toBe(f.rules.testReason);
		expect(excluded.get('crate/devonly-1.0.0:devonly-1.0.0/LICENSE')).toBe(
			f.rules.crates.devOnlyReason,
		);
		expect(excluded.get('rust:LICENSES/GPL-3.0-or-later.txt')).toMatch(/outside library/);
		expect(excluded.get('rust:COPYRIGHT')).toMatch(
			/identical to the copy in the rust-std component/,
		);
		expect(
			excluded.get('gcc-archive:gcc-9-base_1.0_arm64.deb/usr/share/doc/gcc-9-base/copyright'),
		).toBe(f.rules.gcc.otherReason);
		expect(packaged.has('dep/alpha:lib/plain.c')).toBe(false);

		const alpha = inv.origins.find((origin) => origin.id === 'dep/alpha');
		expect(alpha?.peeled).toBeDefined();
		const gaps = new Map(inv.gaps.map((gap) => [gap.id, gap]));
		expect(gaps.get('no-notice-crate/bare-1.0.0')?.status).toBe('open');
		expect(gaps.get('no-notice-npm/readmeonly-1.0.0')?.status).toBe('resolved');
		expect(gaps.get('gpl')?.status).toBe('resolved');
		// A copyright mention without its licence text is stated, not dropped.
		const unprinted = gaps.get('unpackaged-statements-bun');
		expect(unprinted?.status).toBe('open');
		expect(unprinted?.text).toMatch(/^1 files of bun .*src\/core\/attrib\.rs/);
	});

	test('is deterministic and matches a committed copy until one is rewritten', async () => {
		const f = fixture();
		const { result, policy } = await regenerate(f);
		const again = await refresh(f.root, f.cache);
		expect(compareOutput(join(f.root, f.rules.output), again.files)).toEqual([]);
		expect([...again.files.keys()]).toEqual([...result.files.keys()]);

		// A coordinated rewrite of an archive text: new bytes, its sha256 and size in
		// the inventory, and the policy pin. The offline check cannot see it...
		const dir = join(f.root, f.rules.output);
		const inventory = JSON.parse(readFileSync(join(dir, 'inventory.json'), 'utf8')) as Inventory;
		const text = inventory.texts.find(
			(entry) => entry.origin === 'crate/keep-1.0.0',
		) as Inventory['texts'][number];
		const forged = new TextEncoder().encode('keep, rewritten\n');
		rmSync(join(dir, textFile(text)));
		write(dir, `texts/${sha256(forged)}`, forged);
		text.sha256 = sha256(forged);
		text.size = forged.byteLength;
		const raw = `${JSON.stringify(inventory)}\n`;
		writeFileSync(join(dir, 'inventory.json'), raw);
		policy.sha256 = sha256(raw);
		expect(() =>
			verifySupplement(f.root, policy, runtimeOf(f), ['apps/backend/LICENSE']),
		).not.toThrow();
		// ...regenerating from the pinned inputs does.
		const problems = compareOutput(dir, (await refresh(f.root, f.cache)).files);
		expect(problems).toContain('differs: inventory.json');
		expect(problems).toContain(`not produced by the inputs: texts/${sha256(forged)}`);
	});

	test('a coordinated rewrite of a git text with its blob id passes offline, and check rejects it', async () => {
		const f = fixture();
		const { policy } = await regenerate(f);
		const dir = join(f.root, f.rules.output);
		const inventory = JSON.parse(readFileSync(join(dir, 'inventory.json'), 'utf8')) as Inventory;
		const text = inventory.texts.find(
			(entry) => entry.origin === 'dep/alpha' && entry.path === 'COPYING',
		) as Inventory['texts'][number];
		const forged = new TextEncoder().encode('Alpha, rewritten.\n');
		rmSync(join(dir, textFile(text)));
		write(dir, `texts/${sha256(forged)}`, forged);
		Object.assign(text, {
			sha256: sha256(forged),
			size: forged.byteLength,
			gitBlob: gitBlobId(forged),
		});
		const raw = `${JSON.stringify(inventory)}\n`;
		writeFileSync(join(dir, 'inventory.json'), raw);
		policy.sha256 = sha256(raw);
		expect(() =>
			verifySupplement(f.root, policy, runtimeOf(f), ['apps/backend/LICENSE']),
		).not.toThrow();
		const problems = compareOutput(dir, (await refresh(f.root, f.cache)).files);
		expect(problems).toContain('differs: inventory.json');
		expect(problems).toContain(`not produced by the inputs: texts/${sha256(forged)}`);
	});

	test('refuses inputs that do not match their pins', async () => {
		const f = fixture();
		write(
			f.cache,
			'files/keep-1.0.0.crate',
			Bun.gzipSync(tar({ 'keep-1.0.0/LICENSE-MIT': 'swapped\n' })),
		);
		await expect(refresh(f.root, f.cache)).rejects.toThrow(
			/keep-1.0.0.crate does not match its pin/,
		);
	});

	test('reports missing inputs with their URL and expected identity', async () => {
		const f = fixture();
		rmSync(join(f.cache, 'files/polly-1.0.0.tgz'));
		const result = await refresh(f.root, f.cache);
		expect(result.missing.join('\n')).toMatch(
			/registry\.npmjs\.org\/polly\/-\/polly-1\.0\.0\.tgz \(sha512-/,
		);
	});

	test('refuses a Bun tree, tag or rule the rules do not expect', async () => {
		const f = fixture();
		const rulesPath = join(f.root, 'scripts/build/bun-runtime-notices.rules.json');
		const save = (rules: Rules) => writeFileSync(rulesPath, JSON.stringify(rules));
		save({ ...f.rules, bun: { ...f.rules.bun, tree: '0'.repeat(40) } });
		await expect(refresh(f.root, f.cache)).rejects.toThrow(/the rules expect/);
		save({ ...f.rules, llvm: { ...f.rules.llvm, tag: 'llvmorg-2.0.0' } });
		await expect(refresh(f.root, f.cache)).rejects.toThrow(/does not point at/);
		save({ ...f.rules, deps: { ...f.rules.deps, enabled: {} } });
		await expect(refresh(f.root, f.cache)).rejects.toThrow(/unreviewed build condition/);
		save({ ...f.rules, deps: { ...f.rules.deps, notArchive: { 'webkit.ts': 'WebKit' } } });
		await expect(refresh(f.root, f.cache)).rejects.toThrow(/unreviewed dependency recipe/);
		save({
			...f.rules,
			headers: [
				{
					origin: 'dep/alpha',
					roots: ['lib/'],
					extent: 'leading',
					pointer: { origin: 'dep/alpha', path: 'COPYING', quote: 'words it does not contain' },
				},
			],
		});
		await expect(refresh(f.root, f.cache)).rejects.toThrow(/no longer says/);
	});

	test('binds the Rust manifest to the sha256 in the rules, not to the cached sidecar', async () => {
		const f = fixture();
		const rulesPath = join(f.root, 'scripts/build/bun-runtime-notices.rules.json');
		const save = (rules: Rules) => writeFileSync(rulesPath, JSON.stringify(rules));
		// A changed manifest with a matching sidecar: the sidecar does not enrol it.
		const forged = new TextEncoder().encode(
			'date = "2026-01-02"\n[pkg.rustc]\ngit_commit_hash = "x"\n',
		);
		write(f.cache, 'files/channel-rust-nightly.toml', forged);
		write(f.cache, 'files/channel-rust-nightly.toml.sha256', `${sha256(forged)}  x\n`);
		await expect(refresh(f.root, f.cache)).rejects.toThrow(
			/channel-rust-nightly\.toml does not match its pin/,
		);
		// A sidecar that disagrees with the pin.
		const g = fixture();
		write(g.cache, 'files/channel-rust-nightly.toml.sha256', `${'0'.repeat(64)}  x\n`);
		await expect(refresh(g.root, g.cache)).rejects.toThrow(/published \.sha256 differs/);
		// Another channel in Bun than in the rules, or no pin at all.
		save({ ...f.rules, rust: { ...f.rules.rust, channel: 'nightly-2026-01-03' } });
		await expect(refresh(f.root, f.cache)).rejects.toThrow(/the rules pin the manifest of/);
		save({ ...f.rules, rust: { ...f.rules.rust, manifestSha256: '' } });
		await expect(refresh(f.root, f.cache)).rejects.toThrow(/pin no Rust manifest sha256/);
	});

	test('refuses a crate from a source the rules do not cover, and states a covered one', async () => {
		const f = fixture();
		const lockPath = 'Cargo.lock';
		const rulesPath = join(f.root, 'scripts/build/bun-runtime-notices.rules.json');
		// Add a git-sourced crate to the fixture's Bun tree.
		const bare = join(f.cache, 'git', 'example/bun.git');
		const work = scratch('bun-notices-relock-');
		git(['--git-dir', bare, '--work-tree', work, 'checkout', '-q', 'HEAD', '--', '.']);
		const lock = readFileSync(join(work, lockPath), 'utf8');
		write(
			work,
			lockPath,
			`${lock}\n\n[[package]]\nname = "gitdep"\nversion = "0.1.0"\nsource = "git+https://example.invalid/gitdep#abc"\n`,
		);
		const g = (args: string[]) => git(['--git-dir', bare, '--work-tree', work, ...args]);
		g(['add', '-A']);
		g(['commit', '-q', '-m', 'git crate']);
		const commit = g(['rev-parse', 'HEAD']);
		const tree = g(['rev-parse', 'HEAD^{tree}']);
		const policyPath = join(f.root, 'scripts/build/third-party-notices.json');
		const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
		policy.runtime.revision = commit;
		writeFileSync(policyPath, JSON.stringify(policy));
		const rules = { ...f.rules, bun: { ...f.rules.bun, tree } };
		writeFileSync(rulesPath, JSON.stringify(rules));
		await expect(refresh(f.root, f.cache)).rejects.toThrow(
			/crate gitdep 0\.1\.0 comes from git\+https:\/\/example\.invalid\/gitdep#abc/,
		);
		writeFileSync(
			rulesPath,
			JSON.stringify({
				...rules,
				crates: { ...rules.crates, otherSources: { 'gitdep 0.1.0': 'a git dependency, not read' } },
			}),
		);
		const result = await refresh(f.root, f.cache);
		const gap = result.inventory.gaps.find((entry) => entry.id === 'crate-source-gitdep-0.1.0');
		expect(gap?.status).toBe('open');
		expect(gap?.text).toMatch(/a git dependency, not read/);
	});

	test('refuses accounting rules that no longer match the sources', async () => {
		const f = fixture();
		const rulesPath = join(f.root, 'scripts/build/bun-runtime-notices.rules.json');
		const bunRule = f.rules.headers.find(
			(rule) => rule.origin === 'bun',
		) as Rules['headers'][number];
		const save = (rule: Rules['headers'][number]) =>
			writeFileSync(
				rulesPath,
				JSON.stringify({
					...f.rules,
					headers: f.rules.headers.map((item) => (item.origin === 'bun' ? rule : item)),
				}),
			);
		save({ ...bunRule, notNotices: { 'src/data/list.txt': { quotes: ['gone'], reason: 'x' } } });
		await expect(refresh(f.root, f.cache)).rejects.toThrow(/no longer has an unprinted comment/);
		save({
			...bunRule,
			repeated: { 'src/node/child.ts': { quote: 'Permission is hereby granted', reason: 'x' } },
		});
		await expect(refresh(f.root, f.cache)).rejects.toThrow(/no longer repeats/);
		save({ ...bunRule, notNotices: { 'src/elsewhere.txt': { quotes: ['x'], reason: 'x' } } });
		await expect(refresh(f.root, f.cache)).rejects.toThrow(
			/rules for files outside the header rule/,
		);
		save({ ...bunRule, extent: undefined as never });
		await expect(refresh(f.root, f.cache)).rejects.toThrow(/has no extent/);
	});

	test('refuses a ported licence that LICENSE.md no longer names', async () => {
		const f = fixture();
		const rulesPath = join(f.root, 'scripts/build/bun-runtime-notices.rules.json');
		writeFileSync(
			rulesPath,
			JSON.stringify({
				...f.rules,
				bun: {
					...f.rules.bun,
					ported: {
						...f.rules.bun.ported,
						texts: { 'test/lint/licenses/linty.txt': 'https://example.invalid/other' },
					},
				},
			}),
		);
		await expect(refresh(f.root, f.cache)).rejects.toThrow(/no longer links/);
	});

	test('refuses a header rule whose reason no longer holds', async () => {
		const f = fixture();
		const rulesPath = join(f.root, 'scripts/build/bun-runtime-notices.rules.json');
		writeFileSync(
			rulesPath,
			JSON.stringify({
				...f.rules,
				headers: [
					{ origin: 'webkit', roots: ['Source/'], extent: 'leading', only: 'no licence file' },
				],
			}),
		);
		await expect(refresh(f.root, f.cache)).rejects.toThrow(
			/the header rule's reason no longer holds/,
		);
	});
});

describe('readers', () => {
	test('tar refuses unsafe paths and reads long names', () => {
		const long = `${'d'.repeat(120)}/LICENSE`;
		expect(readTar(tar({ [long]: 'x' })).files.get(long)).toEqual(new TextEncoder().encode('x'));
		expect(() => readTar(tar({ '../escape': 'x' }))).toThrow(/unsafe archive path/);
		expect(() => readTar(tar({ '/abs': 'x' }))).toThrow(/unsafe archive path/);
		const corrupt = tar({ a: 'x' });
		corrupt[0] = 0x62;
		expect(() => readTar(corrupt)).toThrow(/checksum/);
	});

	test('ar reads members and refuses truncation', () => {
		const bytes = ar({ one: new TextEncoder().encode('abc') });
		expect(readAr(bytes).get('one')).toEqual(new TextEncoder().encode('abc'));
		expect(() => readAr(bytes.slice(0, bytes.byteLength - 2))).toThrow(/truncated/);
	});

	test('named notices and header excerpts', () => {
		for (const name of [
			'LICENSE',
			'a/COPYING.txt',
			'NOTICE',
			'AUTHORS',
			'LICENSES/MIT.txt',
			'LICENSE-APACHE',
			'license.html',
		]) {
			expect(isNamedNotice(name)).toBe(true);
		}
		for (const name of ['license.rs', 'license-metadata.json', 'src/licensing.c', 'README.md']) {
			expect(isNamedNotice(name)).toBe(false);
		}
		const enc = (text: string) => new TextEncoder().encode(text);
		const dec = (bytes: Uint8Array | null | undefined) => bytes && new TextDecoder().decode(bytes);
		// The leading comment, whole, and nothing of the code after it.
		expect(
			dec(
				headerExcerpt(
					enc('/* Copyright 2020 A\n * Licensed under MIT.\n */\nint main() {}\n'),
					'c',
				),
			),
		).toBe('/* Copyright 2020 A\n * Licensed under MIT.\n */\n');
		// A licence word in the code does not extend it.
		expect(
			dec(
				headerExcerpt(
					enc('// Copyright 2020 A\n// MIT licence.\n\nint main() { /* see the license */ }\n'),
					'c',
				),
			),
		).toBe('// Copyright 2020 A\n// MIT licence.\n');
		// Several leading blocks: through the last one with a licence line, not the file's docs.
		expect(
			dec(
				headerExcerpt(
					enc(
						'/* Copyright 2020 A */\n\n/* Permission is granted. */\n\n/* What this file does. */\nint x;\n',
					),
					'c',
				),
			),
		).toBe('/* Copyright 2020 A */\n\n/* Permission is granted. */\n');
		// A manual page: roff comments only, not the page body.
		expect(
			dec(
				headerExcerpt(
					enc('.\\" Copyright (c) 2003 T\n.\\" All rights reserved.\n.Dd May 1\n.Sh NAME\n'),
					'roff',
				),
			),
		).toBe('.\\" Copyright (c) 2003 T\n.\\" All rights reserved.\n');
		// A file whose first line is code has no header; nor does a comment without a statement.
		expect(headerExcerpt(enc('int x; /* Copyright 2020 A */\n'), 'c')).toBeNull();
		expect(headerExcerpt(enc('// Helpers for x.\nint x;\n'), 'c')).toBeNull();
		expect(headerExcerpt(enc('int x;\n'), 'c')).toBeNull();
		expect(headerExcerpt(new Uint8Array([0x43, 0, 0x6f]), 'c')).toBeNull();
		// Grants anywhere in a file; a mention without a grant is not one.
		const mid = enc(
			'int a;\n// Copyright B\n// Permission is hereby granted.\n\n// WITHOUT WARRANTY.\nint b;\n// (MIT, Copyright C)\nint c;\n',
		);
		expect(grantExcerpts(mid, 'c').map((excerpt) => [excerpt.offset, dec(excerpt.bytes)])).toEqual([
			[7, '// Copyright B\n// Permission is hereby granted.\n\n// WITHOUT WARRANTY.\n'],
		]);
		// The leading header and a later grant together; code that follows a comment's close stays out.
		const both = enc(
			'/* Copyright A\n * Redistribution and use permitted.\n */\nint a;\n/* Copyright B, public domain. */ int b;\n',
		);
		expect(licenceExcerpts(both, 'c', 'leading').map((excerpt) => dec(excerpt.bytes))).toEqual([
			'/* Copyright A\n * Redistribution and use permitted.\n */\n',
			'/* Copyright B, public domain. */',
		]);
		for (const ok of ['/* a\n * b\n */\n', '// a\n\n// b\n', '# a\n', '.\\" a\n', '/* a */ ']) {
			expect(isWholeComment(enc(ok))).toBe(true);
		}
		for (const bad of ['/* a */\nint x;\n', '/* a\n', 'int x;\n', '', '/* a */ int x;\n']) {
			expect(isWholeComment(enc(bad))).toBe(false);
		}
		expect(gitBlobId(new TextEncoder().encode('hello\n'))).toBe(
			'ce013625030ba8dba906f756967f9e9ca394464a',
		);
	});
});

test("the committed texts directory holds exactly the inventory's texts", () => {
	const dir = join(repoRoot, committedRules.output);
	const inventory = JSON.parse(readFileSync(join(dir, 'inventory.json'), 'utf8')) as Inventory;
	const listed = new Set(inventory.texts.map((text) => text.sha256));
	const present = readdirSync(join(dir, 'texts'));
	expect(new Set(present)).toEqual(listed);
	expect(existsSync(join(dir, 'notices'))).toBe(false);
});
