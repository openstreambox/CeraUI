/** Collect the backend's own log message texts for the support download.
 *
 * The support export admits a backend `msg` only when it matches a message this
 * code writes. Each template is the literal text of a logger call's first
 * argument, split where the code interpolates a runtime value; the export puts
 * a bounded token or `[value]` in each gap. Run with `--write` after adding or
 * changing log messages:
 *
 *   bun scripts/support-log-messages.ts --write
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const LOG_METHODS = new Set(["error", "warn", "info", "debug", "verbose"]);
// Templates whose fixed text is shorter than this say nothing on their own.
const MIN_LITERAL_LETTERS = 4;

export const BACKEND_ROOT = join(import.meta.dir, "..");
export const GENERATED_PATH = join(
	BACKEND_ROOT,
	"src/modules/system/support-log-messages.generated.ts",
);

function sourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "tests" || entry.name === "node_modules") continue;
			out.push(...sourceFiles(path));
		} else if (
			entry.name.endsWith(".ts") &&
			!entry.name.endsWith(".test.ts") &&
			!entry.name.endsWith(".d.ts") &&
			!entry.name.endsWith(".generated.ts")
		)
			out.push(path);
	}
	return out;
}

type Pieces = (string | null)[][];

/** Fixed text pieces of an expression; `null` marks a runtime gap. A bare
 * identifier resolves to the initialisers of same-named constants in the file.
 */
function pieces(node: ts.Expression, scope: Scope, depth = 0): Pieces {
	if (ts.isParenthesizedExpression(node))
		return pieces(node.expression, scope, depth);
	if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
		return [[node.text]];
	if (ts.isTemplateExpression(node)) {
		// A span that is itself literal text (`${ok ? "ok" : "err"}`) expands.
		let out: Pieces = [[node.head.text]];
		for (const span of node.templateSpans) {
			const inner = pieces(span.expression, scope, depth);
			out = out
				.flatMap((left) =>
					inner.map((middle) => [...left, ...middle, span.literal.text]),
				)
				.slice(0, 8);
		}
		return out;
	}
	if (ts.isConditionalExpression(node))
		return [
			...pieces(node.whenTrue, scope, depth),
			...pieces(node.whenFalse, scope, depth),
		];
	if (
		ts.isBinaryExpression(node) &&
		node.operatorToken.kind === ts.SyntaxKind.PlusToken
	) {
		const out: Pieces = [];
		for (const left of pieces(node.left, scope, depth))
			for (const right of pieces(node.right, scope, depth))
				out.push([...left, ...right]);
		return out.slice(0, 8);
	}
	if (ts.isIdentifier(node) && depth < 3) {
		const declared = scope.get(node.text);
		if (declared?.length)
			return declared.flatMap((init) => pieces(init, scope, depth + 1));
	}
	return [[null]];
}

type Scope = Map<string, ts.Expression[]>;

