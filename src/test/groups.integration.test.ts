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
		for (const key of ['storageFile', 'groupsFile', 'codeCommand', 'codeArgs', 'autoSync', 'keepExtensions', 'extensionsDir']) {
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
			for (const key of ['groupsFile', 'codeCommand', 'codeArgs', 'autoSync', 'keepExtensions', 'extensionsDir']) {
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
		pickMany?: (title: string, items: PickItem[], options?: { newItem?: { label: string; prompt: string } }) => string[] | undefined;
		confirm?: (message: string, detail: string, action: string) => boolean;
	}

	let api: BetterProfilesApi;
	let restoreUi: () => void = () => { };
	const seen = { pickOne: [] as { title: string; items: PickItem[]; options?: { newItem?: { label: string; prompt: string } } }[], ask: [] as { message: string; buttons: string[] }[], pickMany: [] as { title: string; items: PickItem[]; options?: { newItem?: { label: string; prompt: string } } }[], confirm: [] as { message: string; detail: string; action: string }[] };

	/** Answers the extension's questions from a script; anything unscripted is declined. */
	function answer(script: Script) {
		seen.ask.length = seen.pickOne.length = seen.pickMany.length = seen.confirm.length = 0;
		const original = { ask: api.ui.ask, pickOne: api.ui.pickOne, pickMany: api.ui.pickMany, confirm: api.ui.confirm };
		api.ui.ask = async (message, ...buttons) => { seen.ask.push({ message, buttons }); return script.ask?.(message, buttons); };
		api.ui.pickOne = async (title, items, options) => { seen.pickOne.push({ title, items, options }); return script.pickOne?.(title, items, options); };
		api.ui.pickMany = async (title, items, options) => { seen.pickMany.push({ title, items, options }); return script.pickMany?.(title, items, options); };
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
			// a settings write can take a moment to show up in a fresh read
			for (let i = 0; i < 60 && config().get('autoSync') !== 'off'; i++) {
				await new Promise(resolve => setTimeout(resolve, 50));
			}
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

			test('their titles start with the [Better Profiles] tag and have no trailing ellipsis, so they can be told apart in a menu full of other extensions\' entries', () => {
				const commands: { command: string; title: string }[] = contributes().commands;
				for (const id of ALL) {
					const title = commands.find(c => c.command === id)!.title;
					assert.ok(title.startsWith('[Better Profiles] '), title);
					assert.ok(!/(…|\.\.\.)$/.test(title), 'no trailing ellipsis: ' + title);
				}
			});

			test('no command title of the extension ends with an ellipsis', () => {
				const titles: string[] = contributes().commands.map((c: { title: string }) => c.title);
				assert.deepStrictEqual(titles.filter(title => /(…|\.\.\.)$/.test(title)), []);
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
			setup(() => writeGroups({ groups: { web: ['a.b'], tools: ['c.d'] }, profiles: { Python: ['web'] }, triggers: { web: ['**/package.json'] } } as Partial<GroupsConfig>));

			test('is a multiple-select list of the groups, with nothing ticked and a way to start a new one', async () => {
				answer({ pickMany: () => ['web'] });
				await exec(ADD, ...fromMenu('x.new'));
				assert.strictEqual(seen.pickMany.length, 1);
				assert.strictEqual(seen.pickOne.length, 0, 'it is no longer a single choice');
				assert.ok(seen.pickMany[0].title.includes('x.new'), seen.pickMany[0].title);
				assert.deepStrictEqual(seen.pickMany[0].items.map(i => i.id), ['web', 'tools']);
				assert.ok(seen.pickMany[0].items.every(i => !('picked' in i)), 'nothing is ticked beforehand');
				assert.ok(seen.pickMany[0].options?.newItem, 'it should offer to start a new group');
				assert.deepStrictEqual(readGroups().groups.web, ['a.b', 'x.new']);
				assert.deepStrictEqual(readGroups().groups.tools, ['c.d'], 'a group that was not ticked is untouched');
			});

			test('adds the extension to every ticked group in one go', async () => {
				answer({ pickMany: () => ['web', 'tools'] });
				await exec(ADD, ...fromMenu('x.new'));
				assert.deepStrictEqual(readGroups().groups, { web: ['a.b', 'x.new'], tools: ['c.d', 'x.new'] });
			});

			test('a typed name next to ticked groups starts a new group as well', async () => {
				answer({ pickMany: () => ['web', 'brand-new'] });
				await exec(ADD, ...fromMenu('x.new'));
				const groups = readGroups().groups;
				assert.deepStrictEqual(groups.web, ['a.b', 'x.new']);
				assert.deepStrictEqual(groups['brand-new'], ['x.new']);
				assert.deepStrictEqual(groups.tools, ['c.d']);
			});

			test('keeps the profiles and the triggers of the file', async () => {
				answer({ pickMany: () => ['web', 'tools'] });
				await exec(ADD, ...fromMenu('x.new'));
				const file = readGroups() as GroupsConfig;
				assert.deepStrictEqual(file.profiles, { Python: ['web'] });
				assert.deepStrictEqual(file.triggers, { web: ['**/package.json'] });
			});

			test('a group that already holds the extension is not added to twice, whatever the case', async () => {
				answer({ pickMany: () => ['web', 'tools'] });
				await exec(ADD, ...fromMenu('A.B'));
				assert.deepStrictEqual(readGroups().groups.web, ['a.b']);
				assert.deepStrictEqual(readGroups().groups.tools, ['c.d', 'A.B']);
			});

			test('cancelling, or ticking nothing, changes nothing', async () => {
				const before = fs.readFileSync(groupsFile, 'utf8');
				answer({ pickMany: () => undefined });
				await exec(ADD, ...fromMenu('x.new'));
				answer({ pickMany: () => [] });
				await exec(ADD, ...fromMenu('x.new'));
				assert.strictEqual(fs.readFileSync(groupsFile, 'utf8'), before);
			});

			test('something that is not an extension id is refused before anything is asked', async () => {
				await assert.rejects(exec(ADD, '--evil'), /extension id/i);
				assert.strictEqual(seen.pickMany.length + seen.pickOne.length, 0);
			});

			test('programmatic: "group" or "groups" in an object needs no prompt', async () => {
				await exec(ADD, { id: 'x.new', group: 'web' });
				await exec(ADD, { id: 'y.new', groups: ['web', 'tools'] });
				assert.strictEqual(seen.pickMany.length + seen.pickOne.length, 0);
				assert.deepStrictEqual(readGroups().groups, { web: ['a.b', 'x.new', 'y.new'], tools: ['c.d', 'y.new'] });
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


	suite('buttons on the notifications that follow a change to the groups', () => {
		const ADD_FROM_MENU = 'better-profiles.extensionAddToGroup';
		const ASSIGN = 'better-profiles.assignGroup';
		const SYNC = 'Sync Profile';
		const GIVE = 'Give Group To A Profile';
		const until = async (condition: () => boolean, ms = 3000) => {
			const end = Date.now() + ms;
			while (!condition() && Date.now() < end) {
				await new Promise(resolve => setTimeout(resolve, 25));
			}
			return condition();
		};

		setup(async () => {
			api = await vscode.extensions.getExtension(EXTENSION_ID)!.activate();
			writeState({ Default: [], Python: [], Agents: [] });
			writeGroups({ groups: { web: ['a.b'] }, profiles: { Python: ['web'] } });
			answer({});
		});
		teardown(() => restoreUi());

		test('after adding to a group that a profile follows, the notification offers to sync (instead of telling you to run a command)', async () => {
			await exec(ADD_FROM_MENU, { id: 'x.new', group: 'web' });
			assert.ok(await until(() => seen.ask.length > 0), 'a notification should have been shown');
			assert.ok(seen.ask[0].message.includes('x.new') && seen.ask[0].message.includes('web'), seen.ask[0].message);
			assert.ok(!seen.ask[0].message.includes('Run "Sync'), 'the instruction text is replaced by a button: ' + seen.ask[0].message);
			assert.deepStrictEqual(seen.ask[0].buttons, [SYNC]);
		});

		test('after adding to a group that no profile follows, syncing would do nothing, so it offers to give the group to a profile', async () => {
			writeGroups({ groups: { web: ['a.b'], lonely: [] } });
			await exec(ADD_FROM_MENU, { id: 'x.new', group: 'lonely' });
			assert.ok(await until(() => seen.ask.length > 0));
			assert.deepStrictEqual(seen.ask[0].buttons, [GIVE]);
		});

		test('with several groups, syncing is offered if any of them is followed by a profile', async () => {
			writeGroups({ groups: { web: ['a.b'], lonely: [] }, profiles: { Python: ['web'] } });
			await exec(ADD_FROM_MENU, { id: 'x.new', groups: ['web', 'lonely'] });
			assert.ok(await until(() => seen.ask.length > 0));
			assert.deepStrictEqual(seen.ask[0].buttons, [SYNC]);
			assert.ok(seen.ask[0].message.includes('web') && seen.ask[0].message.includes('lonely'), seen.ask[0].message);
		});

		test('with several groups that no profile follows, it offers to give them to a profile', async () => {
			writeGroups({ groups: { web: ['a.b'], lonely: [], lonelier: [] } });
			await exec(ADD_FROM_MENU, { id: 'x.new', groups: ['lonely', 'lonelier'] });
			assert.ok(await until(() => seen.ask.length > 0));
			assert.deepStrictEqual(seen.ask[0].buttons, [GIVE]);
		});

		test('a group given to every profile ("*") counts as followed', async () => {
			writeGroups({ groups: { web: ['a.b'] }, profiles: { '*': ['web'] } });
			await exec(ADD_FROM_MENU, { id: 'x.new', group: 'web' });
			assert.ok(await until(() => seen.ask.length > 0));
			assert.deepStrictEqual(seen.ask[0].buttons, [SYNC]);
		});

		test('clicking "Sync Profile" starts the sync flow, which asks which profile', async () => {
			answer({ ask: () => SYNC, pickOne: () => undefined });
			await exec(ADD_FROM_MENU, { id: 'x.new', group: 'web' });
			assert.ok(await until(() => seen.pickOne.some(p => p.title === 'Sync which profile with its groups?')), 'the sync flow should have started');
		});

		test('clicking "Give Group To A Profile" asks which profile, for that group, and gives it', async () => {
			writeGroups({ groups: { web: ['a.b'], lonely: ['c.d'] } });
			answer({ ask: () => GIVE, pickOne: title => (title === 'Give a group to which profile?' ? 'Python' : undefined) });
			await exec(ADD_FROM_MENU, { id: 'x.new', group: 'lonely' });
			assert.ok(await until(() => (readGroups().profiles?.Python ?? []).includes('lonely')), 'the group should now be given to Python');
			assert.ok(seen.pickOne.every(p => p.title !== 'Which group should "Python" have?'), 'it must not ask for the group again');
		});

		test('dismissing the notification does nothing more', async () => {
			answer({ ask: () => undefined });
			await exec(ADD_FROM_MENU, { id: 'x.new', group: 'web' });
			await until(() => seen.ask.length > 0);
			await new Promise(resolve => setTimeout(resolve, 300));
			assert.strictEqual(seen.pickOne.length, 0);
		});

		test('the command does not wait for the notification: it finishes while the user has not answered', async () => {
			answer({ ask: () => new Promise<string | undefined>(() => { /* the user never answers */ }) as unknown as string });
			const outcome = await Promise.race([
				exec(ADD_FROM_MENU, { id: 'x.new', group: 'web' }).then(() => 'finished'),
				new Promise(resolve => setTimeout(() => resolve('still waiting'), 3000)),
			]);
			assert.strictEqual(outcome, 'finished');
			assert.deepStrictEqual(readGroups().groups.web, ['a.b', 'x.new']);
		});

		test('after giving a group to a profile, the notification offers to sync it', async () => {
			await exec(ASSIGN, { profile: 'Agents', group: 'web' });
			assert.ok(await until(() => seen.ask.length > 0));
			assert.ok(seen.ask[0].message.includes('Agents') && seen.ask[0].message.includes('web'), seen.ask[0].message);
			assert.ok(!seen.ask[0].message.includes('Run "Sync'), seen.ask[0].message);
			assert.deepStrictEqual(seen.ask[0].buttons, [SYNC]);
		});

		test('for every profile the notification says so', async () => {
			await exec(ASSIGN, { profile: '*', group: 'web' });
			assert.ok(await until(() => seen.ask.length > 0));
			assert.ok(/all profiles/i.test(seen.ask[0].message), seen.ask[0].message);
		});

		test('the older "Add Extensions To Group" command has the same follow-up', async () => {
			await exec('better-profiles.addToGroup', { group: 'web', extensions: ['x.new'] });
			assert.ok(await until(() => seen.ask.length > 0));
			assert.deepStrictEqual(seen.ask[0].buttons, [SYNC]);
		});
	});


	suite('showing which extensions are in a group', () => {
		const ADD = 'better-profiles.extensionAddToGroup';
		const REMOVE = 'better-profiles.extensionRemoveFromGroup';
		const until = async (condition: () => boolean, ms = 3000) => {
			const end = Date.now() + ms;
			while (!condition() && Date.now() < end) {
				await new Promise(resolve => setTimeout(resolve, 25));
			}
			return condition();
		};

		// pointing the setting at a different file is a real change, so the extension reads it again
		let fileCount = 0;
		const useGroups = async (content: object | string) => {
			const file = path.join(dir, `grouped-${++fileCount}.json`);
			fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
			await set('groupsFile', file);
		};

		setup(async () => {
			api = await vscode.extensions.getExtension(EXTENSION_ID)!.activate();
			answer({});
		});
		teardown(() => restoreUi());

		test('only the "Remove from group" entry depends on the extension being in a group', () => {
			const entries: { command: string; when: string }[] = vscode.extensions.getExtension(EXTENSION_ID)!.packageJSON.contributes.menus['extension/context'];
			const whenOf = (command: string) => entries.find(e => e.command === command)!.when;
			assert.ok(whenOf(REMOVE).includes('extension in betterProfiles.groupedExtensions'), whenOf(REMOVE));
			assert.ok(!whenOf(ADD).includes('betterProfiles.groupedExtensions'), whenOf(ADD));
			assert.ok(!whenOf('better-profiles.extensionInstallInProfiles').includes('betterProfiles.groupedExtensions'));
		});

		test('the list holds every extension of every group, lower-case and once', async () => {
			await useGroups({ groups: { web: ['A.One', 'b.two'], tools: ['a.one', 'C.Three'] } });
			assert.ok(await until(() => api.groupedExtensions().length === 3), api.groupedExtensions().join(','));
			assert.deepStrictEqual([...api.groupedExtensions()].sort(), ['a.one', 'b.two', 'c.three']);
		});

		test('it follows what the commands change', async () => {
			await useGroups({ groups: { web: ['a.b'] } });
			assert.ok(await until(() => api.groupedExtensions().includes('a.b')));
			await exec(ADD, { id: 'X.New', group: 'web' });
			assert.ok(api.groupedExtensions().includes('x.new'), 'added');
			await exec(REMOVE, { id: 'X.New', groups: ['web'] });
			assert.ok(!api.groupedExtensions().includes('x.new'), 'removed');
			assert.ok(api.groupedExtensions().includes('a.b'), 'the others stay');
		});

		test('a missing or broken groups file gives an empty list and no error', async () => {
			await useGroups({ groups: { web: ['a.b'] } });
			assert.ok(await until(() => api.groupedExtensions().length === 1));
			await useGroups('{ broken');
			assert.ok(await until(() => api.groupedExtensions().length === 0), 'a broken file means nothing is grouped');
			await set('groupsFile', path.join(dir, 'does-not-exist.json'));
			assert.ok(await until(() => api.groupedExtensions().length === 0));
		});

		test('the "Add to group" picker marks the groups that already hold the extension', async () => {
			writeGroups({ groups: { web: ['x.new', 'a.b'], tools: ['c.d'] } });
			answer({ pickMany: () => undefined });
			await exec(ADD, 'X.New', { id: 'X.New' });
			const items = seen.pickMany[0].items;
			assert.ok(/already/i.test(items.find(i => i.id === 'web')!.description ?? ''), JSON.stringify(items));
			assert.ok(!/already/i.test(items.find(i => i.id === 'tools')!.description ?? ''), JSON.stringify(items));
		});
	});


	suite('the Better Profiles tab', () => {
		const GROUPS_MIME = 'application/vnd.code.tree.betterprofiles.groups';
		const PROFILES_MIME = 'application/vnd.code.tree.betterprofiles.profiles';
		// what the trees' own drags carry; VS Code keeps the "application/vnd.code.tree.<view>" types for itself
		const SOURCES_MIME = 'application/vnd.better-profiles.sources';
		const token = new vscode.CancellationTokenSource().token;
		type Node = Record<string, unknown>;
		const group = (name: string): Node => ({ kind: 'group', name });
		const groupExt = (g: string, id: string): Node => ({ kind: 'groupExtension', group: g, id });
		const profile = (name: string): Node => ({ kind: 'profile', name });
		const profileExt = (p: string, id: string): Node => ({ kind: 'profileExtension', profile: p, id });
		const profileGroup = (p: string, g: string): Node => ({ kind: 'profileGroup', profile: p, name: g });
		const profileGroupExt = (p: string, g: string, id: string): Node => ({ kind: 'profileGroupExtension', profile: p, group: g, id });
		type ViewName = 'groups' | 'profiles';
		const provider = (view: ViewName) => api.views[view].provider as vscode.TreeDataProvider<any>;
		const dnd = (view: ViewName) => api.views[view].dnd as vscode.TreeDragAndDropController<any>;
		const children = async (view: ViewName, node?: Node): Promise<Node[]> => (await provider(view).getChildren(node)) ?? [];
		const item = async (view: ViewName, node: Node) => provider(view).getTreeItem(node) as vscode.TreeItem;
		const label = (i: vscode.TreeItem) => (typeof i.label === 'string' ? i.label : i.label?.label);
		const drag = async (view: ViewName, nodes: Node[]) => {
			const transfer = new vscode.DataTransfer();
			await dnd(view).handleDrag?.(nodes, transfer, token);
			return transfer;
		};
		const drop = (view: ViewName, target: Node | undefined, transfer: vscode.DataTransfer) => dnd(view).handleDrop?.(target, transfer, token);
		const until = async (condition: () => boolean, ms = 3000) => {
			const end = Date.now() + ms;
			while (!condition() && Date.now() < end) {
				await new Promise(resolve => setTimeout(resolve, 25));
			}
			return condition();
		};

		setup(async () => {
			api = await vscode.extensions.getExtension(EXTENSION_ID)!.activate();
			api.views.profiles.refresh(); // the Profiles tree keeps its lists until refreshed, so every test starts from empty
			writeState({ Default: ['common.one'], Python: ['p.installed', 'shared.x'], Agents: ['shared.x'] });
			writeGroups({ groups: { web: ['a.b', 'c.d'], tools: ['x.y'], empty: [] }, profiles: { Python: ['web'], '*': ['tools'] } });
			answer({});
		});
		teardown(() => restoreUi());

		suite('contributions', () => {
			const contributes = () => vscode.extensions.getExtension(EXTENSION_ID)!.packageJSON.contributes;
			const VIEW_COMMANDS = ['refresh', 'newGroup', 'deleteGroup', 'removeFromGroup', 'syncProfile', 'setTriggers', 'assignGroup'].map(c => `better-profiles.view.${c}`);

			test('an activity bar container called Better Profiles with a Groups and a Profiles view', () => {
				const containers: { id: string; title: string; icon: string }[] = contributes().viewsContainers?.activitybar ?? [];
				const container = containers.find(c => c.title === 'Better Profiles');
				assert.ok(container, JSON.stringify(containers));
				assert.ok(fs.existsSync(path.resolve(__dirname, '../..', container!.icon)), 'the icon file must exist: ' + container!.icon);
				const views: { id: string }[] = contributes().views?.[container!.id] ?? [];
				assert.deepStrictEqual(views.map(v => v.id), ['betterProfiles.groups', 'betterProfiles.profiles']);
			});

			test('the commands used by the trees are declared, registered, and kept out of the Command Palette', async () => {
				const declared = (contributes().commands as { command: string }[]).map(c => c.command);
				const registered = new Set(await vscode.commands.getCommands(true));
				const palette: { command: string; when: string }[] = contributes().menus?.commandPalette ?? [];
				for (const id of VIEW_COMMANDS) {
					assert.ok(declared.includes(id), 'declared ' + id);
					assert.ok(registered.has(id), 'registered ' + id);
					assert.ok(palette.some(p => p.command === id && p.when === 'false'), 'hidden from the palette: ' + id);
				}
			});

			test('item menus only apply to the right kind of item', () => {
				const entries: { command: string; when: string }[] = contributes().menus?.['view/item/context'] ?? [];
				const whenOf = (command: string) => entries.find(e => e.command === command)?.when ?? '';
				assert.ok(whenOf('better-profiles.view.deleteGroup').includes('viewItem == group'));
				assert.ok(whenOf('better-profiles.view.removeFromGroup').includes('viewItem == groupExtension'));
				assert.ok(whenOf('better-profiles.view.syncProfile').includes('viewItem == profile'));
			});
		});

		suite('the Groups tree', () => {
			test('lists the groups, how many extensions each has and which profiles follow it', async () => {
				const roots = await children('groups');
				assert.deepStrictEqual(roots.map(n => n.name), ['web', 'tools', 'empty']);
				const [web, tools, empty] = await Promise.all(roots.map(n => item('groups', n)));
				assert.ok(String(web.description).includes('2 extensions') && String(web.description).includes('Python'), String(web.description));
				assert.ok(String(tools.description).includes('1 extension') && /all profiles/i.test(String(tools.description)), String(tools.description));
				assert.ok(String(empty.description).includes('0 extensions'), String(empty.description));
				assert.strictEqual(web.contextValue, 'group');
			});

			test('a group lists its extensions', async () => {
				const kids = await children('groups', group('web'));
				assert.deepStrictEqual(kids, [groupExt('web', 'a.b'), groupExt('web', 'c.d')]);
				const i = await item('groups', kids[0]);
				assert.strictEqual(label(i), 'a.b');
				assert.strictEqual(i.contextValue, 'groupExtension');
			});

			test('no groups file means no items (the welcome text shows instead)', async () => {
				fs.rmSync(groupsFile);
				assert.deepStrictEqual(await children('groups'), []);
			});

			test('a broken groups file is reported as an item, not an error', async () => {
				fs.writeFileSync(groupsFile, '{ broken');
				const roots = await children('groups');
				assert.strictEqual(roots.length, 1);
				assert.strictEqual(roots[0].kind, 'message');
				assert.ok(/groups file/i.test(String(roots[0].text)), String(roots[0].text));
			});

			test('it refreshes when a command changes the groups', async () => {
				let fired = 0;
				const subscription = provider('groups').onDidChangeTreeData?.(() => fired++);
				await exec('better-profiles.addToGroup', { group: 'web', extensions: ['z.new'] });
				assert.ok(await until(() => fired > 0), 'the tree should have been told to refresh');
				subscription?.dispose();
			});
		});

		suite('the Profiles tree', () => {
			test('lists Default and every profile, and marks the one of this window', async () => {
				const roots = await children('profiles');
				assert.deepStrictEqual(roots.map(n => n.name), ['Default', 'Python', 'Agents']);
				const items = await Promise.all(roots.map(n => item('profiles', n)));
				assert.ok(String(items[1].description).includes('current'), String(items[1].description));
				assert.ok(!String(items[0].description ?? '').includes('current'));
				assert.strictEqual(items[0].contextValue, 'profile');
			});

			test('a profile shows its own icon when it has one, and the generic icon otherwise', async () => {
				const iconId = async (name: string) => ((await item('profiles', profile(name))).iconPath as vscode.ThemeIcon).id;
				assert.strictEqual(await iconId('Python'), 'snake');
				assert.strictEqual(await iconId('Agents'), 'account', 'no icon of its own');
				assert.strictEqual(await iconId('Default'), 'account');
			});

			test('an icon that is not a valid codicon id falls back to the generic one', async () => {
				const storage = path.join(dir, 'odd-icon.json');
				fs.writeFileSync(storage, JSON.stringify({ userDataProfiles: [{ name: 'Odd', location: 'odd', icon: 'not a codicon!' }], profileAssociations: { workspaces: {} } }));
				await set('storageFile', storage);
				assert.strictEqual(((await item('profiles', profile('Odd'))).iconPath as vscode.ThemeIcon).id, 'account');
			});

			test('a profile lists the groups it follows first, then the extensions that are in none of them, sorted', async () => {
				const kids = await children('profiles', profile('Python'));
				assert.deepStrictEqual(kids.map(n => n.kind), ['profileGroup', 'profileGroup', 'profileExtension', 'profileExtension']);
				assert.deepStrictEqual(kids.slice(0, 2).map(n => n.name), ['tools', 'web']);
				assert.deepStrictEqual(kids.slice(2).map(n => n.id), ['p.installed', 'shared.x']);
				const i = await item('profiles', kids[2]);
				assert.strictEqual(i.contextValue, 'profileExtension');
				assert.strictEqual(i.description, '1.0.0');
			});

			test('a profile that follows no group lists only its extensions', async () => {
				writeGroups({ groups: { web: ['a.b'] }, profiles: {} });
				const kids = await children('profiles', profile('Python'));
				assert.deepStrictEqual(kids.map(n => n.kind), ['profileExtension', 'profileExtension']);
			});

			test('a group of a profile lists the extensions of the group that the profile has, and no others', async () => {
				writeState({ Default: [], Python: ['a.b', 'p.installed'], Agents: [] });
				const kids = await children('profiles', profileGroup('Python', 'web'));
				assert.deepStrictEqual(kids.map(n => [n.kind, n.profile, n.group, n.id]), [['profileGroupExtension', 'Python', 'web', 'a.b']]);
			});

			test('an extension that is in a followed group is shown there and not among the other extensions', async () => {
				writeState({ Default: [], Python: ['a.b', 'p.installed'], Agents: [] });
				const kids = await children('profiles', profile('Python'));
				assert.deepStrictEqual(kids.filter(n => n.kind === 'profileExtension').map(n => n.id), ['p.installed']);
			});

			test('a group of a profile says how many of its extensions the profile has', async () => {
				writeState({ Default: [], Python: ['a.b'], Agents: [] });
				const web = await item('profiles', profileGroup('Python', 'web'));
				assert.strictEqual(web.contextValue, 'profileGroup');
				assert.strictEqual(web.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
				assert.ok(String(web.description).includes('1 of 2'), String(web.description));
				assert.ok(String(web.tooltip).includes('c.d'), 'the tooltip should name what is missing: ' + String(web.tooltip));
			});

			test('a group of a profile that has none of its extensions cannot be opened and says so', async () => {
				const web = await item('profiles', profileGroup('Python', 'web'));
				assert.strictEqual(web.collapsibleState, vscode.TreeItemCollapsibleState.None);
				assert.ok(String(web.description).includes('0 of 2'), String(web.description));
			});

			test('a group extension of a profile shows the same icon, name and version', async () => {
				writeState({ Default: [], Python: ['aaron-bond.better-comments'], Agents: [] });
				writeGroups({ groups: { web: ['aaron-bond.better-comments'] }, profiles: { Python: ['web'] } });
				await set('extensionsDir', path.resolve(__dirname, '../../test-fixtures/extensions'));
				api.views.profiles.refresh();
				const [node] = await children('profiles', profileGroup('Python', 'web'));
				const i = await item('profiles', node);
				assert.strictEqual(label(i), 'Better Comments');
				assert.ok(i.iconPath instanceof vscode.Uri);
				assert.strictEqual(i.description, '1.0.0');
				assert.strictEqual(i.contextValue, 'profileGroupExtension');
			});

			test('a group that the file mentions for the profile but does not define is not shown', async () => {
				writeGroups({ groups: { web: ['a.b'] }, profiles: { Python: ['web', 'ghost'] } });
				const kids = await children('profiles', profile('Python'));
				assert.deepStrictEqual(kids.filter(n => n.kind === 'profileGroup').map(n => n.name), ['web']);
			});

			test('the groups and the extensions come from one list: the command line is asked once', async () => {
				const askedForPython = () => calls().filter(a => a.includes('--list-extensions') && a.includes('Python')).length;
				await children('profiles', profile('Python'));
				await children('profiles', profileGroup('Python', 'web'));
				await children('profiles', profileGroup('Python', 'tools'));
				assert.strictEqual(askedForPython(), 1);
			});

			test('the list is asked for once and cached until refresh', async () => {
				const askedForPython = () => calls().filter(a => a.includes('--list-extensions') && a.includes('Python')).length;
				await children('profiles', profile('Python'));
				await children('profiles', profile('Python'));
				assert.strictEqual(askedForPython(), 1);
				api.views.profiles.refresh();
				await children('profiles', profile('Python'));
				assert.strictEqual(askedForPython(), 2);
			});

			test('when the command line cannot be found it says so as an item, without starting anything', async () => {
				await set('codeCommand', undefined);
				await set('codeArgs', undefined);
				const kids = await children('profiles', profile('Python'));
				assert.strictEqual(kids.length, 1);
				assert.strictEqual(kids[0].kind, 'message');
				assert.ok(/extensions/i.test(String(kids[0].text)), String(kids[0].text));
				assert.deepStrictEqual(calls(), []);
			});
		});

		suite('drag and drop', () => {
			test('both trees accept drops from both trees', () => {
				for (const view of ['groups', 'profiles'] as const) {
					assert.ok(dnd(view).dragMimeTypes.includes(SOURCES_MIME), view + ' drags with the shared type');
					assert.ok(dnd(view).dropMimeTypes.includes(SOURCES_MIME), view + ' accepts the shared type');
				}
			});

			// VS Code hands a drop between two trees a list in which its own entry for the dragged tree ("{id, itemHandles}"
			// under "application/vnd.code.tree.<view>") sits next to ours; a drop inside one tree overwrites it, which hid this.
			const crossTree = async (view: ViewName, nodes: Node[], tree: string) => {
				const real = (await drag(view, nodes)).get(SOURCES_MIME)!;
				const entries: [string, vscode.DataTransferItem][] = [
					[tree, new vscode.DataTransferItem(JSON.stringify({ id: 'betterProfiles.' + view, itemHandles: ['0/0:Python/0:x'] }))],
					[SOURCES_MIME, new vscode.DataTransferItem('')],
					[SOURCES_MIME, real],
				];
				return {
					get: (mime: string) => entries.find(e => e[0] === mime)?.[1],
					forEach: (callback: (item: vscode.DataTransferItem, mime: string, self: unknown) => void) => entries.forEach(e => callback(e[1], e[0], undefined)),
					[Symbol.iterator]: () => entries[Symbol.iterator](),
				} as unknown as vscode.DataTransfer;
			};

			test('an extension dragged from the Profiles tree onto a group of the Groups tree is added, as VS Code delivers it', async () => {
				await drop('groups', group('web'), await crossTree('profiles', [profileExt('Python', 'p.installed')], PROFILES_MIME));
				assert.deepStrictEqual(readGroups().groups.web, ['a.b', 'c.d', 'p.installed']);
			});

			test('an extension of a group of a profile dragged onto a group of the Groups tree is added, as VS Code delivers it', async () => {
				await drop('groups', group('tools'), await crossTree('profiles', [profileGroupExt('Python', 'web', 'a.b')], PROFILES_MIME));
				assert.deepStrictEqual(readGroups().groups.tools, ['x.y', 'a.b']);
			});

			test('extensions dragged from the Groups tree onto a profile are installed, as VS Code delivers it', async () => {
				await drop('profiles', profile('Agents'), await crossTree('groups', [groupExt('web', 'a.b')], GROUPS_MIME));
				assert.deepStrictEqual(installs(), [['--install-extension', 'a.b', '--profile', 'Agents']]);
			});

			test('a drop that only holds VS Code\'s own entry for the dragged tree changes nothing', async () => {
				const before = fs.readFileSync(groupsFile, 'utf8');
				const transfer = new vscode.DataTransfer();
				transfer.set(PROFILES_MIME, new vscode.DataTransferItem(JSON.stringify({ id: 'betterProfiles.profiles', itemHandles: ['0/0:Python'] })));
				await drop('groups', group('web'), transfer);
				assert.strictEqual(fs.readFileSync(groupsFile, 'utf8'), before);
			});

			test('an extension of a profile dropped on a group is added to it, without running any CLI', async () => {
				const transfer = await drag('profiles', [profileExt('Python', 'p.installed')]);
				await drop('groups', group('web'), transfer);
				assert.deepStrictEqual(readGroups().groups.web, ['a.b', 'c.d', 'p.installed']);
				assert.deepStrictEqual(calls(), []);
			});

			test('an extension dragged from one group to another is copied: the first group keeps it', async () => {
				const transfer = await drag('groups', [groupExt('web', 'a.b')]);
				await drop('groups', group('tools'), transfer);
				assert.deepStrictEqual(readGroups().groups.tools, ['x.y', 'a.b']);
				assert.deepStrictEqual(readGroups().groups.web, ['a.b', 'c.d']);
			});

			test('dropping on an extension of a group counts as dropping on that group', async () => {
				const transfer = await drag('profiles', [profileExt('Python', 'p.installed')]);
				await drop('groups', groupExt('tools', 'x.y'), transfer);
				assert.deepStrictEqual(readGroups().groups.tools, ['x.y', 'p.installed']);
			});

			test('extensions of a group dropped on a profile are installed into that profile, skipping those it has', async () => {
				writeGroups({ groups: { web: ['a.b', 'p.installed'] } });
				const transfer = await drag('groups', [groupExt('web', 'a.b'), groupExt('web', 'p.installed')]);
				await drop('profiles', profile('Python'), transfer);
				assert.deepStrictEqual(installs(), [['--install-extension', 'a.b', '--profile', 'Python']]);
				assert.ok(calls().every(a => !a.some(x => /uninstall|remove|disable/i.test(x))), 'dropping never uninstalls');
				assert.deepStrictEqual(readState().Agents, ['shared.x'], 'other profiles are untouched');
			});

			test('an extension dragged out of a group of a profile counts as an extension of that profile', async () => {
				const transfer = await drag('profiles', [profileGroupExt('Python', 'web', 'a.b')]);
				await drop('groups', group('tools'), transfer);
				assert.deepStrictEqual(readGroups().groups.tools, ['x.y', 'a.b']);
				assert.deepStrictEqual(calls(), []);
			});

			test('a group of a profile can be dragged like the group, and dropped on another profile to give it', async () => {
				const transfer = await drag('profiles', [profileGroup('Python', 'web')]);
				await drop('profiles', profile('Agents'), transfer);
				assert.ok((readGroups().profiles.Agents ?? []).includes('web'));
			});

			test('dropping on a group of a profile, or on one of its extensions, counts as dropping on that profile', async () => {
				const onGroup = await drag('groups', [groupExt('web', 'a.b')]);
				await drop('profiles', profileGroup('Agents', 'tools'), onGroup);
				const onExtension = await drag('groups', [groupExt('web', 'c.d')]);
				await drop('profiles', profileGroupExt('Agents', 'tools', 'x.y'), onExtension);
				assert.deepStrictEqual(installs(), [
					['--install-extension', 'a.b', '--profile', 'Agents'],
					['--install-extension', 'c.d', '--profile', 'Agents'],
				]);
			});

			test('a group of a profile dropped on an extension of the same profile does not give it twice', async () => {
				const transfer = await drag('profiles', [profileGroup('Python', 'web')]);
				await drop('profiles', profileGroupExt('Python', 'web', 'a.b'), transfer);
				assert.deepStrictEqual(readGroups().profiles.Python, ['web']);
			});

			test('a group dropped on a profile is given to it', async () => {
				const transfer = await drag('groups', [group('web')]);
				await drop('profiles', profile('Agents'), transfer);
				assert.ok((readGroups().profiles.Agents ?? []).includes('web'));
			});

			test('dropping on empty space, or items that cannot be dragged, changes nothing', async () => {
				const before = fs.readFileSync(groupsFile, 'utf8');
				await drop('groups', undefined, await drag('profiles', [profileExt('Python', 'p.installed')]));
				const nothing = await drag('profiles', [profile('Python'), { kind: 'message', text: 'hello' }]);
				assert.strictEqual(nothing.get(SOURCES_MIME), undefined, 'profiles and messages are not draggable');
				await drop('groups', group('web'), nothing);
				assert.strictEqual(fs.readFileSync(groupsFile, 'utf8'), before);
				assert.deepStrictEqual(calls(), []);
			});

			test('a drop whose items arrive as text still works', async () => {
				const transfer = new vscode.DataTransfer();
				transfer.set(SOURCES_MIME, new vscode.DataTransferItem(JSON.stringify([{ kind: 'extension', id: 'p.installed', from: { type: 'profile', name: 'Python' } }])));
				await drop('groups', group('web'), transfer);
				assert.deepStrictEqual(readGroups().groups.web, ['a.b', 'c.d', 'p.installed']);
			});

			test('a drop with garbage in it is ignored without an error', async () => {
				const before = fs.readFileSync(groupsFile, 'utf8');
				const transfer = new vscode.DataTransfer();
				transfer.set(PROFILES_MIME, new vscode.DataTransferItem('not json at all'));
				transfer.set(SOURCES_MIME, new vscode.DataTransferItem(JSON.stringify([{ kind: 'extension', id: 5 }, { kind: 'group' }, 'x', null])));
				await drop('groups', group('web'), transfer);
				assert.strictEqual(fs.readFileSync(groupsFile, 'utf8'), before);
			});

			test('the trees refresh after a drop', async () => {
				let fired = 0;
				const subscription = provider('groups').onDidChangeTreeData?.(() => fired++);
				await drop('groups', group('web'), await drag('profiles', [profileExt('Python', 'p.installed')]));
				assert.ok(await until(() => fired > 0));
				subscription?.dispose();
			});
		});

		suite('how extensions are shown', () => {
			const FIXTURE = path.resolve(__dirname, '../../test-fixtures/extensions');
			const forget = () => { api.views.groups.refresh(); api.views.profiles.refresh(); };

			setup(async () => {
				await set('extensionsDir', FIXTURE);
				forget();
			});
			teardown(forget);

			test('a group extension shows its icon image and its display name, like the Extensions list', async () => {
				const i = await item('groups', groupExt('web', 'aaron-bond.better-comments'));
				assert.strictEqual(label(i), 'Better Comments');
				assert.ok(i.iconPath instanceof vscode.Uri, 'the icon should be the extension\'s own image');
				assert.ok((i.iconPath as vscode.Uri).fsPath.endsWith(path.join('images', 'icon.png')), String((i.iconPath as vscode.Uri).fsPath));
				assert.strictEqual(i.description, 'aaron-bond');
				assert.ok(String(i.tooltip).includes('aaron-bond.better-comments') && String(i.tooltip).includes('Improve your code commenting'), String(i.tooltip));
			});

			test('a localised display name is resolved', async () => {
				assert.strictEqual(label(await item('groups', groupExt('web', 'p.installed'))), 'Installed Thing');
			});

			test('without a display name the name is shown, and without an icon the generic extension icon', async () => {
				const i = await item('groups', groupExt('web', 'x.plain'));
				assert.strictEqual(label(i), 'plain');
				assert.ok(i.iconPath instanceof vscode.ThemeIcon);
			});

			test('an extension installed nowhere is shown by its id and says so', async () => {
				const i = await item('groups', groupExt('web', 'not.installed'));
				assert.strictEqual(label(i), 'not.installed');
				assert.strictEqual(i.description, 'not installed');
			});

			test('an extension of a profile shows the same icon and name, with the version the command line reports', async () => {
				writeState({ Default: [], Python: ['aaron-bond.better-comments'], Agents: [] });
				const [node] = (await children('profiles', profile('Python'))).filter(n => n.kind === 'profileExtension');
				const i = await item('profiles', node);
				assert.strictEqual(label(i), 'Better Comments');
				assert.ok(i.iconPath instanceof vscode.Uri);
				assert.strictEqual(i.description, '1.0.0');
			});

			test('a version with a platform finds its platform-specific folder', async () => {
				const i = await item('profiles', { kind: 'profileExtension', profile: 'Python', id: 'y.native', version: '1.2.3@linux-x64' });
				assert.strictEqual(label(i), 'Native Thing');
			});

			test('Refresh makes it look at the extensions folder again', async () => {
				const dynamic = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-ext-'));
				try {
					await set('extensionsDir', dynamic);
					forget();
					assert.strictEqual(label(await item('groups', groupExt('web', 'late.comer'))), 'late.comer');
					fs.mkdirSync(path.join(dynamic, 'late.comer-1.0.0'));
					fs.writeFileSync(path.join(dynamic, 'late.comer-1.0.0', 'package.json'), JSON.stringify({ name: 'late-comer', displayName: 'Late Comer', publisher: 'late', version: '1.0.0' }));
					forget();
					assert.strictEqual(label(await item('groups', groupExt('web', 'late.comer'))), 'Late Comer');
				} finally {
					fs.rmSync(dynamic, { recursive: true, force: true });
				}
			});

			test('with no extensions folder to read, everything is still shown by its id', async () => {
				await set('extensionsDir', undefined);
				forget();
				const i = await item('groups', groupExt('web', 'aaron-bond.better-comments'));
				assert.strictEqual(label(i), 'aaron-bond.better-comments');
				assert.ok(i.iconPath instanceof vscode.ThemeIcon);
			});
		});

		suite('commands on the trees', () => {
			test('New Group creates an empty group, and leaves an existing one alone', async () => {
				await exec('better-profiles.view.newGroup', { name: 'fresh' });
				assert.deepStrictEqual(readGroups().groups.fresh, []);
				await exec('better-profiles.view.newGroup', { name: 'web' });
				assert.deepStrictEqual(readGroups().groups.web, ['a.b', 'c.d']);
			});

			test('Remove From Group takes the extension out of that group only, and uninstalls nothing', async () => {
				await exec('better-profiles.view.removeFromGroup', groupExt('web', 'a.b'));
				assert.deepStrictEqual(readGroups().groups.web, ['c.d']);
				assert.deepStrictEqual(calls(), []);
			});

			test('Delete Group asks first, and then removes the group and every mention of it', async () => {
				answer({ confirm: () => true });
				await exec('better-profiles.view.deleteGroup', group('web'));
				assert.ok(/web/.test(seen.confirm[0].message) && /Python/.test(seen.confirm[0].detail), seen.confirm[0].message + ' | ' + seen.confirm[0].detail);
				const file = readGroups() as GroupsConfig;
				assert.ok(!('web' in file.groups));
				assert.ok(!('Python' in file.profiles));
			});

			test('declining Delete Group changes nothing', async () => {
				const before = fs.readFileSync(groupsFile, 'utf8');
				answer({ confirm: () => false });
				await exec('better-profiles.view.deleteGroup', group('web'));
				assert.strictEqual(fs.readFileSync(groupsFile, 'utf8'), before);
			});

			test('Sync Profile on a profile starts the sync for that profile', async () => {
				answer({ confirm: () => false });
				await exec('better-profiles.view.syncProfile', profile('Python'));
				assert.strictEqual(seen.confirm.length, 1, 'a.b and c.d are missing from Python, so it should ask before installing');
				assert.ok(seen.confirm[0].message.includes('Python'), seen.confirm[0].message);
			});
		});
	});

});
