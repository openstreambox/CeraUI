import fs from "node:fs";
import path from "node:path";

interface Dependencies {
	directory: string;
	available: () => boolean;
	idle: () => boolean;
	start: () => void;
	health?: (degraded: boolean) => void;
	stop: () => Promise<void>;
}

/** The credential has no getter. Only the owned relay receives its value. */
export class MoblinkOwner {
	private tail: Promise<unknown> = Promise.resolve();
	constructor(private readonly deps: Dependencies) {}
	private checked(file: string, directory: boolean): boolean {
		try {
			const s = fs.lstatSync(file);
			if (
				s.isSymbolicLink() ||
				s.uid !== process.getuid?.() ||
				(s.mode & 0o7777) !== (directory ? 0o700 : 0o600) ||
				(directory
					? !s.isDirectory()
					: !s.isFile() || s.nlink !== 1 || s.size === 0 || s.size > 4096)
			)
				throw new Error("Unsafe credential storage");
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw new Error("Unsafe credential storage");
		}
	}
	private file() {
		return path.join(this.deps.directory, "credential");
	}
	private prepareDirectory() {
		try {
			const st = fs.lstatSync(this.deps.directory);
			if (
				!st.isDirectory() ||
				st.isSymbolicLink() ||
				st.uid !== process.getuid?.()
			)
				throw Error("Unsafe credential storage");
			if ((st.mode & 0o7777) !== 0o700)
				fs.chmodSync(this.deps.directory, 0o700);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			fs.mkdirSync(this.deps.directory, { mode: 0o700 });
		}
		this.checked(this.deps.directory, true);
	}
	private sweep() {
		for (const name of fs.readdirSync(this.deps.directory)) {
			if (!name.startsWith(".credential-")) continue;
			const file = path.join(this.deps.directory, name);
			const st = fs.lstatSync(file);
			if (st.isFile() && st.uid === process.getuid?.()) fs.unlinkSync(file);
		}
		const fd = fs.openSync(this.deps.directory, "r");
		try {
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
	}
	status() {
		let configured = false;
		try {
			configured =
				this.checked(this.deps.directory, true) &&
				this.checked(this.file(), false);
		} catch {
			/* Private storage failure is not a diagnostic payload. */
		}
		return { available: this.deps.available(), configured };
	}
	async restore() {
		try {
			fs.lstatSync(this.deps.directory);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			this.deps.health?.(true);
			return;
		}
		try {
			this.prepareDirectory();
			this.sweep();
			if (this.deps.available()) {
				if (this.status().configured) this.deps.start();
				else if (fs.existsSync(this.file())) this.deps.health?.(true);
			}
		} catch {
			this.deps.health?.(true);
		}
	}
	set(password: string) {
		return this.mutate(password);
	}
	clear() {
		return this.mutate(undefined);
	}
	private mutate(password: string | undefined) {
		const operation = this.tail.then(async () => {
			if (!this.deps.idle()) return { success: false, error: "busy" as const };
			if (password !== undefined && !this.deps.available())
				return { success: false, error: "unavailable" as const };
			if (
				password !== undefined &&
				(!password.length ||
					password.length > 1024 ||
					password.includes(String.fromCharCode(0)) ||
					/[\r\n]/.test(password))
			)
				return { success: false, error: "invalid" as const };
			let temporary: string | undefined;
			try {
				this.prepareDirectory();
				this.sweep();
				await this.deps.stop();
				if (!this.deps.idle())
					return { success: false, error: "busy" as const };
				if (password === undefined) {
					fs.rmSync(this.file(), { force: true });
					const dir = fs.openSync(this.deps.directory, "r");
					try {
						fs.fsyncSync(dir);
					} finally {
						fs.closeSync(dir);
					}
				} else {
					temporary = path.join(
						this.deps.directory,
						`.credential-${crypto.randomUUID()}`,
					);
					const fd = fs.openSync(temporary, "wx", 0o600);
					try {
						fs.writeFileSync(fd, password);
						fs.fsyncSync(fd);
					} finally {
						fs.closeSync(fd);
					}
					fs.renameSync(temporary, this.file());
					temporary = undefined;
					const dir = fs.openSync(this.deps.directory, "r");
					try {
						fs.fsyncSync(dir);
					} finally {
						fs.closeSync(dir);
					}
					this.deps.start();
				}
				this.deps.health?.(false);
				return { success: true };
			} catch {
				this.deps.health?.(true);
				return { success: false, error: "failed" as const };
			} finally {
				if (temporary) {
					try {
						fs.rmSync(temporary, { force: true });
					} catch {
						/* No raw filesystem errors at the RPC boundary. */
					}
				}
			}
		});
		this.tail = operation.catch(() => undefined);
		return operation;
	}
}
