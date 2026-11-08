import * as assert from 'assert';
import * as fs from 'fs';
import { EXT, SELF, Session, captureOnFailure, idOf, startSession } from './session';
import { waitFor } from './ui';

const a = idOf(EXT.alpha), b = idOf(EXT.beta), g = idOf(EXT.gamma), o = idOf(EXT.other), base = idOf(EXT.base), dep = idOf(EXT.dependant);

suite('e2e: removing from a profile', function () {
	this.timeout(180_000);
	let s: Session;

	suiteSetup(async function () {
		this.timeout(400_000);
		s = await startSession('remove', {
			profiles: ['Python', 'Agents'],
			groups: { groups: {}, profiles: {} },
		});
	});
	suiteTeardown(async () => s?.stop());
	teardown(async function () {
		await captureOnFailure(s, this.currentTest);
		await s?.ui.tidy();
	});

	/** The state a test starts from: what the profiles have, and the groups file; then the trees read it. */
	async function arrange(options: { python: typeof EXT[keyof typeof EXT][]; agents?: typeof EXT[keyof typeof EXT][]; groups: Record<string, string[]>; follows: Record<string, string[]>; excludes?: Record<string, string[]> }): Promise<void> {
		await s.setFixtures('Python', options.python);
		await s.setFixtures('Agents', options.agents ?? []);
		s.sandbox.writeGroups({ groups: options.groups, profiles: options.follows, ...(options.excludes ? { excludes: options.excludes } : {}) });
		await s.refresh();
		await s.ui.expand('PROFILES', 'Python');
		await s.ui.settled();
	}

	test('an extension is taken out of a profile only: the question, then the tree at once, then the command line', async () => {
		await arrange({ python: [EXT.alpha, EXT.beta], agents: [EXT.beta], groups: { tools: [a, b] }, follows: { Python: ['tools'], Agents: ['tools'] } });
		await s.ui.expand('PROFILES', 'tools');
		const dialog = await s.ui.pressRowButtonForDialog('PROFILES', 'Beta Tool', 'Remove From Profile');
		assert.ok(dialog.message.includes(b) && dialog.message.includes('Python'), dialog.message);
		assert.ok(/stays in its group/i.test(dialog.detail), dialog.detail);

		await s.ui.pressDialogButton('Uninstall');
		await s.ui.waitForNoRow('PROFILES', 'Beta Tool', { timeoutMs: 20_000 });
		await waitFor('the command line to be done', async () => !(await s.fixtures('Python')).includes(b), { timeoutMs: 30_000 });

		assert.deepStrictEqual(await s.fixtures('Python'), [a]);
		assert.deepStrictEqual(await s.fixtures('Agents'), [b], 'another profile keeps it');
		assert.deepStrictEqual(s.sandbox.readGroups().groups.tools, [a, b], 'the group itself is untouched');
		assert.deepStrictEqual(s.sandbox.readGroups().excludes, { Python: [b] }, 'and Python is told not to want it');
		const group = await s.ui.waitForRow('PROFILES', 'tools');
		assert.ok(group.description.includes('1 of 2 installed'), 'the group still has two: ' + group.description);
	});

	test('a question that is declined changes nothing', async () => {
		await arrange({ python: [EXT.alpha], groups: { tools: [a] }, follows: { Python: ['tools'] } });
		await s.ui.expand('PROFILES', 'tools');
		await s.ui.pressRowButtonForDialog('PROFILES', 'Alpha Tool', 'Remove From Profile');
		await s.ui.pressDialogButton('Cancel');
		await new Promise(resolve => setTimeout(resolve, 600));
		assert.deepStrictEqual(await s.fixtures('Python'), [a]);
		assert.ok(await s.ui.row('PROFILES', 'Alpha Tool'));
		assert.strictEqual(s.sandbox.readGroups().excludes, undefined);
	});

	test('a group is taken out of a profile with its extensions, the one that others need coming last', async () => {
		await arrange({ python: [EXT.base, EXT.dependant, EXT.other], groups: { lib: [base, dep, o] }, follows: { Python: ['lib'] } });
		const dialog = await s.ui.pressRowButtonForDialog('PROFILES', 'lib', 'Remove From Profile');
		assert.ok(/3 extensions/.test(dialog.message), dialog.message);
		await s.ui.pressDialogButton('Remove and Uninstall');
		await s.ui.waitForNoRow('PROFILES', 'lib', { timeoutMs: 20_000 });
		await waitFor('all three to be uninstalled', async () => (await s.fixtures('Python')).length === 0, { timeoutMs: 60_000 });
		assert.deepStrictEqual(s.sandbox.readGroups().profiles, {}, 'Python no longer follows it');
		assert.deepStrictEqual(Object.keys(s.sandbox.readGroups().groups), ['lib'], 'the group is still there');
		assert.deepStrictEqual(await s.ui.labels('PROFILES').then(l => l.filter(x => /Tool|Library|Plugin/.test(x))), [], 'and the tree shows none of them');
	});

	test('what another group of the profile still wants stays installed', async () => {
		await arrange({ python: [EXT.alpha, EXT.beta], groups: { one: [a, b], two: [a] }, follows: { Python: ['one', 'two'] } });
		await s.ui.pressRowButtonForDialog('PROFILES', 'one', 'Remove From Profile');
		await s.ui.pressDialogButton('Remove and Uninstall');
		await waitFor('beta to be uninstalled', async () => !(await s.fixtures('Python')).includes(b), { timeoutMs: 30_000 });
		assert.deepStrictEqual(await s.fixtures('Python'), [a], 'alpha is still in "two"');
		assert.deepStrictEqual(s.sandbox.readGroups().profiles, { Python: ['two'] });
	});

	test('several selected extensions are removed with one question and one run of the command line', async () => {
		await arrange({ python: [EXT.alpha, EXT.beta, EXT.gamma], groups: { tools: [a, b, g] }, follows: { Python: ['tools'] } });
		await s.ui.expand('PROFILES', 'tools');
		await s.ui.clickRow('PROFILES', 'Alpha Tool');
		await s.ui.clickRow('PROFILES', 'Beta Tool', { modifiers: 2 });
		const selected = (await s.ui.rows('PROFILES')).filter(r => r.selected).map(r => r.label);
		assert.deepStrictEqual(selected.sort(), ['Alpha Tool', 'Beta Tool']);
		const dialog = await s.ui.pressRowButtonForDialog('PROFILES', 'Beta Tool', 'Remove From Profile');
		assert.ok(/2 extensions/.test(dialog.message), dialog.message);
		await s.ui.pressDialogButton('Uninstall');
		await s.ui.waitForNoRow('PROFILES', 'Alpha Tool', { timeoutMs: 20_000 });
		await s.ui.waitForNoRow('PROFILES', 'Beta Tool', { timeoutMs: 20_000 });
		await waitFor('both to be uninstalled', async () => (await s.fixtures('Python')).join() === g, { timeoutMs: 30_000 });
		assert.deepStrictEqual(s.sandbox.readGroups().excludes?.Python?.slice().sort(), [a, b], 'both recorded, in whatever order');
	});

	test('an extension that VS Code applies to all profiles stays, and the message says why and what to do', async () => {
		await arrange({ python: [EXT.alpha, EXT.beta], groups: { tools: [a, b] }, follows: { Python: ['tools'] } });
		// "Apply Extension to all Profiles" moves an extension into the default profile's list, flagged. A test cannot click that
		// (it is VS Code's own screen), so the flag is written the way VS Code writes it.
		const defaults = s.sandbox.indexFile('Default');
		const own = JSON.parse(fs.readFileSync(s.sandbox.indexFile('Python'), 'utf8')).find((e: { identifier: { id: string } }) => e.identifier.id === a);
		const index = JSON.parse(fs.readFileSync(defaults, 'utf8')) as unknown[];
		index.push({ ...own, metadata: { ...own.metadata, isApplicationScoped: true } });
		fs.writeFileSync(defaults, JSON.stringify(index));
		await s.refresh();
		await s.ui.expand('PROFILES', 'tools');
		await s.ui.clickRow('PROFILES', 'Alpha Tool');
		await s.ui.clickRow('PROFILES', 'Beta Tool', { modifiers: 2 });
		const dialog = await s.ui.pressRowButtonForDialog('PROFILES', 'Beta Tool', 'Remove From Profile');
		assert.ok(dialog.detail.includes(`${a} (applied to all profiles)`), dialog.detail);
		await s.ui.pressDialogButton('Uninstall');
		const message = await waitFor('the message about what was kept', async () => (await s.ui.notifications()).find(n => /Kept/.test(n)), { timeoutMs: 30_000 });
		assert.ok(message.includes(a) && message.includes('Apply Extension to all Profiles'), message);
		await waitFor('beta to be uninstalled', async () => !(await s.fixtures('Python')).includes(b), { timeoutMs: 30_000 });
		assert.ok((await s.fixtures('Python')).includes(a), 'alpha was not uninstalled');
		s.restoreDefaultIndex();
	});

	test('this extension is never uninstalled, even when a group has it', async () => {
		await arrange({ python: [EXT.alpha], groups: { mine: [SELF, a] }, follows: { Python: ['mine'] } });
		await s.ui.expand('PROFILES', 'mine');
		const dialog = await s.ui.pressRowButtonForDialog('PROFILES', 'mine', 'Remove From Profile');
		assert.ok(dialog.detail.includes('this extension'), dialog.detail);
		await s.ui.pressDialogButton(/Uninstall|Remove and Uninstall/);
		await waitFor('alpha to be uninstalled', async () => (await s.fixtures('Python')).length === 0, { timeoutMs: 30_000 });
		assert.ok((await s.sandbox.list('Python')).includes(SELF));
	});
});
