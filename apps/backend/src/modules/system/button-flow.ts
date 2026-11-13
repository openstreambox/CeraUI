import { randomUUID } from "node:crypto";
import type { ButtonRequest, ButtonResult } from "./power-button-client.ts";

export type ButtonPurpose = "connect" | "disconnect";
type Entry = {
	id: string;
	purpose: ButtonPurpose;
	request?: ButtonRequest;
	state: "waiting" | ButtonResult;
	timer: ReturnType<typeof setTimeout>;
};

/** Each prompt belongs to one transport. A lost UI heartbeat cancels it. */
export class ButtonFlow {
	private entries = new WeakMap<object, Entry>();
	constructor(
		private readonly client: {
			confirm(seconds: number): Promise<ButtonRequest | null>;
		},
		private readonly heartbeatMs = 5000,
	) {}
	cancel(owner: object) {
		const entry = this.entries.get(owner);
		if (!entry) return;
		this.entries.delete(owner);
		clearTimeout(entry.timer);
		entry.request?.cancel();
	}
	async begin(owner: object, purpose: ButtonPurpose) {
		this.cancel(owner);
		const entry: Entry = {
			id: randomUUID(),
			purpose,
			state: "waiting",
			timer: setTimeout(() => this.cancel(owner), this.heartbeatMs),
		};
		this.entries.set(owner, entry);
		const request = await this.client.confirm(60);
		if (this.entries.get(owner) !== entry) {
			request?.cancel();
			return null;
		}
		if (!request) {
			this.cancel(owner);
			return null;
		}
		entry.request = request;
		void request.result.then((state) => {
			entry.state = state;
		});
		return entry.id;
	}
	poll(owner: object, id: string) {
		const entry = this.entries.get(owner);
		if (!entry || entry.id !== id) return null;
		clearTimeout(entry.timer);
		if (entry.state === "waiting")
			entry.timer = setTimeout(() => this.cancel(owner), this.heartbeatMs);
		else this.entries.delete(owner);
		return { state: entry.state, purpose: entry.purpose };
	}
}
