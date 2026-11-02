import * as assert from 'assert';
import {
	ALL_PROFILES,
	GroupsConfig,
	addToGroup,
	commonToAllProfiles,
	planCleanup,
	promptKey,
	assignGroup,
	desiredExtensions,
	emptyGroups,
	isExtensionId,
	parseGroups,
	planSync,
	renderMatrix,
	serializeGroups,
} from '../../groups';

const config = (groups: Record<string, string[]>, profiles: Record<string, string[]> = {}): GroupsConfig => ({ groups, profiles });

suite('isExtensionId', () => {
	test('accepts publisher.name ids, including dashes, digits and dots in the name', () => {
		for (const id of ['ms-python.python', 'esbenp.prettier-vscode', 'vscode-icons-team.vscode-icons', 'a1.b2', 'rust-lang.rust-analyzer', 'ms-vscode.cpptools-extension-pack']) {
			assert.ok(isExtensionId(id), id);
		}
	});

	test('rejects flags, paths, urls, spaces and ids without a publisher', () => {
		for (const id of ['', 'python', '--uninstall-extension', '-x.y', '../x.vsix', '/tmp/a.vsix', 'a.b c', 'a/b.c', 'https://x.y/z', 'a.', '.b', 'a..b', 'a.b;rm', 'evil.vsix', 'X.VSIX', 'pub.name.vsix']) {
			assert.ok(!isExtensionId(id), JSON.stringify(id));
		}
	});
});

suite('parseGroups', () => {
	test('reads groups and the groups assigned to each profile', () => {
		const { config: c, warnings } = parseGroups(JSON.stringify({
			groups: { web: ['dbaeumer.vscode-eslint', 'esbenp.prettier-vscode'], python: ['ms-python.python'] },
			profiles: { '*': ['web'], Python: ['python'] },
		}));
		assert.deepStrictEqual(c.groups, { web: ['dbaeumer.vscode-eslint', 'esbenp.prettier-vscode'], python: ['ms-python.python'] });
		assert.deepStrictEqual(c.profiles, { '*': ['web'], Python: ['python'] });
		assert.deepStrictEqual(warnings, []);
	});

	test('empty text or {} is an empty config', () => {
		assert.deepStrictEqual(parseGroups('{}').config, emptyGroups());
		assert.deepStrictEqual(parseGroups('').config, emptyGroups());
		assert.deepStrictEqual(parseGroups('  \n').config, emptyGroups());
	});

	test('throws on invalid JSON so the file is not silently overwritten', () => {
		assert.throws(() => parseGroups('{ nope'), SyntaxError);
	});

	test('drops invalid extension ids and says so', () => {
		const { config: c, warnings } = parseGroups(JSON.stringify({ groups: { g: ['a.b', '--install-extension', '../evil.vsix', 'c.d'] } }));
		assert.deepStrictEqual(c.groups.g, ['a.b', 'c.d']);
		assert.strictEqual(warnings.length, 2);
		assert.ok(warnings.every(w => w.includes('"g"')), warnings.join('|'));
	});

	test('de-duplicates ids case-insensitively, keeping the first spelling', () => {
		const { config: c } = parseGroups(JSON.stringify({ groups: { g: ['MS-Python.python', 'ms-python.python', 'a.b'] } }));
		assert.deepStrictEqual(c.groups.g, ['MS-Python.python', 'a.b']);
	});

	test('ignores a group whose value is not a list, with a warning', () => {
		const { config: c, warnings } = parseGroups(JSON.stringify({ groups: { good: ['a.b'], bad: 'a.b', worse: { x: 1 } } }));
		assert.deepStrictEqual(Object.keys(c.groups), ['good']);
		assert.strictEqual(warnings.length, 2);
	});

	test('keeps a profile that points to a group which does not exist (reported when syncing)', () => {
		const { config: c } = parseGroups(JSON.stringify({ groups: {}, profiles: { Rust: ['rust'] } }));
		assert.deepStrictEqual(c.profiles, { Rust: ['rust'] });
	});
});

suite('serializeGroups', () => {
	test('round-trips through parseGroups', () => {
		const c = config({ web: ['a.b', 'c.d'] }, { '*': ['web'] });
		assert.deepStrictEqual(parseGroups(serializeGroups(c)).config, c);
	});

	test('is readable: indented, one extension per line, newline at the end', () => {
		const text = serializeGroups(config({ web: ['a.b', 'c.d'] }));
		assert.ok(text.endsWith('\n'));
		assert.ok(text.includes('\n      "a.b",\n'), text);
	});
});

