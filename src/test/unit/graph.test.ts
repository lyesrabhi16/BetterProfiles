import * as assert from 'assert';
import { GraphModel, buildGraph } from '../../graph';
import { GroupsConfig } from '../../groups';

const config: GroupsConfig = {
	groups: { web: ['A.One', 'b.two'], tools: ['b.two', 'c.three'], empty: [], lonely: ['d.four'] },
	profiles: { '*': ['tools'], Python: ['web', 'ghost'], Rust: ['web', 'tools'] },
};
const PROFILES = ['Default', 'Python', 'Rust'];

const ids = (g: GraphModel, kind: string) => g.nodes.filter(n => n.kind === kind).map(n => n.id);
const edgeKeys = (g: GraphModel) => g.edges.map(e => `${e.from}>${e.to}${e.all ? '*' : ''}`).sort();
const node = (g: GraphModel, id: string) => g.nodes.find(n => n.id === id)!;

suite('buildGraph nodes', () => {
	test('one node for every extension that is in a group, every group and every profile', () => {
		const g = buildGraph(config, PROFILES);
		assert.deepStrictEqual(ids(g, 'extension'), ['extension:a.one', 'extension:b.two', 'extension:c.three', 'extension:d.four']);
		assert.deepStrictEqual(ids(g, 'group'), ['group:web', 'group:tools', 'group:empty', 'group:lonely']);
		assert.deepStrictEqual(ids(g, 'profile'), ['profile:Default', 'profile:Python', 'profile:Rust']);
	});

	test('an extension in two groups is one node, ids matching without regard to case', () => {
		const g = buildGraph({ groups: { a: ['X.Y'], b: ['x.y'] }, profiles: {} }, []);
		assert.deepStrictEqual(ids(g, 'extension'), ['extension:x.y']);
		assert.strictEqual(node(g, 'extension:x.y').extensionId, 'X.Y', 'keeps the first spelling');
	});

	test('an extension is labelled by its id unless described, and the extension id is kept for opening it', () => {
		const g = buildGraph(config, PROFILES, { describe: id => (id === 'b.two' ? { label: 'Bee Two', icon: 'icon://b' } : undefined) });
		assert.strictEqual(node(g, 'extension:b.two').label, 'Bee Two');
		assert.strictEqual(node(g, 'extension:b.two').icon, 'icon://b');
		assert.strictEqual(node(g, 'extension:c.three').label, 'c.three');
		assert.strictEqual(node(g, 'extension:c.three').icon, undefined);
		assert.strictEqual(node(g, 'extension:a.one').extensionId, 'A.One');
	});

	test('extensions are sorted by what is shown, groups keep the order of the file, profiles the order given', () => {
		const g = buildGraph({ groups: { z: ['p.zed', 'p.alpha'], a: [] }, profiles: {} }, ['B', 'A'], { describe: id => ({ label: id === 'p.zed' ? 'Aardvark' : 'Zebra' }) });
		assert.deepStrictEqual(ids(g, 'extension'), ['extension:p.zed', 'extension:p.alpha']);
		assert.deepStrictEqual(ids(g, 'group'), ['group:z', 'group:a']);
		assert.deepStrictEqual(ids(g, 'profile'), ['profile:B', 'profile:A']);
	});

	test('the current profile is marked', () => {
		const g = buildGraph(config, PROFILES, { current: 'Python' });
		assert.deepStrictEqual(g.nodes.filter(n => n.current).map(n => n.id), ['profile:Python']);
	});

	test('a group says how many extensions it has', () => {
		const g = buildGraph(config, PROFILES);
		assert.strictEqual(node(g, 'group:web').detail, '2 extensions');
		assert.strictEqual(node(g, 'group:lonely').detail, '1 extension');
		assert.strictEqual(node(g, 'group:empty').detail, '0 extensions');
	});

	test('nothing in the file: only the profiles', () => {
		const g = buildGraph({ groups: {}, profiles: {} }, PROFILES);
		assert.deepStrictEqual(g.nodes.map(n => n.kind), ['profile', 'profile', 'profile']);
		assert.deepStrictEqual(g.edges, []);
	});
});

