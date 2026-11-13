export interface IdleWifiRadio {
	key: string;
	identity: string;
	ifname: string;
	eligible: boolean;
	up: boolean;
}
export interface HeatWifiDeps {
	read: (key?: string) => Promise<IdleWifiRadio[]>;
	canRest?: () => boolean;
	wakeRead?: (old: IdleWifiRadio) => Promise<IdleWifiRadio>;
	lock: (key: string, fn: () => Promise<void>) => Promise<unknown>;
	set: (row: IdleWifiRadio, up: boolean) => Promise<void>;
	record: (row: IdleWifiRadio, reason: string) => void;
	load?: () => Promise<IdleWifiRadio[]>;
	save?: (rows: IdleWifiRadio[]) => Promise<void>;
}
/** Only links this owner lowered may be raised. Identity fences prevent hotplug reuse. */
export class HeatWifiRest {
	private resting = new Map<string, IdleWifiRadio>();
	private wanted = new Set<string>();
	private tail: Promise<void> = Promise.resolve();
	private loaded = false;
	private async initialize() {
		if (this.loaded) return;
		for (const row of (await this.deps.load?.()) ?? []) {
			this.resting.set(row.key, row);
			this.wanted.add(row.key);
		}
		this.loaded = true;
	}
	private async save() {
		await this.deps.save?.([...this.resting.values()]);
	}
	constructor(private readonly deps: HeatWifiDeps) {}
	private serial(fn: () => Promise<void>): Promise<void> {
		const next = this.tail.then(async () => {
			await this.initialize();
			await fn();
		});
		this.tail = next.catch(() => undefined);
		return next;
	}
	private async wake(key: string, reason: string) {
		const old = this.resting.get(key);
		if (!old) return;
		if (reason !== "cool") this.wanted.add(key);
		const row = this.deps.wakeRead
			? await this.deps.wakeRead(old)
			: (await this.deps.read(key)).find((r) => r.key === key);
		if (!row) throw Error("Wi-Fi identity unavailable; wake remains pending");
		if (row.identity !== old.identity) {
			this.resting.delete(key);
			await this.save();
			return;
		}

		await this.deps.set(row, true);
		this.resting.delete(key);
		await this.save();
		this.deps.record(row, reason);
	}
	/** Caller holds the adapter lock. Remember intent before awaiting any read. */
	demand(key: string): Promise<void> {
		this.wanted.add(key);
		return this.serial(() => this.wake(key, "needed"));
	}
	update(stage: number, known: boolean): Promise<void> {
		return this.serial(async () => {
			for (const key of this.resting.keys()) {
				if (this.wanted.has(key) || (known && stage === 0))
					await this.deps.lock(key, () =>
						this.wake(key, known && stage === 0 ? "cool" : "needed"),
					);
			}
			if (this.resting.size === 0 && (!known || stage === 0)) {
				if (known) this.wanted.clear();
				return;
			}
			const rows = await this.deps.read();
			for (const key of this.resting.keys()) {
				const row = rows.find((r) => r.key === key);
				if (!row) {
					await this.deps.lock(key, () => this.wake(key, "usage-unknown"));
					continue;
				}
				if (!row.eligible || this.wanted.has(key) || (known && stage === 0)) {
					await this.deps.lock(key, () =>
						this.wake(key, known && stage === 0 ? "cool" : "needed"),
					);
				}
			}
			if (known && stage === 0) this.wanted.clear();
			if (!known || stage < 1) return;
			for (const candidate of rows) {
				if (
					!candidate.eligible ||
					!candidate.up ||
					this.resting.has(candidate.key) ||
					this.wanted.has(candidate.key)
				)
					continue;
				await this.deps.lock(candidate.key, async () => {
					const row = (await this.deps.read(candidate.key)).find(
						(r) => r.key === candidate.key && r.identity === candidate.identity,
					);
					if (
						!row?.eligible ||
						!row.up ||
						this.wanted.has(row.key) ||
						this.deps.canRest?.() === false
					)
						return;
					// Retain ownership on a timeout: the command may already have lowered it.
					this.resting.set(row.key, { ...row });
					try {
						await this.save();
					} catch (error) {
						this.resting.delete(row.key);
						throw error;
					}
					try {
						await this.deps.set(row, false);
						this.deps.record(row, "warm-idle-usb");
					} catch {
						this.wanted.add(row.key);
					}
				});
			}
		});
	}
}