suite('addToGroup / assignGroup', () => {
	test('creates the group and keeps the original untouched', () => {
		const before = config({});
		const after = addToGroup(before, 'web', ['a.b']);
		assert.deepStrictEqual(after.groups, { web: ['a.b'] });
		assert.deepStrictEqual(before.groups, {});
	});

	test('merges into an existing group without duplicates (case-insensitive)', () => {
		const after = addToGroup(config({ web: ['a.b'] }), 'web', ['A.B', 'c.d', 'c.d']);
		assert.deepStrictEqual(after.groups.web, ['a.b', 'c.d']);
	});

	test('refuses ids that are not valid extension ids', () => {
		assert.throws(() => addToGroup(config({}), 'web', ['--evil']), /extension id/i);
	});

	test('refuses an empty group name', () => {
		assert.throws(() => addToGroup(config({}), '  ', ['a.b']), /group name/i);
	});

	test('assignGroup adds the group to the profile once', () => {
		let c = assignGroup(config({ web: ['a.b'] }), 'Python', 'web');
		c = assignGroup(c, 'Python', 'web');
		assert.deepStrictEqual(c.profiles, { Python: ['web'] });
	});

	test('assignGroup works for every profile with the "*" key', () => {
		assert.deepStrictEqual(assignGroup(config({ web: [] }), ALL_PROFILES, 'web').profiles, { '*': ['web'] });
	});
});

suite('desiredExtensions', () => {
	const c = config(
		{ common: ['a.one', 'a.two'], python: ['p.py', 'a.two'], rust: ['r.rust'] },
		{ '*': ['common'], Python: ['python'] },
	);

	test('is the union of the "*" groups and the profile groups, in order, without duplicates', () => {
		assert.deepStrictEqual(desiredExtensions(c, 'Python').ids, ['a.one', 'a.two', 'p.py']);
	});

	test('a profile with no entry only gets the "*" groups', () => {
		assert.deepStrictEqual(desiredExtensions(c, 'Rust').ids, ['a.one', 'a.two']);
	});

	test('reports groups that are referenced but not defined', () => {
		const d = desiredExtensions(config({}, { Python: ['ghost'] }), 'Python');
		assert.deepStrictEqual(d, { ids: [], missingGroups: ['ghost'] });
	});

	test('profile names match exactly', () => {
		assert.deepStrictEqual(desiredExtensions(c, 'python').ids, ['a.one', 'a.two']);
	});
});

suite('planSync', () => {
	const c = config({ g: ['A.One', 'b.two', 'c.three'] }, { Python: ['g'] });

	test('installs only what the profile does not have, comparing ids case-insensitively', () => {
		const plan = planSync(c, 'Python', ['a.one', 'x.other']);
		assert.deepStrictEqual(plan.toInstall, ['b.two', 'c.three']);
		assert.deepStrictEqual(plan.alreadyInstalled, ['A.One']);
	});

	test('never plans to remove anything', () => {
		const plan = planSync(c, 'Python', ['x.other', 'y.another']);
		assert.deepStrictEqual(Object.keys(plan).sort(), ['alreadyInstalled', 'missingGroups', 'toInstall']);
	});

	test('nothing to do when everything is installed', () => {
		const plan = planSync(c, 'Python', ['a.one', 'b.two', 'c.three']);
		assert.deepStrictEqual(plan.toInstall, []);
	});

	test('carries the missing groups through', () => {
		assert.deepStrictEqual(planSync(config({}, { P: ['ghost'] }), 'P', []).missingGroups, ['ghost']);
	});
});

suite('renderMatrix', () => {
	test('one row per extension, one column per profile, sorted by id', () => {
		const md = renderMatrix([
			{ profile: 'Default', ids: ['b.two', 'a.one'] },
			{ profile: 'Python', ids: ['a.one', 'c.three'] },
		]);
		const lines = md.trim().split('\n');
		assert.strictEqual(lines[0], '| Extension | Default | Python |');
		assert.ok(/^\|\s*-+\s*\|/.test(lines[1]), lines[1]);
		assert.deepStrictEqual(lines.slice(2, -1).map(l => l.split('|').slice(1, -1).map(s => s.trim())), [
			['a.one', '✓', '✓'],
			['b.two', '✓', ''],
			['c.three', '', '✓'],
		]);
	});

	test('merges ids that differ only in case', () => {
		const md = renderMatrix([{ profile: 'A', ids: ['X.Y'] }, { profile: 'B', ids: ['x.y'] }]);
		assert.strictEqual(md.trim().split('\n').length, 4, 'header, separator, one merged row, total');
	});

	test('says how many extensions each profile has', () => {
		const md = renderMatrix([{ profile: 'Default', ids: ['a.b', 'c.d'] }, { profile: 'Python', ids: ['a.b'] }]);
		assert.ok(md.includes('| **Total** | 2 | 1 |'), md);
	});

	test('no profiles gives a short message instead of a broken table', () => {
		assert.ok(/no profiles/i.test(renderMatrix([])));
	});

	test('profile names cannot break the table', () => {
		const md = renderMatrix([{ profile: 'a|b', ids: ['x.y'] }]);
		assert.ok(md.includes('a\\|b'), md);
	});
});

