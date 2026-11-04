import type * as vscode from 'vscode';
import type { Profile } from './profiles';

export interface PickItem {
	id: string;
	label: string;
	description?: string;
}

/**
 * Every question this extension asks goes through here, so it can be answered without a screen in the tests.
 * Replace a method to change how it asks; the defaults use VS Code's own notifications and pickers.
 */
export interface PromptUi {
	/** A message with buttons. Resolves to the button clicked, or undefined when dismissed. */
	ask(message: string, ...buttons: string[]): Promise<string | undefined>;
	/**
	 * One choice from a list. With `newItem` the list ends with an entry that asks for a typed name instead.
	 * Resolves to the chosen item's id (or the typed name), or undefined when cancelled.
	 */
	pickOne(title: string, items: PickItem[], options?: { newItem?: { label: string; prompt: string } }): Promise<string | undefined>;
	/**
	 * A checkbox list. Nothing is ticked beforehand. Resolves to the ticked ids, or undefined when cancelled.
	 * With `newItem` the list ends with an entry that, when ticked, asks for a typed name; that name takes its place
	 * in the result (so a result can hold names that were not in `items`).
	 */
	pickMany(title: string, items: PickItem[], options?: { newItem?: { label: string; prompt: string } }): Promise<string[] | undefined>;
	/** A modal confirmation. */
	confirm(message: string, detail: string, action: string): Promise<boolean>;
}

/** What the tests need to reach in a tree view of the Better Profiles tab. */
export interface TreeViewHandles {
	provider: vscode.TreeDataProvider<unknown>;
	dnd: vscode.TreeDragAndDropController<unknown>;
	refresh(): void;
}

/** What `activate()` returns, so other extensions (and the tests) can use it. */
export interface BetterProfilesApi {
	/** The profile of this window, or undefined when VS Code gives no way to tell. */
	getCurrentProfile(): Promise<Profile | undefined>;
	getProfiles(): Promise<Profile[]>;
	/** Re-read VS Code's storage and update the status bar. */
	refresh(): Promise<void>;
	/**
	 * Checks whether this window's profile has all the extensions of its groups and, depending on
	 * `betterProfiles.autoSync`, asks to install them, installs them, or does nothing. Never uninstalls.
	 */
	checkSync(): Promise<void>;
	/** Forget "Not now" answers, so the sync prompt can appear again. */
	resetPrompts(): Promise<void>;
	/** The ids (lower-case) of the extensions that are in some group: the list the Extensions view's menu uses. */
	groupedExtensions(): readonly string[];
	/** The two trees of the Better Profiles tab. */
	readonly views: { groups: TreeViewHandles; profiles: TreeViewHandles };
	readonly ui: PromptUi;
	readonly statusBarItem: vscode.StatusBarItem;
}
