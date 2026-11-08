// Reads how an installed extension presents itself (name, publisher, description, icon) from its folder in the
// extensions directory, which holds every extension of every profile. No `vscode` import.

import * as fs from 'fs/promises';
import * as path from 'path';

export interface ExtensionInfo {
	/** The display name, like VS Code's Extensions list: `displayName`, else `name`. */
	name: string;
	publisher?: string;
	description?: string;
	version?: string;
	/** Absolute path of the icon image, only when it exists inside the extension's own folder. */
	iconPath?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

/** Resolves a `%key%` placeholder through the extension's package.nls.json. Plain text is returned as it is. */
export function resolveNls(value: unknown, nls?: Record<string, unknown>): string | undefined {
	if (typeof value !== 'string' || value === '') {
		return undefined;
	}
	const placeholder = /^%(.+)%$/.exec(value);
	if (!placeholder) {
		return value;
	}
	const entry = nls?.[placeholder[1]];
	if (typeof entry === 'string' && entry !== '') {
		return entry;
	}
	return isRecord(entry) && typeof entry.message === 'string' && entry.message !== '' ? entry.message : undefined;
}

/** Compares version texts like `1.10.0` and `2026.7.1-linux-x64`: numbers as numbers, anything else as text. */
function compareVersions(a: string, b: string): number {
	const left = a.split(/[.-]/);
	const right = b.split(/[.-]/);
	for (let i = 0; i < Math.max(left.length, right.length); i++) {
		const x = left[i] ?? '';
		const y = right[i] ?? '';
		const bothNumbers = /^\d+$/.test(x) && /^\d+$/.test(y);
		const order = bothNumbers ? Number(x) - Number(y) : x.localeCompare(y);
		if (order !== 0) {
			return order;
		}
	}
	return 0;
}

/**
 * The folder of an installed extension: `<id>-<version>[-<platform>]`, lower-case. With a version it picks that one
 * (CLI versions look like `1.2.3` or `1.2.3@linux-x64`); without one, or when that folder is gone, the latest.
 */
export function pickFolder(folders: string[], id: string, version?: string): string | undefined {
	const prefix = `${id.toLowerCase()}-`;
	// a version must follow the id, so that "a.b" does not match the folder of "a.b-c.d"
	const mine = folders.filter(folder => folder.toLowerCase().startsWith(prefix) && /^\d/.test(folder.slice(prefix.length)));
	if (mine.length === 0) {
		return undefined;
	}
	if (version !== undefined) {
		const wanted = `${prefix}${version.replace('@', '-')}`.toLowerCase();
		const exact = mine.find(folder => folder.toLowerCase() === wanted);
		if (exact) {
			return exact;
		}
	}
	return [...mine].sort((a, b) => compareVersions(b.slice(prefix.length), a.slice(prefix.length)))[0];
}

async function readJson(file: string): Promise<unknown> {
	return JSON.parse(await fs.readFile(file, 'utf8'));
}

/** The icon file, if it is really inside the extension's folder (a manifest must not point the editor elsewhere). */
async function insideIcon(folder: string, icon: string): Promise<string | undefined> {
	try {
		const candidate = path.resolve(folder, icon);
		const relative = path.relative(folder, candidate);
		if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
			return undefined;
		}
		const real = await fs.realpath(candidate);
		const realRelative = path.relative(await fs.realpath(folder), real);
		return realRelative.startsWith('..') || path.isAbsolute(realRelative) || !(await fs.stat(real)).isFile() ? undefined : candidate;
	} catch {
		return undefined;
	}
}

async function readInfo(folder: string): Promise<ExtensionInfo | undefined> {
	let manifest: unknown;
	try {
		manifest = await readJson(path.join(folder, 'package.json'));
	} catch {
		return undefined;
	}
	if (!isRecord(manifest)) {
		return undefined;
	}
	let nls: Record<string, unknown> | undefined;
	try {
		const parsed = await readJson(path.join(folder, 'package.nls.json'));
		nls = isRecord(parsed) ? parsed : undefined;
	} catch {
		// no localisation file: the texts are plain
	}
	const name = resolveNls(manifest.displayName, nls) ?? resolveNls(manifest.name, nls);
	if (!name) {
		return undefined;
	}
	const info: ExtensionInfo = { name };
	if (typeof manifest.publisher === 'string') {
		info.publisher = manifest.publisher;
	}
	const description = resolveNls(manifest.description, nls);
	if (description) {
		info.description = description;
	}
	if (typeof manifest.version === 'string') {
		info.version = manifest.version;
	}
	if (typeof manifest.icon === 'string') {
		const iconPath = await insideIcon(folder, manifest.icon);
		if (iconPath) {
			info.iconPath = iconPath;
		}
	}
	return info;
}

/** A plain folder name: no separators, no "..", not absolute. */
const isPlainName = (text: unknown): text is string =>
	typeof text === 'string' && text !== '' && text !== '.' && text !== '..' && !/[\\/]/.test(text) && !path.isAbsolute(text);

/**
 * What the extensions folder says about each extension. Like git with its index, it looks again only at what changed: an
 * extension's manifest is read once and trusted while its size and time stay as they were, so `clear` costs one look at the
 * folder, not a read of every extension.
 */
export class ExtensionCatalog {
	private listing: { dir: string; folders: Promise<string[]> } | undefined;
	/** The folder the manifests below were read from: another folder means they are of no use. */
	private readFrom: string | undefined;
	private readonly read = new Map<string, { mtimeMs: number; info: Promise<ExtensionInfo | undefined> }>();
	/** For the tests: how many times the folder was listed and how many manifests were read. */
	readonly stats = { listings: 0, manifests: 0 };

	constructor(private readonly dir: () => string | undefined) { }

	/** Whether there is an extensions folder to read at all. */
	known(): boolean {
		return this.dir() !== undefined;
	}

	/** Makes the next lookup look at the extensions folder again (for new extensions). What was read of an extension stays. */
	clear(): void {
		this.listing = undefined;
	}

	/** The manifest of one extension folder, read again only when it changed. */
	private async infoOf(full: string): Promise<ExtensionInfo | undefined> {
		let mtimeMs: number;
		try {
			mtimeMs = (await fs.stat(path.join(full, 'package.json'))).mtimeMs;
		} catch {
			this.read.delete(full);
			return undefined;
		}
		const known = this.read.get(full);
		if (known && known.mtimeMs === mtimeMs) {
			return known.info;
		}
		this.stats.manifests++;
		const info = readInfo(full);
		this.read.set(full, { mtimeMs, info });
		return info;
	}

	/** `folder` is where the caller already knows the extension is (VS Code's own list says): then nothing is listed. */
	async lookup(id: string, version?: string, folder?: string): Promise<ExtensionInfo | undefined> {
		const dir = this.dir();
		if (!dir) {
			return undefined;
		}
		if (this.readFrom !== dir) {
			this.read.clear();
			this.readFrom = dir;
		}
		if (isPlainName(folder)) {
			const named = await this.infoOf(path.join(dir, folder));
			if (named) {
				return named;
			}
		}
		if (this.readFrom !== dir) {
			this.read.clear();
			this.readFrom = dir;
		}
		if (this.listing?.dir !== dir) {
			this.listing = { dir, folders: (this.stats.listings++, fs.readdir(dir).catch(() => [] as string[])) };
		}
		const picked = pickFolder(await this.listing.folders, id, version);
		return picked ? this.infoOf(path.join(dir, picked)) : undefined;
	}
}
