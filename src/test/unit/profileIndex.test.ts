import * as assert from 'assert';
import * as path from 'path';
import { indexPath, listFromIndexes, parseProfileIndex } from '../../profileIndex';

// Shape copied from the extensions.json VS Code writes for a profile (checked against `code --list-extensions`).
const entry = (id: string, version: string, extra: Record<string, unknown> = {}, metadata: Record<string, unknown> = {}) => ({
	identifier: { id },
	version,
	location: { $mid: 1, path: `/ext/${id}-${version}`, scheme: 'file' },
	relativeLocation: `${id}-${version}`,
	metadata: { isApplicationScoped: false, installedTimestamp: 1793816148760, ...metadata },
	...extra,
});

suite('parseProfileIndex', () => {
	test('reads the id, the version and the folder of each extension', () => {
		const parsed = parseProfileIndex(JSON.stringify([entry('tyriar.lorem-ipsum', '1.3.1'), entry('a.b', '2.0.0')]));
		assert.deepStrictEqual(parsed, [
			{ id: 'tyriar.lorem-ipsum', version: '1.3.1', folder: 'tyriar.lorem-ipsum-1.3.1', applicationScoped: false },
			{ id: 'a.b', version: '2.0.0', folder: 'a.b-2.0.0', applicationScoped: false },
		]);
	});

	test('an empty file is an empty profile', () => {
		assert.deepStrictEqual(parseProfileIndex('[]'), []);
		assert.deepStrictEqual(parseProfileIndex(''), []);
	});

	test('a platform-specific install is shown the way the command line shows it', () => {
		const [a, b, c] = parseProfileIndex(JSON.stringify([
			entry('x.native', '1.2.3', {}, { targetPlatform: 'linux-x64' }),
			entry('x.universal', '1.0.0', {}, { targetPlatform: 'universal' }),
			entry('x.undefined', '1.0.0', {}, { targetPlatform: 'undefined' }),
		]));
		assert.strictEqual(a.version, '1.2.3@linux-x64');
		assert.strictEqual(b.version, '1.0.0');
		assert.strictEqual(c.version, '1.0.0');
	});

	test('application-scoped extensions are marked', () => {
		const [a] = parseProfileIndex(JSON.stringify([entry('a.b', '1.0.0', {}, { isApplicationScoped: true })]));
		assert.strictEqual(a.applicationScoped, true);
	});

	test('entries that are not extensions are skipped, the others kept', () => {
		const parsed = parseProfileIndex(JSON.stringify([null, 'x', {}, { identifier: {} }, { identifier: { id: 5 } }, { identifier: { id: '--evil' } }, entry('a.b', '1.0.0')]));
		assert.deepStrictEqual(parsed.map(e => e.id), ['a.b']);
	});

	test('a folder that could leave the extensions folder is not trusted', () => {
		const [a, b] = parseProfileIndex(JSON.stringify([entry('a.b', '1.0.0', { relativeLocation: '../../etc' }), entry('c.d', '1.0.0', { relativeLocation: '/abs' })]));
		assert.strictEqual(a.folder, undefined);
		assert.strictEqual(b.folder, undefined);
	});

	test('anything but a list, or invalid JSON, throws so that the caller can ask the command line instead', () => {
		assert.throws(() => parseProfileIndex('{ "not": "a list" }'));
		assert.throws(() => parseProfileIndex('{ broken'));
	});
});

