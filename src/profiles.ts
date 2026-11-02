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

export function parseStorage(_text: string): StorageSnapshot {
	throw new Error('not implemented');
}

export function associationKey(_window: WindowContext): string | undefined {
	throw new Error('not implemented');
}

export function detectProfile(_storage: StorageSnapshot, _window: WindowContext): Detection {
	throw new Error('not implemented');
}

export function statusText(_detection: Detection): string {
	throw new Error('not implemented');
}

export function statusTooltip(_detection: Detection): string {
	throw new Error('not implemented');
}
