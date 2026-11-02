import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import type { BetterProfilesApi } from './api';
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
	userDataDirFromGlobalStorage,
} from './cli';
import {
	ALL_PROFILES,
	GroupsConfig,
	SyncPlan,
	addToGroup,
	assignGroup,
	emptyGroups,
	parseGroups,
	planSync,
	renderMatrix,
	serializeGroups,
} from './groups';

export interface SyncReport {
	profile: string;
	plan: SyncPlan;
	results: InstallResult[];
	/** True when the user declined the confirmation. */
	cancelled?: boolean;
}

interface Dependencies {
	context: vscode.ExtensionContext;
	log: vscode.LogOutputChannel;
	api: Pick<BetterProfilesApi, 'getProfiles' | 'getCurrentProfile'>;
	/** Replaceable so the CLI can be faked. */
	run?: Runner;
}

const lower = (text: string) => text.toLowerCase();

/**
 * Every command takes optional arguments for non-interactive use (that is how the tests drive them). Without
 * them the command asks with quick picks and input boxes.
 */
export function registerGroupCommands({ context, log, api, run = defaultRunner }: Dependencies): vscode.Disposable[] {
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

	async function saveGroups(file: string, config: GroupsConfig): Promise<void> {
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, serializeGroups(config), 'utf8');
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

	function resolveCliOrThrow(): CliInvocation {
		const resolved = resolveCli({
			command: settings().get<string>('codeCommand'),
			args: settings().get<string[]>('codeArgs'),
			execPath: process.execPath,
			appRoot: vscode.env.appRoot,
			userDataDir: userDataDirFromGlobalStorage(context.globalStorageUri.fsPath),
			extensionsDir: pickExtensionsDir(userExtensionPaths()),
		});
		if ('error' in resolved) {
			throw new Error(resolved.error);
		}
		return resolved;
	}

	async function pickProfile(placeHolder: string, options: { includeAll?: boolean } = {}): Promise<string | undefined> {
		const current = (await api.getCurrentProfile())?.name;
		const items: (vscode.QuickPickItem & { value: string })[] = (await profileNames()).map(name => ({
			label: name,
			description: name === current ? 'current' : undefined,
			value: name,
		}));
		if (options.includeAll) {
			items.unshift({ label: '$(globe) All profiles', description: 'groups applied to every profile', value: ALL_PROFILES });
		}
		return (await vscode.window.showQuickPick(items, { placeHolder }))?.value;
	}

	async function pickGroup(config: GroupsConfig, placeHolder: string, options: { allowNew?: boolean } = {}): Promise<string | undefined> {
		const NEW = '$(add) New group…';
		const items: vscode.QuickPickItem[] = Object.keys(config.groups).map(name => ({ label: name, description: `${config.groups[name].length} extensions` }));
		if (options.allowNew) {
			items.push({ label: NEW });
		}
		const choice = await vscode.window.showQuickPick(items, { placeHolder });
		if (choice?.label !== NEW) {
			return choice?.label;
		}
		return vscode.window.showInputBox({ prompt: 'Name of the new group', validateInput: v => (v.trim() ? undefined : 'A group name is required.') });
	}

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
		void vscode.window.showInformationMessage(`Group "${group.trim()}" now has ${next.groups[group.trim()].length} extensions.`);
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
		void vscode.window.showInformationMessage(`"${profile === ALL_PROFILES ? 'All profiles' : profile}" now gets the group "${group}". Run "Sync Profile With Its Groups" to install it.`);
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

	const syncProfile = async (args?: { profile?: string; confirm?: boolean }): Promise<SyncReport | undefined> => {
		const names = await profileNames();
		const profile = args?.profile ?? await pickProfile('Sync which profile with its groups?');
		if (profile === undefined) {
			return undefined;
		}
		if (!names.includes(profile)) {
			throw new Error(`Unknown profile "${profile}". VS Code has: ${names.join(', ')}.`);
		}
		const { config } = await loadGroups();
		const cli = resolveCliOrThrow();

		const installed = await withProgress(`Listing the extensions of "${profile}"…`, () => listExtensions(cli, run, profile));
		const plan = planSync(config, profile, installed.map(e => e.id));
		if (plan.missingGroups.length > 0) {
			void vscode.window.showWarningMessage(`"${profile}" refers to groups that do not exist: ${plan.missingGroups.join(', ')}.`);
		}
		if (plan.toInstall.length === 0) {
			void vscode.window.showInformationMessage(`"${profile}" already has every extension of its groups.`);
			return { profile, plan, results: [] };
		}

		if (args?.confirm !== false) {
			const answer = await vscode.window.showInformationMessage(
				`Install ${plan.toInstall.length} extension${plan.toInstall.length === 1 ? '' : 's'} into "${profile}"?`,
				{ modal: true, detail: `${plan.toInstall.join('\n')}\n\nNothing is uninstalled.` },
				'Install',
			);
			if (answer !== 'Install') {
				return { profile, plan, results: [], cancelled: true };
			}
		}

		const results = await withProgress(`Installing into "${profile}"…`, async () => {
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

		const failed = results.filter(r => !r.ok);
		if (failed.length === 0) {
			void vscode.window.showInformationMessage(`Installed ${results.length} extension${results.length === 1 ? '' : 's'} into "${profile}".`);
		} else {
			void vscode.window.showWarningMessage(`${failed.length} of ${results.length} failed for "${profile}": ${failed.map(r => r.id).join(', ')}.`, 'Show Log')
				.then(choice => choice && log.show());
		}
		return { profile, plan, results };
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

	return [
		logged('better-profiles.editGroups', editGroups),
		logged('better-profiles.addToGroup', addToGroupCommand),
		logged('better-profiles.assignGroup', assignGroupCommand),
		logged('better-profiles.compareProfiles', compareProfiles),
		logged('better-profiles.syncProfile', syncProfile),
	];
}
