import * as vscode from 'vscode';
import type { PromptUi, TreeViewHandles } from './api';
import { ExtensionCatalog, ExtensionInfo } from './catalog';
import { CliInvocation, InstalledExtension, Runner, installExtension, listExtensions } from './cli';
import { DragSource, DropOperation, DropTarget, planDrop } from './dnd';
import { Profile, profileIcon } from './profiles';
import { ALL_PROFILES, GroupsConfig, addToGroup, assignGroup, profileLayout, profilesFollowing, removeFromGroup, removeGroup, unassignGroup } from './groups';

/** What the trees need from the group commands: the groups file, the profile names and the command line. */
export interface ViewsCore {
	loadGroups(): Promise<{ config: GroupsConfig; file: string }>;
	saveGroups(file: string, config: GroupsConfig): Promise<void>;
	profileNames(): Promise<string[]>;
	/** The profiles VS Code has recorded (not Default), with their icons. */
	profiles(): Promise<Profile[]>;
	resolveCli(): CliInvocation;
	run: Runner;
	/** Where the installed extensions are, to read their names and icons from. */
	extensionsDir(): string | undefined;
	onDidChangeGroups: vscode.Event<void>;
	/** A profile's list of extensions changed behind the tree's back (something was uninstalled from it). */
	onDidChangeProfileExtensions: vscode.Event<string>;
	/** An extension installed on purpose is wanted again: lifts the profile's exclusion of it. */
	forgetExclusions(profile: string, ids: readonly string[]): Promise<void>;
	currentProfileName(): Promise<string | undefined>;
}

export type ExtensionNode = Extract<Node, { kind: 'groupExtension' | 'profileGroupExtension' | 'profileExtension' }>;
export type Node =
	| { kind: 'group'; name: string }
	| { kind: 'groupExtension'; group: string; id: string }
	| { kind: 'profile'; name: string }
	| { kind: 'profileGroup'; profile: string; name: string }
	| { kind: 'profileGroupExtension'; profile: string; group: string; id: string; version?: string }
	| { kind: 'profileExtension'; profile: string; id: string; version?: string }
	| { kind: 'message'; text: string };

const GROUPS_VIEW = 'betterProfiles.groups';
const PROFILES_VIEW = 'betterProfiles.profiles';
// What our drags carry. It must not be "application/vnd.code.tree.<tree id>": VS Code puts its own entry ({id, itemHandles})
// under that name, and in a drop from one tree onto the other our entry sits beside it and `get` returns VS Code's.
const SOURCES_MIME = 'application/vnd.better-profiles.sources';

