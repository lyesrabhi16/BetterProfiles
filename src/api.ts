import type * as vscode from 'vscode';
import type { Profile } from './profiles';

/** What `activate()` returns, so other extensions (and the tests) can use it. */
export interface BetterProfilesApi {
	/** The profile of this window, or undefined when VS Code gives no way to tell. */
	getCurrentProfile(): Promise<Profile | undefined>;
	getProfiles(): Promise<Profile[]>;
	/** Re-read VS Code's storage and update the status bar. */
	refresh(): Promise<void>;
	readonly statusBarItem: vscode.StatusBarItem;
}
