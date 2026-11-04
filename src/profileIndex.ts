// VS Code keeps a list of the extensions of each profile in an `extensions.json`: reading it is a few milliseconds, while asking
// the command line costs the start of a whole VS Code. No `vscode` import. The file is VS Code's own, so everything here is
// defensive: anything unexpected throws or is skipped, and the caller falls back to the command line.

import * as path from 'path';
import { InstalledExtension } from './cli';
import { isExtensionId } from './groups';

export interface IndexEntry {
	id: string;
	version?: string;
	/** The extension's folder inside the extensions folder, when the file names one that stays inside it. */
	folder?: string;
	applicationScoped: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A plain folder name: no separators, no "..", not absolute. */
const isFolderName = (text: unknown): text is string =>
	typeof text === 'string' && text !== '' && text !== '.' && text !== '..' && !/[\\/]/.test(text) && !path.isAbsolute(text);

/** Throws when the text is not a list, so that a format that changed is noticed instead of read as "no extensions". */
export function parseProfileIndex(text: string): IndexEntry[] {
	if (text.trim() === '') {
		return [];
	}
	const root: unknown = JSON.parse(text);
	if (!Array.isArray(root)) {
		throw new Error('extensions.json is not a list');
	}
	const entries: IndexEntry[] = [];
	for (const item of root) {
		if (!isRecord(item) || !isRecord(item.identifier) || typeof item.identifier.id !== 'string' || !isExtensionId(item.identifier.id)) {
			continue;
		}
		const metadata = isRecord(item.metadata) ? item.metadata : {};
		const platform = typeof metadata.targetPlatform === 'string' && metadata.targetPlatform !== 'universal' && metadata.targetPlatform !== 'undefined' ? metadata.targetPlatform : undefined;
		const version = typeof item.version === 'string' && item.version !== '' ? `${item.version}${platform ? `@${platform}` : ''}` : undefined;
		entries.push({
			id: item.identifier.id,
			...(version === undefined ? {} : { version }),
			...(isFolderName(item.relativeLocation) ? { folder: item.relativeLocation } : {}),
			applicationScoped: metadata.isApplicationScoped === true,
		});
	}
	return entries;
}

/**
 * What a profile has, as the command line lists it: its own extensions, and the application-scoped ones of the default
 * profile, which VS Code installs once for all profiles. Pass no `defaults` for the default profile itself.
 */
export function listFromIndexes(own: IndexEntry[], defaults: IndexEntry[] | undefined): InstalledExtension[] {
	const seen = new Set(own.map(e => e.id.toLowerCase()));
	const shared = (defaults ?? []).filter(e => e.applicationScoped && !seen.has(e.id.toLowerCase()));
	return [...own, ...shared].map(({ id, version, folder }) => ({ id, ...(version === undefined ? {} : { version }), ...(folder === undefined ? {} : { folder }) }));
}

export interface IndexLocation {
	profile: string;
	defaultName: string;
	extensionsDir: string | undefined;
	userDataDir: string | undefined;
	/** The folder VS Code gave the profile (its `location` in storage.json). */
	locationOf(profile: string): string | undefined;
}

/** Where the list of a profile is: the default one in the extensions folder, the others under the user data folder. */
export function indexPath({ profile, defaultName, extensionsDir, userDataDir, locationOf }: IndexLocation): string | undefined {
	if (profile === defaultName) {
		return extensionsDir ? path.join(extensionsDir, 'extensions.json') : undefined;
	}
	const location = locationOf(profile);
	return userDataDir && isFolderName(location) ? path.join(userDataDir, 'User', 'profiles', location, 'extensions.json') : undefined;
}
