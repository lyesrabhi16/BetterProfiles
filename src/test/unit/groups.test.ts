import * as assert from 'assert';
import {
	ALL_PROFILES,
	GroupsConfig,
	addToGroup,
	assignedGroups,
	groupedExtensionIds,
	groupsContaining,
	profilesFollowing,
	removeFromGroup,
	removeGroup,
	isTriggerPattern,
	setTriggers,
	triggeredGroups,
	commonToAllProfiles,
	planCleanup,
	promptKey,
	profileLayout,
	assignGroup,
	unassignGroup,
	excludeFromProfile,
	includeInProfile,
	excludedFrom,
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

suite('groupedExtensionIds', () => {
	test('is every extension of every group, lower-case and once', () => {
		const c: GroupsConfig = { groups: { web: ['A.One', 'b.two'], tools: ['a.one', 'C.Three'], empty: [] }, profiles: {} };
		assert.deepStrictEqual(groupedExtensionIds(c).sort(), ['a.one', 'b.two', 'c.three']);
	});

	test('no groups, no extensions', () => {
		assert.deepStrictEqual(groupedExtensionIds({ groups: {}, profiles: {} }), []);
	});
});

suite('removeGroup', () => {
	const c: GroupsConfig = {
		groups: { web: ['a.b'], tools: ['c.d'] },
		profiles: { '*': ['tools'], Python: ['web', 'tools'], Rust: ['web'] },
		triggers: { web: ['**/package.json'], tools: ['**/Makefile'] },
	};

	test('deletes the group, its triggers and every mention of it', () => {
		const next = removeGroup(c, 'web');
		assert.deepStrictEqual(next.groups, { tools: ['c.d'] });
		assert.deepStrictEqual(next.triggers, { tools: ['**/Makefile'] });
		assert.deepStrictEqual(next.profiles, { '*': ['tools'], Python: ['tools'] });
	});

	test('a profile left with no groups is dropped from the file', () => {
		assert.ok(!('Rust' in removeGroup(c, 'web').profiles));
	});

	test('leaves the original untouched, and drops the triggers key when none are left', () => {
		const noTriggers: GroupsConfig = { groups: { web: ['a.b'] }, profiles: {}, triggers: { web: ['**/x'] } };
		assert.ok(!('triggers' in removeGroup(noTriggers, 'web')));
		removeGroup(c, 'web');
		assert.deepStrictEqual(Object.keys(c.groups), ['web', 'tools']);
	});

	test('a group that does not exist is an error', () => {
		assert.throws(() => removeGroup(c, 'ghost'), /no group/i);
	});
});

suite('profileLayout', () => {
	const c: GroupsConfig = {
		groups: { web: ['A.One', 'b.two', 'c.three'], tools: ['d.four'], empty: [] },
		profiles: { '*': ['tools'], Python: ['web', 'ghost'] },
	};

	test('puts the groups the profile follows first, each with the extensions it has installed', () => {
		const layout = profileLayout(c, 'Python', ['a.one', 'b.two', 'd.four', 'x.other']);
		assert.deepStrictEqual(layout.groups.map(g => g.name), ['tools', 'web']);
		assert.deepStrictEqual(layout.groups.find(g => g.name === 'web')?.installed, ['a.one', 'b.two']);
		assert.deepStrictEqual(layout.groups.find(g => g.name === 'tools')?.installed, ['d.four']);
	});

	test('what is left over, in no followed group, comes after as the other extensions', () => {
		const layout = profileLayout(c, 'Python', ['a.one', 'd.four', 'x.other', 'y.other']);
		assert.deepStrictEqual(layout.others, ['x.other', 'y.other']);
	});

	test('a group reports how many extensions it has in all', () => {
		const web = profileLayout(c, 'Python', ['a.one']).groups.find(g => g.name === 'web');
		assert.strictEqual(web?.total, 3);
		assert.deepStrictEqual(web?.installed, ['a.one']);
	});

	test('ids match whatever their case, and keep the case the profile reports', () => {
		const layout = profileLayout(c, 'Python', ['A.ONE']);
		assert.deepStrictEqual(layout.groups.find(g => g.name === 'web')?.installed, ['A.ONE']);
		assert.deepStrictEqual(layout.others, []);
	});

	test('an extension in a group the profile does not follow stays among the others', () => {
		const layout = profileLayout(c, 'Agents', ['a.one', 'd.four']);
		assert.deepStrictEqual(layout.groups.map(g => g.name), ['tools']);
		assert.deepStrictEqual(layout.others, ['a.one']);
	});

	test('an extension in two followed groups shows under both and not among the others', () => {
		const both: GroupsConfig = { groups: { a: ['x.y'], b: ['x.y'] }, profiles: { P: ['a', 'b'] } };
		const layout = profileLayout(both, 'P', ['x.y']);
		assert.deepStrictEqual(layout.groups.map(g => g.installed), [['x.y'], ['x.y']]);
		assert.deepStrictEqual(layout.others, []);
	});

	test('a group that is followed but has nothing installed still shows, empty', () => {
		const layout = profileLayout(c, 'Python', []);
		assert.deepStrictEqual(layout.groups.map(g => [g.name, g.installed.length, g.total]), [['tools', 0, 1], ['web', 0, 3]]);
	});

	test('groups the file mentions but does not define are left out', () => {
		assert.ok(!profileLayout(c, 'Python', []).groups.some(g => g.name === 'ghost'));
	});

	test('the others are sorted by id, without caring about case', () => {
		const layout = profileLayout({ groups: {}, profiles: {} }, 'P', ['b.x', 'A.y', 'a.x']);
		assert.deepStrictEqual(layout.others, ['a.x', 'A.y', 'b.x']);
	});

	test('no groups at all: everything is among the others', () => {
		const layout = profileLayout({ groups: {}, profiles: {} }, 'P', ['a.b']);
		assert.deepStrictEqual(layout, { groups: [], others: ['a.b'] });
	});
});

suite('unassignGroup', () => {
	const c: GroupsConfig = {
		groups: { web: ['a.b'], tools: ['c.d'] },
		profiles: { '*': ['tools'], Python: ['web', 'tools'], Rust: ['web'] },
		triggers: { web: ['**/package.json'] },
	};

	test('the profile stops following the group, which stays as it was', () => {
		const next = unassignGroup(c, 'Python', 'web');
		assert.deepStrictEqual(next.profiles.Python, ['tools']);
		assert.deepStrictEqual(next.groups, c.groups);
		assert.deepStrictEqual(next.triggers, c.triggers);
	});

	test('other profiles keep the group', () => {
		assert.deepStrictEqual(unassignGroup(c, 'Python', 'web').profiles.Rust, ['web']);
	});

	test('a profile left with no groups is dropped from the file', () => {
		assert.ok(!('Rust' in unassignGroup(c, 'Rust', 'web').profiles));
	});

	test('"*" works like a profile: the group stops going to every profile', () => {
		const next = unassignGroup(c, ALL_PROFILES, 'tools');
		assert.ok(!(ALL_PROFILES in next.profiles));
		assert.deepStrictEqual(next.profiles.Python, ['web', 'tools']);
	});

	test('leaves the original untouched', () => {
		unassignGroup(c, 'Python', 'web');
		assert.deepStrictEqual(c.profiles.Python, ['web', 'tools']);
	});

	test('a profile that does not follow the group is an error', () => {
		assert.throws(() => unassignGroup(c, 'Rust', 'tools'), /does not follow/i);
		assert.throws(() => unassignGroup(c, 'Nobody', 'web'), /does not follow/i);
	});
});

suite('exclusions: an extension a profile does not want although its group has it', () => {
	const c: GroupsConfig = {
		groups: { web: ['a.b', 'c.d'], tools: ['e.f'] },
		profiles: { Python: ['web', 'tools'], Rust: ['web'] },
	};

	test('excludeFromProfile records it for that profile only, leaving the group and the other profiles alone', () => {
		const next = excludeFromProfile(c, 'Python', 'a.b');
		assert.deepStrictEqual(next.excludes, { Python: ['a.b'] });
		assert.deepStrictEqual(next.groups, c.groups);
		assert.deepStrictEqual(excludedFrom(next, 'Rust'), []);
		assert.strictEqual(c.excludes, undefined, 'the original is untouched');
	});

	test('it is recorded once, whatever the case', () => {
		const next = excludeFromProfile(excludeFromProfile(c, 'Python', 'A.B'), 'Python', 'a.b');
		assert.deepStrictEqual(next.excludes, { Python: ['A.B'] });
	});

	test('only a valid extension id and a profile name are accepted', () => {
		assert.throws(() => excludeFromProfile(c, 'Python', '--uninstall-extension'), /not a valid extension id/);
		assert.throws(() => excludeFromProfile(c, ' ', 'a.b'), /profile name is required/i);
	});

	test('includeInProfile takes it back, and drops the profile and then the whole key when nothing is left', () => {
		const two = excludeFromProfile(excludeFromProfile(c, 'Python', 'a.b'), 'Rust', 'a.b');
		assert.deepStrictEqual(includeInProfile(two, 'Python', 'A.B').excludes, { Rust: ['a.b'] });
		assert.ok(!('excludes' in includeInProfile(excludeFromProfile(c, 'Python', 'a.b'), 'Python', 'a.b')));
	});

	test('includeInProfile on something that was not excluded changes nothing', () => {
		assert.strictEqual(includeInProfile(c, 'Python', 'a.b'), c);
	});

	test('what a profile wants leaves out its exclusions, whatever the case', () => {
		const next = excludeFromProfile(c, 'Python', 'A.b');
		assert.deepStrictEqual(desiredExtensions(next, 'Python').ids, ['c.d', 'e.f']);
		assert.deepStrictEqual(desiredExtensions(next, 'Rust').ids, ['a.b', 'c.d']);
	});

	test('a sync does not install an excluded extension', () => {
		const plan = planSync(excludeFromProfile(c, 'Python', 'a.b'), 'Python', []);
		assert.deepStrictEqual(plan.toInstall, ['c.d', 'e.f']);
	});

	test('an excluded extension that is still installed is an extra of the profile', () => {
		const plan = planCleanup(excludeFromProfile(c, 'Python', 'a.b'), 'Python', ['a.b', 'c.d', 'e.f'], []);
		assert.deepStrictEqual(plan, { managed: true, extras: ['a.b'] });
	});

	test('every change to the groups keeps the exclusions', () => {
		const e = excludeFromProfile(c, 'Python', 'a.b');
		assert.deepStrictEqual(addToGroup(e, 'web', ['z.z']).excludes, e.excludes);
		assert.deepStrictEqual(assignGroup(e, 'Rust', 'tools').excludes, e.excludes);
		assert.deepStrictEqual(unassignGroup(e, 'Rust', 'web').excludes, e.excludes);
		assert.deepStrictEqual(removeFromGroup(e, 'web', 'c.d').excludes, e.excludes);
		assert.deepStrictEqual(removeGroup(e, 'tools').excludes, e.excludes);
		assert.deepStrictEqual(setTriggers(e, 'web', ['**/x']).excludes, e.excludes);
	});

	test('they are read from the file and written back', () => {
		const e = excludeFromProfile(c, 'Python', 'a.b');
		const back = parseGroups(serializeGroups(e));
		assert.deepStrictEqual(back.config.excludes, { Python: ['a.b'] });
		assert.deepStrictEqual(back.warnings, []);
		assert.ok(!serializeGroups(c).includes('excludes'), 'no key when there are none');
	});

	test('bad entries in the file are ignored with a warning', () => {
		const { config, warnings } = parseGroups(JSON.stringify({ groups: {}, profiles: {}, excludes: { A: 'x.y', B: ['ok.one', '--bad', 5], C: [] } }));
		assert.deepStrictEqual(config.excludes, { B: ['ok.one'] });
		assert.strictEqual(warnings.length, 3, warnings.join(' | '));
	});
});

suite('profileLayout with exclusions', () => {
	const c: GroupsConfig = {
		groups: { web: ['a.b', 'c.d', 'e.f'] },
		profiles: { P: ['web'] },
		excludes: { P: ['c.d'] },
	};

	test('an excluded extension still counts as one of the extensions of the group, so "2 of 3" tells the truth', () => {
		const layout = profileLayout(c, 'P', ['a.b', 'e.f']);
		assert.strictEqual(layout.groups[0].total, 3);
		assert.deepStrictEqual(layout.groups[0].installed, ['a.b', 'e.f']);
		assert.deepStrictEqual(layout.groups[0].excluded, ['c.d']);
	});

	test('but it is not missing: a sync would not install it', () => {
		assert.deepStrictEqual(profileLayout(c, 'P', ['a.b', 'e.f']).groups[0].missing, []);
		assert.deepStrictEqual(profileLayout(c, 'P', ['a.b']).groups[0].missing, ['e.f']);
	});

	test('one that is excluded but still installed stays in its group, not among the other extensions', () => {
		const layout = profileLayout(c, 'P', ['a.b', 'c.d']);
		assert.deepStrictEqual(layout.groups[0].installed, ['a.b', 'c.d']);
		assert.deepStrictEqual(layout.others, []);
	});

	test('the group lists what the profile lacks and does not want', () => {
		const layout = profileLayout(c, 'P', []);
		assert.deepStrictEqual(layout.groups[0].missing, ['a.b', 'e.f']);
		assert.deepStrictEqual(layout.groups[0].excluded, ['c.d']);
	});

	test('other profiles are not affected', () => {
		const other: GroupsConfig = { ...c, profiles: { P: ['web'], Q: ['web'] } };
		assert.strictEqual(profileLayout(other, 'Q', []).groups[0].total, 3);
		assert.deepStrictEqual(profileLayout(other, 'Q', []).groups[0].excluded, []);
		assert.deepStrictEqual(profileLayout(other, 'Q', []).groups[0].missing, ['a.b', 'c.d', 'e.f']);
	});
});