/** An extension as VS Code's Extensions list shows it: its icon image and its display name; the id when it is not found. */
function extensionItem(id: string, info: ExtensionInfo | undefined, node: ExtensionNode): vscode.TreeItem {
	const item = new vscode.TreeItem(info?.name ?? id, vscode.TreeItemCollapsibleState.None);
	item.contextValue = node.kind;
	// a click runs this; two clicks in a row on the same item open the page (see better-profiles.view.clickExtension)
	item.command = { command: 'better-profiles.view.clickExtension', title: 'Open Extension Page', arguments: [node] };
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
				const item = extensionItem(node.id, info, node);
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

	constructor(private readonly core: ViewsCore, private readonly catalog: ExtensionCatalog) {
		// the groups decide how a profile's extensions are laid out; what each profile has is unchanged, so its lists are kept
		core.onDidChangeGroups(() => this.changed.fire());
		core.onDidChangeProfileExtensions(profile => this.invalidate(profile));
	}

	/** Forgets every list and reads them again when a profile is next opened. */
	refresh(): void {
		this.cache.clear();
		this.catalog.clear();
		this.changed.fire();
	}

	invalidate(profile: string): void {
		this.cache.delete(profile);
		this.catalog.clear(); // an install adds a folder
		// The whole tree: VS Code only knows the item objects it was given, and a new object for the profile is ignored
		// (it would leave the old list on screen). Open profiles stay open, so nothing is lost by redrawing all of it.
		this.changed.fire();
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
		if (node.kind !== 'profile' && node.kind !== 'profileGroup') {
			return [];
		}
		const profile = node.kind === 'profile' ? node.name : node.profile;
		try {
			const extensions = await this.extensionsOf(profile);
			const versions = new Map(extensions.map(e => [e.id, e.version]));
			const layout = profileLayout(await this.groupsConfig(), profile, extensions.map(e => e.id));
			if (node.kind === 'profileGroup') {
				const group = layout.groups.find(candidate => candidate.name === node.name);
				return (group?.installed ?? []).map(id => ({ kind: 'profileGroupExtension', profile, group: node.name, id, version: versions.get(id) }));
			}
			return [
				...layout.groups.map((group): Node => ({ kind: 'profileGroup', profile, name: group.name })),
				...layout.others.map((id): Node => ({ kind: 'profileExtension', profile, id, version: versions.get(id) })),
			];
		} catch (error) {
			return [message(errorText(error))];
		}
	}

	/** The groups, or none when the file cannot be read: the profile's extensions still show, just ungrouped. */
	private async groupsConfig(): Promise<GroupsConfig> {
		try {
			return (await this.core.loadGroups()).config;
		} catch {
			return { groups: {}, profiles: {} };
		}
	}

	async getTreeItem(node: Node): Promise<vscode.TreeItem> {
		switch (node.kind) {
			case 'profile': {
				const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.Collapsed);
				item.description = node.name === (await this.core.currentProfileName()) ? 'current' : undefined;
				item.contextValue = 'profile';
				// the profile's own icon when it has one, like VS Code shows it
				const own = (await this.core.profiles()).find(candidate => candidate.name === node.name);
				item.iconPath = new vscode.ThemeIcon((own && profileIcon(own)) ?? 'account');
				return item;
			}
			case 'profileGroup': {
				const layout = profileLayout(await this.groupsConfig(), node.profile, (await this.extensionsOf(node.profile)).map(e => e.id));
				const group = layout.groups.find(candidate => candidate.name === node.name);
				const have = group?.installed.length ?? 0;
				const total = group?.total ?? 0;
				const item = new vscode.TreeItem(node.name, have > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
				item.description = `${have} of ${total} installed`;
				item.contextValue = 'profileGroup';
				item.iconPath = new vscode.ThemeIcon('package');
				item.tooltip = have === total
					? `${node.profile} has every extension of "${node.name}".`
					: `${node.profile} lacks ${(group?.missing ?? []).join(', ')}. Sync the profile to install it.`;
				return item;
			}
			case 'profileGroupExtension':
			case 'profileExtension': {
				const item = extensionItem(node.id, await this.catalog.lookup(node.id, node.version), node);
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
		case 'profileGroup': return { kind: 'group', name: node.name };
		case 'profileGroupExtension':
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
		case 'profileGroup':
		case 'profileGroupExtension':
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
		await core.forgetExclusions(profile, ids.filter(id => !failed.some(f => f.id.toLowerCase() === id.toLowerCase()))); // wanted again, installed already or not
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

	const controller = (): vscode.TreeDragAndDropController<Node> => ({
		dragMimeTypes: [SOURCES_MIME],
		dropMimeTypes: [SOURCES_MIME],
		handleDrag(nodes, transfer) {
			const sources = nodes.map(sourceOf).filter((s): s is DragSource => s !== undefined);
			if (sources.length > 0) {
				transfer.set(SOURCES_MIME, new vscode.DataTransferItem(sources));
			}
		},
		async handleDrop(node, transfer) {
			const target = targetOf(node);
			if (!target) {
				return;
			}
			const items: vscode.DataTransferItem[] = [];
			transfer.forEach((item, mime) => mime === SOURCES_MIME && items.push(item)); // every entry: one may be an empty placeholder
			const sources = (await Promise.all(items.map(sourcesFrom))).flat();
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

	const groupsDnd = controller();
	const profilesDnd = controller();

	const nodeOf = <K extends Node['kind']>(arg: unknown, kind: K): Extract<Node, { kind: K }> => {
		if ((arg as Node | undefined)?.kind !== kind) {
			throw new Error('This command works on an item of the Better Profiles tab.');
		}
		return arg as Extract<Node, { kind: K }>;
	};

	const EXTENSION_KINDS = ['groupExtension', 'profileGroupExtension', 'profileExtension'];
	const extensionNodeOf = (arg: unknown): ExtensionNode => {
		if (!EXTENSION_KINDS.includes((arg as Node | undefined)?.kind ?? '')) {
			throw new Error('This command works on an item of the Better Profiles tab.');
		}
		return arg as ExtensionNode;
	};
	/** A group, in the Groups tree or inside a profile: either way the group itself. */
	const groupNameOf = (arg: unknown): string => {
		const kind = (arg as Node | undefined)?.kind;
		if (kind !== 'group' && kind !== 'profileGroup') {
			throw new Error('This command works on an item of the Better Profiles tab.');
		}
		return (arg as { name: string }).name;
	};

	// Two clicks in a row on the same item count as a double click: the tree tells an extension only about clicks.
	const DOUBLE_CLICK_MS = 500;
	let lastClick: { key: string; at: number } | undefined;
	const clickKey = (node: ExtensionNode) => [node.kind, 'profile' in node ? node.profile : '', 'group' in node ? node.group : '', node.id.toLowerCase()].join('|');

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

			// A button in a view's title bar is run with the item that is focused in the tree, which has a `name` of its own:
			// the name is only taken from `groupName`, never from what the command is given by the tree.
			command('better-profiles.view.newGroup', async (arg?: { groupName?: unknown }) => {
				const given = typeof arg?.groupName === 'string' ? arg.groupName : undefined;
				const typed = given ?? await ui.input('Name of the new group');
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

			command('better-profiles.view.clickExtension', async (arg?: unknown) => {
				const node = extensionNodeOf(arg);
				// when VS Code is set to open items on a double click it already runs this only for one
				const key = clickKey(node);
				const now = Date.now();
				const doubleClicks = vscode.workspace.getConfiguration('workbench.list').get('openMode') === 'doubleClick';
				if (doubleClicks || (lastClick?.key === key && now - lastClick.at <= DOUBLE_CLICK_MS)) {
					lastClick = undefined;
					await ui.openExtension(node.id);
				} else {
					lastClick = { key, at: now };
				}
			}),

			command('better-profiles.view.openExtension', (arg?: unknown) => ui.openExtension(extensionNodeOf(arg).id)),

			command('better-profiles.view.copyExtensionId', async (arg?: unknown) => {
				const { id } = extensionNodeOf(arg);
				await vscode.env.clipboard.writeText(id);
				vscode.window.setStatusBarMessage(`Copied ${id}`, 2500);
			}),

			// Only the id is passed on: these commands read other fields (a "group", say) of what they are given as answers.
			command('better-profiles.view.addExtensionToGroup', (arg?: unknown) =>
				vscode.commands.executeCommand('better-profiles.extensionAddToGroup', extensionNodeOf(arg).id)),

			command('better-profiles.view.installExtensionInProfiles', (arg?: unknown) =>
				vscode.commands.executeCommand('better-profiles.extensionInstallInProfiles', extensionNodeOf(arg).id)),

			command('better-profiles.view.deleteGroup', async (arg?: unknown) => {
				const { name } = nodeOf(arg, 'group'); // the group itself: only from the Groups tree
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
				const { group, id } = nodeOf(arg, 'groupExtension'); // the real group: only from the Groups tree
				const { config, file } = await core.loadGroups();
				await core.saveGroups(file, removeFromGroup(config, group, id));
				void vscode.window.showInformationMessage(`Removed ${id} from "${group}". Nothing was uninstalled.`);
			}),

			command('better-profiles.view.removeFromProfile', async (arg?: unknown) => {
				const { profile, name } = nodeOf(arg, 'profileGroup');
				const { config, file } = await core.loadGroups();
				const own = Object.prototype.hasOwnProperty.call(config.profiles, profile) ? config.profiles[profile] : [];
				if (!own.includes(name)) {
					// it comes from "*": the profile does not list it, so it cannot leave just this one
					const choice = await ui.ask(`"${name}" goes to all profiles, so it cannot be taken out of just "${profile}".`, 'Remove From All Profiles');
					if (choice !== undefined) {
						await core.saveGroups(file, unassignGroup(config, ALL_PROFILES, name));
					}
					return;
				}
				// stops the profile following the group and uninstalls the group's extensions from it, after asking
				return vscode.commands.executeCommand('better-profiles.removeGroupFromProfile', { profile, group: name });
			}),

			command('better-profiles.view.removeExtensionFromProfile', (arg?: unknown) => {
				const node = extensionNodeOf(arg);
				if (node.kind === 'groupExtension') {
					throw new Error('This command works on an item of the Better Profiles tab.'); // that one belongs to the real group
				}
				// only the id and the profile are passed on: what the node says about its group must not answer for the user
				return vscode.commands.executeCommand('better-profiles.removeExtensionFromProfile', { profile: node.profile, id: node.id });
			}),

			command('better-profiles.view.syncProfile', (arg?: unknown) =>
				vscode.commands.executeCommand('better-profiles.syncProfile', { profile: nodeOf(arg, 'profile').name })),

			command('better-profiles.view.setTriggers', (arg?: unknown) =>
				vscode.commands.executeCommand('better-profiles.setGroupTriggers', { group: groupNameOf(arg) })),

			command('better-profiles.view.assignGroup', (arg?: unknown) =>
				vscode.commands.executeCommand('better-profiles.assignGroup', { group: groupNameOf(arg) })),
		],
		handles: {
			groups: { provider: groups as vscode.TreeDataProvider<unknown>, dnd: groupsDnd as vscode.TreeDragAndDropController<unknown>, refresh: () => groups.refresh() },
			profiles: { provider: profiles as vscode.TreeDataProvider<unknown>, dnd: profilesDnd as vscode.TreeDragAndDropController<unknown>, refresh: () => profiles.refresh() },
		},
	};
}
