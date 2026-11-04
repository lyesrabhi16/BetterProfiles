import * as assert from 'assert';
import {
	ALL_PROFILES,
	GroupsConfig,
	addToGroup,
	assignedGroups,
	groupsContaining,
	profilesFollowing,
	removeFromGroup,
	isTriggerPattern,
	setTriggers,
	triggeredGroups,
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

suite('isTriggerPattern', () => {
	test('accepts globs relative to a workspace folder', () => {
		for (const p of ['pubspec.yaml', '**/pubspec.yaml', '*.py', 'src/**/*.ts', '**/{a,b}.json', 'docs/*.md']) {
			assert.ok(isTriggerPattern(p), p);
		}
	});

	test('rejects empty, absolute, parent-escaping, backslashed, NUL-containing and absurdly long patterns', () => {
		for (const p of ['', '   ', '/etc/passwd', '/**/x', '../x', 'a/../b', '..', 'C:\\x', 'C:/x', 'a\\b', 'a\0b', 'x'.repeat(300)]) {
			assert.ok(!isTriggerPattern(p), JSON.stringify(p));
		}
	});
});

suite('triggers in the groups file', () => {
	test('are read per group', () => {
		const { config: c, warnings } = parseGroups(JSON.stringify({
			groups: { flutter: ['dart-code.flutter'] },
			triggers: { flutter: ['**/pubspec.yaml', 'lib/*.dart'] },
		}));
		assert.deepStrictEqual(c.triggers, { flutter: ['**/pubspec.yaml', 'lib/*.dart'] });
		assert.deepStrictEqual(warnings, []);
	});

	test('a file without triggers has no triggers key at all (so the config stays minimal)', () => {
		assert.ok(!('triggers' in parseGroups(JSON.stringify({ groups: { g: ['a.b'] } })).config));
		assert.ok(!('triggers' in parseGroups('{}').config));
	});

	test('invalid patterns are dropped with a warning that names the group', () => {
		const { config: c, warnings } = parseGroups(JSON.stringify({ groups: { g: ['a.b'] }, triggers: { g: ['**/ok.txt', '/etc/passwd', '../x', 5, ''] } }));
		assert.deepStrictEqual(c.triggers, { g: ['**/ok.txt'] });
		assert.strictEqual(warnings.length, 4);
		assert.ok(warnings.every(w => w.includes('"g"')), warnings.join('|'));
	});

	test('a group whose triggers are all invalid ends up with none rather than an empty list', () => {
		const { config: c } = parseGroups(JSON.stringify({ groups: { g: ['a.b'] }, triggers: { g: ['/abs'] } }));
		assert.ok(!c.triggers || !('g' in c.triggers));
	});

	test('triggers that are not a list are ignored with a warning', () => {
		const { config: c, warnings } = parseGroups(JSON.stringify({ groups: { g: ['a.b'] }, triggers: { g: '**/x' } }));
		assert.ok(!c.triggers || !('g' in c.triggers));
		assert.strictEqual(warnings.length, 1);
	});

	test('triggers for a group that does not exist are kept, with a warning', () => {
		const { config: c, warnings } = parseGroups(JSON.stringify({ groups: {}, triggers: { ghost: ['**/x'] } }));
		assert.deepStrictEqual(c.triggers, { ghost: ['**/x'] });
		assert.strictEqual(warnings.length, 1);
		assert.ok(warnings[0].includes('"ghost"'));
	});

	test('round-trip through serializeGroups', () => {
		const c: GroupsConfig = { groups: { f: ['a.b'] }, profiles: {}, triggers: { f: ['**/pubspec.yaml'] } };
		assert.deepStrictEqual(parseGroups(serializeGroups(c)).config, c);
	});

	test('addToGroup and assignGroup keep the triggers', () => {
		const c: GroupsConfig = { groups: { f: ['a.b'] }, profiles: {}, triggers: { f: ['**/pubspec.yaml'] } };
		assert.deepStrictEqual(addToGroup(c, 'f', ['c.d']).triggers, c.triggers);
		assert.deepStrictEqual(assignGroup(c, 'Mobile', 'f').triggers, c.triggers);
	});
});

suite('setTriggers', () => {
	const base = config({ flutter: ['a.b'] });

	test('sets the patterns of an existing group and leaves the original alone', () => {
		const next = setTriggers(base, 'flutter', ['**/pubspec.yaml']);
		assert.deepStrictEqual(next.triggers, { flutter: ['**/pubspec.yaml'] });
		assert.ok(!('triggers' in base));
	});

	test('replaces earlier patterns, removes duplicates and trims', () => {
		const once = setTriggers(base, 'flutter', ['**/a', '**/b']);
		assert.deepStrictEqual(setTriggers(once, 'flutter', [' **/c ', '**/c']).triggers, { flutter: ['**/c'] });
	});

	test('an empty list removes the triggers, and the triggers key when none are left', () => {
		const once = setTriggers(base, 'flutter', ['**/a']);
		assert.ok(!('triggers' in setTriggers(once, 'flutter', [])));
	});

	test('refuses an invalid pattern and an unknown group', () => {
		assert.throws(() => setTriggers(base, 'flutter', ['../x']), /pattern/i);
		assert.throws(() => setTriggers(base, 'nope', ['**/x']), /no group/i);
	});
});

suite('triggeredGroups / assignedGroups', () => {
	const c: GroupsConfig = {
		groups: { common: ['c.one'], flutter: ['f.one'], py: ['p.one'] },
		profiles: { '*': ['common'], Mobile: ['flutter', 'py'] },
		triggers: { flutter: ['**/pubspec.yaml'], py: ['**/*.py'], common: [] },
	};

	test('assignedGroups is "*" first, then the profile, without duplicates', () => {
		assert.deepStrictEqual(assignedGroups(c, 'Mobile'), ['common', 'flutter', 'py']);
		assert.deepStrictEqual(assignedGroups(c, 'Other'), ['common']);
	});

	test('triggeredGroups lists only the profile groups that have triggers', () => {
		assert.deepStrictEqual(triggeredGroups(c, 'Mobile'), [
			{ group: 'flutter', patterns: ['**/pubspec.yaml'] },
			{ group: 'py', patterns: ['**/*.py'] },
		]);
		assert.deepStrictEqual(triggeredGroups(c, 'Other'), []);
	});

	test('a config without triggers has none', () => {
		assert.deepStrictEqual(triggeredGroups(config({ g: ['a.b'] }, { P: ['g'] }), 'P'), []);
	});
});

suite('wanted extensions where a workspace matches only some triggers', () => {
	const c: GroupsConfig = {
		groups: { common: ['c.one'], flutter: ['f.one', 'f.two'], py: ['p.one'] },
		profiles: { Mobile: ['common', 'flutter', 'py'] },
		triggers: { flutter: ['**/pubspec.yaml'], py: ['**/*.py'] },
	};

	test('without match information every assigned group counts (an explicit sync)', () => {
		assert.deepStrictEqual(desiredExtensions(c, 'Mobile').ids, ['c.one', 'f.one', 'f.two', 'p.one']);
	});

	test('a triggered group counts only when it matched; groups without triggers always count', () => {
		assert.deepStrictEqual(desiredExtensions(c, 'Mobile', ['flutter']).ids, ['c.one', 'f.one', 'f.two']);
		assert.deepStrictEqual(desiredExtensions(c, 'Mobile', []).ids, ['c.one']);
	});

	test('match names that the profile does not follow are ignored', () => {
		assert.deepStrictEqual(desiredExtensions(c, 'Mobile', ['ghost']).ids, ['c.one']);
	});

	test('planSync carries the match information through', () => {
		const plan = planSync(c, 'Mobile', ['c.one'], ['flutter']);
		assert.deepStrictEqual(plan.toInstall, ['f.one', 'f.two']);
		assert.deepStrictEqual(planSync(c, 'Mobile', ['c.one'], []).toInstall, []);
	});

	test('cleanup still sees every assigned group, so a group this workspace does not need is never offered for removal', () => {
		const plan = planCleanup(c, 'Mobile', ['c.one', 'f.one', 'p.one', 'x.extra'], []);
		assert.deepStrictEqual(plan.extras, ['x.extra']);
	});
});

suite('groupsContaining', () => {
	const c: GroupsConfig = { groups: { web: ['A.One', 'b.two'], tools: ['a.one'], empty: [] }, profiles: {} };

	test('lists the groups that hold the extension, case-insensitively, in file order', () => {
		assert.deepStrictEqual(groupsContaining(c, 'a.ONE'), ['web', 'tools']);
		assert.deepStrictEqual(groupsContaining(c, 'b.two'), ['web']);
	});

	test('an extension in no group gives an empty list', () => {
		assert.deepStrictEqual(groupsContaining(c, 'z.nope'), []);
	});
});

suite('removeFromGroup', () => {
	const c: GroupsConfig = {
		groups: { web: ['A.One', 'b.two'], tools: ['a.one'] },
		profiles: { Python: ['web'] },
		triggers: { web: ['**/package.json'] },
	};

	test('removes the extension from that group only, matching case-insensitively', () => {
		const next = removeFromGroup(c, 'web', 'a.one');
		assert.deepStrictEqual(next.groups, { web: ['b.two'], tools: ['a.one'] });
	});

	test('keeps the profiles and the triggers, and leaves the original untouched', () => {
		const next = removeFromGroup(c, 'web', 'b.two');
		assert.deepStrictEqual(next.profiles, c.profiles);
		assert.deepStrictEqual(next.triggers, c.triggers);
		assert.deepStrictEqual(c.groups.web, ['A.One', 'b.two']);
	});

	test('a group left empty is kept (profiles and triggers still point at it)', () => {
		const next = removeFromGroup(c, 'tools', 'a.one');
		assert.deepStrictEqual(next.groups.tools, []);
	});

	test('an extension that is not in the group is a no-op', () => {
		assert.deepStrictEqual(removeFromGroup(c, 'web', 'z.nope'), c);
	});

	test('a group that does not exist is an error', () => {
		assert.throws(() => removeFromGroup(c, 'ghost', 'a.one'), /no group/i);
	});

	test('a config without triggers stays without a triggers key', () => {
		const plain: GroupsConfig = { groups: { g: ['a.b'] }, profiles: {} };
		assert.ok(!('triggers' in removeFromGroup(plain, 'g', 'a.b')));
	});
});

suite('profilesFollowing', () => {
	const c: GroupsConfig = {
		groups: { web: ['a.b'], tools: ['c.d'], unused: [] },
		profiles: { '*': ['tools'], Python: ['web'], Rust: ['web', 'tools'] },
	};

	test('lists the profiles that follow the group, in file order', () => {
		assert.deepStrictEqual(profilesFollowing(c, 'web'), ['Python', 'Rust']);
	});

	test('"*" counts: a group given to every profile is followed', () => {
		assert.deepStrictEqual(profilesFollowing(c, 'tools'), ['*', 'Rust']);
	});

	test('a group nobody follows gives an empty list', () => {
		assert.deepStrictEqual(profilesFollowing(c, 'unused'), []);
		assert.deepStrictEqual(profilesFollowing(c, 'nope'), []);
	});
});
