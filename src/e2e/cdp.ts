// A minimal client of Chromium's debugging protocol (what the browser tools of every editor speak), enough to look at a page and
// to click on it with real mouse events, including real drags. Uses the WebSocket of Node 22.

interface Pending {
	resolve: (value: any) => void;
	reject: (error: Error) => void;
}

declare const WebSocket: any;

export class Cdp {
	private id = 0;
	private readonly pending = new Map<number, Pending>();
	private readonly listeners = new Map<string, ((params: any) => void)[]>();

	private constructor(private readonly socket: any) {
		socket.addEventListener('message', (event: { data: string }) => {
			const message = JSON.parse(event.data);
			if (message.id !== undefined && this.pending.has(message.id)) {
				const { resolve, reject } = this.pending.get(message.id)!;
				this.pending.delete(message.id);
				message.error ? reject(new Error(`${message.error.message}`)) : resolve(message.result);
			} else if (message.method) {
				(this.listeners.get(message.method) ?? []).forEach(listener => listener(message.params));
			}
		});
	}

	static async connect(url: string): Promise<Cdp> {
		if (typeof WebSocket === 'undefined') {
			throw new Error('The end-to-end tests need a WebSocket in Node (Node 22 or newer).');
		}
		const socket = new WebSocket(url);
		await new Promise<void>((resolve, reject) => {
			socket.addEventListener('open', () => resolve());
			socket.addEventListener('error', () => reject(new Error(`Cannot connect to ${url}`)));
		});
		return new Cdp(socket);
	}

	send<T = any>(method: string, params: object = {}): Promise<T> {
		return new Promise((resolve, reject) => {
			const id = ++this.id;
			this.pending.set(id, { resolve, reject });
			this.socket.send(JSON.stringify({ id, method, params }));
		});
	}

	on(method: string, listener: (params: any) => void): void {
		this.listeners.set(method, [...(this.listeners.get(method) ?? []), listener]);
	}

	/** Runs an expression in the page and gives its value (it must be JSON). */
	async evaluate<T = any>(expression: string): Promise<T> {
		const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
		if (result.exceptionDetails) {
			throw new Error(`In the page: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
		}
		return result.result.value as T;
	}

	async screenshot(): Promise<Buffer> {
		const { data } = await this.send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
		return Buffer.from(data, 'base64');
	}

	close(): void {
		try { this.socket.close(); } catch { /* closed already */ }
	}
}
