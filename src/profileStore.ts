// What each profile has, kept in one place for the trees and the commands, plus what is being done to it right now:
// an extension that is being installed shows at once (marked), one that is being removed disappears at once, long before
// the command line is done. No `vscode` import.

import { InstalledExtension } from './cli';

export interface Entry {
	id: string;
	version?: string;
	folder?: string;
	/** Being installed: shown now, not there yet. */
	installing?: boolean;
}

interface Known {
	list: InstalledExtension[];
	at: number;
}

const lower = (text: string) => text.toLowerCase();

export class ProfileStore {
	private readonly known = new Map<string, Known>();
	private readonly reading = new Map<string, Promise<InstalledExtension[]>>();
	private readonly adding = new Map<string, Map<string, string>>();
	private readonly removingIds = new Map<string, Map<string, string>>();
	/** Changes that came while the list was not known (or was being read): applied to the list when it arrives. */
	private readonly queued = new Map<string, ((list: InstalledExtension[]) => InstalledExtension[])[]>();
	private readonly listeners = new Set<(profile?: string) => void>();
	private readonly now: () => number;

	constructor(private readonly read: (profile: string) => Promise<InstalledExtension[]>, options: { now?: () => number } = {}) {
		this.now = options.now ?? Date.now;
	}

	/** The list of a profile. With maxAgeMs, one read longer ago than that is read again. */
	list(profile: string, options: { maxAgeMs?: number } = {}): Promise<InstalledExtension[]> {
		const known = this.known.get(profile);
		if (known && (options.maxAgeMs === undefined || this.now() - known.at <= options.maxAgeMs)) {
			return Promise.resolve(known.list);
		}
		let pending = this.reading.get(profile);
		if (!pending) {
			pending = this.read(profile).then(list => {
				const settled = (this.queued.get(profile) ?? []).reduce((current, change) => change(current), list);
				this.queued.delete(profile);
				this.known.set(profile, { list: settled, at: this.now() });
				return settled;
			});
			this.reading.set(profile, pending);
			const forget = () => { if (this.reading.get(profile) === pending) { this.reading.delete(profile); } };
			pending.then(forget, forget);
		}
		return pending;
	}

	/** What is known, without waiting. */
	peek(profile: string): InstalledExtension[] | undefined {
		return this.known.get(profile)?.list;
	}

	private merge(list: InstalledExtension[], profile: string): Entry[] {
		const hidden = new Set(this.removingIds.get(profile)?.keys() ?? []);
		const have = new Set(list.map(e => lower(e.id)));
		return [
			...list.filter(e => !hidden.has(lower(e.id))),
			...[...(this.adding.get(profile) ?? [])].filter(([key]) => !have.has(key)).map(([, id]): Entry => ({ id, installing: true })),
		];
	}

	/** What a tree shows: the list, without what is being removed, with what is being installed. */
	async entries(profile: string): Promise<Entry[]> {
		return this.merge(await this.list(profile), profile);
	}

	entriesNow(profile: string): Entry[] | undefined {
		const list = this.peek(profile);
		return list && this.merge(list, profile);
	}

	private mark(table: Map<string, Map<string, string>>, profile: string, ids: readonly string[]): void {
		const marks = table.get(profile) ?? new Map<string, string>();
		ids.forEach(id => marks.set(lower(id), id));
		table.set(profile, marks);
		this.changed(profile);
	}

	installing(profile: string, ids: readonly string[]): void {
		this.mark(this.adding, profile, ids);
	}

	removing(profile: string, ids: readonly string[]): void {
		this.mark(this.removingIds, profile, ids);
	}

	private unmark(profile: string, ids: readonly string[]): void {
		for (const table of [this.adding, this.removingIds]) {
			ids.forEach(id => table.get(profile)?.delete(lower(id)));
		}
	}

	/** Whatever was being done to these did not happen (or is over): they show as they really are. */
	settle(profile: string, ids: readonly string[]): void {
		this.unmark(profile, ids);
		this.changed(profile);
	}

	/** Applies a change to the list: now if it is known, and again when a read that was under way arrives. */
	private apply(profile: string, change: (list: InstalledExtension[]) => InstalledExtension[]): void {
		const known = this.known.get(profile);
		if (known) {
			this.known.set(profile, { list: change(known.list), at: this.now() });
		}
		if (!known || this.reading.has(profile)) {
			this.queued.set(profile, [...(this.queued.get(profile) ?? []), change]);
		}
	}

	/** The install happened: they are in the list now. */
	added(profile: string, ids: readonly string[]): void {
		this.unmark(profile, ids);
		this.apply(profile, list => [...list, ...ids.filter(id => !list.some(e => lower(e.id) === lower(id))).map(id => ({ id }))]);
		this.changed(profile);
	}

	/** The uninstall happened: they are out of the list now. */
	removed(profile: string, ids: readonly string[]): void {
		const gone = new Set(ids.map(lower));
		this.unmark(profile, ids);
		this.apply(profile, list => list.filter(e => !gone.has(lower(e.id))));
		this.changed(profile);
	}

	/** Reads the profile again without anyone waiting for it. False when that did not work, and what was known stays. */
	async reload(profile: string): Promise<boolean> {
		try {
			const list = await this.read(profile);
			this.queued.delete(profile);
			this.known.set(profile, { list, at: this.now() });
			this.changed(profile);
			return true;
		} catch {
			return false;
		}
	}

	/** Forgets what is known of a profile (or of all), so that it is read again when asked for. */
	invalidate(profile?: string): void {
		if (profile === undefined) {
			this.known.clear();
			this.reading.clear();
			this.queued.clear();
		} else {
			this.known.delete(profile);
			this.reading.delete(profile);
			this.queued.delete(profile);
		}
		this.changed(profile);
	}

	onDidChange(listener: (profile?: string) => void): () => void {
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	}

	private changed(profile?: string): void {
		for (const listener of [...this.listeners]) {
			listener(profile);
		}
	}
}
