import * as assert from 'assert';
import { EXT, Session, captureOnFailure, idOf, startSession } from './session';
import { Cdp } from './cdp';
import { flush, record } from '../test/perf/bench';
import { waitFor } from './ui';
import { FixtureExtension } from './vsix';

void Cdp;

const SCALE = Number(process.env.BP_PERF_SCALE ?? '1') || 1;
const COUNT = 30;
const bulk: FixtureExtension[] = Array.from({ length: COUNT }, (_, i) => ({ publisher: 'bptest', name: `perf${i}`, version: '1.0.0', displayName: `Perf Tool ${i}` }));

/**
 * How fast the tab answers in a real VS Code, with a group of thirty extensions. The budgets are generous (a shared CI machine is
 * slow, and these are UI timings); what matters is that "instant" stays far below a second, and every number is kept in
 * perf-results/e2e.json so that a slow drift can be seen over runs.
 */
suite('e2e performance: the tab answers at once', function () {
	this.timeout(240_000);
	let s: Session;

	const check = (name: string, ms: number, budgetMs: number, note?: string) => {
		const budget = budgetMs * SCALE;
		record({ name, ms: Math.round(ms), budgetMs: budget, runs: 1, note });
		assert.ok(ms <= budget, `${name} took ${Math.round(ms)} ms, the budget is ${budget} ms`);
	};

	suiteSetup(async function () {
		this.timeout(500_000);
		s = await startSession('perf', {
			profiles: ['Python'],
			groups: { groups: { bulk: bulk.map(idOf), few: [idOf(EXT.alpha), idOf(EXT.beta)] }, profiles: { Python: ['bulk', 'few'] } },
		});
		await s.sandbox.install([...bulk, EXT.alpha, EXT.beta], 'Python');
		await s.refresh();
		await s.ui.settled();
	});
	suiteTeardown(async () => {
		flush('e2e');
		await s?.stop();
	});
	teardown(async function () {
		await captureOnFailure(s, this.currentTest);
		await s?.ui.tidy();
	});

	test('a profile with thirty extensions in a group opens at once', async () => {
		const started = Date.now();
		await s.ui.expand('PROFILES', 'Python');
		await s.ui.waitForRow('PROFILES', 'bulk');
		check('open a profile (30 extensions in a group)', Date.now() - started, 2000);
		const group = await s.ui.waitForRow('PROFILES', 'bulk');
		assert.ok(group.description.includes(`${COUNT} of ${COUNT} installed`), group.description);
	});

	test('the question before an uninstall appears at once', async () => {
		await s.ui.expand('PROFILES', 'few');
		await s.ui.waitForRow('PROFILES', 'Alpha Tool');
		await s.ui.hover(await s.ui.rowBox('PROFILES', 'Alpha Tool'));
		const at = await s.ui.rowButton('PROFILES', 'Alpha Tool', 'Remove From Profile');
		const started = Date.now();
		await s.ui.click(at);
		await s.ui.waitForDialog({ timeoutMs: 15_000 });
		check('the question after pressing the button', Date.now() - started, 1000);
		await s.ui.pressDialogButton('Cancel');
	});

	test('an extension leaves the tree at once after the question is answered', async () => {
		await s.ui.pressRowButtonForDialog('PROFILES', 'Beta Tool', 'Remove From Profile');
		const confirmed = Date.now();
		await s.ui.pressDialogButton('Uninstall');
		await s.ui.waitForNoRow('PROFILES', 'Beta Tool', { timeoutMs: 15_000 });
		check('the extension gone after confirming', Date.now() - confirmed, 1000);
		await waitFor('the command line to be done', async () => !(await s.fixtures('Python')).includes(idOf(EXT.beta)), { timeoutMs: 60_000 });
		record({ name: 'the command line finishing (one extension), for reference', ms: Date.now() - confirmed, runs: 1 });
	});

	test('a group of thirty extensions leaves the profile at once, and is uninstalled in a few runs of the command line', async () => {
		await s.ui.pressRowButtonForDialog('PROFILES', 'bulk', 'Remove From Profile');
		const confirmed = Date.now();
		await s.ui.pressDialogButton('Remove and Uninstall');
		await s.ui.waitForNoRow('PROFILES', 'bulk', { timeoutMs: 15_000 });
		check('thirty extensions gone after confirming', Date.now() - confirmed, 1500);
		await waitFor('all thirty to be uninstalled', async () => (await s.fixtures('Python')).filter(id => id.startsWith('bptest.perf')).length === 0, { timeoutMs: 180_000, intervalMs: 500 });
		const finished = Date.now() - confirmed;
		record({ name: 'the command line finishing (thirty extensions), for reference', ms: finished, budgetMs: 60_000 * SCALE, runs: 1, note: 'one run of the command line takes them all' });
		assert.ok(finished < 60_000 * SCALE, `the uninstall took ${finished} ms`);
	});

	test('the trees are read again at once on Refresh', async () => {
		const started = Date.now();
		await s.refresh();
		await s.ui.settled(300);
		check('Refresh until the trees are quiet', Date.now() - started, 3000);
	});

	test('the graph opens at once', async () => {
		const started = Date.now();
		await s.ui.pressTitleButton('GROUPS', 'Show Graph');
		await waitFor('the graph tab', async () => (await s.ui.tabs()).some(t => /Better Profiles Graph/.test(t)), { timeoutMs: 15_000, intervalMs: 20 });
		check('the graph tab after pressing the button', Date.now() - started, 3000);
	});
});
