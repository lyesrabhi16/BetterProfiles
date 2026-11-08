// Reads those files, and reads a file again only when it changed: a look at its size and time (like git does with its
// index) is enough to know. No `vscode` import.

import * as fs from 'fs/promises';
import { IndexEntry, parseProfileIndex } from './profileIndex';

interface Known {
	mtimeMs: number;
	size: number;
	entries: IndexEntry[];
}

export class ProfileIndexReader {
	private readonly known = new Map<string, Known>();
	/** For the tests: how often a file was only looked at and how often it was read. */
	readonly stats = { looks: 0, reads: 0 };

	/** The entries of the file; undefined when there is no file or it cannot be understood (the caller must not assume "empty"). */
	async read(file: string): Promise<IndexEntry[] | undefined> {
		let stat;
		try {
			stat = await fs.stat(file);
			this.stats.looks++;
		} catch (error) {
			this.known.delete(file);
			return undefined;
		}
		const before = this.known.get(file);
		if (before && before.mtimeMs === stat.mtimeMs && before.size === stat.size) {
			return [...before.entries];
		}
		try {
			const entries = parseProfileIndex(await fs.readFile(file, 'utf8'));
			this.stats.reads++;
			this.known.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, entries });
			return [...entries];
		} catch {
			this.known.delete(file);
			return undefined;
		}
	}

	forget(file?: string): void {
		if (file === undefined) {
			this.known.clear();
		} else {
			this.known.delete(file);
		}
	}
}
