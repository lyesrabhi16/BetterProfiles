// Pure logic for extension groups, no `vscode` import.

/** A group name -> extension ids, and a profile name -> the groups it should have. */
export interface GroupsConfig {
	groups: Record<string, string[]>;
	profiles: Record<string, string[]>;
}

/** The `profiles` key whose groups apply to every profile. */
export const ALL_PROFILES = '*';

export interface SyncPlan {
	toInstall: string[];
	alreadyInstalled: string[];
	/** Groups a profile points to that are not defined. */
	missingGroups: string[];
}

export interface MatrixColumn {
	profile: string;
	ids: string[];
}

// publisher.name. A `.vsix` suffix is refused on purpose: the CLI would read "evil.vsix" as a file path.
const EXTENSION_ID = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9._-]*$/i;

export function isExtensionId(text: string): boolean {
	return EXTENSION_ID.test(text) && !/\.vsix$/i.test(text);
}

export function emptyGroups(): GroupsConfig {
	return { groups: {}, profiles: {} };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const has = (record: object, key: string): boolean => Object.prototype.hasOwnProperty.call(record, key);

/** Removes duplicates, comparing case-insensitively and keeping the first spelling. */
function unique(items: string[]): string[] {
	const seen = new Set<string>();
	return items.filter(item => {
		const key = item.toLowerCase();
		return seen.has(key) ? false : (seen.add(key), true);
	});
}

/** Throws SyntaxError on invalid JSON, so a broken file is reported and never overwritten. */
export function parseGroups(text: string): { config: GroupsConfig; warnings: string[] } {
	const config = emptyGroups();
	const warnings: string[] = [];
	if (text.trim() === '') {
		return { config, warnings };
	}
	const root: unknown = JSON.parse(text);
	const data = isRecord(root) ? root : {};

	if (isRecord(data.groups)) {
		for (const [name, value] of Object.entries(data.groups)) {
			if (!Array.isArray(value)) {
				warnings.push(`Group "${name}" is not a list of extension ids; ignored.`);
				continue;
			}
			const ids: string[] = [];
			for (const entry of value) {
				if (typeof entry === 'string' && isExtensionId(entry)) {
					ids.push(entry);
				} else {
					warnings.push(`Group "${name}": ${JSON.stringify(entry)} is not a valid extension id (expected publisher.name); ignored.`);
				}
			}
			config.groups[name] = unique(ids);
		}
	}

	if (isRecord(data.profiles)) {
		for (const [name, value] of Object.entries(data.profiles)) {
			if (!Array.isArray(value)) {
				warnings.push(`Profile "${name}" does not list its groups as an array; ignored.`);
				continue;
			}
			config.profiles[name] = unique(value.filter((g): g is string => typeof g === 'string'));
		}
	}
	return { config, warnings };
}

export function serializeGroups(config: GroupsConfig): string {
	return JSON.stringify(config, null, 2) + '\n';
}

export function addToGroup(config: GroupsConfig, group: string, ids: string[]): GroupsConfig {
	const name = group.trim();
	if (name === '') {
		throw new Error('A group name is required.');
	}
	for (const id of ids) {
		if (!isExtensionId(id)) {
			throw new Error(`"${id}" is not a valid extension id (expected publisher.name).`);
		}
	}
	return {
		groups: { ...config.groups, [name]: unique([...(has(config.groups, name) ? config.groups[name] : []), ...ids]) },
		profiles: { ...config.profiles },
	};
}

export function assignGroup(config: GroupsConfig, profile: string, group: string): GroupsConfig {
	const profileName = profile.trim();
	const groupName = group.trim();
	if (profileName === '') {
		throw new Error('A profile name is required.');
	}
	if (groupName === '') {
		throw new Error('A group name is required.');
	}
	const current = has(config.profiles, profileName) ? config.profiles[profileName] : [];
	return {
		groups: { ...config.groups },
		profiles: { ...config.profiles, [profileName]: current.includes(groupName) ? current : [...current, groupName] },
	};
}

/** The extensions a profile should have: the "*" groups first, then its own. */
export function desiredExtensions(config: GroupsConfig, profile: string): { ids: string[]; missingGroups: string[] } {
	const names = unique([
		...(has(config.profiles, ALL_PROFILES) ? config.profiles[ALL_PROFILES] : []),
		...(profile !== ALL_PROFILES && has(config.profiles, profile) ? config.profiles[profile] : []),
	]);
	const ids: string[] = [];
	const missingGroups: string[] = [];
	for (const name of names) {
		if (has(config.groups, name)) {
			ids.push(...config.groups[name]);
		} else {
			missingGroups.push(name);
		}
	}
	return { ids: unique(ids), missingGroups };
}

/** What to install into a profile. It only ever adds: nothing is uninstalled or disabled. */
export function planSync(config: GroupsConfig, profile: string, installedIds: string[]): SyncPlan {
	const { ids, missingGroups } = desiredExtensions(config, profile);
	const installed = new Set(installedIds.map(id => id.toLowerCase()));
	return {
		toInstall: ids.filter(id => !installed.has(id.toLowerCase())),
		alreadyInstalled: ids.filter(id => installed.has(id.toLowerCase())),
		missingGroups,
	};
}

const cell = (text: string): string => text.replace(/\|/g, '\\|');

/** A Markdown table: one row per extension, one column per profile. */
export function renderMatrix(columns: MatrixColumn[]): string {
	if (columns.length === 0) {
		return 'No profiles to compare.\n';
	}
	const sets = columns.map(c => new Set(c.ids.map(id => id.toLowerCase())));
	const names = new Map<string, string>();
	for (const column of columns) {
		for (const id of column.ids) {
			if (!names.has(id.toLowerCase())) {
				names.set(id.toLowerCase(), id);
			}
		}
	}
	const keys = [...names.keys()].sort();
	const lines = [
		`| Extension | ${columns.map(c => cell(c.profile)).join(' | ')} |`,
		`| --- | ${columns.map(() => '---').join(' | ')} |`,
		...keys.map(key => `| ${cell(names.get(key)!)} | ${sets.map(s => (s.has(key) ? '✓' : '')).join(' | ')} |`),
		`| **Total** | ${sets.map(s => s.size).join(' | ')} |`,
	];
	return lines.join('\n') + '\n';
}

export interface CleanupPlan {
	/** Cleanup is only offered for a profile that has groups, all of them defined. */
	managed: boolean;
	reason?: 'no-groups' | 'missing-groups';
	/** Installed in the profile but in none of its groups, and not protected. */
	extras: string[];
}

/**
 * Extensions a profile has that its groups do not. Anything in `protectedIds` is never an extra.
 * Offered only when the groups fully describe the profile: with no groups, or a group that does not exist,
 * "everything else" would be a guess.
 */
export function planCleanup(_config: GroupsConfig, _profile: string, _installedIds: string[], _protectedIds: string[]): CleanupPlan {
	throw new Error('not implemented');
}

/** The ids present in every list. Extensions VS Code installs for all profiles at once show up in all of them. */
export function commonToAllProfiles(_lists: string[][]): string[] {
	throw new Error('not implemented');
}

/** Identifies a set of ids, so "Not now" can be remembered for exactly that set. */
export function promptKey(_ids: string[]): string {
	throw new Error('not implemented');
}
