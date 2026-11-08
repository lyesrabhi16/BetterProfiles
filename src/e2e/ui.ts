// What a person does in the Better Profiles tab, as calls: find a row, click it, hover for its buttons, answer a dialog, drag a row
// onto another. Everything is found in the page of the real workbench, by what is shown, and every wait is a poll with a limit,
// never a fixed sleep.

import { Cdp } from './cdp';

export type Section = 'GROUPS' | 'PROFILES';

export interface Row {
	label: string;
	description: string;
	selected: boolean;
}

export interface Point {
	x: number;
	y: number;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const q = (text: string) => JSON.stringify(text);

export async function waitFor<T>(what: string, check: () => Promise<T | undefined | false | null>, options: { timeoutMs?: number; intervalMs?: number } = {}): Promise<T> {
	const end = Date.now() + (options.timeoutMs ?? 15_000);
	let last: unknown;
	while (Date.now() < end) {
		try {
			const value = await check();
			if (value) {
				return value;
			}
		} catch (error) {
			last = error;
		}
		await sleep(options.intervalMs ?? 25);
	}
	throw new Error(`Timed out after ${options.timeoutMs ?? 15_000} ms waiting for ${what}${last ? ` (last error: ${String(last)})` : ''}.`);
}

export class Ui {
	constructor(readonly cdp: Cdp) { }

	// ---- the page ------------------------------------------------------------------------------------------------------

	/** The sidebar of Better Profiles: opens it from the activity bar and waits for both trees. */
	async openBetterProfiles(): Promise<void> {
		await waitFor('the Better Profiles icon in the activity bar', async () => this.cdp.evaluate<boolean>(`!!document.querySelector('.activitybar [aria-label^="Better Profiles"]')`), { timeoutMs: 90_000, intervalMs: 250 });
		const visible = await this.cdp.evaluate<boolean>(`[...document.querySelectorAll('.pane-header')].some(h => /^\\s*PROFILES/i.test(h.textContent || ''))`);
		if (!visible) {
			await this.click(await waitFor('the activity bar item', () => this.cdp.evaluate<Point | null>(`(() => { const a = document.querySelector('.activitybar [aria-label^="Better Profiles"]'); if (!a) return null; const b = a.getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`)));
		}
		await waitFor('the Groups and Profiles views', async () => (await this.cdp.evaluate<boolean>(`[...document.querySelectorAll('.pane-header')].some(h => /^\\s*GROUPS/i.test(h.textContent || ''))`)) && (await this.cdp.evaluate<boolean>(`[...document.querySelectorAll('.pane-header')].some(h => /^\\s*PROFILES/i.test(h.textContent || ''))`)));
	}

	// ---- rows ----------------------------------------------------------------------------------------------------------

	rows(section: Section): Promise<Row[]> {
		return this.cdp.evaluate<Row[]>(`(() => {
			for (const pane of document.querySelectorAll('.pane')) {
				if (!(pane.querySelector('.pane-header')?.textContent || '').toUpperCase().includes(${q(section)})) continue;
				return [...pane.querySelectorAll('.monaco-list-row')].map(r => ({
					label: (r.querySelector('.label-name')?.textContent || '').trim(),
					description: (r.querySelector('.label-description')?.textContent || '').trim(),
					selected: r.classList.contains('selected') || r.classList.contains('focused'),
				}));
			}
			return [];
		})()`);
	}

	async labels(section: Section): Promise<string[]> {
		return (await this.rows(section)).map(r => r.label);
	}

	async row(section: Section, label: string): Promise<Row | undefined> {
		return (await this.rows(section)).find(r => r.label === label);
	}

	waitForRow(section: Section, label: string, options: { timeoutMs?: number } = {}): Promise<Row> {
		return waitFor(`the row "${label}" in ${section}`, () => this.row(section, label), options);
	}

	async waitForNoRow(section: Section, label: string, options: { timeoutMs?: number } = {}): Promise<void> {
		await waitFor(`the row "${label}" to leave ${section}`, async () => !(await this.row(section, label)), options);
	}

	/** Where to click on a row (its middle) and its left edge. */
	async rowBox(section: Section, label: string): Promise<Point & { left: number }> {
		return waitFor(`the row "${label}" in ${section} to be on screen`, () => this.cdp.evaluate<(Point & { left: number }) | null>(`(() => {
			for (const pane of document.querySelectorAll('.pane')) {
				if (!(pane.querySelector('.pane-header')?.textContent || '').toUpperCase().includes(${q(section)})) continue;
				for (const r of pane.querySelectorAll('.monaco-list-row')) {
					if ((r.querySelector('.label-name')?.textContent || '').trim() !== ${q(label)}) continue;
					const b = r.getBoundingClientRect();
					if (b.height === 0) return null;
					return { x: Math.round(b.left + 150), y: Math.round(b.top + b.height / 2), left: Math.round(b.left) };
				}
			}
			return null;
		})()`));
	}