/** `const name = …` initialisers in a file, for resolving logged variables. */
function constants(source: ts.SourceFile): Scope {
	const scope: Scope = new Map();
	const visit = (node: ts.Node) => {
		if (
			ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) &&
			node.initializer &&
			ts.isVariableDeclarationList(node.parent) &&
			node.parent.flags & ts.NodeFlags.Const
		) {
			const list = scope.get(node.name.text) ?? [];
			list.push(node.initializer);
			scope.set(node.name.text, list);
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return scope;
}

/** Literal parts around each gap: ["Modem ", " failed"] is "Modem …failed". */
function normalise(raw: (string | null)[]): string[] {
	const parts = [""];
	for (const piece of raw) {
		if (piece === null) {
			if (parts.at(-1) !== "" || parts.length === 1) parts.push("");
		} else parts[parts.length - 1] += piece;
	}
	return parts;
}

function useful(parts: string[]): boolean {
	const letters = parts.join("").replace(/[^A-Za-z]/g, "").length;
	return (
		letters >= MIN_LITERAL_LETTERS &&
		parts.every((part) => !part.includes("\n") && part.length <= 400)
	);
}

// Bare functions the code wires to the logger (`warn(…)`, `log.error(…)`).
const LOG_FUNCTIONS = new Set(["warn", "error", "logWarn", "logError"]);
const LOGGER_OBJECT =
	/(?:^|\.)(?:logger|log|defaultLogger|[a-zA-Z]*Logger|sink)$|logger\.child\(/;

interface Collected {
	logs: string[][];
	errors: string[][];
	reasons: string[][];
	dynamic: string[];
}

function sorted(map: Map<string, string[]>): string[][] {
	return [...map.values()].sort((a, b) =>
		JSON.stringify(a) < JSON.stringify(b) ? -1 : 1,
	);
}

function collect(root = BACKEND_ROOT): Collected {
	const logs = new Map<string, string[]>();
	const errors = new Map<string, string[]>();
	const reasons = new Map<string, string[]>();
	const dynamic = new Set<string>();
	const add = (into: Map<string, string[]>, all: Pieces): boolean => {
		let any = false;
		for (const raw of all) {
			const parts = normalise(raw);
			if (!useful(parts)) continue;
			into.set(JSON.stringify(parts), parts);
			any = true;
		}
		return any;
	};
	for (const file of sourceFiles(join(root, "src"))) {
		const source = ts.createSourceFile(
			file,
			readFileSync(file, "utf8"),
			ts.ScriptTarget.Latest,
			true,
			ts.ScriptKind.TS,
		);
		const scope = constants(source);
		const rel = relative(root, file);
		const visit = (node: ts.Node) => {
			if (ts.isCallExpression(node) && node.arguments.length > 0) {
				const callee = node.expression;
				const first = node.arguments[0];
				const method =
					ts.isPropertyAccessExpression(callee) &&
					LOG_METHODS.has(callee.name.text) &&
					callee.expression.getText(source) !== "console";
				const bare = ts.isIdentifier(callee) && LOG_FUNCTIONS.has(callee.text);
				if (first && (method || bare)) {
					const literal = add(logs, pieces(first, scope));
					const loggerLike =
						bare ||
						(ts.isPropertyAccessExpression(callee) &&
							LOGGER_OBJECT.test(callee.expression.getText(source)));
					if (!literal && loggerLike)
						dynamic.add(
							`${rel}: ${callee.getText(source)}(${first.getText(source).replace(/\s+/g, " ").slice(0, 80)})`,
						);
				}
				// Error subclasses build their message with super(…).
				if (
					callee.kind === ts.SyntaxKind.SuperKeyword &&
					first &&
					/Error\b/.test(
						ts
							.findAncestor(node, ts.isClassLike)
							?.heritageClauses?.[0]?.getText(source) ?? "",
					)
				)
					add(errors, pieces(first, scope));
			}
			if (
				ts.isNewExpression(node) &&
				/Error$/.test(node.expression.getText(source)) &&
				node.arguments?.[0]
			)
				add(errors, pieces(node.arguments[0], scope));
			if (ts.isThrowStatement(node) && node.expression)
				add(errors, pieces(node.expression, scope));
			if (
				ts.isPropertyAssignment(node) &&
				(ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
				node.name.text === "reason"
			)
				add(reasons, pieces(node.initializer, scope));
			ts.forEachChild(node, visit);
		};
		visit(source);
	}
	return {
		logs: sorted(logs),
		errors: sorted(errors),
		reasons: sorted(reasons),
		dynamic: [...dynamic].sort(),
	};
}

let cached: Collected | undefined;
const collected = () => {
	cached ??= collect();
	return cached;
};

export const collectLogTemplates = (): string[][] => collected().logs;
export const collectErrorTemplates = (): string[][] => collected().errors;
export const collectReasonTemplates = (): string[][] => collected().reasons;
export const collectDynamicLogCalls = (): string[] => collected().dynamic;

export function renderGenerated(all: Collected = collected()): string {
	return `// Generated by apps/backend/scripts/support-log-messages.ts; do not edit.
// The backend's own texts, split where the code interpolates a value. The
// support download admits backend text only if it matches one of these.

/** Log message texts (logger calls and bare warn()/error() calls). */
export const SUPPORT_LOG_TEMPLATES: readonly (readonly string[])[] = ${JSON.stringify(all.logs)};

/** Error message texts the code throws (new …Error(…), super(…), throw). */
export const SUPPORT_ERROR_TEMPLATES: readonly (readonly string[])[] = ${JSON.stringify(all.errors)};

/** Values the code assigns to a \`reason\` field. */
export const SUPPORT_REASON_TEMPLATES: readonly (readonly string[])[] = ${JSON.stringify(all.reasons)};

/** Logger calls whose message is not literal text; their messages are withheld. */
export const SUPPORT_LOG_DYNAMIC_CALLS: readonly string[] = ${JSON.stringify(all.dynamic)};
`;
}

if (import.meta.main) {
	const text = renderGenerated();
	if (process.argv.includes("--write")) {
		writeFileSync(GENERATED_PATH, text);
		// Match the repository formatting so `biome check` stays clean.
		spawnSync("bunx", ["biome", "format", "--write", GENERATED_PATH], {
			stdio: "inherit",
		});
	} else process.stdout.write(text);
}
