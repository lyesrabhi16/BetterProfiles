import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { BetterProfilesApi } from '../../api';

// Runs in a window that opened test-fixtures/multi-root/multi.code-workspace: folders a/ and b/, and only b/
// contains a pubspec.yaml. The fake CLI never touches a real VS Code.

const EXTENSION_ID = 'lyesrabhi.better-profiles';
const STUB = path.resolve(__dirname, '../../../test-fixtures/stub-code.js');
const PYTHON = { name: 'Python', location: '25bf4367', icon: 'snake' };

const settings = () => vscode.workspace.getConfiguration('betterProfiles');
const set = (key: string, value: unknown) => settings().update(key, value, vscode.ConfigurationTarget.Global);

suite('a real multi-root window', () => {
	let dir: string;
	let api: BetterProfilesApi;
	let log: string;
	const asked: string[] = [];
	let original: Pick<BetterProfilesApi['ui'], 'ask' | 'pickMany' | 'confirm'>;

	const folderKeys = () => vscode.workspace.workspaceFolders!.map(f => f.uri.toString());
	const workspaceKey = () => vscode.workspace.workspaceFile!.toString();
	const calls = (): string[][] => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);

	async function useStorage(workspaces: Record<string, string>) {
		const file = path.join(dir, `storage-${Math.random().toString(36).slice(2)}.json`);
		fs.writeFileSync(file, JSON.stringify({ userDataProfiles: [PYTHON], profileAssociations: { workspaces } }));
		await set('storageFile', file);
	}

	const writeGroups = (triggers: Record<string, string[]>) =>
		fs.writeFileSync(path.join(dir, 'groups.json'), JSON.stringify({
			groups: { flutter: ['f.one'] },
			profiles: { Python: ['flutter'] },
			triggers,
		}));

	suiteSetup(async () => {
		api = await vscode.extensions.getExtension(EXTENSION_ID)!.activate();
		original = { ask: api.ui.ask, pickMany: api.ui.pickMany, confirm: api.ui.confirm };
	});

	setup(async () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-multiroot-'));
		log = path.join(dir, 'calls.log');
		process.env.STUB_STATE = path.join(dir, 'state.json');
		process.env.STUB_LOG = log;
		process.env.ELECTRON_RUN_AS_NODE = '1';
		fs.writeFileSync(process.env.STUB_STATE, JSON.stringify({ Default: [], Python: [] }));
		asked.length = 0;
		api.ui.ask = async message => { asked.push(message); return undefined; };
		await api.resetPrompts();
		await set('autoSync', 'ask');
		await set('groupsFile', path.join(dir, 'groups.json'));
		await set('codeCommand', process.execPath);
		await set('codeArgs', [STUB]);
	});

	teardown(async () => {
		Object.assign(api.ui, original);
		for (const key of ['storageFile', 'groupsFile', 'codeCommand', 'codeArgs', 'autoSync']) {
			await set(key, undefined);
		}
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test('is a two-folder window with a workspace file', () => {
		assert.deepStrictEqual(vscode.workspace.workspaceFolders!.map(f => f.name), ['a', 'b']);
		assert.ok(vscode.workspace.workspaceFile?.fsPath.endsWith('multi.code-workspace'), String(vscode.workspace.workspaceFile));
	});

	test('the profile is found through the workspace file, the way VS Code records a multi-root window', async () => {
		await useStorage({ [workspaceKey()]: PYTHON.location });
		await api.refresh();
		assert.strictEqual((await api.getCurrentProfile())?.name, 'Python');
		assert.strictEqual(api.statusBarItem.text, '$(snake) Python');
	});

	test('an association recorded for a single folder is not used for the whole workspace', async () => {
		await useStorage({ [folderKeys()[0]]: PYTHON.location, [folderKeys()[1]]: PYTHON.location });
		await api.refresh();
		assert.strictEqual(await api.getCurrentProfile(), undefined);
	});

	test('a trigger is searched in every folder: a file that only the second one has is a match', async () => {
		await useStorage({ [workspaceKey()]: PYTHON.location });
		writeGroups({ flutter: ['pubspec.yaml'] });
		await api.checkSync();
		assert.strictEqual(asked.length, 1, 'it should ask once');
		assert.ok(asked[0].includes('Python') && asked[0].includes('flutter'), asked[0]);
	});

	test('"Sync" installs into the profile of the workspace file', async () => {
		await useStorage({ [workspaceKey()]: PYTHON.location });
		writeGroups({ flutter: ['pubspec.yaml'] });
		api.ui.ask = async () => 'Sync';
		api.ui.pickMany = async () => undefined;
		await api.checkSync();
		assert.deepStrictEqual(calls().filter(a => a.includes('--install-extension')), [['--install-extension', 'f.one', '--profile', 'Python']]);
	});

	test('a trigger that matches in none of the folders stays quiet and starts no CLI', async () => {
		await useStorage({ [workspaceKey()]: PYTHON.location });
		writeGroups({ flutter: ['nothing-like-this.txt'] });
		await api.checkSync();
		assert.strictEqual(asked.length, 0);
		assert.deepStrictEqual(calls(), []);
	});

	test('patterns are relative to each folder, not to the workspace file', async () => {
		await useStorage({ [workspaceKey()]: PYTHON.location });
		writeGroups({ flutter: ['b/pubspec.yaml'] }); // would match only if relative to the folder that CONTAINS a/ and b/
		await api.checkSync();
		assert.strictEqual(asked.length, 0);
	});
});
