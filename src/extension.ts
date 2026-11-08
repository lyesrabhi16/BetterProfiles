import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import type { BetterProfilesApi } from './api';
import { registerGroupCommands } from './groupCommands';
import { registerGraph } from './graphView';
import { registerViews } from './views';
import { createUi } from './ui';
import {
	Detection,
	Profile,
	StorageSnapshot,
	detectProfile,
	parseStorage,
	statusText,
	statusTooltip,
} from './profiles';

const SWITCH_COMMAND = 'better-profiles.switchProfile';
const BUILTIN_SWITCHER = 'workbench.profiles.actions.switchProfile';

export async function activate(context: vscode.ExtensionContext): Promise<BetterProfilesApi> {
	const log = vscode.window.createOutputChannel('Better Profiles', { log: true });
	const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99999999);
	statusBarItem.command = SWITCH_COMMAND;

	/** VS Code's `storage.json` sits next to the folder our global storage lives in. */
	const storageFile = (): string => {
		const configured = vscode.workspace.getConfiguration('betterProfiles').get<string>('storageFile')?.trim();
		return configured || path.join(path.dirname(context.globalStorageUri.fsPath), 'storage.json');
	};

	const readStorage = async (): Promise<StorageSnapshot> => {
		const file = storageFile();
		try {
			return parseStorage(await fs.readFile(file, 'utf8'));
		} catch (error) {
			log.error(`Could not read ${file}: ${error instanceof Error ? error.message : String(error)}`);
			return { profiles: [], workspaces: {} };
		}
	};

	// Uri.toString() is the exact form VS Code uses for its association keys (percent-encoded).
	const windowContext = () => ({
		workspaceFile: vscode.workspace.workspaceFile?.toString(),
		folders: (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.toString()),
	});

	const detect = async (): Promise<Detection> => detectProfile(await readStorage(), windowContext());

	const refresh = async (): Promise<void> => {
		const detection = await detect();
		statusBarItem.text = statusText(detection);
		statusBarItem.tooltip = statusTooltip(detection);
		statusBarItem.show();
	};

	const ui = createUi();

	const api: BetterProfilesApi = {
		async getCurrentProfile(): Promise<Profile | undefined> {
			const detection = await detect();
			return detection.kind === 'unknown' ? undefined : detection.profile;
		},
		async getProfiles(): Promise<Profile[]> {
			return (await readStorage()).profiles;
		},
		refresh,
		checkSync: () => groups.checkSync(),
		resetPrompts: () => groups.resetPrompts(),
		groupedExtensions: () => groups.groupedExtensions(),
		ui,
		get views() { return views.handles; },
		get graph() { return graph.handle; },
		statusBarItem,
	};

	const groups = registerGroupCommands({ context, log, api, ui });
	const viewsCore = { ...groups.core, currentProfileName: async () => (await api.getCurrentProfile())?.name };
	const views = registerViews({ core: viewsCore, ui, log });
	const graph = registerGraph({ core: viewsCore, ui, log });

	context.subscriptions.push(
		log,
		statusBarItem,
		vscode.commands.registerCommand(SWITCH_COMMAND, async () => {
			try {
				await vscode.commands.executeCommand(BUILTIN_SWITCHER);
			} catch (error) {
				log.error(`Could not open the profile switcher: ${String(error)}`);
				void vscode.window.showErrorMessage('Better Profiles: this version of VS Code has no profile switcher command.');
			}
		}),
		// Kept for keybindings and other extensions; the same data as the exported API.
		vscode.commands.registerCommand('better-profiles.getCurrentProfile', () => api.getCurrentProfile()),
		vscode.commands.registerCommand('better-profiles.getProfiles', () => api.getProfiles()),
		vscode.workspace.onDidChangeWorkspaceFolders(() => { void refresh(); void groups.checkSync(); }),
		// A profile can be renamed or re-iconed from another window.
		vscode.window.onDidChangeWindowState(state => state.focused && void refresh()),
		vscode.workspace.onDidChangeConfiguration(event => event.affectsConfiguration('betterProfiles.storageFile') && void refresh()),
		...groups.disposables,
		...views.disposables,
		...graph.disposables,
		// editing the groups file by hand: check again when it is saved
		vscode.workspace.onDidSaveTextDocument(doc => {
			if (doc.uri.fsPath === groups.groupsFilePath()) {
				void groups.refreshGroupedContext();
				void groups.checkSync();
			}
		}),
		vscode.workspace.onDidChangeConfiguration(event => event.affectsConfiguration('betterProfiles.groupsFile') && void groups.refreshGroupedContext()),
	);

	await refresh();
	await groups.refreshGroupedContext();

	// Shortly after startup, look whether this profile has all the extensions of its groups.
	// Not under test: the tests call checkSync() themselves, and a timer would race with them.
	if (context.extensionMode !== vscode.ExtensionMode.Test) {
		const timer = setTimeout(() => void groups.checkSync(), 4000);
		context.subscriptions.push({ dispose: () => clearTimeout(timer) });
	}
	return api;
}

export function deactivate() { }
