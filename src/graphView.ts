import * as crypto from 'crypto';
import * as vscode from 'vscode';
import type { GraphHandle, PromptUi } from './api';
import { ExtensionCatalog } from './catalog';
import { GraphModel, buildGraph } from './graph';
import { graphHtml } from './graphHtml';
import { isExtensionId } from './groups';
import type { ViewsCore } from './views';

export const SHOW_GRAPH = 'better-profiles.showGraph';

/** The graph of extensions, groups and profiles, in one panel that is opened by a button of the Better Profiles tab. */
export function registerGraph({ core, ui, log }: { core: ViewsCore; ui: PromptUi; log: vscode.LogOutputChannel }): { disposables: vscode.Disposable[]; handle: GraphHandle } {
	const catalog = new ExtensionCatalog(() => core.extensionsDir());
	let panel: vscode.WebviewPanel | undefined;
	let last: { graph: GraphModel; error?: string } | undefined;
	let opened = 0;
	let sent = 0;

	async function model(): Promise<{ graph: GraphModel; error?: string }> {
		let config;
		try {
			config = (await core.loadGroups()).config;
		} catch (error) {
			return { graph: { nodes: [], edges: [] }, error: error instanceof Error ? error.message : String(error) };
		}
		const infos = new Map<string, Awaited<ReturnType<ExtensionCatalog['lookup']>>>();
		for (const id of new Set(Object.values(config.groups).flat())) {
			infos.set(id.toLowerCase(), await catalog.lookup(id));
		}
		const webview = panel?.webview;
		return {
			graph: buildGraph(config, await core.profileNames(), {
				current: await core.currentProfileName(),
				describe: id => {
					const info = infos.get(id.toLowerCase());
					return info && { label: info.name, icon: info.iconPath && webview ? webview.asWebviewUri(vscode.Uri.file(info.iconPath)).toString() : undefined };
				},
			}),
		};
	}

	async function publish(): Promise<void> {
		if (!panel) {
			return;
		}
		catalog.clear();
		last = await model();
		sent++;
		await panel.webview.postMessage({ type: 'graph', ...last });
	}

	async function receive(message: unknown): Promise<void> {
		const m = message as { type?: unknown; id?: unknown } | null | undefined;
		if (typeof m !== 'object' || m === null) {
			return;
		}
		if (m.type === 'ready' || m.type === 'refresh') {
			return publish();
		}
		if (m.type === 'openExtension' && typeof m.id === 'string' && isExtensionId(m.id)) {
			return ui.openExtension(m.id);
		}
	}

	async function open(): Promise<void> {
		if (panel) {
			panel.reveal();
			return;
		}
		const dir = core.extensionsDir();
		panel = vscode.window.createWebviewPanel('betterProfiles.graph', 'Better Profiles Graph', vscode.ViewColumn.Active, {
			enableScripts: true,
			localResourceRoots: dir ? [vscode.Uri.file(dir)] : [],
		});
		opened++;
		const mine = panel;
		mine.webview.html = graphHtml(crypto.randomBytes(16).toString('hex'), mine.webview.cspSource);
		mine.webview.onDidReceiveMessage(message => receive(message).catch(error => log.error(`graph: ${String(error)}`)));
		mine.onDidDispose(() => {
			if (panel === mine) {
				panel = undefined;
				last = undefined;
			}
		});
		await publish();
	}

	const changes = core.onDidChangeGroups(() => publish().catch(error => log.error(`graph: ${String(error)}`)));

	return {
		disposables: [
			changes,
			vscode.commands.registerCommand(SHOW_GRAPH, async () => {
				try {
					await open();
				} catch (error) {
					log.error(`${SHOW_GRAPH}: ${String(error)}`);
					throw error;
				}
			}),
			{ dispose: () => panel?.dispose() },
		],
		handle: {
			open,
			close: () => panel?.dispose(),
			isOpen: () => panel !== undefined,
			opened: () => opened,
			sent: () => sent,
			state: () => last,
			receive,
		},
	};
}
