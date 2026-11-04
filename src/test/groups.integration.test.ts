import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { GroupsConfig, SyncPlan } from '../groups';
import type { InstallResult } from '../cli';
import type { BetterProfilesApi, PickItem } from '../api';

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
	extras?: string[];
	uninstalled?: InstallResult[];
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
		fs.writeFileSync(storage, JSON.stringify({ userDataProfiles: [PYTHON, AGENTS], profileAssociations: { workspaces: { [vscode.workspace.workspaceFolders![0].uri.toString()]: PYTHON.location } } }));
		await set('storageFile', storage);
		await set('groupsFile', groupsFile);
		await set('codeCommand', process.execPath);
		await set('codeArgs', [STUB]);
	});

	teardown(async () => {
		for (const key of ['storageFile', 'groupsFile', 'codeCommand', 'codeArgs', 'autoSync', 'keepExtensions']) {
			await set(key, undefined);
		}
		fs.rmSync(dir, { recursive: true, force: true });
	});

	suite('commands', () => {
		const IDS = ['editGroups', 'addToGroup', 'assignGroup', 'compareProfiles', 'syncProfile', 'resetPrompts', 'setGroupTriggers'].map(c => `better-profiles.${c}`);

		test('are contributed to the palette and registered', async () => {
			const ext = vscode.extensions.getExtension(EXTENSION_ID)!;
			const contributed = (ext.packageJSON.contributes?.commands ?? []).map((c: { command: string }) => c.command);
			const registered = new Set(await vscode.commands.getCommands(true));
			assert.deepStrictEqual(IDS.filter(id => !contributed.includes(id)), [], 'not contributed');
			assert.deepStrictEqual(IDS.filter(id => !registered.has(id)), [], 'not registered');
		});

		test('their settings are declared', () => {
			const props = vscode.extensions.getExtension(EXTENSION_ID)!.packageJSON.contributes?.configuration?.properties ?? {};
			for (const key of ['groupsFile', 'codeCommand', 'codeArgs', 'autoSync', 'keepExtensions']) {
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
			assert.ok(md.split('\n').includes('| Extension | Default | Python | Agents |'), md);
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

	// ---- prompts and cleanup -------------------------------------------------------------------------------

	interface Script {
		ask?: (message: string, buttons: string[]) => string | undefined;
		pickOne?: (title: string, items: PickItem[], options?: { newItem?: { label: string; prompt: string } }) => string | undefined;
		pickMany?: (title: string, items: PickItem[]) => string[] | undefined;
		confirm?: (message: string, detail: string, action: string) => boolean;
	}

	let api: BetterProfilesApi;
	let restoreUi: () => void = () => { };
	const seen = { pickOne: [] as { title: string; items: PickItem[]; options?: { newItem?: { label: string; prompt: string } } }[], ask: [] as { message: string; buttons: string[] }[], pickMany: [] as { title: string; items: PickItem[] }[], confirm: [] as { message: string; detail: string; action: string }[] };

	/** Answers the extension's questions from a script; anything unscripted is declined. */
	function answer(script: Script) {
		seen.ask.length = seen.pickOne.length = seen.pickMany.length = seen.confirm.length = 0;
		const original = { ask: api.ui.ask, pickOne: api.ui.pickOne, pickMany: api.ui.pickMany, confirm: api.ui.confirm };
		api.ui.ask = async (message, ...buttons) => { seen.ask.push({ message, buttons }); return script.ask?.(message, buttons); };
		api.ui.pickOne = async (title, items, options) => { seen.pickOne.push({ title, items, options }); return script.pickOne?.(title, items, options); };
		api.ui.pickMany = async (title, items) => { seen.pickMany.push({ title, items }); return script.pickMany?.(title, items); };
		api.ui.confirm = async (message, detail, action) => { seen.confirm.push({ message, detail, action }); return script.confirm?.(message, detail, action) ?? false; };
		restoreUi = () => Object.assign(api.ui, original);
	}

	const uninstalls = () => calls().filter(a => a.includes('--uninstall-extension'));

	suite('ask to sync when the profile is out of sync', () => {
		setup(async () => {
			api = await vscode.extensions.getExtension(EXTENSION_ID)!.activate();
			await api.resetPrompts();
			await set('autoSync', 'ask');
			writeGroups({ groups: { py: ['p.installed', 'p.new', 'p.new2'] }, profiles: { Python: ['py'] } });
			answer({});
		});
		teardown(() => restoreUi());

		test('asks once, naming the profile and how many are missing', async () => {
			await api.checkSync();
			assert.strictEqual(seen.ask.length, 1);
			assert.ok(seen.ask[0].message.includes('Python'), seen.ask[0].message);
			assert.ok(seen.ask[0].message.includes('2'), seen.ask[0].message);
			assert.deepStrictEqual(seen.ask[0].buttons, ['Sync', 'Not now', 'Stop asking']);
			assert.deepStrictEqual(installs(), [], 'asking must not install anything');
		});

		test('"Sync" installs what is missing into this profile', async () => {
			answer({ ask: () => 'Sync' });
			await api.checkSync();
			assert.deepStrictEqual(installs(), [
				['--install-extension', 'p.new', '--profile', 'Python'],
				['--install-extension', 'p.new2', '--profile', 'Python'],
			]);
		});

		test('"Not now" is remembered for that exact set, and it asks again when the set changes', async () => {
			answer({ ask: () => 'Not now' });
			await api.checkSync();
			await api.checkSync();
			assert.strictEqual(seen.ask.length, 1, 'it must not nag about the same missing extensions');

			writeGroups({ groups: { py: ['p.installed', 'p.new', 'p.new2', 'p.new3'] }, profiles: { Python: ['py'] } });
			await api.checkSync();
			assert.strictEqual(seen.ask.length, 2);
		});

		test('resetPrompts() makes a dismissed prompt appear again', async () => {
			answer({ ask: () => 'Not now' });
			await api.checkSync();
			await api.resetPrompts();
			await api.checkSync();
			assert.strictEqual(seen.ask.length, 2);
		});

		test('"Stop asking" turns autoSync off and installs nothing', async () => {
			answer({ ask: () => 'Stop asking' });
			await api.checkSync();
			assert.strictEqual(config().get('autoSync'), 'off');
			assert.deepStrictEqual(installs(), []);
			await api.checkSync();
			assert.strictEqual(seen.ask.length, 1);
		});

		test('autoSync "auto" installs without asking', async () => {
			await set('autoSync', 'auto');
			await api.checkSync();
			assert.strictEqual(seen.ask.length, 0);
			assert.deepStrictEqual(installs().map(a => a[1]), ['p.new', 'p.new2']);
		});

		test('autoSync "auto" never uninstalls, even when there are extras', async () => {
			await set('autoSync', 'auto');
			writeState({ Default: [], Python: ['p.installed', 'extra.a'], Agents: [] });
			await api.checkSync();
			assert.deepStrictEqual(uninstalls(), []);
			assert.strictEqual(seen.pickMany.length, 0, 'no cleanup question at startup');
		});

		test('autoSync "off" does nothing and runs no CLI at all', async () => {
			await set('autoSync', 'off');
			await api.checkSync();
			assert.strictEqual(seen.ask.length, 0);
			assert.deepStrictEqual(calls(), []);
		});

		test('stays quiet when the profile already has everything', async () => {
			writeState({ Default: [], Python: ['p.installed', 'p.new', 'p.new2'], Agents: [] });
			await api.checkSync();
			assert.strictEqual(seen.ask.length, 0);
		});

		test('stays quiet, and runs no CLI, when this profile has no groups', async () => {
			writeGroups({ groups: { py: ['p.new'] }, profiles: { Agents: ['py'] } });
			await api.checkSync();
			assert.strictEqual(seen.ask.length, 0);
			assert.deepStrictEqual(calls(), []);
		});

		test('stays quiet when the profile of this window is unknown', async () => {
			const storage = path.join(dir, 'no-association.json');
			fs.writeFileSync(storage, JSON.stringify({ userDataProfiles: [PYTHON], profileAssociations: { workspaces: {} } }));
			await set('storageFile', storage);
			await api.checkSync();
			assert.strictEqual(seen.ask.length, 0);
			assert.deepStrictEqual(calls(), []);
		});

		test('does not throw or ask when the CLI cannot be found, or the groups file is broken', async () => {
			await set('codeCommand', undefined);
			await set('codeArgs', undefined);
			await api.checkSync();
			fs.writeFileSync(groupsFile, '{ broken');
			await api.checkSync();
			assert.strictEqual(seen.ask.length, 0);
		});
	});

	suite('uninstalling what the groups do not mention', () => {
		const SELF = 'lyesrabhi.better-profiles';

		setup(async () => {
			api = await vscode.extensions.getExtension(EXTENSION_ID)!.activate();
			await api.resetPrompts();
			// shared.x is in every profile, the way an application-scoped extension is
			writeState({
				Default: ['common.one', 'shared.x', 'd.only'],
				Python: ['p.installed', 'shared.x', 'extra.a', 'extra.b', SELF],
				Agents: ['shared.x', 'only.here'],
			});
			writeGroups({ groups: { py: ['p.installed'] }, profiles: { Python: ['py'] } });
			answer({});
		});
		teardown(() => restoreUi());

		test('lists the extras with nothing ticked beforehand, and never the shared, application-scoped or own extension', async () => {
			await sync({ profile: 'Python', confirm: true, uninstall: 'ask' });
			assert.strictEqual(seen.pickMany.length, 1);
			assert.deepStrictEqual(seen.pickMany[0].items.map(i => i.id), ['extra.a', 'extra.b']);
			assert.ok(seen.pickMany[0].title.includes('Python'), seen.pickMany[0].title);
			assert.ok(seen.pickMany[0].items.every(i => !('picked' in i)), 'nothing is pre-selected');
		});

		test('uninstalls only what was ticked, after a confirmation that lists it', async () => {
			answer({ pickMany: () => ['extra.a'], confirm: () => true });
			const report = await sync({ profile: 'Python', confirm: true, uninstall: 'ask' });

			assert.strictEqual(seen.confirm.length, 1);
			assert.ok(seen.confirm[0].detail.includes('extra.a') && !seen.confirm[0].detail.includes('extra.b'), seen.confirm[0].detail);
			assert.deepStrictEqual(uninstalls(), [['--uninstall-extension', 'extra.a', '--profile', 'Python']]);
			assert.deepStrictEqual(report.uninstalled?.map(r => [r.id, r.ok]), [['extra.a', true]]);
			assert.ok(readState().Python.includes('extra.b'), 'what was not ticked stays');
			assert.deepStrictEqual(readState().Default, ['common.one', 'shared.x', 'd.only'], 'other profiles are untouched');
		});

		test('declining the confirmation uninstalls nothing', async () => {
			answer({ pickMany: () => ['extra.a', 'extra.b'], confirm: () => false });
			await sync({ profile: 'Python', confirm: true, uninstall: 'ask' });
			assert.deepStrictEqual(uninstalls(), []);
		});

		test('cancelling the list, or ticking nothing, uninstalls nothing and does not even ask to confirm', async () => {
			answer({ pickMany: () => undefined });
			await sync({ profile: 'Python', confirm: true, uninstall: 'ask' });
			answer({ pickMany: () => [] });
			await sync({ profile: 'Python', confirm: true, uninstall: 'ask' });
			assert.deepStrictEqual(uninstalls(), []);
			assert.strictEqual(seen.confirm.length, 0);
		});

		test('programmatic: an explicit list is uninstalled without prompts', async () => {
			const report = await sync({ profile: 'Python', uninstall: ['extra.b'] });
			assert.deepStrictEqual(uninstalls(), [['--uninstall-extension', 'extra.b', '--profile', 'Python']]);
			assert.strictEqual(seen.pickMany.length + seen.confirm.length, 0);
			assert.deepStrictEqual(report.uninstalled?.map(r => r.id), ['extra.b']);
		});

		test('programmatic: ids that are not extras are refused before anything is uninstalled', async () => {
			for (const notExtra of ['p.installed', 'shared.x', SELF, 'not.installed']) {
				await assert.rejects(sync({ profile: 'Python', uninstall: ['extra.a', notExtra] }), /not an extra/i, notExtra);
			}
			assert.deepStrictEqual(uninstalls(), []);
		});

		test('by default a programmatic sync uninstalls nothing and asks nothing', async () => {
			await sync({ profile: 'Python' });
			assert.deepStrictEqual(uninstalls(), []);
			assert.strictEqual(seen.pickMany.length, 0);
		});

		test('a failed uninstall is reported and the others still run', async () => {
			writeState({ Default: [], Python: ['p.installed', 'extra.z', 'fail.bad'], Agents: [] });
			const report = await sync({ profile: 'Python', uninstall: ['fail.bad', 'extra.z'] });
			const byId = Object.fromEntries((report.uninstalled ?? []).map(r => [r.id, r.ok]));
			assert.deepStrictEqual(byId, { 'fail.bad': false, 'extra.z': true });
			assert.ok(!readState().Python.includes('extra.z'));
		});

		test('the betterProfiles.keepExtensions setting hides extensions from the list', async () => {
			await set('keepExtensions', ['EXTRA.A']);
			await sync({ profile: 'Python', confirm: true, uninstall: 'ask' });
			assert.deepStrictEqual(seen.pickMany[0].items.map(i => i.id), ['extra.b']);
		});

		test('a profile with no groups is never offered a cleanup', async () => {
			await sync({ profile: 'Agents', confirm: true, uninstall: 'ask' });
			assert.strictEqual(seen.pickMany.length, 0);
		});

		test('a group that is assigned but not defined blocks cleanup', async () => {
			writeGroups({ groups: { py: ['p.installed'] }, profiles: { Python: ['py', 'ghost'] } });
			await sync({ profile: 'Python', confirm: true, uninstall: 'ask' });
			assert.strictEqual(seen.pickMany.length, 0);
		});

		test('installs missing extensions first, then offers the cleanup', async () => {
			writeGroups({ groups: { py: ['p.installed', 'p.brand-new'] }, profiles: { Python: ['py'] } });
			answer({ pickMany: () => ['extra.a'], confirm: () => true });
			await sync({ profile: 'Python', confirm: false, uninstall: 'ask' });
			const order = calls().filter(a => a.includes('--install-extension') || a.includes('--uninstall-extension')).map(a => a[0]);
			assert.deepStrictEqual(order, ['--install-extension', '--uninstall-extension']);
		});
	});


	suite('install when needed: workspace triggers', () => {
		const MATCHES = '**/README.md'; // exists in the fixture workspace
		const NO_MATCH = '**/pubspec.yaml'; // does not

		setup(async () => {
			api = await vscode.extensions.getExtension(EXTENSION_ID)!.activate();
			await api.resetPrompts();
			await set('autoSync', 'ask');
			answer({});
		});
		teardown(() => restoreUi());

		test('setGroupTriggers writes the patterns of an existing group', async () => {
			writeGroups({ groups: { flutter: ['f.one'] } });
			await exec('better-profiles.setGroupTriggers', { group: 'flutter', patterns: ['**/pubspec.yaml', 'lib/*.dart'] });
			assert.deepStrictEqual((readGroups() as GroupsConfig).triggers, { flutter: ['**/pubspec.yaml', 'lib/*.dart'] });
			await exec('better-profiles.setGroupTriggers', { group: 'flutter', patterns: [] });
			assert.ok(!('triggers' in readGroups()), 'an empty list removes them');
		});

		test('setGroupTriggers refuses a bad pattern and an unknown group, and writes nothing', async () => {
			writeGroups({ groups: { flutter: ['f.one'] } });
			const before = fs.readFileSync(groupsFile, 'utf8');
			await assert.rejects(exec('better-profiles.setGroupTriggers', { group: 'flutter', patterns: ['../outside'] }), /pattern/i);
			await assert.rejects(exec('better-profiles.setGroupTriggers', { group: 'ghost', patterns: ['**/x'] }), /no group/i);
			assert.strictEqual(fs.readFileSync(groupsFile, 'utf8'), before);
		});

		test('a group whose trigger matches this workspace is offered, and the notification says why', async () => {
			writeGroups({ groups: { flutter: ['f.one', 'f.two'] }, profiles: { Python: ['flutter'] }, triggers: { flutter: [MATCHES] } } as Partial<GroupsConfig>);
			await api.checkSync();
			assert.strictEqual(seen.ask.length, 1);
			assert.ok(seen.ask[0].message.includes('Python') && seen.ask[0].message.includes('2'), seen.ask[0].message);
			assert.ok(seen.ask[0].message.includes('flutter'), 'it should name the group this workspace matched: ' + seen.ask[0].message);
		});

		test('a group whose trigger does not match is not offered, and no CLI is even started', async () => {
			writeGroups({ groups: { flutter: ['f.one'] }, profiles: { Python: ['flutter'] }, triggers: { flutter: [NO_MATCH] } } as Partial<GroupsConfig>);
			await api.checkSync();
			assert.strictEqual(seen.ask.length, 0);
			assert.deepStrictEqual(calls(), []);
		});

		test('only the groups this workspace needs are counted and installed', async () => {
			writeGroups({
				groups: { py: ['p.installed', 'p.new'], flutter: ['f.one'] },
				profiles: { Python: ['py', 'flutter'] },
				triggers: { flutter: [NO_MATCH] },
			} as Partial<GroupsConfig>);
			answer({ ask: () => 'Sync' });
			await api.checkSync();
			assert.ok(seen.ask[0].message.includes('1 extension'), seen.ask[0].message);
			assert.deepStrictEqual(installs(), [['--install-extension', 'p.new', '--profile', 'Python']]);
			assert.ok(!readState().Python.includes('f.one'));
		});

		test('autoSync "auto" installs only what this workspace needs', async () => {
			await set('autoSync', 'auto');
			writeGroups({
				groups: { flutter: ['f.one'], other: ['o.one'] },
				profiles: { Python: ['flutter', 'other'] },
				triggers: { flutter: [MATCHES], other: [NO_MATCH] },
			} as Partial<GroupsConfig>);
			await api.checkSync();
			assert.strictEqual(seen.ask.length, 0);
			assert.deepStrictEqual(installs().map(a => a[1]), ['f.one']);
		});

		test('an explicit sync installs every group of the profile, triggers or not', async () => {
			writeGroups({
				groups: { py: ['p.new'], flutter: ['f.one'] },
				profiles: { Python: ['py', 'flutter'] },
				triggers: { flutter: [NO_MATCH] },
			} as Partial<GroupsConfig>);
			const report = await sync({ profile: 'Python' });
			assert.deepStrictEqual(report.plan.toInstall.sort(), ['f.one', 'p.new']);
		});

		test('cleanup never offers the extensions of a group this workspace does not currently need', async () => {
			writeState({ Default: [], Python: ['p.installed', 'f.installed', 'extra.a'], Agents: [] });
			writeGroups({
				groups: { py: ['p.installed'], flutter: ['f.installed'] },
				profiles: { Python: ['py', 'flutter'] },
				triggers: { flutter: [NO_MATCH] },
			} as Partial<GroupsConfig>);
			await sync({ profile: 'Python', confirm: true, uninstall: 'ask' });
			assert.deepStrictEqual(seen.pickMany[0].items.map(i => i.id), ['extra.a']);
		});
	});


	suite('the gear menu of an extension in the Extensions view', () => {
		const ADD = 'better-profiles.extensionAddToGroup';
		const REMOVE = 'better-profiles.extensionRemoveFromGroup';
		const INSTALL = 'better-profiles.extensionInstallInProfiles';
		const ALL = [ADD, REMOVE, INSTALL];
		// what VS Code passes to a command from the extension/context menu: the id, then an object about the extension
		const fromMenu = (id: string) => [id, { id, version: '1.0.0', location: undefined, galleryLink: undefined }] as const;

		interface InstallReport { id: string; results: { profile: string; ok: boolean; message: string }[]; alreadyHad: string[] }

		setup(async () => {
			api = await vscode.extensions.getExtension(EXTENSION_ID)!.activate();
			await api.resetPrompts();
			writeState({ Default: ['common.one'], Python: ['p.installed'], Agents: [] });
			answer({});
		});
		teardown(() => restoreUi());

		suite('contributions', () => {
			const contributes = () => vscode.extensions.getExtension(EXTENSION_ID)!.packageJSON.contributes;

			test('three entries in the extension/context menu, only for installed extensions that are not built in', () => {
				const entries: { command: string; when: string; group: string }[] = contributes().menus?.['extension/context'] ?? [];
				assert.deepStrictEqual(entries.map(e => e.command).sort(), [...ALL].sort());
				for (const e of entries) {
					assert.ok(e.when.includes('extensionStatus == installed'), e.when);
					assert.ok(e.when.includes('!isBuiltinExtension'), e.when);
					assert.ok(e.group.startsWith('2_profiles'), e.group);
				}
			});

			test('they are declared and registered, and kept out of the Command Palette because they need an extension to act on', async () => {
				const declared = (contributes().commands as { command: string }[]).map(c => c.command);
				const registered = new Set(await vscode.commands.getCommands(true));
				const palette: { command: string; when: string }[] = contributes().menus?.commandPalette ?? [];
				for (const id of ALL) {
					assert.ok(declared.includes(id), 'declared ' + id);
					assert.ok(registered.has(id), 'registered ' + id);
					assert.ok(palette.some(p => p.command === id && p.when === 'false'), 'hidden from the palette: ' + id);
				}
			});
		});

		suite('Add to group', () => {
			setup(() => writeGroups({ groups: { web: ['a.b'] }, profiles: { Python: ['web'] }, triggers: { web: ['**/package.json'] } } as Partial<GroupsConfig>));

			test('asks which group (or a new one) and adds the extension the menu was opened for', async () => {
				answer({ pickOne: () => 'web' });
				await exec(ADD, ...fromMenu('x.new'));
				assert.strictEqual(seen.pickOne.length, 1);
				assert.ok(seen.pickOne[0].title.includes('x.new'), seen.pickOne[0].title);
				assert.deepStrictEqual(seen.pickOne[0].items.map(i => i.id), ['web']);
				assert.ok(seen.pickOne[0].options?.newItem, 'it should offer to start a new group');
				assert.deepStrictEqual(readGroups().groups.web, ['a.b', 'x.new']);
			});

			test('keeps the profiles and the triggers of the file', async () => {
				answer({ pickOne: () => 'web' });
				await exec(ADD, ...fromMenu('x.new'));
				const file = readGroups() as GroupsConfig;
				assert.deepStrictEqual(file.profiles, { Python: ['web'] });
				assert.deepStrictEqual(file.triggers, { web: ['**/package.json'] });
			});

			test('a typed name starts a new group', async () => {
				answer({ pickOne: () => 'brand-new' });
				await exec(ADD, ...fromMenu('x.new'));
				assert.deepStrictEqual(readGroups().groups['brand-new'], ['x.new']);
			});

			test('an extension that is already in the group is not added twice, whatever the case', async () => {
				answer({ pickOne: () => 'web' });
				await exec(ADD, ...fromMenu('A.B'));
				assert.deepStrictEqual(readGroups().groups.web, ['a.b']);
			});

			test('cancelling changes nothing', async () => {
				const before = fs.readFileSync(groupsFile, 'utf8');
				answer({ pickOne: () => undefined });
				await exec(ADD, ...fromMenu('x.new'));
				assert.strictEqual(fs.readFileSync(groupsFile, 'utf8'), before);
			});

			test('something that is not an extension id is refused before anything is asked', async () => {
				await assert.rejects(exec(ADD, '--evil'), /extension id/i);
				assert.strictEqual(seen.pickOne.length, 0);
			});

			test('programmatic: an object with the group needs no prompt', async () => {
				await exec(ADD, { id: 'x.new', group: 'web' });
				assert.strictEqual(seen.pickOne.length, 0);
				assert.deepStrictEqual(readGroups().groups.web, ['a.b', 'x.new']);
			});
		});

		suite('Remove from group', () => {
			setup(() => writeGroups({
				groups: { web: ['a.b', 'x.one'], tools: ['X.One'], other: ['o.one'] },
				profiles: { Python: ['web'] },
				triggers: { web: ['**/package.json'] },
			} as Partial<GroupsConfig>));

			test('offers only the groups that hold the extension, and removes it from the ticked ones', async () => {
				answer({ pickMany: () => ['tools'] });
				await exec(REMOVE, ...fromMenu('x.one'));
				assert.deepStrictEqual(seen.pickMany[0].items.map(i => i.id), ['web', 'tools']);
				assert.ok(seen.pickMany[0].title.includes('x.one'), seen.pickMany[0].title);
				const file = readGroups() as GroupsConfig;
				assert.deepStrictEqual(file.groups, { web: ['a.b', 'x.one'], tools: [], other: ['o.one'] });
				assert.deepStrictEqual(file.profiles, { Python: ['web'] });
				assert.deepStrictEqual(file.triggers, { web: ['**/package.json'] });
			});

			test('never runs a CLI: taking an extension out of a group uninstalls nothing', async () => {
				answer({ pickMany: () => ['web', 'tools'] });
				await exec(REMOVE, ...fromMenu('x.one'));
				assert.deepStrictEqual(calls(), []);
			});

			test('an extension that is in no group changes nothing and asks nothing', async () => {
				const before = fs.readFileSync(groupsFile, 'utf8');
				await exec(REMOVE, ...fromMenu('z.nowhere'));
				assert.strictEqual(seen.pickMany.length, 0);
				assert.strictEqual(fs.readFileSync(groupsFile, 'utf8'), before);
			});

			test('cancelling, or ticking nothing, changes nothing', async () => {
				const before = fs.readFileSync(groupsFile, 'utf8');
				answer({ pickMany: () => undefined });
				await exec(REMOVE, ...fromMenu('x.one'));
				answer({ pickMany: () => [] });
				await exec(REMOVE, ...fromMenu('x.one'));
				assert.strictEqual(fs.readFileSync(groupsFile, 'utf8'), before);
			});

			test('programmatic: named groups need no prompt, and a group that does not hold it is refused', async () => {
				await exec(REMOVE, { id: 'x.one', groups: ['web'] });
				assert.strictEqual(seen.pickMany.length, 0);
				assert.deepStrictEqual(readGroups().groups.web, ['a.b']);
				await assert.rejects(exec(REMOVE, { id: 'x.one', groups: ['other'] }), /not in the group/i);
			});
		});

		suite('Install in other profiles', () => {
			setup(() => writeGroups({ groups: {} }));

			test('offers the profiles that lack the extension, nothing ticked, and installs into the ticked ones only', async () => {
				answer({ pickMany: () => ['Python'] });
				const report = await exec<InstallReport>(INSTALL, ...fromMenu('x.new'));
				assert.deepStrictEqual(seen.pickMany[0].items.map(i => i.id), ['Default', 'Python', 'Agents']);
				assert.ok(seen.pickMany[0].title.includes('x.new'), seen.pickMany[0].title);
				assert.ok(seen.pickMany[0].items.every(i => !('picked' in i)), 'nothing is pre-selected');
				assert.deepStrictEqual(installs(), [['--install-extension', 'x.new', '--profile', 'Python']]);
				assert.deepStrictEqual(report.results.map(r => [r.profile, r.ok]), [['Python', true]]);
				assert.ok(readState().Python.includes('x.new'));
				assert.ok(!readState().Default.includes('x.new') && !readState().Agents.includes('x.new'));
			});

			test('does not offer a profile that already has it', async () => {
				writeState({ Default: ['common.one'], Python: ['X.New'], Agents: [] });
				await exec(INSTALL, ...fromMenu('x.new'));
				assert.deepStrictEqual(seen.pickMany[0].items.map(i => i.id), ['Default', 'Agents']);
			});

			test('an extension every profile has (application scoped) asks nothing and installs nothing', async () => {
				writeState({ Default: ['shared.x'], Python: ['shared.x'], Agents: ['shared.x'] });
				const report = await exec<InstallReport>(INSTALL, ...fromMenu('shared.x'));
				assert.strictEqual(seen.pickMany.length, 0);
				assert.deepStrictEqual(installs(), []);
				assert.deepStrictEqual(report.alreadyHad.sort(), ['Agents', 'Default', 'Python']);
			});

			test('cancelling, or ticking nothing, installs nothing', async () => {
				answer({ pickMany: () => undefined });
				await exec(INSTALL, ...fromMenu('x.new'));
				answer({ pickMany: () => [] });
				await exec(INSTALL, ...fromMenu('x.new'));
				assert.deepStrictEqual(installs(), []);
			});

			test('never uninstalls anything', async () => {
				answer({ pickMany: () => ['Python', 'Agents'] });
				await exec(INSTALL, ...fromMenu('x.new'));
				assert.ok(calls().every(a => !a.some(x => /uninstall|remove|disable/i.test(x))));
			});

			test('programmatic: named profiles need no prompt, and Default is installed into without --profile', async () => {
				await exec(INSTALL, { id: 'x.new', profiles: ['Default', 'Agents'] });
				assert.strictEqual(seen.pickMany.length, 0);
				assert.deepStrictEqual(installs(), [['--install-extension', 'x.new'], ['--install-extension', 'x.new', '--profile', 'Agents']]);
			});

			test('programmatic: a profile that already has it is skipped and reported', async () => {
				writeState({ Default: [], Python: ['x.new'], Agents: [] });
				const report = await exec<InstallReport>(INSTALL, { id: 'x.new', profiles: ['Python', 'Agents'] });
				assert.deepStrictEqual(installs(), [['--install-extension', 'x.new', '--profile', 'Agents']]);
				assert.deepStrictEqual(report.alreadyHad, ['Python']);
			});

			test('programmatic: an unknown profile is refused before anything runs', async () => {
				await assert.rejects(exec(INSTALL, { id: 'x.new', profiles: ['Nope'] }), /Nope/);
				assert.deepStrictEqual(calls(), []);
			});

			test('something that is not an extension id is refused before any CLI starts', async () => {
				await assert.rejects(exec(INSTALL, '--evil'), /extension id/i);
				await assert.rejects(exec(INSTALL, '../x.vsix'), /extension id/i);
				assert.deepStrictEqual(calls(), []);
			});

			test('a failed install is reported per profile and the others still run', async () => {
				const report = await exec<InstallReport>(INSTALL, { id: 'fail.ext', profiles: ['Python', 'Agents'] });
				assert.deepStrictEqual(report.results.map(r => [r.profile, r.ok]), [['Python', false], ['Agents', false]]);
				assert.ok(report.results[0].message.includes("'fail.ext' not found"), report.results[0].message);
				assert.strictEqual(installs().length, 2, 'it must have tried both');
			});
		});
	});

});
