import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { BetterProfilesApi } from '../api';

// Runs inside a real VS Code Extension Host, with the fixture workspace
// "test-fixtures/workspace é with spaces" open (see .vscode-test.mjs).

const EXTENSION_ID = 'lyesrabhi.better-profiles';
const DEFAULT_ICON = 'settings-view-bar-icon';

const PYTHON = { name: 'Python', location: '25bf4367', icon: 'snake' };
const NO_ICON = { name: 'Agents', location: 'agents' };

function getExtension() {
	const ext = vscode.extensions.getExtension<BetterProfilesApi>(EXTENSION_ID);
	assert.ok(ext, `extension ${EXTENSION_ID} not found`);
	return ext;
}

async function getApi(): Promise<BetterProfilesApi> {
	const api = await getExtension().activate();
	assert.ok(api && typeof api.refresh === 'function', 'activate() must return the public API');
	return api;
}

/** The key VS Code uses for this window in profileAssociations.workspaces. */
function workspaceKey(): string {
	return vscode.workspace.workspaceFolders![0].uri.toString();
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-fixture-'));
let counter = 0;

/** Points the extension at a fixture storage.json (an object is serialised, a string is written as is). */
async function useStorage(content: object | string): Promise<void> {
	const file = path.join(scratch, `storage-${++counter}.json`);
	fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
	await vscode.workspace.getConfiguration('betterProfiles').update('storageFile', file, vscode.ConfigurationTarget.Global);
}

const storage = (profiles: object[], workspaces: Record<string, string>) => ({
	userDataProfiles: profiles,
	profileAssociations: { workspaces, emptyWindows: {} },
});

suite('Better Profiles in a real Extension Host', () => {
	suiteTeardown(async () => {
		await vscode.workspace.getConfiguration('betterProfiles').update('storageFile', undefined, vscode.ConfigurationTarget.Global);
		fs.rmSync(scratch, { recursive: true, force: true });
	});

	suite('the test workspace', () => {
		test('is the fixture whose URI is percent-encoded (so the encoding case is always exercised)', () => {
			assert.ok(workspaceKey().includes('%20'), workspaceKey());
			assert.ok(workspaceKey().includes('%C3%A9'), workspaceKey());
		});
	});

	suite('activation and commands', () => {
		test('activates and returns its public API', async () => {
			const api = await getApi();
			assert.ok(getExtension().isActive);
			assert.strictEqual(typeof api.getCurrentProfile, 'function');
			assert.strictEqual(typeof api.getProfiles, 'function');
			assert.ok(api.statusBarItem, 'statusBarItem');
		});

		test('every command declared in package.json is registered (no dangling palette entries)', async () => {
			await getExtension().activate();
			const declared: { command: string }[] = getExtension().packageJSON.contributes?.commands ?? [];
			assert.ok(declared.length > 0, 'the extension should contribute at least one command');
			const registered = new Set(await vscode.commands.getCommands(true));
			const missing = declared.map(c => c.command).filter(c => !registered.has(c));
			assert.deepStrictEqual(missing, []);
		});

		test('contributes a "switch profile" command', async () => {
			const ids = (getExtension().packageJSON.contributes?.commands ?? []).map((c: { command: string }) => c.command);
			assert.ok(ids.includes('better-profiles.switchProfile'), ids.join(', '));
		});

		test('the status bar item switches profile when clicked', async () => {
			const api = await getApi();
			assert.strictEqual(typeof api.statusBarItem.command === 'string' ? api.statusBarItem.command : api.statusBarItem.command?.command, 'better-profiles.switchProfile');
		});

		test('the built-in profile switcher it delegates to exists in this VS Code', async () => {
			const registered = await vscode.commands.getCommands(true);
			assert.ok(registered.includes('workbench.profiles.actions.switchProfile'));
		});

		test('declares the betterProfiles.storageFile setting', () => {
			const props = getExtension().packageJSON.contributes?.configuration?.properties ?? {};
			assert.ok('betterProfiles.storageFile' in props);
		});
	});

	suite('profile detection against a fixture storage.json', () => {
		test('a folder associated with a named profile shows its icon and name', async () => {
			await useStorage(storage([PYTHON], { [workspaceKey()]: PYTHON.location }));
			const api = await getApi();
			await api.refresh();
			assert.strictEqual((await api.getCurrentProfile())?.name, 'Python');
			assert.strictEqual(api.statusBarItem.text, '$(snake) Python');
		});

		test('a folder associated with the default profile shows Default', async () => {
			await useStorage(storage([PYTHON], { [workspaceKey()]: '__default__profile__' }));
			const api = await getApi();
			await api.refresh();
			assert.strictEqual((await api.getCurrentProfile())?.name, 'Default');
			assert.strictEqual(api.statusBarItem.text, `$(${DEFAULT_ICON}) Default`);
		});

		test('a folder VS Code has not recorded is unknown, not Default', async () => {
			await useStorage(storage([PYTHON], {}));
			const api = await getApi();
			await api.refresh();
			assert.strictEqual(await api.getCurrentProfile(), undefined);
			assert.strictEqual(api.statusBarItem.text, `$(${DEFAULT_ICON}) Profile`);
		});

		test('a profile without an icon never renders "$(undefined)"', async () => {
			await useStorage(storage([NO_ICON], { [workspaceKey()]: NO_ICON.location }));
			const api = await getApi();
			await api.refresh();
			assert.strictEqual(api.statusBarItem.text, `$(${DEFAULT_ICON}) Agents`);
		});

		test('refresh() picks up a changed storage file', async () => {
			const api = await getApi();
			await useStorage(storage([PYTHON], { [workspaceKey()]: PYTHON.location }));
			await api.refresh();
			assert.strictEqual(api.statusBarItem.text, '$(snake) Python');
			await useStorage(storage([PYTHON, NO_ICON], { [workspaceKey()]: NO_ICON.location }));
			await api.refresh();
			assert.strictEqual(api.statusBarItem.text, `$(${DEFAULT_ICON}) Agents`);
		});

		test('changing the storageFile setting updates the status bar without calling refresh()', async () => {
			const api = await getApi();
			await useStorage(storage([PYTHON], { [workspaceKey()]: PYTHON.location }));
			const deadline = Date.now() + 5000;
			while (api.statusBarItem.text !== '$(snake) Python' && Date.now() < deadline) {
				await new Promise(resolve => setTimeout(resolve, 50));
			}
			assert.strictEqual(api.statusBarItem.text, '$(snake) Python');
		});

		test('getProfiles() returns every profile in the storage file', async () => {
			await useStorage(storage([PYTHON, NO_ICON], {}));
			const api = await getApi();
			await api.refresh();
			assert.deepStrictEqual((await api.getProfiles()).map(p => p.name), ['Python', 'Agents']);
		});

		test('getCurrentProfile and getProfiles stay available as commands and match the API', async () => {
			await useStorage(storage([PYTHON], { [workspaceKey()]: PYTHON.location }));
			const api = await getApi();
			await api.refresh();
			assert.deepStrictEqual(await vscode.commands.executeCommand('better-profiles.getCurrentProfile'), await api.getCurrentProfile());
			assert.deepStrictEqual(await vscode.commands.executeCommand('better-profiles.getProfiles'), await api.getProfiles());
		});

		test('getProfiles() is empty when there are no custom profiles', async () => {
			await useStorage({});
			const api = await getApi();
			await api.refresh();
			assert.deepStrictEqual(await api.getProfiles(), []);
		});

		test('a missing storage file does not throw and leaves a neutral status', async () => {
			await vscode.workspace.getConfiguration('betterProfiles').update('storageFile', path.join(scratch, 'does-not-exist.json'), vscode.ConfigurationTarget.Global);
			const api = await getApi();
			await api.refresh();
			assert.strictEqual(await api.getCurrentProfile(), undefined);
			assert.deepStrictEqual(await api.getProfiles(), []);
			assert.strictEqual(api.statusBarItem.text, `$(${DEFAULT_ICON}) Profile`);
		});

		test('invalid JSON does not throw and leaves a neutral status', async () => {
			await useStorage('{ this is not json');
			const api = await getApi();
			await api.refresh();
			assert.strictEqual(await api.getCurrentProfile(), undefined);
			assert.strictEqual(api.statusBarItem.text, `$(${DEFAULT_ICON}) Profile`);
		});
	});
});
