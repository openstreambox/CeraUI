import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

import {
	checkBinary,
	collectPackages,
	cssSources,
	generate,
	isGlueChunk,
	loadPolicy,
	packageRootOf,
	type Policy,
	sha256,
	sourcesOfMap,
} from "./third-party-notices.ts";

const repoRoot = resolve(import.meta.dir, "../..");
const RUNTIME_TEXT = "Runtime fixture licence\nline two\n";
const BUN = { version: "9.9.9", revision: "0123456789abcdef0123456789abcdef01234567" };

const fixtures: string[] = [];
afterEach(() => {
	for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function write(root: string, path: string, text: string): string {
	const full = join(root, path);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, text);
	return full;
}

function pkg(root: string, dir: string, manifest: object, files: Record<string, string> = {}) {
	write(root, join(dir, "package.json"), JSON.stringify(manifest));
	write(root, join(dir, "index.js"), "module.exports = 1;\n");
	for (const [name, text] of Object.entries(files)) write(root, join(dir, name), text);
	return join(root, dir, "index.js");
}

/** A tiny checkout: first-party licences, three bundled packages, one web map. */
function fixture(): { root: string; policy: Policy; backend: Map<string, string[]> } {
	const root = mkdtempSync(join(tmpdir(), "notices-fixture-"));
	fixtures.push(root);
	write(root, "apps/backend/LICENSE", "GPL fixture text\n");
	write(root, "apps/frontend/LICENSE", "GPL fixture text\n");
	write(root, "BRAND-ASSETS-NOTICE.md", "Brand fixture notice\n");
	write(root, "notices/runtime.md", RUNTIME_TEXT);
	const isolated = pkg(
		root,
		"node_modules/.bun/alpha@1.0.0/node_modules/alpha",
		{ name: "alpha", version: "1.0.0", license: "MIT" },
		{ LICENSE: "Alpha MIT text\n" },
	);
	const scoped = pkg(
		root,
		"node_modules/.bun/@scope+beta@2.0.0/node_modules/@scope/beta",
		{ name: "@scope/beta", version: "2.0.0", license: "Apache-2.0" },
		{
			"LICENSE.txt": "Beta Apache text\n",
			NOTICE: "Beta notice\n",
			"README.md": "not a licence\n",
		},
	);
	const hoisted = pkg(
		root,
		"node_modules/gamma",
		{ name: "gamma", version: "3.0.0", license: "ISC" },
		{ "license.md": "Gamma ISC text\n" },
	);
	// Shipped web files: one mapped chunk, a glue chunk, a generated runtime whose
	// packages are named inside it, a font, and a stylesheet with a banner.
	write(root, "dist/public/assets/app.js", "console.log(1);\n");
	write(root, "dist/public/assets/glue.js", 'import{t as e}from"./app.js";export default e();');
	write(root, "dist/public/runtime-1a2b.js", 'self["rt:core:1.0"];self["rt:extra:1.0"];');
	write(root, "dist/public/assets/font-x.woff2", "font bytes");
	write(root, "dist/public/assets/index.css", "/*! styler v1 */ a{}");
	write(root, "dist/public/assets/other.css", "b{}");
	pkg(
		root,
		"apps/frontend/node_modules/builder",
		{ name: "builder", version: "5.0.0" },
		{ LICENSE: "Builder text\n" },
	);
	pkg(
		root,
		"apps/frontend/node_modules/builder/node_modules/rt-core",
		{ name: "rt-core", version: "1.0.1" },
		{ LICENSE: "Core text\n" },
	);
	pkg(
		root,
		"apps/frontend/node_modules/builder/node_modules/rt-extra",
		{ name: "rt-extra", version: "1.0.1" },
		{ LICENSE: "Extra text\n" },
	);
	pkg(
		root,
		"node_modules/fontpkg",
		{ name: "fontpkg", version: "5.3.0" },
		{ LICENSE: "OFL fixture text\n" },
	);
	pkg(
		root,
		"node_modules/styler",
		{ name: "styler", version: "1.0.0" },
		{ LICENSE: "Styler text\n" },
	);
	const mapDir = join(root, "dist/sourcemaps/assets");
	mkdirSync(mapDir, { recursive: true });
	writeFileSync(
		join(mapDir, "app.js.map"),
		JSON.stringify({
			version: 3,
			sources: [
				relative(mapDir, hoisted),
				relative(mapDir, join(root, "apps/frontend/src/main.ts")),
				"\0vite/preload-helper.js",
			],
		}),
	);
	const policy: Policy = {
		firstParty: {
			source: "https://example.invalid/source",
			licenceFiles: ["apps/backend/LICENSE", "apps/frontend/LICENSE"],
			brandNotice: "BRAND-ASSETS-NOTICE.md",
		},
		backendEntrypoints: {},
		webSourcemapDir: "dist/sourcemaps",
		web: {
			root: "dist/public",
			label: "web app",
			mustBeAttributed: "\\.(?:m?js|woff2?)$",
			rules: [
				{
					files: "^runtime-[0-9a-f]+\\.js$",
					markerPackages: { pattern: "rt:([a-z]+):", name: "rt-$1" },
					resolveFrom: ["apps/frontend", "builder"],
				},
				{
					files: "^assets/font-[^/]+\\.woff2$",
					packages: ["fontpkg"],
					resolveFrom: ["apps/frontend"],
				},
				{
					files: "\\.css$",
					marker: "/*! styler v",
					packages: ["styler"],
					resolveFrom: ["apps/frontend"],
				},
			],
		},
		runtime: {
			name: "Runtime",
			version: BUN.version,
			revision: BUN.revision,
			source: "https://example.invalid/runtime",
			file: "notices/runtime.md",
			sha256: sha256(RUNTIME_TEXT),
		},
		withoutLicenceText: {},
	};
	const backend = new Map([
		["backend", [isolated, scoped, join(root, "apps/backend/src/main.ts")]],
		["recovery", [isolated]],
	]);
	return { root, policy, backend };
}

async function run(f: ReturnType<typeof fixture>, outDir = join(f.root, "out")) {
	await generate({
		repoRoot: f.root,
		policy: f.policy,
		copyrightPath: join(outDir, "doc/copyright"),
		indexPath: join(outDir, "index.json"),
		bun: BUN,
		backend: new Map(f.backend),
	});
	// The whole notice is the copyright file: devices keep nothing else in /usr/share/doc.
	const copyright = readFileSync(join(outDir, "doc/copyright"), "utf8");
	return {
		copyright,
		notices: copyright,
		index: JSON.parse(readFileSync(join(outDir, "index.json"), "utf8")),
	};
}

describe("third-party notices", () => {
	test("copies every bundled package's licence texts verbatim, with where it is used", async () => {
		const f = fixture();
		const { notices, index } = await run(f);
		for (const text of [
			RUNTIME_TEXT.trimEnd(),
			"Alpha MIT text",
			"Beta Apache text",
			"Beta notice",
			"Gamma ISC text",
		]) {
			expect(notices).toContain(text);
		}
		expect(notices).not.toContain("not a licence");
		expect(index.packages.map((p: { name: string }) => p.name)).toEqual([
			"@scope/beta",
			"alpha",
			"fontpkg",
			"gamma",
			"rt-core",
			"rt-extra",
			"styler",
		]);
		const alpha = index.packages.find((p: { name: string }) => p.name === "alpha");
		expect(alpha.bundledInto).toEqual(["backend", "recovery"]);
		expect(alpha.licenceFiles).toEqual([{ name: "LICENSE", sha256: sha256("Alpha MIT text\n") }]);
		const gamma = index.packages.find((p: { name: string }) => p.name === "gamma");
		expect(gamma.bundledInto).toEqual(["web app"]);
		expect(index.runtime.sha256).toBe(sha256(RUNTIME_TEXT));
	});

	test("keeps notice variants, rejects code files and conflicting copies", async () => {
		const f = fixture();
		const second = pkg(
			f.root,
			"node_modules/second/node_modules/alpha",
			{ name: "alpha", version: "1.0.0", license: "MIT" },
			{
				LICENSE: "Alpha MIT text\n",
				NOTICES: "Extra notice\n",
				"LICENSE.MIT": "MIT variant text\n",
				"LICENSE.APACHE2": "Apache variant text\n",
				UNLICENSE: "Public domain notice\n",
				"ThirdPartyNotices.txt": "Inherited notice\n",
				"notice.js": "code, not a notice",
				COPYRIGHT: "Copyright fixture text\n",
				"COPYRIGHT.cpp": "source code fixture",
				"ThirdPartyNoticeText.txt": "TypeScript-style notice\n",
			},
		);
		f.backend.get("recovery")!.push(second);
		const { notices } = await run(f);
		expect(notices).toContain("Extra notice");
		expect(notices).toContain("MIT variant text");
		expect(notices).toContain("Apache variant text");
		expect(notices).toContain("Public domain notice");
		expect(notices).toContain("Inherited notice");
		expect(notices).toContain("Copyright fixture text");
		expect(notices).toContain("TypeScript-style notice");
		expect(notices).not.toContain("source code fixture");
		expect(notices).not.toContain("code, not a notice");
		write(f.root, "node_modules/second/node_modules/alpha/LICENSE", "conflicting");
		await expect(run(f)).rejects.toThrow(/conflicting licence file/);
	});

	test("CSS plugin and config directives fail closed, including nested imports", () => {
		for (const directive of ['@plugin "plug";', '@config "./tailwind.config.ts";']) {
			const f = fixture();
			write(f.root, "entry.css", '@import "./nested.css";');
			write(f.root, "nested.css", directive);
			expect(() => cssSources(f.root, ["entry.css"])).toThrow(/unsupported CSS attribution directive/);
		}
	});

	test("exceptions expire at a version boundary", async () => {
		const f = fixture();
		const source = pkg(f.root, "node_modules/bare", { name: "bare", version: "2" });
		f.policy.withoutLicenceText["bare@1"] = "Reviewed version one";
		f.backend.get("backend")!.push(source);
		await expect(run(f)).rejects.toThrow(/bare@2/);
	});

	test("CSS-only imports and nested imports are included; unresolved imports fail", () => {
		const f = fixture();
		write(f.root, "src/app.css", '@import "styler";');
		write(
			f.root,
			"node_modules/styler/package.json",
			JSON.stringify({ name: "styler", version: "1", style: "index.css" }),
		);
		write(f.root, "node_modules/styler/index.css", '@import "./tokens.css";');
		write(f.root, "node_modules/styler/tokens.css", ":root { --color: red }");
		const sources = cssSources(f.root, ["src/app.css"]);
		expect(sources).toContain(join(f.root, "node_modules/styler/tokens.css"));
		expect(collectPackages(new Map([["web", sources]]), f.policy)[0]?.name).toBe("styler");
		write(f.root, "src/app.css", '@import "missing-package";');
		expect(() => cssSources(f.root, ["src/app.css"])).toThrow(/cannot resolve/);
		write(f.root, "src/app.css", "@import url(unquoted.css);");
		expect(() => cssSources(f.root, ["src/app.css"])).toThrow(/unsupported CSS import/);
	});

	test("binary membership is checked for each artifact separately", () => {
		const f = fixture();
		const packages = collectPackages(f.backend, f.policy);
		const exe = write(
			f.root,
			"exe",
			"node_modules/.bun/@scope+beta@2.0.0/node_modules/@scope/beta/x.js",
		);
		expect(checkBinary(exe, packages, "backend")).toEqual([]);
		expect(checkBinary(exe, packages, "recovery")).toEqual(["@scope/beta@2.0.0"]);
	});

	test("copyright carries the first-party licence once and the brand notice", async () => {
		const f = fixture();
		const { copyright } = await run(f);
		expect(copyright).toContain("Licence text from apps/backend/LICENSE, apps/frontend/LICENSE");
		expect(copyright.split("GPL fixture text").length).toBe(2);
		expect(copyright).toContain("Brand fixture notice");
		expect(copyright).toContain("https://example.invalid/source");
		// First-party texts come before the third-party section.
		expect(copyright.indexOf("GPL fixture text")).toBeLessThan(copyright.indexOf("Alpha MIT text"));
		expect(readdirSync(join(f.root, "out", "doc"))).toEqual(["copyright"]);
	});

	test("output is byte-identical across runs", async () => {
		const f = fixture();
		const first = await run(f, join(f.root, "a"));
		const second = await run(f, join(f.root, "b"));
		expect(second).toEqual(first);
	});

	test("a bundled package without licence text fails unless the policy names it", async () => {
		const f = fixture();
		const bare = pkg(f.root, "node_modules/.bun/bare@0.1.0/node_modules/bare", {
			name: "bare",
			version: "0.1.0",
			license: "MIT",
		});
		f.backend.get("backend")?.push(bare);
		await expect(run(f)).rejects.toThrow(/bare@0\.1\.0/);

		f.policy.withoutLicenceText["bare@0.1.0"] = "Declares MIT; the package has no licence file.";
		const { notices, index } = await run(f);
		expect(notices).toContain(
			"No licence text is published in this package. Declares MIT; the package has no licence file.",
		);
		const bareEntry = index.packages.find((p: { name: string }) => p.name === "bare");
		expect(bareEntry.licenceFiles).toEqual([]);
		expect(bareEntry.withoutLicenceText).toBe("Declares MIT; the package has no licence file.");
	});

	test("the pinned runtime licence must match the running Bun and its hash", async () => {
		const f = fixture();
		await expect(
			generate({
				repoRoot: f.root,
				policy: f.policy,
				copyrightPath: join(f.root, "out/copyright"),
				bun: { ...BUN, version: "9.9.8" },
				backend: f.backend,
			}),
		).rejects.toThrow(/refresh notices\/runtime\.md/);

		write(f.root, "notices/runtime.md", "edited\n");
		await expect(run(f)).rejects.toThrow(/does not match its sha256/);

		rmSync(join(f.root, "notices/runtime.md"));
		await expect(run(f)).rejects.toThrow(/pinned runtime licence missing/);
	});

	test("missing first-party licence, brand notice or web maps fail the build", async () => {
		let f = fixture();
		rmSync(join(f.root, "apps/frontend/LICENSE"));
		await expect(run(f)).rejects.toThrow(/first-party licence file missing/);

		f = fixture();
		rmSync(join(f.root, "BRAND-ASSETS-NOTICE.md"));
		await expect(run(f)).rejects.toThrow(/brand notice missing/);

		f = fixture();
		rmSync(join(f.root, "dist/sourcemaps"), { recursive: true });
		await expect(run(f)).rejects.toThrow(/no web app source maps/);
	});

	test("web files without maps are attributed by rule, from markers inside them", async () => {
		const { index, notices } = await run(fixture());
		const web = index.packages
			.filter((p: { bundledInto: string[] }) => p.bundledInto.includes("web app"))
			.map((p: { name: string; version: string }) => `${p.name}@${p.version}`);
		expect(web).toEqual([
			"fontpkg@5.3.0",
			"gamma@3.0.0",
			"rt-core@1.0.1",
			"rt-extra@1.0.1",
			"styler@1.0.0",
		]);
		expect(notices).toContain("OFL fixture text");
		expect(notices).not.toContain("Builder text");
	});

	test("a shipped script or font with no map, rule or glue shape fails", async () => {
		let f = fixture();
		write(f.root, "dist/public/assets/stray.js", "var vendored = function () { return 42; };");
		await expect(run(f)).rejects.toThrow(/assets\/stray\.js/);

		f = fixture();
		write(f.root, "dist/public/assets/other.woff", "font");
		await expect(run(f)).rejects.toThrow(/assets\/other\.woff/);

		f = fixture();
		write(f.root, "dist/public/runtime-1a2b.js", "no markers here");
		await expect(run(f)).rejects.toThrow(/no rt:\(\[a-z\]\+\): markers/);
	});

	test("glue chunks are only imports and re-exports", () => {
		expect(isGlueChunk('import"./a.js";')).toBe(true);
		expect(isGlueChunk('export{t as default}from"./b.js";')).toBe(true);
		expect(isGlueChunk('import{i as e}from"./c.js";export default e();')).toBe(true);
		expect(isGlueChunk('import"./a.js";var x=1;')).toBe(false);
		expect(isGlueChunk("")).toBe(true);
	});

	test("binary cross-check finds bundled packages the notices lack", () => {
		const f = fixture();
		const packages = collectPackages(f.backend, f.policy);
		const exe = write(
			f.root,
			"exe",
			"\0../node_modules/.bun/alpha@1.0.0/node_modules/alpha/index.js\0" +
				"../node_modules/.bun/@scope+beta@2.0.0+3f2a/node_modules/@scope/beta/x.js\0",
		);
		expect(checkBinary(exe, packages)).toEqual([]);

		write(f.root, "exe", "node_modules/.bun/delta@4.0.0/node_modules/delta/i.js");
		expect(checkBinary(exe, packages)).toEqual(["delta@4.0.0"]);

		write(f.root, "exe", "no bundled paths");
		expect(checkBinary(exe, packages)[0]).toMatch(/no node_modules\/\.bun paths/);
	});

	test("unknown virtual and hidden dependency paths fail closed", () => {
		const f = fixture();
		const map = write(f.root, "test.map", JSON.stringify({ sources: ["\0unknown:helper"] }));
		expect(() => sourcesOfMap(map)).toThrow(/unrecognised virtual source/);
		for (const source of ["/r/node_modules/.vite/deps/x.js", "/r/node_modules/.bun/a@1/x.js"]) {
			expect(() => packageRootOf(source)).toThrow(/unresolved/);
		}
	});

	test("package roots follow the last node_modules segment", () => {
		expect(packageRootOf("/r/node_modules/.bun/a@1/node_modules/a/lib/x.js")).toBe(
			"/r/node_modules/.bun/a@1/node_modules/a",
		);
		expect(packageRootOf("/r/node_modules/@s/b/x.js")).toBe("/r/node_modules/@s/b");
		expect(packageRootOf("/r/apps/backend/src/main.ts")).toBeNull();
		expect(() => packageRootOf("/r/node_modules/.bin/tool")).toThrow(/unresolved/);
	});
});

describe("committed notice policy", () => {
	const policy = loadPolicy(join(repoRoot, "scripts/build/third-party-notices.json"));

	test("pins the Bun release this repository builds with, by hash", () => {
		const pinned = readFileSync(join(repoRoot, ".bun-version"), "utf8").trim();
		expect(policy.runtime.version).toBe(pinned);
		const text = readFileSync(join(repoRoot, policy.runtime.file), "utf8");
		expect(sha256(text)).toBe(policy.runtime.sha256);
		expect(policy.runtime.source).toContain(policy.runtime.revision);
	});

	test("bundles the same entry points and web maps the package build ships", () => {
		const backendBuild = JSON.parse(
			readFileSync(join(repoRoot, "apps/backend/package.json"), "utf8"),
		).scripts["build:backend-only"] as string;
		const debBuild = readFileSync(join(repoRoot, "scripts/build/build-debian-package.sh"), "utf8");
		const [main, recovery] = Object.entries(policy.backendEntrypoints);
		expect(main?.[1]).toBe("/usr/local/bin/ceralive");
		expect(backendBuild).toContain(
			`--sourcemap --target=$BUN_TARGET ${main?.[0].replace("apps/backend/", "")}`,
		);
		expect(debBuild).toContain(`cp dist/ceralive "$TEMP_DIR${main?.[1]}"`);
		expect(debBuild).toContain(
			`NODE_ENV=production bun build ${recovery?.[0]} --minify --sourcemap --compile`,
		);
		expect(debBuild).toContain(`--outfile="$TEMP_DIR${recovery?.[1]}"`);
		expect(debBuild).toContain('cp -r dist/public/* "$TEMP_DIR/var/www/ceralive/"');
		expect(policy.web.root).toBe("dist/public");
		const spa = readFileSync(join(repoRoot, "apps/frontend/vite.sourcemaps.ts"), "utf8");
		const dir = /SPA_SOURCEMAP_OUT_DIR = "([^"]+)"/.exec(spa)?.[1];
		expect(policy.webSourcemapDir).toBe(`dist/${dir}`);
	});

	test("first-party texts exist and every exception carries a reason", () => {
		for (const file of [...policy.firstParty.licenceFiles, policy.firstParty.brandNotice]) {
			expect(readFileSync(join(repoRoot, file), "utf8").length).toBeGreaterThan(0);
		}
		for (const reason of Object.values(policy.withoutLicenceText)) {
			expect(reason.trim().length).toBeGreaterThan(20);
		}
	});
});
