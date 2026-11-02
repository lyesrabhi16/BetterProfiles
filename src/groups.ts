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

export function isExtensionId(_text: string): boolean {
	throw new Error('not implemented');
}

export function emptyGroups(): GroupsConfig {
	throw new Error('not implemented');
}

export function parseGroups(_text: string): { config: GroupsConfig; warnings: string[] } {
	throw new Error('not implemented');
}

export function serializeGroups(_config: GroupsConfig): string {
	throw new Error('not implemented');
}

export function addToGroup(_config: GroupsConfig, _group: string, _ids: string[]): GroupsConfig {
	throw new Error('not implemented');
}

export function assignGroup(_config: GroupsConfig, _profile: string, _group: string): GroupsConfig {
	throw new Error('not implemented');
}

export function desiredExtensions(_config: GroupsConfig, _profile: string): { ids: string[]; missingGroups: string[] } {
	throw new Error('not implemented');
}

export function planSync(_config: GroupsConfig, _profile: string, _installedIds: string[]): SyncPlan {
	throw new Error('not implemented');
}

export function renderMatrix(_columns: MatrixColumn[]): string {
	throw new Error('not implemented');
}