	/** Opens a row that has children, if it is closed. */
	async expand(section: Section, label: string): Promise<void> {
		const open = await this.cdp.evaluate<boolean>(`(() => {
			for (const pane of document.querySelectorAll('.pane')) {
				if (!(pane.querySelector('.pane-header')?.textContent || '').toUpperCase().includes(${q(section)})) continue;
				for (const r of pane.querySelectorAll('.monaco-list-row')) if ((r.querySelector('.label-name')?.textContent || '').trim() === ${q(label)}) return r.getAttribute('aria-expanded') === 'true';
			}
			return false;
		})()`);
		if (!open) {
			const box = await this.rowBox(section, label);
			await this.click({ x: box.left + 10, y: box.y });
			await waitFor(`"${label}" to open`, () => this.cdp.evaluate<boolean>(`(() => {
				for (const pane of document.querySelectorAll('.pane')) {
					if (!(pane.querySelector('.pane-header')?.textContent || '').toUpperCase().includes(${q(section)})) continue;
					for (const r of pane.querySelectorAll('.monaco-list-row')) if ((r.querySelector('.label-name')?.textContent || '').trim() === ${q(label)}) return r.getAttribute('aria-expanded') === 'true';
				}
				return false;
			})()`));
		}
	}

	// ---- the mouse -----------------------------------------------------------------------------------------------------

