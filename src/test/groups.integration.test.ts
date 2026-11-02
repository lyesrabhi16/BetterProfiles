import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { GroupsConfig, SyncPlan } from '../groups';
import type { InstallResult } from '../cli';

// Extension groups, in a real Extension Host, against a FAKE CLI (test-fixtures/stub-code.js).
// Nothing here runs a real VS Code CLI, so nothing can touch real profiles or extensions.

const EXTENSION_ID = 'lyesrabhi.better-profiles';
const STUB = path.resolve(__dirname, '../../test-fixtures/stub-code.js');

const PYTHON = { name: 'Python', location: '25bf4367', icon: 'snake' };
const AGENTS = { name: 'Agents', location: 'agents' };

interface SyncReport {
	profile: string;
	plan: SyncPlan;
	results: InstallResult[];
	cancelled?: boolean;
}

/** executeCommand returns a Thenable; assert.rejects wants a real Promise. */
const exec = <T = unknown>(command: string, ...args: unknown[]): Promise<T> => Promise.resolve(vscode.commands.executeCommand<T>(command, ...args));

const config = () => vscode.workspace.getConfiguration('betterProfiles');
const set = (key: string, value: unknown) => config().update(key, value, vscode.ConfigurationTarget.Global);

suite('Extension groups against a fake CLI', () => {
	let dir: string;
	let groupsFile: string;
	let stateFile: string;
	let logFile: string;
	let n = 0;

	/** What the fake CLI has "installed" per profile. */
	const writeState = (state: Record<string, string[]>) => fs.writeFileSync(stateFile, JSON.stringify(state));
	const readState = (): Record<string, string[]> => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
	const calls = (): string[][] => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
	const installs = () => calls().filter(a => a.includes('--install-extension'));
	const writeGroups = (c: Partial<GroupsConfig>) => fs.writeFileSync(groupsFile, JSON.stringify({ groups: {}, profiles: {}, ...c }));
	const readGroups = (): GroupsConfig => JSON.parse(fs.readFileSync(groupsFile, 'utf8'));
	const sync = (args: object): Promise<SyncReport> => exec('better-profiles.syncProfile', { confirm: false, ...args });

	suiteSetup(async () => {
		await vscode.extensions.getExtension(EXTENSION_ID)!.activate();
	});

	setup(async () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), `bp-groups-${++n}-`));
		groupsFile = path.join(dir, 'groups.json');
		stateFile = path.join(dir, 'state.json');
		logFile = path.join(dir, 'calls.log');
		process.env.STUB_STATE = stateFile;
		process.env.STUB_LOG = logFile;
		process.env.ELECTRON_RUN_AS_NODE = '1'; // the fake CLI is run by the editor binary acting as node
		writeState({ Default: ['common.one'], Python: ['p.installed'], Agents: [] });

		const storage = path.join(dir, 'storage.json');
		fs.writeFileSync(storage, JSON.stringify({ userDataProfiles: [PYTHON, AGENTS], profileAssociations: { workspaces: {} } }));
		await set('storageFile', storage);
		await set('groupsFile', groupsFile);
		await set('codeCommand', process.execPath);
		await set('codeArgs', [STUB]);
	});

	teardown(async () => {
		for (const key of ['storageFile', 'groupsFile', 'codeCommand', 'codeArgs']) {
			await set(key, undefined);
		}
		fs.rmSync(dir, { recursive: true, force: true });
	});

	suite('commands', () => {
		const IDS = ['editGroups', 'addToGroup', 'assignGroup', 'compareProfiles', 'syncProfile'].map(c => `better-profiles.${c}`);

		test('are contributed to the palette and registered', async () => {
			const ext = vscode.extensions.getExtension(EXTENSION_ID)!;
			const contributed = (ext.packageJSON.contributes?.commands ?? []).map((c: { command: string }) => c.command);
			const registered = new Set(await vscode.commands.getCommands(true));
			assert.deepStrictEqual(IDS.filter(id => !contributed.includes(id)), [], 'not contributed');
			assert.deepStrictEqual(IDS.filter(id => !registered.has(id)), [], 'not registered');
		});

		test('their settings are declared', () => {
			const props = vscode.extensions.getExtension(EXTENSION_ID)!.packageJSON.contributes?.configuration?.properties ?? {};
			for (const key of ['groupsFile', 'codeCommand', 'codeArgs']) {
				assert.ok(`betterProfiles.${key}` in props, key);
			}
		});
	});

	suite('the groups file', () => {
		test('editGroups creates a valid empty file when there is none and returns its path', async () => {
			const file = await exec<string>('better-profiles.editGroups', { open: false });
			assert.strictEqual(file, groupsFile);
			assert.deepStrictEqual(readGroups(), { groups: {}, profiles: {} });
		});

		test('editGroups does not overwrite an existing file', async () => {
			writeGroups({ groups: { web: ['a.b'] } });
			await exec('better-profiles.editGroups', { open: false });
			assert.deepStrictEqual(readGroups().groups, { web: ['a.b'] });
		});

		test('addToGroup writes the group, then merges without duplicates', async () => {
			await exec('better-profiles.addToGroup', { group: 'web', extensions: ['a.b', 'c.d'] });
			await exec('better-profiles.addToGroup', { group: 'web', extensions: ['C.D', 'e.f'] });
			assert.deepStrictEqual(readGroups().groups, { web: ['a.b', 'c.d', 'e.f'] });
		});

		test('addToGroup rejects an invalid extension id and writes nothing', async () => {
			await assert.rejects(exec('better-profiles.addToGroup', { group: 'web', extensions: ['--evil'] }), /extension id/i);
			assert.ok(!fs.existsSync(groupsFile));
		});

		test('assignGroup maps a group to a profile', async () => {
			writeGroups({ groups: { web: ['a.b'] } });
			await exec('better-profiles.assignGroup', { profile: 'Python', group: 'web' });
			assert.deepStrictEqual(readGroups().profiles, { Python: ['web'] });
		});

		test('a file that is not valid JSON is reported and left exactly as it was', async () => {
			fs.writeFileSync(groupsFile, '{ broken');
			await assert.rejects(exec('better-profiles.addToGroup', { group: 'web', extensions: ['a.b'] }), /groups/i);
			assert.strictEqual(fs.readFileSync(groupsFile, 'utf8'), '{ broken');
		});
	});

	suite('compareProfiles', () => {
		test('lists the extensions of Default and every profile, asking the CLI once per profile', async () => {
			writeState({ Default: ['a.one', 'b.two'], Python: ['a.one', 'p.py'], Agents: [] });
			const md = await exec<string>('better-profiles.compareProfiles', { open: false });
			assert.ok(md.split('\n')[0].startsWith('| Extension | Default | Python | Agents |'), md);
			assert.ok(/\| a\.one \| ✓ \| ✓ \|/.test(md), md);
			assert.ok(/\| b\.two \| ✓ \|\s*\|\s*\|/.test(md), md);
			assert.ok(/\| p\.py \|\s*\| ✓ \|/.test(md), md);

			const profilesAsked = calls().map(a => (a.includes('--profile') ? a[a.indexOf('--profile') + 1] : 'Default'));
			assert.deepStrictEqual(profilesAsked, ['Default', 'Python', 'Agents']);
			assert.ok(calls().every(a => a.includes('--list-extensions')));
		});
	});

	suite('syncProfile', () => {
		test('installs only what the profile is missing, into that profile, as separate arguments', async () => {
			writeGroups({ groups: { common: ['common.one', 'common.two'], py: ['p.installed', 'p.new'] }, profiles: { '*': ['common'], Python: ['py'] } });
			const report = await sync({ profile: 'Python' });

			assert.deepStrictEqual(report.plan.toInstall, ['common.one', 'common.two', 'p.new']);
			assert.deepStrictEqual(report.plan.alreadyInstalled, ['p.installed']);
			assert.ok(report.results.every(r => r.ok));
			assert.deepStrictEqual(installs(), [
				['--install-extension', 'common.one', '--profile', 'Python'],
				['--install-extension', 'common.two', '--profile', 'Python'],
				['--install-extension', 'p.new', '--profile', 'Python'],
			]);
			assert.deepStrictEqual(readState().Python, ['p.installed', 'common.one', 'common.two', 'p.new']);
			assert.deepStrictEqual(readState().Default, ['common.one'], 'other profiles are untouched');
		});

		test('never uninstalls anything', async () => {
			writeGroups({ groups: { g: ['new.one'] }, profiles: { Python: ['g'] } });
			await sync({ profile: 'Python' });
			assert.ok(calls().every(a => !a.some(x => /uninstall|remove|disable/i.test(x))));
			assert.ok(readState().Python.includes('p.installed'));
		});

		test('keeps going when one extension fails and reports it', async () => {
			writeGroups({ groups: { g: ['a.first', 'fail.ext', 'z.last'] }, profiles: { Agents: ['g'] } });
			const report = await sync({ profile: 'Agents' });
			assert.deepStrictEqual(report.results.map(r => [r.id, r.ok]), [['a.first', true], ['fail.ext', false], ['z.last', true]]);
			assert.ok(report.results[1].message.includes("'fail.ext' not found"), report.results[1].message);
			assert.deepStrictEqual(readState().Agents, ['a.first', 'z.last']);
		});

		test('the Default profile is installed into without --profile', async () => {
			writeGroups({ groups: { g: ['d.new'] }, profiles: { Default: ['g'] } });
			await sync({ profile: 'Default' });
			assert.deepStrictEqual(installs(), [['--install-extension', 'd.new']]);
		});

		test('does nothing when the profile already has everything', async () => {
			writeGroups({ groups: { g: ['p.installed'] }, profiles: { Python: ['g'] } });
			const report = await sync({ profile: 'Python' });
			assert.deepStrictEqual(report.plan.toInstall, []);
			assert.deepStrictEqual(installs(), []);
		});

		test('reports groups that are assigned but not defined', async () => {
			writeGroups({ groups: {}, profiles: { Python: ['ghost'] } });
			const report = await sync({ profile: 'Python' });
			assert.deepStrictEqual(report.plan.missingGroups, ['ghost']);
		});

		test('rejects a profile VS Code does not know, before running anything', async () => {
			writeGroups({ groups: { g: ['a.b'] }, profiles: { Nope: ['g'] } });
			await assert.rejects(sync({ profile: 'Nope' }), /Nope/);
			assert.deepStrictEqual(calls(), []);
		});

		test('refuses to guess where the extensions live when no CLI is configured', async () => {
			await set('codeCommand', undefined);
			await set('codeArgs', undefined);
			writeGroups({ groups: { g: ['a.b'] }, profiles: { Python: ['g'] } });
			await assert.rejects(sync({ profile: 'Python' }), /extensions/i);
			assert.deepStrictEqual(calls(), [], 'it must not run any CLI it could not point at the right installation');
		});

		test('a broken groups file stops the sync and is left untouched', async () => {
			fs.writeFileSync(groupsFile, '{ broken');
			await assert.rejects(sync({ profile: 'Python' }), /groups/i);
			assert.deepStrictEqual(calls(), []);
			assert.strictEqual(fs.readFileSync(groupsFile, 'utf8'), '{ broken');
		});
	});
});
