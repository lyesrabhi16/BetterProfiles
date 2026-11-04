import * as vscode from 'vscode';
import type { PromptUi, TreeViewHandles } from './api';
import { ExtensionCatalog, ExtensionInfo } from './catalog';
import { CliInvocation, InstalledExtension, Runner, installExtension, listExtensions } from './cli';
import { DragSource, DropOperation, DropTarget, planDrop } from './dnd';
import { ALL_PROFILES, GroupsConfig, addToGroup, assignGroup, profilesFollowing, removeFromGroup, removeGroup } from './groups';

/** What the trees need from the group commands: the groups file, the profile names and the command line. */
export interface ViewsCore {
	loadGroups(): Promise<{ config: GroupsConfig; file: string }>;
	saveGroups(file: string, config: GroupsConfig): Promise<void>;
	profileNames(): Promise<string[]>;
	resolveCli(): CliInvocation;
	run: Runner;
	/** Where the installed extensions are, to read their names and icons from. */
	extensionsDir(): string | undefined;
	onDidChangeGroups: vscode.Event<void>;
	currentProfileName(): Promise<string | undefined>;
}

export type Node =
	| { kind: 'group'; name: string }
	| { kind: 'groupExtension'; group: string; id: string }
	| { kind: 'profile'; name: string }
	| { kind: 'profileExtension'; profile: string; id: string; version?: string }
	| { kind: 'message'; text: string };

const GROUPS_VIEW = 'betterProfiles.groups';
const PROFILES_VIEW = 'betterProfiles.profiles';
// "application/vnd.code.tree.<tree id in lower case>" is the mime type VS Code gives the items dragged out of a tree
const GROUPS_MIME = 'application/vnd.code.tree.betterprofiles.groups';
const PROFILES_MIME = 'application/vnd.code.tree.betterprofiles.profiles';

