// Pure logic, no `vscode` import: unit-testable without an Extension Host.

export const DEFAULT_PROFILE_ID = '__default__profile__';
export const DEFAULT_ICON = 'settings-view-bar-icon';

export interface Profile {
	name: string;
	location: string;
	icon?: string;
	useDefaultFlags?: Record<string, boolean>;
}

export interface StorageSnapshot {
	profiles: Profile[];
	/** Workspace URI (as `Uri.toString()`) -> profile location or DEFAULT_PROFILE_ID. */
	workspaces: Record<string, string>;
}

/** What the window has open. Strings are `Uri.toString()` values, the same form VS Code stores. */
export interface WindowContext {
	workspaceFile?: string;
	folders: string[];
}

export type UnknownReason = 'no-workspace' | 'not-recorded' | 'unknown-location';

export type Detection =
	| { kind: 'profile'; profile: Profile }
	| { kind: 'default'; profile: Profile }
	| { kind: 'unknown'; reason: UnknownReason };

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

function toProfile(entry: unknown): Profile | undefined {
	if (!isRecord(entry) || typeof entry.name !== 'string' || typeof entry.location !== 'string') {
		return undefined;
	}
	const profile: Profile = { name: entry.name, location: entry.location };
	if (typeof entry.icon === 'string') {
		profile.icon = entry.icon;
	}
	if (isRecord(entry.useDefaultFlags)) {
		profile.useDefaultFlags = Object.fromEntries(
			Object.entries(entry.useDefaultFlags).filter((flag): flag is [string, boolean] => typeof flag[1] === 'boolean'),
		);
	}
	return profile;
}

/** Reads the parts of VS Code's `storage.json` we need. Throws SyntaxError on invalid JSON. */
export function parseStorage(text: string): StorageSnapshot {
	const root: unknown = JSON.parse(text);
	const data = isRecord(root) ? root : {};

	const profiles = Array.isArray(data.userDataProfiles)
		? data.userDataProfiles.map(toProfile).filter((p): p is Profile => p !== undefined)
		: [];

	const workspaces: Record<string, string> = {};
	const associations = isRecord(data.profileAssociations) ? data.profileAssociations.workspaces : undefined;
	if (isRecord(associations)) {
		for (const [key, value] of Object.entries(associations)) {
			if (typeof value === 'string') {
				workspaces[key] = value;
			}
		}
	}
	return { profiles, workspaces };
}

/**
 * The key VS Code uses for this window in `profileAssociations.workspaces`: the workspace file when one
 * is open (multi-root), otherwise the single folder. Empty windows have none.
 */
export function associationKey(window: WindowContext): string | undefined {
	return window.workspaceFile ?? window.folders[0];
}

const defaultProfile = (): Profile => ({ name: 'Default', location: DEFAULT_PROFILE_ID });

/**
 * Works out the profile of a window. Only what VS Code recorded counts: a window with nothing recorded
 * is `unknown`, never guessed to be Default.
 */
export function detectProfile(storage: StorageSnapshot, window: WindowContext): Detection {
	const key = associationKey(window);
	if (key === undefined) {
		return { kind: 'unknown', reason: 'no-workspace' };
	}
	if (!Object.prototype.hasOwnProperty.call(storage.workspaces, key)) {
		return { kind: 'unknown', reason: 'not-recorded' };
	}
	const location = storage.workspaces[key];
	if (location === DEFAULT_PROFILE_ID) {
		return { kind: 'default', profile: defaultProfile() };
	}
	const profile = storage.profiles.find(p => p.location === location);
	return profile ? { kind: 'profile', profile } : { kind: 'unknown', reason: 'unknown-location' };
}

// Codicon ids are letters, digits and dashes; anything else would break the `$(icon)` syntax.
const ICON_ID = /^[a-z0-9][a-z0-9-]*$/i;

/** The profile's own icon (a codicon id), only when it has a valid one. */
export function profileIcon(profile: Profile): string | undefined {
	return profile.icon && ICON_ID.test(profile.icon) ? profile.icon : undefined;
}

const iconOf = (profile: Profile): string => profileIcon(profile) ?? DEFAULT_ICON;

// A profile named "$(rocket) x" must not turn into an icon: escape it as VS Code expects.
const escapeLabel = (text: string): string => text.replace(/\$\(/g, () => '\\$(');

export function statusText(detection: Detection): string {
	if (detection.kind === 'unknown') {
		return `$(${DEFAULT_ICON}) Profile`;
	}
	return `$(${iconOf(detection.profile)}) ${escapeLabel(detection.profile.name)}`;
}

export function statusTooltip(detection: Detection): string {
	const switchHint = 'Click to switch profile.';
	switch (detection.kind) {
		case 'profile':
		case 'default':
			return `Profile: ${detection.profile.name}. ${switchHint}`;
		case 'unknown':
			switch (detection.reason) {
				case 'no-workspace':
					return `Open a folder to detect the profile of this window. ${switchHint}`;
				case 'not-recorded':
					return `VS Code has not recorded a profile for this workspace yet. ${switchHint}`;
				case 'unknown-location':
					return `This workspace uses a profile that no longer exists (it was deleted). ${switchHint}`;
			}
	}
}