suite('buildGraph edges', () => {
	test('an extension points to each group it is in', () => {
		const g = buildGraph(config, PROFILES);
		const fromExtensions = edgeKeys(g).filter(k => k.startsWith('extension:'));
		assert.deepStrictEqual(fromExtensions, ['extension:a.one>group:web', 'extension:b.two>group:tools', 'extension:b.two>group:web', 'extension:c.three>group:tools', 'extension:d.four>group:lonely']);
	});

	test('a group points to the profiles that follow it; the ones that go to every profile are marked', () => {
		const g = buildGraph(config, PROFILES);
		const toProfiles = edgeKeys(g).filter(k => k.startsWith('group:'));
		assert.deepStrictEqual(toProfiles, [
			'group:tools>profile:Default*', 'group:tools>profile:Python*', 'group:tools>profile:Rust',
			'group:web>profile:Python', 'group:web>profile:Rust',
		]);
	});

	test('a group that a profile follows by itself and through all profiles is one edge, the profile\'s own', () => {
		const g = buildGraph({ groups: { t: ['a.b'] }, profiles: { '*': ['t'], P: ['t'] } }, ['P', 'Q']);
		assert.deepStrictEqual(edgeKeys(g).filter(k => k.startsWith('group:')), ['group:t>profile:P', 'group:t>profile:Q*']);
	});

	test('a group the file gives to a profile but does not define has no node and no edge', () => {
		const g = buildGraph(config, PROFILES);
		assert.ok(!g.nodes.some(n => n.id === 'group:ghost'));
		assert.ok(!g.edges.some(e => e.from === 'group:ghost' || e.to === 'group:ghost'));
	});

	test('a profile the file names but that does not exist (any more) has no node and no edge', () => {
		const g = buildGraph({ groups: { a: ['x.y'] }, profiles: { Deleted: ['a'] } }, ['Default']);
		assert.ok(!g.nodes.some(n => n.id === 'profile:Deleted'));
		assert.deepStrictEqual(edgeKeys(g), ['extension:x.y>group:a']);
	});

	test('every edge joins two nodes that exist', () => {
		const g = buildGraph(config, PROFILES);
		const known = new Set(g.nodes.map(n => n.id));
		assert.ok(g.edges.every(e => known.has(e.from) && known.has(e.to)));
	});
});

suite('buildGraph related', () => {
	const g = buildGraph(config, PROFILES);
	const related = (id: string) => [...node(g, id).related].sort();

	test('an extension is related to its groups and the profiles that get them', () => {
		assert.deepStrictEqual(related('extension:a.one'), ['extension:a.one', 'group:web', 'profile:Python', 'profile:Rust']);
	});

	test('an extension in groups with different followers is related to all of them', () => {
		assert.deepStrictEqual(related('extension:b.two'), ['extension:b.two', 'group:tools', 'group:web', 'profile:Default', 'profile:Python', 'profile:Rust']);
	});

	test('a group is related to its extensions and its profiles', () => {
		assert.deepStrictEqual(related('group:web'), ['extension:a.one', 'extension:b.two', 'group:web', 'profile:Python', 'profile:Rust']);
	});

	test('a profile is related to the groups it follows and the extensions in them', () => {
		assert.deepStrictEqual(related('profile:Default'), ['extension:b.two', 'extension:c.three', 'group:tools', 'profile:Default']);
	});

	test('a group nobody follows, or with no extensions, is related to what it does have', () => {
		assert.deepStrictEqual(related('group:lonely'), ['extension:d.four', 'group:lonely']);
		assert.deepStrictEqual(related('group:empty'), ['group:empty']);
	});

	test('a profile with no groups is related to itself only', () => {
		const alone = buildGraph({ groups: { a: ['x.y'] }, profiles: {} }, ['P']);
		assert.deepStrictEqual(alone.nodes.find(n => n.id === 'profile:P')!.related, ['profile:P']);
	});
});