/** An extension as VS Code's Extensions list shows it: its icon image and its display name; the id when it is not found. */
function extensionItem(id: string, info: ExtensionInfo | undefined, contextValue: string): vscode.TreeItem {
	const item = new vscode.TreeItem(info?.name ?? id, vscode.TreeItemCollapsibleState.None);
	item.contextValue = contextValue;
	item.iconPath = info?.iconPath ? vscode.Uri.file(info.iconPath) : new vscode.ThemeIcon('extensions');
	item.tooltip = info
		? [info.name, `${id}${info.version ? ` v${info.version}` : ''}`, ...(info.description ? [info.description] : [])].join('\n')
		: id;
	return item;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
const message = (text: string): Node => ({ kind: 'message', text });
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

class GroupsProvider implements vscode.TreeDataProvider<Node> {
	private readonly changed = new vscode.EventEmitter<Node | undefined | void>();
	readonly onDidChangeTreeData = this.changed.event;

	constructor(private readonly core: ViewsCore, private readonly catalog: ExtensionCatalog) {
		core.onDidChangeGroups(() => this.refresh());
	}

	refresh(): void {
		this.catalog.clear();
		this.changed.fire();
	}

	async getChildren(node?: Node): Promise<Node[]> {
		let config: GroupsConfig;
		try {
			config = (await this.core.loadGroups()).config;
		} catch (error) {
			return node ? [] : [message(errorText(error))];
		}
		if (!node) {
			return Object.keys(config.groups).map(name => ({ kind: 'group', name }));
		}
		if (node.kind === 'group') {
			return (config.groups[node.name] ?? []).map(id => ({ kind: 'groupExtension', group: node.name, id }));
		}
		return [];
	}

	async getTreeItem(node: Node): Promise<vscode.TreeItem> {
		switch (node.kind) {
			case 'group': {
				const { config } = await this.core.loadGroups();
				const ids = config.groups[node.name] ?? [];
				const followers = profilesFollowing(config, node.name).map(profile => (profile === ALL_PROFILES ? 'all profiles' : profile));
				const item = new vscode.TreeItem(node.name, ids.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
				item.description = [plural(ids.length, 'extension'), ...(followers.length > 0 ? [followers.join(', ')] : [])].join(' · ');
				item.contextValue = 'group';
				item.iconPath = new vscode.ThemeIcon('package');
				item.tooltip = followers.length > 0 ? `Followed by: ${followers.join(', ')}` : 'No profile follows this group yet';
				return item;
			}
			case 'groupExtension': {
				const info = await this.catalog.lookup(node.id);
				const item = extensionItem(node.id, info, 'groupExtension');
				item.description = info ? info.publisher : this.catalog.known() ? 'not installed' : undefined;
				return item;
			}
			default:
				return messageItem(node);
		}
	}
}

class ProfilesProvider implements vscode.TreeDataProvider<Node> {
	private readonly changed = new vscode.EventEmitter<Node | undefined | void>();
	readonly onDidChangeTreeData = this.changed.event;
	private cache = new Map<string, Promise<InstalledExtension[]>>();

	constructor(private readonly core: ViewsCore, private readonly catalog: ExtensionCatalog) { }

	/** Forgets every list and reads them again when a profile is next opened. */
	refresh(): void {
		this.cache.clear();
		this.catalog.clear();
		this.changed.fire();
	}

	invalidate(profile: string): void {
		this.cache.delete(profile);
		this.catalog.clear(); // an install adds a folder
		this.changed.fire({ kind: 'profile', name: profile });
	}

	private extensionsOf(profile: string): Promise<InstalledExtension[]> {
		let pending = this.cache.get(profile);
		if (!pending) {
			pending = listExtensions(this.core.resolveCli(), this.core.run, profile);
			this.cache.set(profile, pending);
			pending.catch(() => this.cache.delete(profile)); // so that a retry asks again
		}
		return pending;
	}

	async getChildren(node?: Node): Promise<Node[]> {
		if (!node) {
			return (await this.core.profileNames()).map(name => ({ kind: 'profile', name }));
		}
		if (node.kind !== 'profile') {
			return [];
		}
		try {
			const extensions = await this.extensionsOf(node.name);
			return [...extensions]
				.sort((a, b) => a.id.toLowerCase().localeCompare(b.id.toLowerCase()))
				.map(e => ({ kind: 'profileExtension', profile: node.name, id: e.id, version: e.version }));
		} catch (error) {
			return [message(errorText(error))];
		}
	}

	async getTreeItem(node: Node): Promise<vscode.TreeItem> {
		switch (node.kind) {
			case 'profile': {
				const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.Collapsed);
				item.description = node.name === (await this.core.currentProfileName()) ? 'current' : undefined;
				item.contextValue = 'profile';
				item.iconPath = new vscode.ThemeIcon('account');
				return item;
			}
			case 'profileExtension': {
				const item = extensionItem(node.id, await this.catalog.lookup(node.id, node.version), 'profileExtension');
				item.description = node.version;
				return item;
			}
			default:
				return messageItem(node);
		}
	}
}

function messageItem(node: Node): vscode.TreeItem {
	const item = new vscode.TreeItem(node.kind === 'message' ? node.text : '', vscode.TreeItemCollapsibleState.None);
	item.iconPath = new vscode.ThemeIcon('warning');
	item.contextValue = 'message';
	return item;
}

/** What a dragged node stands for. Profiles and messages cannot be dragged. */
function sourceOf(node: Node): DragSource | undefined {
	switch (node.kind) {
		case 'group': return { kind: 'group', name: node.name };
		case 'groupExtension': return { kind: 'extension', id: node.id, from: { type: 'group', name: node.group } };
		case 'profileExtension': return { kind: 'extension', id: node.id, from: { type: 'profile', name: node.profile } };
		default: return undefined;
	}
}

function isDragSource(value: unknown): value is DragSource {
	const v = value as { kind?: unknown; name?: unknown; id?: unknown; from?: { type?: unknown; name?: unknown } } | null;
	if (typeof v !== 'object' || v === null) {
		return false;
	}
	if (v.kind === 'group') {
		return typeof v.name === 'string';
	}
	return v.kind === 'extension' && typeof v.id === 'string'
		&& (v.from?.type === 'group' || v.from?.type === 'profile') && typeof v.from.name === 'string';
}

/** What a dragged item holds: the objects themselves in the same extension host, or their JSON if they arrive as text. */
async function sourcesFrom(item: vscode.DataTransferItem | undefined): Promise<DragSource[]> {
	if (!item) {
		return [];
	}
	let value: unknown = item.value;
	if (!Array.isArray(value)) {
		try {
			value = JSON.parse(await item.asString());
		} catch {
			return [];
		}
	}
	return Array.isArray(value) ? value.filter(isDragSource) : [];
}

/** The group or profile that a drop on this node counts as a drop on. */
function targetOf(node: Node | undefined): DropTarget | undefined {
	switch (node?.kind) {
		case 'group': return { kind: 'group', name: node.name };
		case 'groupExtension': return { kind: 'group', name: node.group };
		case 'profile': return { kind: 'profile', name: node.name };
		case 'profileExtension': return { kind: 'profile', name: node.profile };
		default: return undefined;
	}
}

export function registerViews({ core, ui, log }: { core: ViewsCore; ui: PromptUi; log: vscode.LogOutputChannel }): { disposables: vscode.Disposable[]; handles: { groups: TreeViewHandles; profiles: TreeViewHandles } } {
	const catalog = new ExtensionCatalog(() => core.extensionsDir());
	const groups = new GroupsProvider(core, catalog);
	const profiles = new ProfilesProvider(core, catalog);

	const withProgress = <T>(title: string, task: () => Promise<T>) =>
		vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, task);

	async function installInto(profile: string, ids: string[]): Promise<void> {
		const cli = core.resolveCli();
		const results = await withProgress(`Installing into "${profile}"…`, async () => {
			const have = new Set((await listExtensions(cli, core.run, profile)).map(e => e.id.toLowerCase()));
			const done: { id: string; ok: boolean; message: string }[] = [];
			for (const id of ids.filter(candidate => !have.has(candidate.toLowerCase()))) {
				const result = await installExtension(cli, core.run, id, profile);
				if (!result.ok) {
					log.error(`${id} -> ${profile}: ${result.message}`);
				}
				done.push(result);
			}
			return done;
		});
		profiles.invalidate(profile);
		const failed = results.filter(r => !r.ok);
		if (results.length === 0) {
			void vscode.window.showInformationMessage(`"${profile}" already has ${ids.length === 1 ? 'it' : 'all of them'}.`);
		} else if (failed.length === 0) {
			void vscode.window.showInformationMessage(`Installed ${plural(results.length, 'extension')} into "${profile}".`);
		} else {
			void vscode.window.showWarningMessage(`Could not install ${failed.map(r => r.id).join(', ')} into "${profile}".`);
		}
	}

	async function execute(operation: DropOperation): Promise<void> {
		switch (operation.op) {
			case 'addToGroup': {
				const { config, file } = await core.loadGroups();
				await core.saveGroups(file, addToGroup(config, operation.group, operation.ids));
				void vscode.window.showInformationMessage(`Added ${plural(operation.ids.length, 'extension')} to "${operation.group}".`);
				return;
			}
			case 'installInProfile':
				return installInto(operation.profile, operation.ids);
			case 'assignGroup': {
				const { config, file } = await core.loadGroups();
				await core.saveGroups(file, assignGroup(config, operation.profile, operation.group));
				void vscode.window.showInformationMessage(`"${operation.profile}" now gets the group "${operation.group}".`);
				return;
			}
		}
	}

	const controller = (selfMime: string): vscode.TreeDragAndDropController<Node> => ({
		dragMimeTypes: [selfMime],
		dropMimeTypes: [GROUPS_MIME, PROFILES_MIME],
		handleDrag(nodes, transfer) {
			const sources = nodes.map(sourceOf).filter((s): s is DragSource => s !== undefined);
			if (sources.length > 0) {
				transfer.set(selfMime, new vscode.DataTransferItem(sources));
			}
		},
		async handleDrop(node, transfer) {
			const target = targetOf(node);
			if (!target) {
				return;
			}
			const sources = (await Promise.all([GROUPS_MIME, PROFILES_MIME].map(mime => sourcesFrom(transfer.get(mime))))).flat();
			try {
				for (const operation of planDrop(sources, target)) {
					await execute(operation);
				}
			} catch (error) {
				log.error(`drop: ${errorText(error)}`);
				void vscode.window.showErrorMessage(errorText(error));
			}
		},
	});

	const groupsDnd = controller(GROUPS_MIME);
	const profilesDnd = controller(PROFILES_MIME);

	const nodeOf = <K extends Node['kind']>(arg: unknown, kind: K): Extract<Node, { kind: K }> => {
		if ((arg as Node | undefined)?.kind !== kind) {
			throw new Error('This command works on an item of the Better Profiles tab.');
		}
		return arg as Extract<Node, { kind: K }>;
	};

	const command = (id: string, handler: (...args: never[]) => unknown) => vscode.commands.registerCommand(id, async (...args: unknown[]) => {
		try {
			return await (handler as (...a: unknown[]) => unknown)(...args);
		} catch (error) {
			log.error(`${id}: ${errorText(error)}`);
			throw error;
		}
	});

	return {
		disposables: [
			vscode.window.createTreeView(GROUPS_VIEW, { treeDataProvider: groups, dragAndDropController: groupsDnd, showCollapseAll: true, canSelectMany: true }),
			vscode.window.createTreeView(PROFILES_VIEW, { treeDataProvider: profiles, dragAndDropController: profilesDnd, showCollapseAll: true, canSelectMany: true }),

			command('better-profiles.view.refresh', () => {
				groups.refresh();
				profiles.refresh();
			}),

			command('better-profiles.view.newGroup', async (arg?: { name?: string }) => {
				const typed = arg?.name ?? await vscode.window.showInputBox({ prompt: 'Name of the new group', validateInput: v => (v.trim() ? undefined : 'A name is required.') });
				const name = typed?.trim();
				if (!name) {
					return;
				}
				const { config, file } = await core.loadGroups();
				if (Object.prototype.hasOwnProperty.call(config.groups, name)) {
					void vscode.window.showInformationMessage(`There is already a group "${name}".`);
					return;
				}
				await core.saveGroups(file, addToGroup(config, name, []));
			}),

			command('better-profiles.view.deleteGroup', async (arg?: unknown) => {
				const { name } = nodeOf(arg, 'group');
				const { config, file } = await core.loadGroups();
				const followers = profilesFollowing(config, name).map(profile => (profile === ALL_PROFILES ? 'all profiles' : profile));
				const confirmed = await ui.confirm(
					`Delete the group "${name}"?`,
					`It has ${plural((config.groups[name] ?? []).length, 'extension')} and is followed by ${followers.length > 0 ? followers.join(', ') : 'no profile'}. The extensions themselves stay installed.`,
					'Delete',
				);
				if (confirmed) {
					await core.saveGroups(file, removeGroup(config, name));
				}
			}),

			command('better-profiles.view.removeFromGroup', async (arg?: unknown) => {
				const { group, id } = nodeOf(arg, 'groupExtension');
				const { config, file } = await core.loadGroups();
				await core.saveGroups(file, removeFromGroup(config, group, id));
				void vscode.window.showInformationMessage(`Removed ${id} from "${group}". Nothing was uninstalled.`);
			}),

			command('better-profiles.view.syncProfile', (arg?: unknown) =>
				vscode.commands.executeCommand('better-profiles.syncProfile', { profile: nodeOf(arg, 'profile').name })),

			command('better-profiles.view.setTriggers', (arg?: unknown) =>
				vscode.commands.executeCommand('better-profiles.setGroupTriggers', { group: nodeOf(arg, 'group').name })),

			command('better-profiles.view.assignGroup', (arg?: unknown) =>
				vscode.commands.executeCommand('better-profiles.assignGroup', { group: nodeOf(arg, 'group').name })),
		],
		handles: {
			groups: { provider: groups as vscode.TreeDataProvider<unknown>, dnd: groupsDnd as vscode.TreeDragAndDropController<unknown>, refresh: () => groups.refresh() },
			profiles: { provider: profiles as vscode.TreeDataProvider<unknown>, dnd: profilesDnd as vscode.TreeDragAndDropController<unknown>, refresh: () => profiles.refresh() },
		},
	};
}
