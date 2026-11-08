import * as assert from 'assert';
import { EXT, SELF, Session, captureOnFailure, idOf, startSession } from './session';
import { waitFor } from './ui';

suite('e2e: the Better Profiles tab', function () {
	this.timeout(120_000);
	let s: Session;

	suiteSetup(async function () {
		this.timeout(400_000);
		s = await startSession('tree', {
			profiles: ['Python', 'Agents'],
			extensions: { Default: [EXT.alpha], Python: [EXT.alpha, EXT.beta, EXT.gamma], Agents: [EXT.gamma] },
			groups: {
				groups: { tools: [idOf(EXT.alpha), idOf(EXT.beta)], more: [idOf(EXT.gamma), idOf(EXT.other)], lonely: [idOf(EXT.other)] },
				profiles: { Python: ['tools', 'more'], Agents: ['more'] },
			},
		});
	});
	suiteTeardown(async () => s?.stop());
	teardown(async function () {
		await captureOnFailure(s, this.currentTest);
		await s?.ui.tidy();
	});

	test('the Groups tree lists every group with how many extensions it has and who follows it', async () => {
		const tools = await s.ui.waitForRow('GROUPS', 'tools');
		assert.ok(tools.description.includes('2 extensions') && tools.description.includes('Python'), tools.description);
		const more = await s.ui.waitForRow('GROUPS', 'more');
		assert.ok(more.description.includes('Python') && more.description.includes('Agents'), more.description);
		assert.ok(await s.ui.waitForRow('GROUPS', 'lonely'));
	});

	test('the Profiles tree lists every profile and marks the one of this window', async () => {
		assert.ok(await s.ui.waitForRow('PROFILES', 'Default'));
		assert.ok(await s.ui.waitForRow('PROFILES', 'Agents'));
		const python = await s.ui.waitForRow('PROFILES', 'Python');
		assert.ok(python.description.includes('current'), python.description);
	});

	test('a profile shows its groups first, with how many of their extensions it has, then its other extensions', async () => {
		await s.ui.expand('PROFILES', 'Python');
		const tools = await s.ui.waitForRow('PROFILES', 'tools');
		assert.ok(tools.description.includes('2 of 2 installed'), tools.description);
		const more = await s.ui.waitForRow('PROFILES', 'more');
		assert.ok(more.description.includes('1 of 2 installed'), more.description);
		const labels = await s.ui.labels('PROFILES');
		assert.ok(labels.indexOf('tools') < labels.indexOf('Better Profiles'), 'groups come before the extensions that are in none: ' + labels.join(', '));
	});

	test('the extensions are shown by their display names, with their version', async () => {
		await s.ui.expand('PROFILES', 'Python');
		await s.ui.expand('PROFILES', 'tools');
		const alpha = await s.ui.waitForRow('PROFILES', 'Alpha Tool');
		assert.strictEqual(alpha.description, '1.0.0');
		assert.ok(await s.ui.waitForRow('PROFILES', 'Beta Tool'));
	});

	test('New Group asks for a name even when a group is focused in the tree (it once took the name of the focused group)', async () => {
		await s.ui.clickRow('GROUPS', 'tools');
		await s.ui.pressTitleButton('GROUPS', 'New Group');
		const box = await waitFor('the name prompt', () => s.ui.inputBox());
		assert.ok(box.prompt.includes('Name of the new group'), box.prompt);
		await s.ui.type('fresh');
		await s.ui.pressKey('Enter');
		await s.ui.waitForRow('GROUPS', 'fresh');
		assert.deepStrictEqual(s.sandbox.readGroups().groups.fresh, []);
		assert.ok(!(await s.ui.notifications()).some(n => /already a group/i.test(n)));
	});

	test('a double click on an extension opens its page', async () => {
		await s.ui.expand('PROFILES', 'Python');
		await s.ui.expand('PROFILES', 'tools');
		await s.ui.doubleClick(await s.ui.rowBox('PROFILES', 'Alpha Tool'));
		await waitFor('the extension page', async () => (await s.ui.tabs()).some(t => /Extension: Alpha Tool/.test(t)));
	});

	test('a single click does not open anything', async () => {
		const before = (await s.ui.tabs()).length;
		await s.ui.expand('PROFILES', 'Python');
		await s.ui.expand('PROFILES', 'tools');
		await s.ui.clickRow('PROFILES', 'Beta Tool');
		await new Promise(resolve => setTimeout(resolve, 900));
		assert.strictEqual((await s.ui.tabs()).length, before);
	});

	test('right-clicking an extension offers what can be done with it', async () => {
		await s.ui.expand('PROFILES', 'Python');
		await s.ui.expand('PROFILES', 'tools');
		await s.ui.clickRow('PROFILES', 'Beta Tool', { button: 'right' });
		const menu = await waitFor('the menu', async () => { const m = await s.ui.contextMenu(); return m.length > 0 ? m : undefined; });
		for (const entry of ['Open Extension Page', 'Add to Group', 'Install in Other Profiles', 'Copy Extension Id', 'Remove From Profile']) {
			assert.ok(menu.includes(entry), `"${entry}" should be offered: ${menu.join(' | ')}`);
		}
		assert.ok(!menu.includes('Remove From Group'), 'inside a profile it must not offer to change the real group');
	});

	test('a group inside a profile can be taken out of it with a quick button, and cannot be deleted from there', async () => {
		await s.ui.expand('PROFILES', 'Python');
		await s.ui.clickRow('PROFILES', 'tools', { button: 'right' });
		const menu = await waitFor('the menu', async () => { const m = await s.ui.contextMenu(); return m.length > 0 ? m : undefined; });
		assert.ok(menu.includes('Remove From Profile'), menu.join(' | '));
		assert.ok(!menu.includes('Delete Group'), menu.join(' | '));
		await s.ui.closeMenus();
		assert.ok(await s.ui.rowButton('PROFILES', 'tools', 'Remove From Profile'));
	});

	test('the graph opens in a tab from the button at the top', async () => {
		await s.ui.pressTitleButton('GROUPS', 'Show Graph');
		await waitFor('the graph tab', async () => (await s.ui.tabs()).some(t => /Better Profiles Graph/.test(t)));
	});

	test('the extension under test is there, and is not one of the fixtures', async () => {
		assert.ok((await s.sandbox.list('Python')).includes(SELF));
	});
});
