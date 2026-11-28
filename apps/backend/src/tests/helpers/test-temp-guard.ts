import { mock } from "bun:test";
import fs, { appendFileSync, constants } from "node:fs";
import fsp from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function contains(root: string, path: string): boolean {
	const suffix = relative(root, path);
	return (
		suffix === "" ||
		(suffix !== ".." && !suffix.startsWith("../") && !isAbsolute(suffix))
	);
}

function writeFlags(flags: unknown): boolean {
	if (typeof flags === "number")
		return Boolean(
			flags &
				(constants.O_WRONLY |
					constants.O_RDWR |
					constants.O_APPEND |
					constants.O_CREAT |
					constants.O_TRUNC),
		);
	return typeof flags === "string" && /[wa+]/.test(flags);
}

export function installTestTempGuard(
	root: string,
	run: string,
	tempParent: string,
): void {
	const shared = [
		"/tmp",
		"/var/tmp",
		"/private/tmp",
		"/private/var/tmp",
		tempParent,
	];
	const checkout = fileURLToPath(new URL("../../../../../", import.meta.url));
	const record = join(run, "temp-escapes.log");

	const check = (target: unknown): void => {
		const value = target instanceof URL ? fileURLToPath(target) : target;
		if (typeof value !== "string" && !Buffer.isBuffer(value)) return;
		const path = resolve(value.toString());
		if (
			contains(root, path) ||
			contains(checkout, path) ||
			!shared.some((base) => contains(base, path))
		)
			return;
		const message = `Backend test tried to write outside its temp root: ${path}`;
		appendFileSync(record, `${message}\n`);
		if (run !== root)
			appendFileSync(join(root, "temp-escapes.log"), `${message}\n`);
		throw new Error(message);
	};

	// Bun keeps builtin named exports separate from the CommonJS/default object.
	function guard(module: object, names: readonly string[]): void {
		const methods = module as Record<string, unknown>;
		for (const name of names) {
			const original = methods[name];
			if (typeof original !== "function") continue;
			const operation = name.replace(/Sync$/, "");
			methods[name] = function (this: unknown, ...args: unknown[]) {
				if (["copyFile", "cp", "link", "rename", "symlink"].includes(operation))
					check(args[1]);
				else if (operation !== "open" || writeFlags(args[1])) check(args[0]);
				return Reflect.apply(original, this, args);
			};
		}
	}
	const methods = [
		"appendFile",
		"copyFile",
		"cp",
		"link",
		"mkdir",
		"mkdtemp",
		"open",
		"rename",
		"symlink",
		"truncate",
		"writeFile",
	];
	guard(fs, [
		...methods,
		...methods.map((name) => `${name}Sync`),
		"createWriteStream",
	]);
	guard(fsp, methods);
	mock.module("node:fs", () => ({ ...fs, default: fs }));
	mock.module("node:fs/promises", () => ({ ...fsp, default: fsp }));

	Bun.write = new Proxy(Bun.write, {
		apply(write, receiver, args: unknown[]) {
			const target = args[0];
			check(
				target && typeof target === "object" && "name" in target
					? target.name
					: target,
			);
			return Reflect.apply(write, receiver, args);
		},
	});
	Bun.file = new Proxy(Bun.file, {
		apply(file, receiver, args: unknown[]) {
			const result: Bun.BunFile = Reflect.apply(file, receiver, args);
			const writer = result.writer.bind(result);
			result.writer = (...options) => {
				check(args[0]);
				return writer(...options);
			};
			return result;
		},
	});
}