	private async mouse(type: 'mouseMoved' | 'mousePressed' | 'mouseReleased', at: Point, options: { button?: 'left' | 'right'; modifiers?: number; clickCount?: number } = {}): Promise<void> {
		const button = options.button ?? 'left';
		await this.cdp.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button, buttons: type === 'mousePressed' ? (button === 'left' ? 1 : 2) : 0, clickCount: options.clickCount ?? 1, modifiers: options.modifiers ?? 0 });
	}

	async hover(at: Point): Promise<void> {
		await this.mouse('mouseMoved', at);
	}

	/** modifiers: 2 is Ctrl, 8 is Shift. */
	async click(at: Point, options: { modifiers?: number; button?: 'left' | 'right' } = {}): Promise<void> {
		await this.mouse('mouseMoved', at, options);
		await this.mouse('mousePressed', at, options);
		await this.mouse('mouseReleased', at, options);
	}

	/** Two clicks in a row, then the browser's double click. */
	async doubleClick(at: Point): Promise<void> {
		await this.click(at);
		await sleep(80);
		await this.mouse('mousePressed', at, { clickCount: 2 });
		await this.mouse('mouseReleased', at, { clickCount: 2 });
	}

	async clickRow(section: Section, label: string, options: { modifiers?: number; button?: 'left' | 'right' } = {}): Promise<void> {
		await this.click(await this.rowBox(section, label), options);
	}

	/** Real drag and drop: the page starts the drag, and the drop is delivered where the target is. */
	async drag(from: { section: Section; label: string }, to: { section: Section; label: string }): Promise<void> {
		const source = await this.rowBox(from.section, from.label);
		const target = await this.rowBox(to.section, to.label);
		let data: unknown;
		this.cdp.on('Input.dragIntercepted', params => { data = params.data; });
		await this.cdp.send('Input.setInterceptDrags', { enabled: true });
		try {
			await this.mouse('mouseMoved', source);
			await this.mouse('mousePressed', source);
			for (let step = 1; step <= 8; step++) {
				await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: source.x + step * 3, y: source.y + step, button: 'left', buttons: 1 });
				await sleep(40);
			}
			await waitFor('the page to start a drag', async () => data, { timeoutMs: 3000 });
			await this.cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', x: target.x, y: target.y, data });
			for (let i = 0; i < 3; i++) {
				await this.cdp.send('Input.dispatchDragEvent', { type: 'dragOver', x: target.x, y: target.y, data });
				await sleep(60);
			}
			await this.cdp.send('Input.dispatchDragEvent', { type: 'drop', x: target.x, y: target.y, data });
			await this.mouse('mouseReleased', target);
		} finally {
			await this.cdp.send('Input.setInterceptDrags', { enabled: false });
		}
	}

	// ---- buttons and menus ---------------------------------------------------------------------------------------------

	/** The button of a row that shows when the pointer is over it (the quick "x"), by its title. */
	async rowButton(section: Section, label: string, title: string): Promise<Point> {
		const box = await this.rowBox(section, label);
		await this.hover(box);
		return waitFor(`the "${title}" button of "${label}"`, () => this.cdp.evaluate<Point | null>(`(() => {
			for (const pane of document.querySelectorAll('.pane')) {
				if (!(pane.querySelector('.pane-header')?.textContent || '').toUpperCase().includes(${q(section)})) continue;
				for (const r of pane.querySelectorAll('.monaco-list-row')) {
					if ((r.querySelector('.label-name')?.textContent || '').trim() !== ${q(label)}) continue;
					const a = [...r.querySelectorAll('.actions .action-label')].find(x => (x.getAttribute('aria-label') || x.title || '') === ${q(title)});
					if (!a) return null;
					const b = a.getBoundingClientRect();
					return b.width === 0 ? null : { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
				}
			}
			return null;
		})()`));
	}

	async pressRowButton(section: Section, label: string, title: string): Promise<void> {
		const at = await this.rowButton(section, label, title);
		await this.click(at);
	}

	/** A button in the title bar of a view: shown only while the pointer is over the title. */
	async titleButton(section: Section, title: string): Promise<Point> {
		const header = await waitFor(`the title of ${section}`, () => this.cdp.evaluate<Point | null>(`(() => {
			for (const pane of document.querySelectorAll('.pane')) {
				const head = pane.querySelector('.pane-header');
				if (!(head?.textContent || '').toUpperCase().includes(${q(section)})) continue;
				const b = head.getBoundingClientRect();
				return { x: Math.round(b.left + 40), y: Math.round(b.top + b.height / 2) };
			}
			return null;
		})()`));
		await this.hover(header);
		return waitFor(`the "${title}" button in the title of ${section}`, () => this.cdp.evaluate<Point | null>(`(() => {
			for (const pane of document.querySelectorAll('.pane')) {
				if (!(pane.querySelector('.pane-header')?.textContent || '').toUpperCase().includes(${q(section)})) continue;
				const a = [...pane.querySelectorAll('.pane-header .action-label')].find(x => (x.getAttribute('aria-label') || x.title || '') === ${q(title)});
				if (!a) return null;
				const b = a.getBoundingClientRect();
				return b.width === 0 ? null : { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
			}
			return null;
		})()`));
	}

	async pressTitleButton(section: Section, title: string): Promise<void> {
		await this.click(await this.titleButton(section, title));
	}

	/** The entries of the context menu that is open now. */
	contextMenu(): Promise<string[]> {
		return this.cdp.evaluate<string[]>(`[...document.querySelectorAll('.context-view .action-label')].map(a => (a.textContent || '').trim()).filter(Boolean)`);
	}

	async closeMenus(): Promise<void> {
		await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
		await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
	}

	// ---- dialogs, input boxes, notifications, tabs ---------------------------------------------------------------------

	dialog(): Promise<{ message: string; detail: string; buttons: string[] } | null> {
		return this.cdp.evaluate(`(() => {
			if (!document.querySelector('.dialog-buttons .monaco-button')) return null;
			return {
				message: (document.querySelector('.dialog-message-text')?.textContent || '').trim(),
				detail: (document.querySelector('.dialog-message-detail')?.textContent || '').trim(),
				buttons: [...document.querySelectorAll('.dialog-buttons .monaco-button')].map(b => (b.textContent || '').trim()),
			};
		})()`);
	}

	waitForDialog(options: { timeoutMs?: number } = {}): Promise<{ message: string; detail: string; buttons: string[] }> {
		return waitFor('a dialog', () => this.dialog(), { intervalMs: 10, ...options });
	}

	async pressDialogButton(text: string | RegExp): Promise<void> {
		const at = await waitFor(`the dialog button ${String(text)}`, () => this.cdp.evaluate<Point | null>(`(() => {
			const matches = ${text instanceof RegExp ? `t => ${text.toString()}.test(t)` : `t => t === ${q(text)}`};
			const b = [...document.querySelectorAll('.dialog-buttons .monaco-button')].find(x => matches((x.textContent || '').trim()));
			if (!b) return null;
			const r = b.getBoundingClientRect();
			return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
		})()`));
		await this.click(at);
	}

	/** The prompt of an input box that is open, or null. */
	inputBox(): Promise<{ prompt: string; value: string } | null> {
		return this.cdp.evaluate(`(() => {
			const widget = document.querySelector('.quick-input-widget');
			if (!widget || getComputedStyle(widget).display === 'none') return null;
			const input = widget.querySelector('input');
			if (!input) return null;
			return { prompt: (widget.querySelector('.quick-input-message')?.textContent || '').trim(), value: input.value };
		})()`);
	}

	async type(text: string): Promise<void> {
		await this.cdp.send('Input.insertText', { text });
	}

	async pressKey(key: 'Enter' | 'Escape'): Promise<void> {
		const code = key === 'Enter' ? 13 : 27;
		await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: code, text: key === 'Enter' ? '\r' : undefined });
		await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: code });
	}

	notifications(): Promise<string[]> {
		return this.cdp.evaluate<string[]>(`[...document.querySelectorAll('.notification-list-item-message')].map(n => (n.textContent || '').trim())`);
	}

	tabs(): Promise<string[]> {
		return this.cdp.evaluate<string[]>(`[...document.querySelectorAll('.tabs-container .tab')].map(t => t.getAttribute('aria-label') || (t.textContent || '').trim())`);
	}

	/** Clears what a previous test left open. */
	async tidy(): Promise<void> {
		await this.closeMenus();
		await this.cdp.evaluate(`(() => { document.querySelectorAll('.notification-toast .codicon-close, .notification-list-item .codicon-close').forEach(b => b.click()); })()`);
	}
}