suite('listFromIndexes', () => {
	const own = parseProfileIndex(JSON.stringify([entry('a.b', '1.0.0')]));
	const defaults = parseProfileIndex(JSON.stringify([entry('d.one', '1.0.0'), entry('app.wide', '5.0.0', {}, { isApplicationScoped: true })]));

	test('the default profile has what its own file lists', () => {
		assert.deepStrictEqual(listFromIndexes(defaults, undefined).map(e => e.id), ['d.one', 'app.wide']);
	});

	test('another profile has its own, and the application-scoped extensions of the default profile: VS Code installs those once for all', () => {
		assert.deepStrictEqual(listFromIndexes(own, defaults).map(e => e.id), ['a.b', 'app.wide']);
	});

	test('one that both list is there once, the profile\'s own version winning', () => {
		const both = parseProfileIndex(JSON.stringify([entry('app.wide', '6.0.0')]));
		const merged = listFromIndexes(both, defaults);
		assert.deepStrictEqual(merged.map(e => [e.id, e.version]), [['app.wide', '6.0.0']]);
	});

	test('what is returned has the form of the command line list: an id and a version', () => {
		assert.deepStrictEqual(listFromIndexes(own, undefined), [{ id: 'a.b', version: '1.0.0', folder: 'a.b-1.0.0', applicationScoped: false }]);
	});
});

suite('listFromIndexes and "applied to all profiles"', () => {
	test('what VS Code applies to all profiles is marked in every list it appears in', () => {
		const flagged = parseProfileIndex(JSON.stringify([entry('app.wide', '5.0.0', {}, { isApplicationScoped: true }), entry('d.one', '1.0.0')]));
		const named = parseProfileIndex(JSON.stringify([entry('a.b', '1.0.0')]));
		assert.deepStrictEqual(listFromIndexes(flagged, undefined).map(e => [e.id, e.applicationScoped]), [['app.wide', true], ['d.one', false]]);
		assert.deepStrictEqual(listFromIndexes(named, flagged).map(e => [e.id, e.applicationScoped]), [['a.b', false], ['app.wide', true]]);
	});
});

suite('an extension both lists, one of them saying VS Code applies it to all profiles', () => {
	test('it counts as applied to all profiles, whichever file says it, with the profile\'s own version', () => {
		const own = parseProfileIndex(JSON.stringify([entry('app.wide', '6.0.0')]));
		const defaults = parseProfileIndex(JSON.stringify([entry('app.wide', '5.0.0', {}, { isApplicationScoped: true })]));
		assert.deepStrictEqual(listFromIndexes(own, defaults).map(e => [e.id, e.version, e.applicationScoped]), [['app.wide', '6.0.0', true]]);
	});

	test('one the default profile lists without the flag does not make the profile\'s copy applied to all', () => {
		const own = parseProfileIndex(JSON.stringify([entry('a.b', '1.0.0')]));
		const defaults = parseProfileIndex(JSON.stringify([entry('a.b', '1.0.0')]));
		assert.deepStrictEqual(listFromIndexes(own, defaults).map(e => e.applicationScoped), [false]);
	});
});

suite('indexPath', () => {
	const base = { extensionsDir: '/home/u/.vscode/extensions', userDataDir: '/home/u/.config/Code', defaultName: 'Default' };

	test('the default profile keeps its list in the extensions folder', () => {
		assert.strictEqual(indexPath({ ...base, profile: 'Default', locationOf: () => undefined }), path.join('/home/u/.vscode/extensions', 'extensions.json'));
	});

	test('another profile keeps it in its own folder under the user data folder', () => {
		assert.strictEqual(indexPath({ ...base, profile: 'Python', locationOf: name => (name === 'Python' ? '25bf4367' : undefined) }), path.join('/home/u/.config/Code', 'User', 'profiles', '25bf4367', 'extensions.json'));
	});

	test('a profile VS Code has not recorded has no known file', () => {
		assert.strictEqual(indexPath({ ...base, profile: 'Ghost', locationOf: () => undefined }), undefined);
	});

	test('a location that is not a plain folder name is refused', () => {
		for (const location of ['../x', 'a/b', '', '/abs', '..']) {
			assert.strictEqual(indexPath({ ...base, profile: 'P', locationOf: () => location }), undefined, location);
		}
	});

	test('without the folders there is no file', () => {
		assert.strictEqual(indexPath({ ...base, extensionsDir: undefined, profile: 'Default', locationOf: () => undefined }), undefined);
		assert.strictEqual(indexPath({ ...base, userDataDir: undefined, profile: 'P', locationOf: () => 'x' }), undefined);
	});
});