suite('planCleanup', () => {
	const c = config({ py: ['p.keep', 'P.Other'], common: ['c.one'] }, { '*': ['common'], Python: ['py'] });

	test('extras are installed extensions that none of the profile groups mention', () => {
		const plan = planCleanup(c, 'Python', ['p.keep', 'c.one', 'x.extra', 'y.extra'], []);
		assert.deepStrictEqual(plan, { managed: true, extras: ['x.extra', 'y.extra'] });
	});

	test('ids are compared case-insensitively and extras keep the installed spelling, sorted', () => {
		const plan = planCleanup(c, 'Python', ['p.OTHER', 'Z.Last', 'a.first'], []);
		assert.deepStrictEqual(plan.extras, ['a.first', 'Z.Last']);
	});

	test('protected ids are never extras (application-scoped extensions, this extension, "keep" list)', () => {
		const plan = planCleanup(c, 'Python', ['shared.x', 'LyesRabhi.better-profiles', 'x.extra'], ['SHARED.x', 'lyesrabhi.better-profiles']);
		assert.deepStrictEqual(plan.extras, ['x.extra']);
	});

	test('a profile with no groups is not managed, so nothing is an extra', () => {
		const plan = planCleanup(c, 'Rust', ['r.one'], []);
		assert.strictEqual(plan.managed, true, 'Rust still gets the "*" group');
		const none = planCleanup(config({ g: ['a.b'] }, {}), 'Rust', ['r.one', 'r.two'], []);
		assert.deepStrictEqual(none, { managed: false, reason: 'no-groups', extras: [] });
	});

	test('a group that is assigned but not defined blocks cleanup: the list of wanted extensions is incomplete', () => {
		const plan = planCleanup(config({ g: ['a.b'] }, { Python: ['g', 'ghost'] }), 'Python', ['x.extra'], []);
		assert.deepStrictEqual(plan, { managed: false, reason: 'missing-groups', extras: [] });
	});

	test('groups that exist but are empty give nothing to compare against, so they do not manage the profile', () => {
		const plan = planCleanup(config({ empty: [] }, { Python: ['empty'] }), 'Python', ['x.extra'], []);
		assert.deepStrictEqual(plan, { managed: false, reason: 'no-groups', extras: [] });
	});

	test('nothing installed means nothing to remove', () => {
		assert.deepStrictEqual(planCleanup(c, 'Python', [], []).extras, []);
	});

	test('does not change the install plan: planSync still never mentions removals', () => {
		assert.deepStrictEqual(Object.keys(planSync(c, 'Python', ['x.extra'])).sort(), ['alreadyInstalled', 'missingGroups', 'toInstall']);
	});
});

suite('commonToAllProfiles', () => {
	test('is what every list has, comparing case-insensitively', () => {
		assert.deepStrictEqual(commonToAllProfiles([['a.b', 'C.D', 'x.only'], ['c.d', 'a.b'], ['A.B', 'c.d', 'y.only']]).sort(), ['a.b', 'c.d']);
	});

	test('an extension missing from even one profile is not common', () => {
		assert.deepStrictEqual(commonToAllProfiles([['a.b', 'c.d'], ['a.b'], []]), []);
	});

	test('no lists means nothing is common', () => {
		assert.deepStrictEqual(commonToAllProfiles([]), []);
	});

	test('one list is common to itself', () => {
		assert.deepStrictEqual(commonToAllProfiles([['a.b', 'c.d']]).sort(), ['a.b', 'c.d']);
	});
});

suite('promptKey', () => {
	test('is the same for the same set whatever the order or case', () => {
		assert.strictEqual(promptKey(['B.two', 'a.one']), promptKey(['A.ONE', 'b.two']));
	});

	test('differs when the set differs', () => {
		assert.notStrictEqual(promptKey(['a.one']), promptKey(['a.one', 'b.two']));
	});

	test('an empty set has a stable key', () => {
		assert.strictEqual(promptKey([]), promptKey([]));
	});
});
