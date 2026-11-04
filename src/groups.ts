// Pure logic for extension groups, no `vscode` import.

/** A group name -> extension ids, and a profile name -> the groups it should have. */
export interface GroupsConfig {
	groups: Record<string, string[]>;
	profiles: Record<string, string[]>;
	/** group name -> globs. A group with triggers is only wanted automatically where the workspace matches one. */
	triggers?: Record<string, string[]>;
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
	if (isRecord(data.triggers)) {
		for (const [group, value] of Object.entries(data.triggers)) {
			if (!Array.isArray(value)) {
				warnings.push(`Triggers of group "${group}" are not a list of patterns; ignored.`);
				continue;
			}
			const valid: string[] = [];
			for (const entry of value) {
				if (typeof entry === 'string' && isTriggerPattern(entry)) {
					valid.push(entry.trim());
				} else {
					warnings.push(`Group "${group}": ${JSON.stringify(entry)} is not a valid trigger pattern (a glob relative to the workspace folder); ignored.`);
				}
			}
			if (!has(config.groups, group)) {
				warnings.push(`Triggers are set for group "${group}", which does not exist.`);
			}
			if (valid.length > 0) {
				config.triggers = { ...(config.triggers ?? {}), [group]: [...new Set(valid)] };
			}
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
		...(config.triggers ? { triggers: config.triggers } : {}),
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
		...(config.triggers ? { triggers: config.triggers } : {}),
	};
}

/** The groups a profile follows: the "*" groups first, then its own. */
export function assignedGroups(config: GroupsConfig, profile: string): string[] {
	return unique([
		...(has(config.profiles, ALL_PROFILES) ? config.profiles[ALL_PROFILES] : []),
		...(profile !== ALL_PROFILES && has(config.profiles, profile) ? config.profiles[profile] : []),
	]);
}

/**
 * The extensions a profile should have, and the groups it refers to that do not exist. With `matched` (the
 * triggered groups this workspace matches), a group that has triggers only counts if it is in that list;
 * without it every assigned group counts.
 */
export function desiredExtensions(config: GroupsConfig, profile: string, matched?: readonly string[]): { ids: string[]; missingGroups: string[] } {
	const ids: string[] = [];
	const missingGroups: string[] = [];
	for (const name of assignedGroups(config, profile)) {
		if (!has(config.groups, name)) {
			missingGroups.push(name);
		} else if (matched === undefined || (config.triggers?.[name]?.length ?? 0) === 0 || matched.includes(name)) {
			// a group with triggers only counts where the workspace matched one of them
			ids.push(...config.groups[name]);
		}
	}
	return { ids: unique(ids), missingGroups };
}

/** What to install into a profile. It only ever adds: nothing is uninstalled or disabled. */
export function planSync(config: GroupsConfig, profile: string, installedIds: string[], matched?: readonly string[]): SyncPlan {
	const { ids, missingGroups } = desiredExtensions(config, profile, matched);
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
export function planCleanup(config: GroupsConfig, profile: string, installedIds: string[], protectedIds: string[]): CleanupPlan {
	if (assignedGroups(config, profile).length === 0) {
		return { managed: false, reason: 'no-groups', extras: [] };
	}
	const { ids, missingGroups } = desiredExtensions(config, profile);
	if (missingGroups.length > 0) {
		return { managed: false, reason: 'missing-groups', extras: [] };
	}
	if (ids.length === 0) {
		return { managed: false, reason: 'no-groups', extras: [] };
	}
	const keep = new Set([...ids, ...protectedIds].map(id => id.toLowerCase()));
	const extras = unique(installedIds)
		.filter(id => !keep.has(id.toLowerCase()))
		.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
	return { managed: true, extras };
}

/** The ids present in every list. Extensions VS Code installs for all profiles at once show up in all of them. */
export function commonToAllProfiles(lists: string[][]): string[] {
	if (lists.length === 0) {
		return [];
	}
	const sets = lists.map(list => new Set(list.map(id => id.toLowerCase())));
	return [...sets[0]].filter(id => sets.every(set => set.has(id)));
}

/** Identifies a set of ids, so "Not now" can be remembered for exactly that set. */
export function promptKey(ids: string[]): string {
	return unique(ids).map(id => id.toLowerCase()).sort().join(',');
}

/** A glob relative to a workspace folder. No absolute paths, no "..", no backslashes. */
export function isTriggerPattern(text: string): boolean {
	return typeof text === 'string'
		&& text.trim() !== ''
		&& text.length <= 200
		&& !text.includes('\0')
		&& !text.includes('\\')
		&& !text.startsWith('/')
		&& !/^[A-Za-z]:/.test(text)
		&& !text.split('/').includes('..');
}

const uniqueExact = (items: string[]): string[] => [...new Set(items)];

/** Replaces the triggers of an existing group; an empty list removes them. */
export function setTriggers(config: GroupsConfig, group: string, patterns: string[]): GroupsConfig {
	const name = group.trim();
	if (!has(config.groups, name)) {
		throw new Error(`There is no group "${name}".`);
	}
	const cleaned = uniqueExact(patterns.map(p => p.trim()));
	for (const pattern of cleaned) {
		if (!isTriggerPattern(pattern)) {
			throw new Error(`"${pattern}" is not a valid trigger pattern (a glob relative to the workspace folder, without ".." and not absolute).`);
		}
	}
	const triggers = { ...(config.triggers ?? {}) };
	if (cleaned.length > 0) {
		triggers[name] = cleaned;
	} else {
		delete triggers[name];
	}
	const { triggers: _old, ...rest } = config;
	return Object.keys(triggers).length > 0 ? { ...rest, triggers } : rest;
}

/** The groups this profile follows that have triggers, with their patterns. */
export function triggeredGroups(config: GroupsConfig, profile: string): { group: string; patterns: string[] }[] {
	return assignedGroups(config, profile)
		.filter(group => (config.triggers?.[group]?.length ?? 0) > 0)
		.map(group => ({ group, patterns: config.triggers![group] }));
}

/** The groups that contain an extension (ids compare case-insensitively), in the order of the file. */
export function groupsContaining(config: GroupsConfig, id: string): string[] {
	const key = id.toLowerCase();
	return Object.keys(config.groups).filter(group => config.groups[group].some(existing => existing.toLowerCase() === key));
}

/** Takes an extension out of one group. Nothing else changes; in particular nothing is uninstalled. */
export function removeFromGroup(config: GroupsConfig, group: string, id: string): GroupsConfig {
	if (!has(config.groups, group)) {
		throw new Error(`There is no group "${group}".`);
	}
	const key = id.toLowerCase();
	const kept = config.groups[group].filter(existing => existing.toLowerCase() !== key);
	if (kept.length === config.groups[group].length) {
		return config;
	}
	return { ...config, groups: { ...config.groups, [group]: kept } };
}

/** The profiles (and "*" for every profile) that follow a group, in the order of the file. */
export function profilesFollowing(config: GroupsConfig, group: string): string[] {
	return Object.keys(config.profiles).filter(profile => config.profiles[profile].includes(group));
}

/** Every extension that is in some group, lower-case and once: the form VS Code's menus use for an extension's id. */
export function groupedExtensionIds(config: GroupsConfig): string[] {
	return [...new Set(Object.values(config.groups).flat().map(id => id.toLowerCase()))];
}

/** Deletes a group, its triggers, and every profile's mention of it. The extensions themselves are untouched. */
export function removeGroup(_config: GroupsConfig, _group: string): GroupsConfig {
	throw new Error('not implemented');
}
