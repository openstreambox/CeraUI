import { connect } from "node:net";

export type ButtonResult =
	| "confirmed"
	| "timeout"
	| "cancelled"
	| "unavailable";
export interface ButtonRequest {
	result: Promise<ButtonResult>;
	cancel(): void;
}

/** Root-only image service. No network or shell fallback. */
export class PowerButtonClient {
	constructor(
		private readonly path = "/run/ceralive-button/control.sock",
		private readonly handshakeMs = 1000,
	) {}

	confirm(seconds: number): Promise<ButtonRequest | null> {
		if (!Number.isInteger(seconds) || seconds < 1 || seconds > 60)
			return Promise.reject(
				new Error("Confirmation timeout must be 1–60 seconds"),
			);
		return this.exchange(`CONFIRM ${seconds}\n`, seconds);
	}

	private exchange(
		command: string,
		seconds: number,
	): Promise<ButtonRequest | null> {
		return new Promise((resolve) => {
			const socket = connect(this.path);
			let ready = false;
			let ended = false;
			let buffer = "";
			let settle!: (result: ButtonResult) => void;
			const result = new Promise<ButtonResult>((r) => {
				settle = r;
			});
			const finish = (value: ButtonResult) => {
				if (ended) return;
				ended = true;
				clearTimeout(handshake);
				clearTimeout(deadline);
				if (!ready) resolve(null);
				settle(value);
				socket.destroy();
			};
			const handshake = setTimeout(
				() => finish("unavailable"),
				this.handshakeMs,
			);
			const deadline = setTimeout(
				() => finish("timeout"),
				seconds * 1000 + this.handshakeMs,
			);
			socket.on("connect", () => socket.write(command));
			socket.on("error", () => finish("unavailable"));
			socket.on("close", () => finish("unavailable"));
			socket.on("data", (data) => {
				buffer += data.toString();
				if (buffer.length > 128) return finish("unavailable");
				while (buffer.includes("\n") && !ended) {
					const end = buffer.indexOf("\n");
					const line = buffer.slice(0, end);
					buffer = buffer.slice(end + 1);
					if (!ready && line === "READY") {
						ready = true;
						clearTimeout(handshake);
						resolve({ result, cancel: () => finish("cancelled") });
					} else if (ready && line === "CONFIRMED") finish("confirmed");
					else if (ready && line === "TIMEOUT") finish("timeout");
					else finish("unavailable");
				}
			});
		});
	}

	async setLive(live: boolean): Promise<boolean> {
		return new Promise((resolve) => {
			const socket = connect(this.path);
			let buffer = "";
			let done = false;
			const finish = (ok: boolean) => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				socket.destroy();
				resolve(ok);
			};
			const timer = setTimeout(() => finish(false), this.handshakeMs);
			socket.on("connect", () => socket.write(`LIVE ${live ? 1 : 0}\n`));
			socket.on("data", (data) => {
				buffer += data.toString();
				if (buffer.includes("\n") || buffer.length > 128)
					finish(buffer === "OK\n");
			});
			socket.on("error", () => finish(false));
			socket.on("close", () => finish(false));
		});
	}
}
export const powerButton = new PowerButtonClient();
