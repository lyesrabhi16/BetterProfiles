import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import type { BetterProfilesApi, PickItem, PromptUi } from './api';
import type { ViewsCore } from './views';
import {
	CliInvocation,
	DEFAULT_PROFILE_NAME,
	InstallResult,
	Runner,
	defaultRunner,
	installExtension,
	listExtensions,
	isInstalledExtensionPath,
	pickExtensionsDir,
	resolveCli,
	uninstallExtension,
	userDataDirFromGlobalStorage,
} from './cli';
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
	/** Left installed on purpose: this extension, what keepExtensions lists, what every profile has. */
	kept: string[];
	/** The command line could not uninstall them. */
	failed: string[];
	/** The user declined the question, and nothing was changed. */
	cancelled: boolean;
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
	/** A profile's own list of extensions changed (something was uninstalled from it). */
	const profileExtensionsChanged = new vscode.EventEmitter<string>();

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

	const assignGroupCommand = async (args?: { profile?: string; group?: string }): Promise<GroupsConfig | undefined> => {
		const { config, file } = await loadGroups();
		const profile = args?.profile ?? await pickProfile('Give a group to which profile?', { includeAll: true });
		const group = profile === undefined ? undefined : (args?.group ?? await pickGroup(config, `Which group should "${profile}" have?`));
		if (profile === undefined || group === undefined) {
			return undefined;
		}
		if (!Object.prototype.hasOwnProperty.call(config.groups, group)) {
			throw new Error(`There is no group "${group}". Add extensions to it first.`);
		}
		const next = assignGroup(config, profile, group);
		await saveGroups(file, next);
		offer(`"${profile === ALL_PROFILES ? 'All profiles' : profile}" now gets the group "${group}".`, { [SYNC_BUTTON]: () => vscode.commands.executeCommand('better-profiles.syncProfile') });
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
	const optionsOf = <T extends object>(target: unknown): Partial<T> => (typeof target === 'object' && target !== null ? target as Partial<T> : {});

	const quoted = (names: string[]) => names.map(name => `"${name}"`).join(', ');

	const extensionAddToGroup = async (target: unknown): Promise<GroupsConfig | undefined> => {
		const id = extensionIdOf(target);
		const { config, file } = await loadGroups();
		const named = optionsOf<{ group: string; groups: string[] }>(target);
		let picked: string[] | undefined = named.groups ?? (named.group === undefined ? undefined : [named.group]);
		if (picked === undefined) {
			const holders = groupsContaining(config, id);
			picked = await ui.pickMany(
				`Add ${id} to which groups?`,
				Object.keys(config.groups).map(name => ({
					id: name,
					label: name,
					description: holders.includes(name) ? '$(check) already has it' : `${config.groups[name].length} extensions`,
				})),
				{ newItem: { label: '$(add) New group', prompt: 'Name of the new group' } },
			);
		}
		// a name that is not an existing group starts a new one
		const chosen = [...new Set((picked ?? []).map(name => name.trim()).filter(name => name !== ''))];
		if (chosen.length === 0) {
			return undefined;
		}
		const holders = groupsContaining(config, id);
		const toAdd = chosen.filter(name => !holders.includes(name));
		const already = chosen.filter(name => holders.includes(name));
		if (toAdd.length === 0) {
			void vscode.window.showInformationMessage(`${id} is already in ${quoted(already)}.`);
			return config;
		}
		const next = toAdd.reduce((updated, name) => addToGroup(updated, name, [id]), config);
		await saveGroups(file, next);
		offer(`Added ${id} to ${quoted(toAdd)}.${already.length > 0 ? ` It was already in ${quoted(already)}.` : ''}`, nextStepFor(next, toAdd));
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

	const extensionInstallInProfiles = async (target: unknown): Promise<{ id: string; results: { profile: string; ok: boolean; message: string }[]; alreadyHad: string[] } | undefined> => {
		const id = extensionIdOf(target);
		const named = optionsOf<{ profiles: string[] }>(target).profiles;
		const names = await profileNames();
		const unknown = named?.find(profile => !names.includes(profile));
		if (unknown !== undefined) {
			throw new Error(`Unknown profile "${unknown}". VS Code has: ${names.join(', ')}.`);
		}
		const cli = resolveCliOrThrow();

		const has = new Map<string, boolean>();
		await withProgress(`Looking for ${id} in every profile…`, async () => {
			for (const name of names) {
				has.set(name, (await listExtensions(cli, run, name)).some(e => lower(e.id) === lower(id)));
			}
		});
		const alreadyHad = names.filter(name => has.get(name));
		const lacking = names.filter(name => !has.get(name));
		if (lacking.length === 0) {
			void vscode.window.showInformationMessage(`${id} is already in every profile.`);
			return { id, results: [], alreadyHad };
		}

		let targets: string[];
		if (named) {
			targets = named.filter(profile => lacking.includes(profile));
		} else {
			const picked = await ui.pickMany(`Install ${id} into which profiles?`, lacking.map(name => ({ id: name, label: name })));
			if (!picked?.length) {
				return undefined;
			}
			targets = lacking.filter(name => picked.includes(name));
		}

		const results = await withProgress(`Installing ${id}…`, async () => {
			const done: { profile: string; ok: boolean; message: string }[] = [];
			for (const profile of targets) {
				const result = await installExtension(cli, run, id, profile);
				if (!result.ok) {
					log.error(`${id} -> ${profile}: ${result.message}`);
				}
				done.push({ profile, ok: result.ok, message: result.message });
			}
			return done;
		});
		for (const done of results.filter(r => r.ok)) {
			await forgetExclusions(done.profile, [id]);
		}
		const failed = results.filter(r => !r.ok);
		void (failed.length === 0
			? vscode.window.showInformationMessage(results.length > 0 ? `Installed ${id} into ${results.map(r => `"${r.profile}"`).join(', ')}.` : `${id} is already in the profiles you named.`)
			: vscode.window.showWarningMessage(`Could not install ${id} into ${failed.map(r => `"${r.profile}"`).join(', ')}.`, 'Show Log').then(choice => choice && log.show()));
		return { id, results, alreadyHad };
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
		const cli = resolveCliOrThrow();
		const columns = await withProgress('Comparing the extensions of every profile…', async () => {
			const result = [];
			for (const profile of names) {
				try {
					result.push({ profile, ids: (await listExtensions(cli, run, profile)).map(e => e.id) });
				} catch (error) {
					throw new Error(`Could not list the extensions of "${profile}": ${error instanceof Error ? error.message : String(error)}`);
				}
			}
			return result;
		});
		const markdown = `# Extensions per profile\n\n${renderMatrix(columns)}`;
		if (args?.open !== false) {
			await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: 'markdown', content: markdown }));
		}
		return markdown;
	};

	/** What every profile has, by profile. */
	async function listEveryProfile(cli: CliInvocation): Promise<Map<string, string[]>> {
		const lists = new Map<string, string[]>();
		for (const name of await profileNames()) {
			lists.set(name, (await listExtensions(cli, run, name)).map(e => e.id));
		}
		return lists;
	}

	/** What must never be uninstalled from one profile, whatever asked for it. */
	const protectedFromRemoval = (lists: Map<string, string[]>): string[] => [
		// installed once for every profile ("application scoped"): removing it from one removes it from all
		...commonToAllProfiles([...lists.values()]),
		SELF_ID,
		...(settings().get<string[]>('keepExtensions') ?? []),
	];

	/** Everything the profile has that its groups do not, minus what must never be offered for removal. */
	async function findExtras(cli: CliInvocation, profile: string, config: GroupsConfig): Promise<string[]> {
		const lists = await listEveryProfile(cli);
		return planCleanup(config, profile, lists.get(profile) ?? [], protectedFromRemoval(lists)).extras;
	}

	/** Which of these the profile has, split into what can go and what must stay. */
	async function planRemoval(cli: CliInvocation, profile: string, ids: string[]): Promise<{ remove: string[]; kept: string[] }> {
		const lists = await listEveryProfile(cli);
		const protectedIds = new Set(protectedFromRemoval(lists).map(lower));
		const have = new Map((lists.get(profile) ?? []).map(id => [lower(id), id]));
		const here = [...new Set(ids.map(lower))].flatMap(id => have.get(id) ?? []);
		return { remove: here.filter(id => !protectedIds.has(lower(id))), kept: here.filter(id => protectedIds.has(lower(id))) };
	}

	async function uninstallAll(cli: CliInvocation, profile: string, ids: string[], report: RemovalReport): Promise<void> {
		await withProgress(`Uninstalling from "${profile}"…`, async () => {
			for (const id of ids) {
				const result = await uninstallExtension(cli, run, id, profile);
				if (result.ok) {
					report.uninstalled.push(id);
				} else {
					log.error(`uninstall ${id} <- ${profile}: ${result.message}`);
					report.failed.push(id);
				}
			}
		});
		profileExtensionsChanged.fire(profile);
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
			report.kept.length > 0 ? `Kept ${report.kept.join(', ')}: this extension, what keepExtensions lists and what every profile has is never uninstalled.` : '',
		].filter(Boolean);
		if (report.failed.length > 0) {
			void vscode.window.showWarningMessage(`Could not uninstall ${report.failed.join(', ')} from "${profile}". ${parts.join(' ')}`, 'Show Log').then(choice => choice && log.show());
		} else if (parts.length > 0) {
			void vscode.window.showInformationMessage(parts.join(' '));
		}
	};

	/**
	 * Makes a profile stop following a group and uninstalls the group's extensions from it, except those that another
	 * group the profile follows still wants. The group itself and every other profile are untouched.
	 */
	const removeGroupFromProfile = async (args?: { profile?: string; group?: string; confirm?: boolean }): Promise<RemovalReport> => {
		const profile = await checkedProfile(args?.profile);
		const group = String(args?.group);
		const { config, file } = await loadGroups();
		const next = unassignGroup(config, profile, group);
		const stillWanted = new Set(desiredExtensions(next, profile).ids.map(lower));
		const excluded = new Set((config.excludes?.[profile] ?? []).map(lower));
		const cli = resolveCliOrThrow();
		const plan = await planRemoval(cli, profile, (config.groups[group] ?? []).filter(id => !stillWanted.has(lower(id)) && !excluded.has(lower(id))));
		const report: RemovalReport = { uninstalled: [], kept: plan.kept, failed: [], cancelled: false };

		if (plan.remove.length > 0 && args?.confirm !== false && !await ui.confirm(
			`Remove "${group}" from "${profile}" and uninstall ${plan.remove.length} extension${plan.remove.length === 1 ? '' : 's'} from it?`,
			`${plan.remove.join('\n')}\n\nThey are uninstalled from "${profile}" only. The group and the other profiles are not changed.${plan.kept.length > 0 ? `\n\nStays installed: ${plan.kept.join(', ')}.` : ''}`,
			'Remove and Uninstall',
		)) {
			report.cancelled = true;
			return report;
		}
		await saveGroups(file, next);
		await uninstallAll(cli, profile, plan.remove, report);
		const alsoAll = (config.profiles[ALL_PROFILES] ?? []).includes(group);
		void vscode.window.showInformationMessage(`"${profile}" no longer follows "${group}"${alsoAll ? ', which still goes to all profiles' : ''}.`);
		reported(profile, report);
		return report;
	};

	/**
	 * Uninstalls one extension from one profile. When a group the profile follows has it, the profile is also told not to
	 * want it (otherwise the next sync would bring it back); the group itself and the other profiles are untouched.
	 */
	const removeExtensionFromProfile = async (args?: { profile?: string; id?: string; confirm?: boolean }): Promise<RemovalReport> => {
		const id = extensionIdOf(args?.id);
		const profile = await checkedProfile(args?.profile);
		const { config, file } = await loadGroups();
		const wanted = desiredExtensions(config, profile).ids.some(existing => lower(existing) === lower(id));
		const cli = resolveCliOrThrow();
		const plan = await planRemoval(cli, profile, [id]);
		const report: RemovalReport = { uninstalled: [], kept: plan.kept, failed: [], cancelled: false };
		const exclude = async () => saveGroups(file, excludeFromProfile((await loadGroups()).config, profile, id));

		if (plan.kept.length > 0) {
			reported(profile, report);
			return report;
		}
		if (plan.remove.length === 0) {
			if (wanted) {
				await exclude(); // not installed here: only record that the profile does not want it
			}
			return report;
		}
		if (args?.confirm !== false && !await ui.confirm(
			`Uninstall "${id}" from "${profile}"?`,
			wanted
				? `It stays in its group, and the other profiles keep it. "${profile}" will no longer ask for it.`
				: `None of the groups of "${profile}" has it. It is uninstalled from this profile only.`,
			'Uninstall',
		)) {
			report.cancelled = true;
			return report;
		}
		await uninstallAll(cli, profile, plan.remove, report);
		if (wanted && report.failed.length === 0) {
			await exclude();
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
		const extras = await findExtras(cli, profile, config);
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

		const results: InstallResult[] = [];
		await withProgress(`Uninstalling from "${profile}"…`, async () => {
			for (const id of chosen) {
				const result = await uninstallExtension(cli, run, id, profile);
				if (!result.ok) {
					log.error(`uninstall ${id} <- ${profile}: ${result.message}`);
				}
				results.push(result);
			}
		});
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

		const installed = await withProgress(`Listing the extensions of "${profile}"…`, () => listExtensions(cli, run, profile));
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

			report.results = await withProgress(`Installing into "${profile}"…`, async () => {
				const done: InstallResult[] = [];
				for (const id of plan.toInstall) {
					const result = await installExtension(cli, run, id, profile);
					if (!result.ok) {
						log.error(`${id} -> ${profile}: ${result.message}`);
					}
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
			profileExtensionsChanged,
		],
		checkSync,
		resetPrompts,
		groupsFilePath,
		groupedExtensions: () => grouped,
		refreshGroupedContext,
		core: { loadGroups, saveGroups, profileNames, profiles: () => api.getProfiles(), resolveCli: resolveCliOrThrow, run, extensionsDir, onDidChangeGroups: groupsChanged.event, onDidChangeProfileExtensions: profileExtensionsChanged.event, forgetExclusions },
	};
}
