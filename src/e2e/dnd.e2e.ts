import * as assert from 'assert';
import { EXT, Session, captureOnFailure, idOf, startSession } from './session';
import { waitFor } from './ui';

const a = idOf(EXT.alpha), b = idOf(EXT.beta), g = idOf(EXT.gamma);

suite('e2e: drag and drop between the trees', function () {
	this.timeout(180_000);
	let s: Session;

	suiteSetup(async function () {
		this.timeout(400_000);
		s = await startSession('dnd', {
			profiles: ['Python', 'Agents'],
			extensions: { Python: [EXT.alpha, EXT.beta] },
			groups: { groups: { tools: [a], other: [g] }, profiles: { Python: ['tools'] } },
		});
	});
	suiteTeardown(async () => s?.stop());
	teardown(async function () {
		await captureOnFailure(s, this.currentTest);
		await s?.ui.tidy();
	});

	async function arrange(): Promise<void> {
		s.sandbox.writeGroups({ groups: { tools: [a], other: [g] }, profiles: { Python: ['tools'] } });
		await s.refresh();
		await s.ui.expand('PROFILES', 'Python');
		await s.ui.settled();
	}

	test('an extension of a profile dropped on a group of the other tree is added to that group', async () => {
		await arrange();
		await s.ui.drag({ section: 'PROFILES', label: 'Beta Tool' }, { section: 'GROUPS', label: 'other' });
		await waitFor('the group to have it', async () => s.sandbox.readGroups().groups.other.includes(b), { timeoutMs: 10_000 });
		assert.deepStrictEqual(s.sandbox.readGroups().groups.other, [g, b]);
		const group = await waitFor('the group row to say 2 extensions', async () => { const r = await s.ui.row('GROUPS', 'other'); return r && r.description.includes('2 extensions') ? r : undefined; });
		assert.ok(group);
		assert.deepStrictEqual(await s.fixtures('Python'), [a, b], 'nothing was installed or uninstalled');
	});

	test('a group dropped on a profile makes that profile follow it, and it shows there at once', async () => {
		await arrange();
		await s.ui.drag({ section: 'GROUPS', label: 'tools' }, { section: 'PROFILES', label: 'Agents' });
		await waitFor('Agents to follow it', async () => (s.sandbox.readGroups().profiles.Agents ?? []).includes('tools'), { timeoutMs: 10_000 });
		await s.ui.expand('PROFILES', 'Agents');
		const labels = await waitFor('the group inside Agents', async () => { const l = await s.ui.labels('PROFILES'); return l.slice(l.indexOf('Agents')).includes('tools') ? l : undefined; });
		assert.ok(labels.includes('tools'));
	});

	test('dropping on the group where the extension already is changes nothing', async () => {
		await arrange();
		const before = JSON.stringify(s.sandbox.readGroups());
		await s.ui.expand('PROFILES', 'tools');
		await s.ui.drag({ section: 'PROFILES', label: 'Alpha Tool' }, { section: 'GROUPS', label: 'tools' });
		await new Promise(resolve => setTimeout(resolve, 800));
		assert.strictEqual(JSON.stringify(s.sandbox.readGroups()), before);
	});

	test('an extension dragged from one group of the Groups tree to another is copied', async () => {
		await arrange();
		await s.ui.expand('GROUPS', 'tools');
		await s.ui.waitForRow('GROUPS', 'Alpha Tool');
		await s.ui.drag({ section: 'GROUPS', label: 'Alpha Tool' }, { section: 'GROUPS', label: 'other' });
		await waitFor('the other group to have it', async () => s.sandbox.readGroups().groups.other.includes(a), { timeoutMs: 10_000 });
		assert.deepStrictEqual(s.sandbox.readGroups().groups.tools, [a], 'the first group keeps it');
	});

	// Installing by a drop asks the Marketplace for the extension, so it needs the network: it runs when BP_E2E_NETWORK=1 (the nightly build).
	test('an extension dropped on a profile shows at once as being installed, then is installed (needs the network)', async function () {
		if (!process.env.BP_E2E_NETWORK) {
			this.skip();
		}
		this.timeout(240_000);
		const id = 'tyriar.sort-lines';
		s.sandbox.writeGroups({ groups: { net: [id] }, profiles: {} });
		await s.refresh();
		await s.ui.expand('GROUPS', 'net');
		await s.ui.waitForRow('GROUPS', id);
		await s.ui.expand('PROFILES', 'Agents');
		const dropped = Date.now();
		await s.ui.drag({ section: 'GROUPS', label: id }, { section: 'PROFILES', label: 'Agents' });
		const shown = await waitFor('the extension to show in Agents', async () => (await s.ui.rows('PROFILES')).find(r => /installing/.test(r.description)), { timeoutMs: 5000, intervalMs: 10 });
		assert.ok(shown);
		assert.ok(Date.now() - dropped < 5000);
		await waitFor('the install to finish', async () => (await s.sandbox.list('Agents')).includes(id), { timeoutMs: 200_000, intervalMs: 1000 });
	});
});
