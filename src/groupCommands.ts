import { FSWatcher, watch } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import type { BetterProfilesApi, PickItem, PromptUi } from './api';
import type { ViewsCore } from './views';
import {
	CliInvocation,
	DEFAULT_PROFILE_NAME,
	InstallResult,
	InstalledExtension,
	Runner,
	defaultRunner,
	installExtension,
	listExtensions,
	uninstallExtensions,
	isInstalledExtensionPath,
	pickExtensionsDir,
	resolveCli,
	userDataDirFromGlobalStorage,
	userDataDirFromStorageFile,
} from './cli';
import { IndexEntry, indexPath, listFromIndexes } from './profileIndex';
import { KeptReason, keptDetail, keptSentence } from './removalText';
import { ProfileIndexReader } from './profileIndexReader';
import { ProfileStore } from './profileStore';
import {
	ALL_PROFILES,
	GroupsConfig,
	SyncPlan,
	addToGroup,
	assignGroup,
	commonToAllProfiles,
	desiredExtensions,
	emptyGroups,
	excludeFromProfile,
	groupedExtensionIds,
	groupsContaining,
	includeInProfile,
	isExtensionId,
	parseGroups,
	planCleanup,
	planSync,
	promptKey,
	profilesFollowing,
	removeFromGroup,
	renderMatrix,
	serializeGroups,
	setTriggers,
	triggeredGroups,
	unassignGroup,
} from './groups';

export interface SyncReport {
	profile: string;
	plan: SyncPlan;
	results: InstallResult[];
	/** True when the user declined the confirmation. */
	cancelled?: boolean;
	/** Extensions the profile has that none of its groups mention (only when a cleanup was considered). */
	extras?: string[];
	uninstalled?: InstallResult[];
}

type UninstallMode = 'none' | 'ask' | string[];

/** What removing something from a profile did. */
export interface RemovalReport {
	/** Taken out of the profile. */
	uninstalled: string[];
	/** Left installed on purpose: this extension, what keepExtensions lists, what VS Code applies to all profiles. */
	kept: string[];
	/** The command line could not uninstall them. */
	failed: string[];
	/** The user declined the question, and nothing was changed. */
	cancelled: boolean;
	/** Why each one in `kept` stays. */
	reasons: Record<string, KeptReason>;
}

export interface GroupFeatures {
	/** The lower-case ids of the extensions that are in some group (what the Extensions view menu is told). */
	groupedExtensions(): readonly string[];
	/** Reads the groups file again and tells VS Code, so the menu shows the right entries. */
	refreshGroupedContext(): Promise<void>;
	disposables: vscode.Disposable[];
	checkSync(): Promise<void>;
	resetPrompts(): Promise<void>;
	groupsFilePath(): string;
	/** What the Better Profiles tab needs to read and change the groups and to reach the command line. */
	core: Omit<ViewsCore, 'currentProfileName'>;
}

const SELF_ID = 'lyesrabhi.better-profiles';
const DISMISSED_KEY = 'betterProfiles.dismissedSyncPrompts';

interface Dependencies {
	context: vscode.ExtensionContext;
	log: vscode.LogOutputChannel;
	api: Pick<BetterProfilesApi, 'getProfiles' | 'getCurrentProfile'>;
	ui: PromptUi;
	/** Replaceable so the CLI can be faked. */
	run?: Runner;
}

const lower = (text: string) => text.toLowerCase();

/**
 * Every command takes optional arguments for non-interactive use (that is how the tests drive them). Without
 * them the command asks with quick picks and input boxes.
 */
export function registerGroupCommands({ context, log, api, ui, run = defaultRunner }: Dependencies): GroupFeatures {
	const settings = () => vscode.workspace.getConfiguration('betterProfiles');

	// The groups live in this extension's global storage, which every profile shares (VS Code settings are per profile).
	const groupsFilePath = (): string =>
		settings().get<string>('groupsFile')?.trim() || path.join(context.globalStorageUri.fsPath, 'groups.json');

	async function loadGroups(): Promise<{ config: GroupsConfig; file: string }> {
		const file = groupsFilePath();
		let text: string;
		try {
			text = await fs.readFile(file, 'utf8');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				return { config: emptyGroups(), file };
			}
			throw new Error(`Could not read your groups file ${file}: ${error instanceof Error ? error.message : String(error)}`);
		}
		try {
			const { config, warnings } = parseGroups(text);
			warnings.forEach(warning => log.warn(warning));
			return { config, file };
		} catch {
			throw new Error(`Your groups file is not valid JSON, so nothing was changed: ${file}`);
		}
	}

	let grouped: readonly string[] = [];
	const groupsChanged = new vscode.EventEmitter<void>();

	/**
	 * A menu entry's label is fixed text, so group names cannot appear in the Extensions view menu. What a menu can do
	 * is depend on a context key: this one lists the extensions that are in a group, and "Remove from group" is only
	 * shown for those. The menu's own `extension` key is the lower-case id.
	 */
	async function refreshGroupedContext(): Promise<void> {
		try {
			grouped = groupedExtensionIds((await loadGroups()).config);
		} catch {
			grouped = []; // a broken or unreadable file: nothing counts as grouped, and the commands report the problem themselves
		}
		await vscode.commands.executeCommand('setContext', 'betterProfiles.groupedExtensions', [...grouped]);
	}

	async function saveGroups(file: string, config: GroupsConfig): Promise<void> {
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, serializeGroups(config), 'utf8');
		await refreshGroupedContext();
		groupsChanged.fire();
	}

	/** Default plus every profile VS Code has. */
	async function profileNames(): Promise<string[]> {
		const names = [DEFAULT_PROFILE_NAME, ...(await api.getProfiles()).map(p => p.name)];
		return names.filter((name, i) => names.indexOf(name) === i);
	}

	/** Where installed extensions live. Development checkouts and built-in extensions say nothing about it. */
	function userExtensionPaths(): string[] {
		return vscode.extensions.all.filter(ext => isInstalledExtensionPath(ext.id, ext.extensionPath)).map(ext => ext.extensionPath);
	}

	/** The folder holding every installed extension: the setting, else the folder of the extensions that are installed. */
	function extensionsDir(): string | undefined {
		return settings().get<string>('extensionsDir')?.trim() || pickExtensionsDir(userExtensionPaths());
	}

	function resolveCliOrThrow(): CliInvocation {
		const resolved = resolveCli({
			command: settings().get<string>('codeCommand'),
			args: settings().get<string[]>('codeArgs'),
			execPath: process.execPath,
			appRoot: vscode.env.appRoot,
			userDataDir: userDataDirFromGlobalStorage(context.globalStorageUri.fsPath),
			extensionsDir: extensionsDir(),
		});
		if ('error' in resolved) {
			throw new Error(resolved.error);
		}
		return resolved;
	}

	// ---- what each profile has -----------------------------------------------------------------------------------

	const indexReader = new ProfileIndexReader();
	const watchers = new Map<string, FSWatcher>();
	let redrawTimer: NodeJS.Timeout | undefined;

	/** The user data folder, as far as the storage file in use says (a test, a portable install), else this window's. */
	const userDataDir = (): string => {
		const configured = settings().get<string>('storageFile')?.trim();
		return (configured ? userDataDirFromStorageFile(configured) : undefined) ?? userDataDirFromGlobalStorage(context.globalStorageUri.fsPath);
	};

	/** Something else (the Extensions view, another window) changed a list: forget what was known, and the trees redraw. */
	function watchFolder(dir: string): void {
		if (watchers.has(dir)) {
			return;
		}
		try {
			const watcher = watch(dir, (_event, name) => {
				if (name && name !== 'extensions.json') {
					return;
				}
				clearTimeout(redrawTimer);
				redrawTimer = setTimeout(() => {
					indexReader.forget();
					store.invalidate();
				}, 150);
			});
			watcher.on('error', () => { watcher.close(); watchers.delete(dir); });
			watchers.set(dir, watcher);
		} catch {
			// no watching here: the lists are then read again whenever a command needs them
		}
	}

	/** A profile's extensions from the files VS Code keeps, which is instant; undefined when they cannot be trusted. */
	async function listFromFiles(profile: string): Promise<InstalledExtension[] | undefined> {
		if (settings().get<boolean>('listFromFiles') === false) {
			return undefined;
		}
		const known = await api.getProfiles();
		const where = (name: string) => indexPath({ profile: name, defaultName: DEFAULT_PROFILE_NAME, extensionsDir: extensionsDir(), userDataDir: userDataDir(), locationOf: other => known.find(p => p.name === other)?.location });
		const file = where(profile);
		if (!file) {
			return undefined;
		}
		watchFolder(path.dirname(file));
		let own = await indexReader.read(file);
		if (own === undefined) {
			// Only a profile that has a folder of its own but no list file yet is known to have no extensions. A file that is
			// there and cannot be understood, or a folder that is not there, says nothing: the command line is asked.
			const there = (target: string) => fs.stat(target).then(() => true, () => false);
			if (profile === DEFAULT_PROFILE_NAME || await there(file) || !await there(path.dirname(file))) {
				return undefined;
			}
			own = [];
		}
		let defaults: IndexEntry[] | undefined;
		if (profile !== DEFAULT_PROFILE_NAME) {
			const defaultFile = where(DEFAULT_PROFILE_NAME);
			defaults = defaultFile ? await indexReader.read(defaultFile) : undefined;
			if (defaults === undefined) {
				return undefined; // the application-scoped extensions live there: without them the list would be wrong
			}
		}
		return listFromIndexes(own, defaults);
	}

	/** The files when they can be read, else the command line (which starts a whole VS Code, hence the caching in the store). */
	async function readProfile(profile: string): Promise<InstalledExtension[]> {
		let fromFiles: InstalledExtension[] | undefined;
		try {
			fromFiles = await listFromFiles(profile);
		} catch (error) {
			log.warn(`Could not read the extension list of "${profile}" from VS Code's files: ${error instanceof Error ? error.message : String(error)}`);
		}
		return fromFiles ?? listExtensions(resolveCliOrThrow(), run, profile);
	}

	const store = new ProfileStore(readProfile);

	async function pickProfile(title: string, options: { includeAll?: boolean } = {}): Promise<string | undefined> {
		const current = (await api.getCurrentProfile())?.name;
		const items: PickItem[] = (await profileNames()).map(name => ({ id: name, label: name, description: name === current ? 'current' : undefined }));
		if (options.includeAll) {
			items.unshift({ id: ALL_PROFILES, label: '$(globe) All profiles', description: 'groups applied to every profile' });
		}
		return ui.pickOne(title, items);
	}

	async function pickGroup(config: GroupsConfig, title: string, options: { allowNew?: boolean } = {}): Promise<string | undefined> {
		const items: PickItem[] = Object.keys(config.groups).map(name => ({ id: name, label: name, description: `${config.groups[name].length} extensions` }));
		return ui.pickOne(title, items, options.allowNew ? { newItem: { label: '$(add) New group', prompt: 'Name of the new group' } } : undefined);
	}

	const SYNC_BUTTON = 'Sync Profile';
	const GIVE_BUTTON = 'Give Group To A Profile';

	/** A notification whose buttons start the next step. The command never waits for the answer: the user may leave it open. */
	function offer(message: string, actions: Record<string, () => Thenable<unknown>>): void {
		void ui.ask(message, ...Object.keys(actions))
			.then(choice => (choice !== undefined && Object.prototype.hasOwnProperty.call(actions, choice) ? actions[choice]() : undefined))
			.then(undefined, error => log.warn(`Follow-up from a notification failed: ${error instanceof Error ? error.message : String(error)}`));
	}

	/**
	 * After groups changed: sync if some profile follows any of them; if none does, syncing would do nothing, so offer to
	 * give them to one. With a single group the profile question already knows which group it is about.
	 */
	const nextStepFor = (config: GroupsConfig, groups: string[]): Record<string, () => Thenable<unknown>> =>
		groups.some(group => profilesFollowing(config, group).length > 0)
			? { [SYNC_BUTTON]: () => vscode.commands.executeCommand('better-profiles.syncProfile') }
			: { [GIVE_BUTTON]: () => vscode.commands.executeCommand('better-profiles.assignGroup', groups.length === 1 ? { group: groups[0] } : undefined) };

	const withProgress = <T>(title: string, task: () => Promise<T>) =>
		vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, task);
	/** For looking at things, which is usually instant: a spinner in the status bar, not a notification that flashes. */
	const looking = <T>(title: string, task: () => Promise<T>) =>
		vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title }, task);

	const editGroups = async (args?: { open?: boolean }): Promise<string> => {
		const file = groupsFilePath();
		try {
			await fs.access(file);
		} catch {
			await saveGroups(file, emptyGroups());
		}
		if (args?.open !== false) {
			await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(file)));
		}
		return file;
	};

	const addToGroupCommand = async (args?: { group?: string; extensions?: string[] }): Promise<GroupsConfig | undefined> => {
		const { config, file } = await loadGroups();
		let { group, extensions } = args ?? {};
		if (group === undefined || extensions === undefined) {
			group = await pickGroup(config, 'Add extensions to which group?', { allowNew: true });
			const profile = group === undefined ? undefined : await pickProfile('Pick the extensions from which profile?');
			if (group === undefined || profile === undefined) {
				return undefined;
			}
			const inGroup = new Set((config.groups[group] ?? []).map(lower));
			const installed = await withProgress(`Listing the extensions of "${profile}"…`, () => listExtensions(resolveCliOrThrow(), run, profile));
			const picked = await vscode.window.showQuickPick(
				installed.filter(e => !inGroup.has(lower(e.id))).map(e => ({ label: e.id, description: e.version })),
				{ canPickMany: true, placeHolder: `Extensions of "${profile}" to add to "${group}"` },
			);
			if (!picked?.length) {
				return undefined;
			}
			extensions = picked.map(item => item.label);
		}
		const next = addToGroup(config, group, extensions);
		await saveGroups(file, next);
		offer(`Group "${group.trim()}" now has ${next.groups[group.trim()].length} extensions.`, nextStepFor(next, [group.trim()]));
		return next;
	};

	const assignGroupCommand = async (args?: { profile?: string; group?: string; groups?: string[] }): Promise<GroupsConfig | undefined> => {
		const { config, file } = await loadGroups();
		const named = args?.groups ?? (args?.group === undefined ? undefined : [args.group]);
		const profile = args?.profile ?? await pickProfile('Give a group to which profile?', { includeAll: true });
		const picked = profile === undefined ? undefined : (named ?? await (async () => { const one = await pickGroup(config, `Which group should "${profile}" have?`); return one === undefined ? undefined : [one]; })());
		if (profile === undefined || picked === undefined || picked.length === 0) {
			return undefined;
		}
		for (const group of picked) {
			if (!Object.prototype.hasOwnProperty.call(config.groups, group)) {
				throw new Error(`There is no group "${group}". Add extensions to it first.`);
			}
		}
		const next = picked.reduce((updated, group) => assignGroup(updated, profile, group), config);
		await saveGroups(file, next);
		offer(`"${profile === ALL_PROFILES ? 'All profiles' : profile}" now gets the group${picked.length === 1 ? '' : 's'} ${picked.map(group => `"${group}"`).join(', ')}.`, { [SYNC_BUTTON]: () => vscode.commands.executeCommand('better-profiles.syncProfile') });
		return next;
	};

	// ---- commands for the gear menu of an extension in the Extensions view (menu "extension/context") ------------
	// VS Code calls them with the extension's id, then an object about it. A test (or another extension) can instead
	// pass one object that also carries the answers, so nothing needs to be asked.

	const extensionIdOf = (target: unknown): string => {
		const id = typeof target === 'string' ? target : (target as { id?: unknown } | null | undefined)?.id;
		if (typeof id !== 'string' || !isExtensionId(id)) {
			throw new Error(`"${String(id)}" is not a valid extension id (expected publisher.name).`);
		}
		return id;
	};
	/** One extension (an id, or an object with an id), or `{ ids }` for several: each valid, once. */
	const extensionIdsOf = (target: unknown): string[] => {
		const given = Array.isArray((target as { ids?: unknown } | null | undefined)?.ids) ? (target as { ids: unknown[] }).ids : [target];
		const ids = [...new Map(given.map(item => extensionIdOf(item)).map(id => [lower(id), id])).values()];
		if (ids.length === 0) {
			throw new Error('No extension was given.');
		}
		return ids;
	};
	const optionsOf = <T extends object>(target: unknown): Partial<T> => (typeof target === 'object' && target !== null ? target as Partial<T> : {});

	const quoted = (names: string[]) => names.map(name => `"${name}"`).join(', ');

	const extensionAddToGroup = async (target: unknown): Promise<GroupsConfig | undefined> => {
		const ids = extensionIdsOf(target);
		const subject = ids.length === 1 ? ids[0] : `${ids.length} extensions`;
		const { config, file } = await loadGroups();
		const named = optionsOf<{ group: string; groups: string[] }>(target);
		const heldIn = (group: string) => ids.filter(id => (config.groups[group] ?? []).some(existing => lower(existing) === lower(id)));
		let picked: string[] | undefined = named.groups ?? (named.group === undefined ? undefined : [named.group]);
		if (picked === undefined) {
			picked = await ui.pickMany(
				`Add ${subject} to which groups?`,
				Object.keys(config.groups).map(name => {
					const held = heldIn(name).length;
					return {
						id: name,
						label: name,
						description: held === ids.length ? `$(check) already has ${ids.length === 1 ? 'it' : 'all of them'}` : held > 0 ? `${held} of ${ids.length} already in it` : `${config.groups[name].length} extensions`,
					};
				}),
				{ newItem: { label: '$(add) New group', prompt: 'Name of the new group' } },
			);
		}
		// a name that is not an existing group starts a new one
		const chosen = [...new Set((picked ?? []).map(name => name.trim()).filter(name => name !== ''))];
		if (chosen.length === 0) {
			return undefined;
		}
		let next = config;
		const touched: string[] = [];
		const already: string[] = [];
		for (const name of chosen) {
			const missing = ids.filter(id => !heldIn(name).some(held => lower(held) === lower(id)));
			if (missing.length === 0) {
				already.push(name);
			} else {
				next = addToGroup(next, name, missing);
				touched.push(name);
			}
		}
		if (touched.length === 0) {
			void vscode.window.showInformationMessage(`${subject} ${ids.length === 1 ? 'is' : 'are'} already in ${quoted(already)}.`);
			return config;
		}
		await saveGroups(file, next);
		offer(`Added ${subject} to ${quoted(touched)}.${already.length > 0 ? ` ${ids.length === 1 ? 'It was' : 'They were'} already in ${quoted(already)}.` : ''}`, nextStepFor(next, touched));
		return next;
	};

	const extensionRemoveFromGroup = async (target: unknown): Promise<GroupsConfig | undefined> => {
		const id = extensionIdOf(target);
		const { config, file } = await loadGroups();
		const holders = groupsContaining(config, id);
		if (holders.length === 0) {
			void vscode.window.showInformationMessage(`${id} is not in any group.`);
			return config;
		}
		const named = optionsOf<{ groups: string[] }>(target).groups;
		let chosen: string[];
		if (named) {
			const notHolding = named.find(group => !holders.includes(group));
			if (notHolding !== undefined) {
				throw new Error(`${id} is not in the group "${notHolding}".`);
			}
			chosen = named;
		} else {
			const picked = await ui.pickMany(`Remove ${id} from which groups?`, holders.map(group => ({ id: group, label: group })));
			if (!picked?.length) {
				return undefined;
			}
			chosen = holders.filter(group => picked.includes(group));
		}
		const next = chosen.reduce((updated, group) => removeFromGroup(updated, group, id), config);
		await saveGroups(file, next);
		void vscode.window.showInformationMessage(`Removed ${id} from ${chosen.map(g => `"${g}"`).join(', ')}. Nothing was uninstalled.`);
		return next;
	};

	const extensionInstallInProfiles = async (target: unknown): Promise<{ id: string; ids: string[]; results: { profile: string; ok: boolean; message: string }[]; alreadyHad: string[] } | undefined> => {
		const ids = extensionIdsOf(target);
		const subject = ids.length === 1 ? ids[0] : `${ids.length} extensions`;
		const named = optionsOf<{ profiles: string[] }>(target).profiles;
		const names = await profileNames();
		const unknown = named?.find(profile => !names.includes(profile));
		if (unknown !== undefined) {
			throw new Error(`Unknown profile "${unknown}". VS Code has: ${names.join(', ')}.`);
		}
		const cli = resolveCliOrThrow();

		const found = await looking(`Looking for ${subject} in every profile…`, () => Promise.all(names.map(async name => {
			const have = new Set((await store.list(name, { maxAgeMs: 0 })).map(e => lower(e.id)));
			return [name, ids.filter(id => !have.has(lower(id)))] as const;
		})));
		const missing = new Map(found);
		const alreadyHad = names.filter(name => missing.get(name)!.length === 0);
		const lacking = names.filter(name => missing.get(name)!.length > 0);
		if (lacking.length === 0) {
			void vscode.window.showInformationMessage(ids.length === 1 ? `${ids[0]} is already in every profile.` : `All ${ids.length} extensions are already in every profile.`);
			return { id: ids[0], ids, results: [], alreadyHad };
		}

		let targets: string[];
		if (named) {
			targets = named.filter(profile => lacking.includes(profile));
		} else {
			const picked = await ui.pickMany(
				`Install ${subject} into which profiles?`,
				lacking.map(name => ({ id: name, label: name, description: ids.length > 1 ? `lacks ${missing.get(name)!.length} of ${ids.length}` : undefined })),
			);
			if (!picked?.length) {
				return undefined;
			}
			targets = lacking.filter(name => picked.includes(name));
		}

		targets.forEach(profile => store.installing(profile, missing.get(profile)!)); // shown in those profiles now, while the command line works
		const results = await withProgress(`Installing ${subject}…`, async () => {
			const done: { profile: string; ok: boolean; message: string }[] = [];
			for (const profile of targets) {
				const failures: string[] = [];
				for (const id of missing.get(profile)!) {
					const result = await installExtension(cli, run, id, profile);
					if (!result.ok) {
						log.error(`${id} -> ${profile}: ${result.message}`);
						failures.push(ids.length === 1 ? result.message : `${id}: ${result.message}`);
					}
					result.ok ? store.added(profile, [id]) : store.settle(profile, [id]);
					if (result.ok) {
						await forgetExclusions(profile, [id]);
					}
				}
				done.push({ profile, ok: failures.length === 0, message: failures.join('; ') });
			}
			return done;
		});
		const failed = results.filter(r => !r.ok);
		void (failed.length === 0
			? vscode.window.showInformationMessage(results.length > 0 ? `Installed ${subject} into ${results.map(r => `"${r.profile}"`).join(', ')}.` : `${subject} ${ids.length === 1 ? 'is' : 'are'} already in the profiles you named.`)
			: vscode.window.showWarningMessage(`Could not install ${subject} into ${failed.map(r => `"${r.profile}"`).join(', ')}.`, 'Show Log').then(choice => choice && log.show()));
		return { id: ids[0], ids, results, alreadyHad };
	};

	const setGroupTriggersCommand = async (args?: { group?: string; patterns?: string[] }): Promise<GroupsConfig | undefined> => {
		const { config, file } = await loadGroups();
		const group = args?.group ?? await pickGroup(config, 'Set workspace triggers for which group?');
		if (group === undefined) {
			return undefined;
		}
		let patterns = args?.patterns;
		if (patterns === undefined) {
			const typed = await vscode.window.showInputBox({
				prompt: `Files that tell ${group} is needed, as globs relative to the workspace folder, separated by commas (empty removes them)`,
				placeHolder: '**/pubspec.yaml, **/*.dart',
				value: (config.triggers?.[group] ?? []).join(', '),
			});
			if (typed === undefined) {
				return undefined;
			}
			patterns = typed.split(',').map(p => p.trim()).filter(p => p !== '');
		}
		const next = setTriggers(config, group, patterns);
		await saveGroups(file, next);
		void vscode.window.showInformationMessage(patterns.length > 0
			? `"${group}" is now offered in workspaces that contain: ${patterns.join(', ')}.`
			: `"${group}" no longer has workspace triggers.`);
		return next;
	};

	const compareProfiles = async (args?: { open?: boolean }): Promise<string> => {
		const names = await profileNames();
		const columns = await looking('Comparing the extensions of every profile…', () => Promise.all(names.map(async profile => {
			try {
				return { profile, ids: (await store.list(profile, { maxAgeMs: 0 })).map(e => e.id) };
			} catch (error) {
				throw new Error(`Could not list the extensions of "${profile}": ${error instanceof Error ? error.message : String(error)}`);
			}
		})));
		const markdown = `# Extensions per profile\n\n${renderMatrix(columns)}`;
		if (args?.open !== false) {
			await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: 'markdown', content: markdown }));
		}
		return markdown;
	};

	/** What every profile has now, by profile: from the files that is instant, and the reads go side by side. */
	async function everyProfile(known: Map<string, string[]> = new Map()): Promise<Map<string, string[]>> {
		const names = await profileNames();
		const lists = await Promise.all(names.map(async name => known.get(name) ?? (await store.list(name, { maxAgeMs: 0 })).map(e => e.id)));
		return new Map(names.map((name, i) => [name, lists[i]]));
	}

	/**
	 * Why each extension must never be uninstalled from just one profile (by lower-case id): this one, what the user listed,
	 * and what VS Code applies to all profiles (one copy for every profile, so "from this profile" would mean from all).
	 * VS Code's files say which those are; with only the command line's lists the best guess is what every profile has.
	 */
	async function protectionOf(profile: string, own: InstalledExtension[], known?: Map<string, string[]>): Promise<Map<string, KeptReason>> {
		const reasons = new Map<string, KeptReason>();
		if (own.length > 0 && own.every(e => e.applicationScoped !== undefined)) {
			own.filter(e => e.applicationScoped).forEach(e => reasons.set(lower(e.id), 'application'));
		} else if (own.length > 0) {
			commonToAllProfiles([...(await everyProfile(known)).values()]).forEach(id => reasons.set(id, 'everywhere'));
		}
		(settings().get<string[]>('keepExtensions') ?? []).forEach(id => reasons.set(lower(id), 'keep'));
		reasons.set(lower(SELF_ID), 'self');
		return reasons;
	}

	/** Everything the profile has that its groups do not, minus what must never be offered for removal. */
	async function findExtras(profile: string, config: GroupsConfig): Promise<string[]> {
		const own = await looking(`Looking at what "${profile}" has…`, () => store.list(profile, { maxAgeMs: 0 }));
		const protectedIds = [...(await looking(`Looking at what "${profile}" has…`, () => protectionOf(profile, own))).keys()];
		return planCleanup(config, profile, own.map(e => e.id), protectedIds).extras;
	}

	/** Which of these the profile has, split into what can go and what must stay (with why). */
	async function planRemoval(profile: string, ids: string[]): Promise<{ remove: string[]; kept: string[]; why: Record<string, KeptReason> }> {
		return looking(`Looking at what "${profile}" has…`, async () => {
			// the profile first: when it has none of them there is nothing to protect, and the others need not be read
			const own = await store.list(profile, { maxAgeMs: 0 });
			const have = new Map(own.map(e => [lower(e.id), e.id]));
			const here = [...new Set(ids.map(lower))].flatMap(id => have.get(id) ?? []);
			if (here.length === 0) {
				return { remove: [], kept: [], why: {} };
			}
			const reasons = await protectionOf(profile, own, new Map([[profile, own.map(e => e.id)]]));
			const kept = here.filter(id => reasons.has(lower(id)));
			return { remove: here.filter(id => !reasons.has(lower(id))), kept, why: Object.fromEntries(kept.map(id => [id, reasons.get(lower(id))!])) };
		});
	}

	/**
	 * Uninstalls extensions from a profile. They leave the trees at once (the command line takes a while); the ones it could
	 * not remove come back. All in one run of the command line.
	 */
	async function uninstallFrom(cli: CliInvocation, profile: string, ids: string[]): Promise<InstallResult[]> {
		if (ids.length === 0) {
			return [];
		}
		store.removing(profile, ids);
		let results: InstallResult[];
		try {
			results = await withProgress(`Uninstalling ${ids.length === 1 ? ids[0] : `${ids.length} extensions`} from "${profile}"…`, () => uninstallExtensions(cli, run, ids, profile));
		} catch (error) {
			store.settle(profile, ids);
			throw error;
		}
		for (const result of results.filter(r => !r.ok)) {
			log.error(`uninstall ${result.id} <- ${profile}: ${result.message}`);
		}
		store.removed(profile, results.filter(r => r.ok).map(r => r.id));
		store.settle(profile, results.filter(r => !r.ok).map(r => r.id));
		return results;
	}

	const checkedProfile = async (profile: unknown): Promise<string> => {
		const names = await profileNames();
		if (typeof profile !== 'string' || !names.includes(profile)) {
			throw new Error(`Unknown profile "${String(profile)}". VS Code has: ${names.join(', ')}.`);
		}
		return profile;
	};

	const reported = (profile: string, report: RemovalReport): void => {
		const parts = [
			report.uninstalled.length > 0 ? `Uninstalled ${report.uninstalled.join(', ')} from "${profile}".` : '',
			keptSentence(report.reasons),
		].filter(Boolean);
		if (report.failed.length > 0) {
			void vscode.window.showWarningMessage(`Could not uninstall ${report.failed.join(', ')} from "${profile}". ${parts.join(' ')}`, 'Show Log').then(choice => choice && log.show());
		} else if (parts.length > 0) {
			void vscode.window.showInformationMessage(parts.join(' '));
		}
	};

	/**
	 * Makes a profile stop following one or more groups and uninstalls their extensions from it, except those that
	 * another group the profile still follows wants. The groups themselves and every other profile are untouched.
	 */
	const removeGroupFromProfile = async (args?: { profile?: string; group?: string; groups?: string[]; confirm?: boolean }): Promise<RemovalReport> => {
		const profile = await checkedProfile(args?.profile);
		const removed = args?.groups ?? [String(args?.group)];
		const { config, file } = await loadGroups();
		const next = removed.reduce((updated, group) => unassignGroup(updated, profile, group), config);
		const stillWanted = new Set(desiredExtensions(next, profile).ids.map(lower));
		const excluded = new Set((config.excludes?.[profile] ?? []).map(lower));
		const cli = resolveCliOrThrow();
		const members = [...new Set(removed.flatMap(group => config.groups[group] ?? []))];
		const plan = await planRemoval(profile, members.filter(id => !stillWanted.has(lower(id)) && !excluded.has(lower(id))));
		const report: RemovalReport = { uninstalled: [], kept: plan.kept, failed: [], cancelled: false, reasons: plan.why };
		const names = removed.map(group => `"${group}"`).join(', ');

		if (plan.remove.length > 0 && args?.confirm !== false && !await ui.confirm(
			`Remove ${removed.length === 1 ? names : `${removed.length} groups`} from "${profile}" and uninstall ${plan.remove.length} extension${plan.remove.length === 1 ? '' : 's'} from it?`,
			`${removed.length > 1 ? `Groups: ${names}\n\n` : ''}${plan.remove.join('\n')}\n\nThey are uninstalled from "${profile}" only. The group${removed.length === 1 ? '' : 's'} and the other profiles are not changed.${plan.kept.length > 0 ? `\n\nStays installed: ${keptDetail(plan.why)}.` : ''}`,
			'Remove and Uninstall',
		)) {
			report.cancelled = true;
			return report;
		}
		store.removing(profile, plan.remove); // gone from the tree before anything is written or run
		try {
			await saveGroups(file, next);
		} catch (error) {
			store.settle(profile, plan.remove);
			throw error;
		}
		for (const result of await uninstallFrom(cli, profile, plan.remove)) {
			(result.ok ? report.uninstalled : report.failed).push(result.id);
		}
		const alsoAll = removed.filter(group => (config.profiles[ALL_PROFILES] ?? []).includes(group));
		void vscode.window.showInformationMessage(`"${profile}" no longer follows ${names}${alsoAll.length > 0 ? `, which still goes to all profiles` : ''}.`);
		reported(profile, report);
		return report;
	};

	/**
	 * Uninstalls one or more extensions from one profile. Those a group the profile follows has are also recorded as not
	 * wanted by the profile (otherwise the next sync would bring them back); the groups and the other profiles are untouched.
	 */
	const removeExtensionFromProfile = async (args?: { profile?: string; id?: string; ids?: string[]; confirm?: boolean }): Promise<RemovalReport> => {
		const ids = args?.ids === undefined ? [extensionIdOf(args?.id)] : extensionIdsOf({ ids: args.ids });
		const profile = await checkedProfile(args?.profile);
		const { config } = await loadGroups();
		const desired = new Set(desiredExtensions(config, profile).ids.map(lower));
		const cli = resolveCliOrThrow();
		const plan = await planRemoval(profile, ids);
		const report: RemovalReport = { uninstalled: [], kept: plan.kept, failed: [], cancelled: false, reasons: plan.why };
		const present = new Set([...plan.remove, ...plan.kept].map(lower));
		const exclude = async (which: string[]) => {
			const loaded = await loadGroups();
			await saveGroups(loaded.file, which.reduce((updated, id) => excludeFromProfile(updated, profile, id), loaded.config));
		};

		// not installed here, but a group wants it: only record that this profile does not want it
		const absentButWanted = ids.filter(id => !present.has(lower(id)) && desired.has(lower(id)));
		if (absentButWanted.length > 0) {
			await exclude(absentButWanted);
		}
		if (plan.remove.length === 0) {
			if (plan.kept.length > 0) {
				reported(profile, report);
			}
			return report;
		}
		const wanted = plan.remove.filter(id => desired.has(lower(id)));
		if (args?.confirm !== false && !await ui.confirm(
			plan.remove.length === 1 ? `Uninstall "${plan.remove[0]}" from "${profile}"?` : `Uninstall ${plan.remove.length} extensions from "${profile}"?`,
			`${plan.remove.length > 1 ? `${plan.remove.join('\n')}\n\n` : ''}${wanted.length > 0
				? (wanted.length === 1
					? `It stays in its group, and the other profiles keep it. "${profile}" will no longer ask for it.`
					: `Those that a group has stay in their groups, and the other profiles keep them. "${profile}" will no longer ask for them.`)
				: `None of the groups of "${profile}" has ${plan.remove.length === 1 ? 'it' : 'them'}. ${plan.remove.length === 1 ? 'It is' : 'They are'} uninstalled from this profile only.`}${plan.kept.length > 0 ? `\n\nStays installed: ${keptDetail(plan.why)}.` : ''}`,
			'Uninstall',
		)) {
			report.cancelled = true;
			return report;
		}
		store.removing(profile, plan.remove); // gone from the tree now
		if (wanted.length > 0) {
			await exclude(wanted); // the groups then show them as removed from this profile at once
		}
		for (const result of await uninstallFrom(cli, profile, plan.remove)) {
			(result.ok ? report.uninstalled : report.failed).push(result.id);
		}
		const stillThere = wanted.filter(id => report.failed.some(failed => lower(failed) === lower(id)));
		if (stillThere.length > 0) {
			await forgetExclusions(profile, stillThere); // those are still installed, so the profile still has them
		}
		reported(profile, report);
		return report;
	};

	/** An extension that is installed on purpose is wanted again: its exclusions for these profiles are lifted. */
	async function forgetExclusions(profile: string, ids: readonly string[]): Promise<void> {
		const { config, file } = await loadGroups();
		const next = ids.reduce((updated, id) => includeInProfile(updated, profile, id), config);
		if (next !== config) {
			await saveGroups(file, next);
		}
	}

	/** Offers (or, for an explicit list, applies) the removal of extras. Never removes anything without a confirmation. */
	async function review(cli: CliInvocation, profile: string, config: GroupsConfig, mode: UninstallMode, confirmExplicit: boolean, report: SyncReport): Promise<void> {
		const extras = await findExtras(profile, config);
		report.extras = extras;

		let chosen: string[];
		let needsConfirmation: boolean;
		if (Array.isArray(mode)) {
			const notExtras = mode.filter(id => !extras.some(extra => lower(extra) === lower(id)));
			if (notExtras.length > 0) {
				throw new Error(`"${notExtras[0]}" is not an extra of "${profile}" (it is in one of its groups, installed for every profile, protected, or not installed), so it will not be uninstalled.`);
			}
			chosen = mode.map(id => extras.find(extra => lower(extra) === lower(id))!);
			needsConfirmation = confirmExplicit;
		} else {
			if (extras.length === 0) {
				return;
			}
			const picked = await ui.pickMany(
				`Extensions of "${profile}" that none of its groups mention`,
				extras.map(id => ({ id, label: id })),
			);
			if (!picked?.length) {
				return;
			}
			chosen = extras.filter(id => picked.includes(id));
			needsConfirmation = true;
		}

		if (chosen.length === 0) {
			return;
		}
		if (needsConfirmation && !await ui.confirm(
			`Uninstall ${chosen.length} extension${chosen.length === 1 ? '' : 's'} from "${profile}"?`,
			`${chosen.join('\n')}\n\nThey are removed from this profile only, and this extension cannot bring them back for you.`,
			'Uninstall',
		)) {
			return;
		}

		const results = await uninstallFrom(cli, profile, chosen);
		report.uninstalled = results;

		const failed = results.filter(r => !r.ok);
		void (failed.length === 0
			? vscode.window.showInformationMessage(`Uninstalled ${results.length} extension${results.length === 1 ? '' : 's'} from "${profile}".`)
			: vscode.window.showWarningMessage(`${failed.length} of ${results.length} could not be uninstalled from "${profile}": ${failed.map(r => r.id).join(', ')}.`));
	}

	const syncProfile = async (args?: { profile?: string; confirm?: boolean; uninstall?: UninstallMode; only?: string[] }): Promise<SyncReport | undefined> => {
		const names = await profileNames();
		const profile = args?.profile ?? await pickProfile('Sync which profile with its groups?');
		if (profile === undefined) {
			return undefined;
		}
		if (!names.includes(profile)) {
			throw new Error(`Unknown profile "${profile}". VS Code has: ${names.join(', ')}.`);
		}
		// Without prompts (confirm: false) nothing is ever uninstalled unless an explicit list is given.
		const uninstall: UninstallMode = args?.uninstall ?? (args?.confirm === false ? 'none' : 'ask');
		const { config } = await loadGroups();
		const cli = resolveCliOrThrow();

		const installed = await looking(`Looking at what "${profile}" has…`, () => store.list(profile, { maxAgeMs: 0 }));
		const fullPlan = planSync(config, profile, installed.map(e => e.id));
		// "only" is what the notification announced (the groups this workspace needs); an explicit sync installs all
		const only = args?.only ? new Set(args.only.map(lower)) : undefined;
		const plan: SyncPlan = only ? { ...fullPlan, toInstall: fullPlan.toInstall.filter(id => only.has(lower(id))) } : fullPlan;
		if (plan.missingGroups.length > 0) {
			void vscode.window.showWarningMessage(`"${profile}" refers to groups that do not exist: ${plan.missingGroups.join(', ')}.`);
		}

		const report: SyncReport = { profile, plan, results: [] };
		if (plan.toInstall.length === 0) {
			if (uninstall === 'none') {
				void vscode.window.showInformationMessage(`"${profile}" already has every extension of its groups.`);
			}
		} else {
			if (args?.confirm !== false && !await ui.confirm(
				`Install ${plan.toInstall.length} extension${plan.toInstall.length === 1 ? '' : 's'} into "${profile}"?`,
				plan.toInstall.join('\n'),
				'Install',
			)) {
				return { ...report, cancelled: true };
			}

			store.installing(profile, plan.toInstall); // shown now, marked, while the command line works
			report.results = await withProgress(`Installing into "${profile}"…`, async () => {
				const done: InstallResult[] = [];
				for (const id of plan.toInstall) {
					const result = await installExtension(cli, run, id, profile);
					if (!result.ok) {
						log.error(`${id} -> ${profile}: ${result.message}`);
					}
					result.ok ? store.added(profile, [id]) : store.settle(profile, [id]);
					done.push(result);
				}
				return done;
			});
			const failed = report.results.filter(r => !r.ok);
			if (failed.length === 0) {
				void vscode.window.showInformationMessage(`Installed ${report.results.length} extension${report.results.length === 1 ? '' : 's'} into "${profile}".`);
			} else {
				void vscode.window.showWarningMessage(`${failed.length} of ${report.results.length} failed for "${profile}": ${failed.map(r => r.id).join(', ')}.`, 'Show Log')
					.then(choice => choice && log.show());
			}
		}

		if (uninstall !== 'none') {
			await review(cli, profile, config, uninstall, args?.confirm !== false, report);
		}
		return report;
	};

	// ---- asking to sync when a profile is out of date ---------------------------------------------------

	/** The triggered groups of this profile for which a pattern matches a file in one of the workspace folders. */
	async function matchedTriggerGroups(config: GroupsConfig, profile: string): Promise<string[]> {
		const folders = vscode.workspace.workspaceFolders ?? [];
		const matched: string[] = [];
		for (const { group, patterns } of triggeredGroups(config, profile)) {
			search: for (const folder of folders) {
				for (const pattern of patterns) {
					const hits = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, pattern), '**/{node_modules,.git}/**', 1);
					if (hits.length > 0) {
						matched.push(group);
						break search;
					}
				}
			}
		}
		return matched;
	}

	const dismissed = (): Record<string, string> => context.globalState.get<Record<string, string>>(DISMISSED_KEY, {});

	const resetPrompts = async (): Promise<void> => {
		await context.globalState.update(DISMISSED_KEY, undefined);
	};

	let checking = false;

	/** Installs only; removing anything always goes through the explicit sync command and its confirmation. */
	const checkSync = async (): Promise<void> => {
		if (checking) {
			return;
		}
		checking = true;
		try {
			const mode = settings().get<string>('autoSync') ?? 'ask';
			if (mode === 'off') {
				return;
			}
			const current = await api.getCurrentProfile();
			if (!current) {
				return; // VS Code gives no way to tell which profile this window is in
			}
			const profile = current.name;
			const { config } = await loadGroups();
			const matched = await matchedTriggerGroups(config, profile);
			if (desiredExtensions(config, profile, matched).ids.length === 0) {
				return; // nothing this workspace needs: do not even start the CLI
			}
			const cli = resolveCliOrThrow();
			const installed = await listExtensions(cli, run, profile);
			const { toInstall } = planSync(config, profile, installed.map(e => e.id), matched);
			if (toInstall.length === 0) {
				return;
			}

			if (mode === 'auto') {
				await syncProfile({ profile, confirm: false, uninstall: 'none', only: toInstall });
				return;
			}
			const key = promptKey(toInstall);
			if (dismissed()[profile] === key) {
				return;
			}
			const preview = toInstall.slice(0, 3).join(', ') + (toInstall.length > 3 ? ', …' : '');
			const answer = await ui.ask(
				`"${profile}" is missing ${toInstall.length} extension${toInstall.length === 1 ? '' : 's'} from its groups (${preview}).${matched.length > 0 ? ` This workspace matches: ${matched.join(', ')}.` : ''}`,
				'Sync', 'Not now', 'Stop asking',
			);
			if (answer === 'Sync') {
				await syncProfile({ profile, confirm: false, uninstall: 'ask', only: toInstall });
			} else if (answer === 'Not now') {
				await context.globalState.update(DISMISSED_KEY, { ...dismissed(), [profile]: key });
			} else if (answer === 'Stop asking') {
				await settings().update('autoSync', 'off', vscode.ConfigurationTarget.Global);
			}
		} catch (error) {
			// background work: it must never turn into an error popup
			log.warn(`Sync check skipped: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			checking = false;
		}
	};

	/** Logs a failure before it reaches the caller, so it is in the Output panel too. */
	const logged = <A extends unknown[], R>(name: string, handler: (...args: A) => Promise<R>) =>
		vscode.commands.registerCommand(name, async (...args: A) => {
			try {
				return await handler(...args);
			} catch (error) {
				log.error(`${name}: ${error instanceof Error ? error.message : String(error)}`);
				throw error;
			}
		});

	return {
		disposables: [
			groupsChanged,
			logged('better-profiles.editGroups', editGroups),
			logged('better-profiles.addToGroup', addToGroupCommand),
			logged('better-profiles.assignGroup', assignGroupCommand),
			logged('better-profiles.compareProfiles', compareProfiles),
			logged('better-profiles.syncProfile', syncProfile),
			logged('better-profiles.resetPrompts', resetPrompts),
			logged('better-profiles.setGroupTriggers', setGroupTriggersCommand),
			logged('better-profiles.extensionAddToGroup', extensionAddToGroup),
			logged('better-profiles.extensionRemoveFromGroup', extensionRemoveFromGroup),
			logged('better-profiles.extensionInstallInProfiles', extensionInstallInProfiles),
			logged('better-profiles.removeGroupFromProfile', removeGroupFromProfile),
			logged('better-profiles.removeExtensionFromProfile', removeExtensionFromProfile),
			{ dispose: () => { clearTimeout(redrawTimer); watchers.forEach(watcher => watcher.close()); watchers.clear(); } },
		],
		checkSync,
		resetPrompts,
		groupsFilePath,
		groupedExtensions: () => grouped,
		refreshGroupedContext,
		core: { loadGroups, saveGroups, profileNames, profiles: () => api.getProfiles(), resolveCli: resolveCliOrThrow, run, extensionsDir, onDidChangeGroups: groupsChanged.event, store, forgetExclusions },
	};
}
