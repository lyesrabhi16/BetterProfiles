import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ExtensionCatalog, pickFolder, resolveNls } from '../../catalog';

suite('resolveNls', () => {
	test('plain text is returned as it is', () => {
		assert.strictEqual(resolveNls('Better Comments'), 'Better Comments');
	});

	test('a %key% placeholder is looked up in the nls file', () => {
		assert.strictEqual(resolveNls('%displayName%', { displayName: 'Installed Thing' }), 'Installed Thing');
	});

	test('the { message, comment } form is understood', () => {
		assert.strictEqual(resolveNls('%displayName%', { displayName: { message: 'With A Message', comment: ['x'] } }), 'With A Message');
	});

	test('a placeholder that cannot be resolved gives nothing, so the caller can fall back', () => {
		assert.strictEqual(resolveNls('%missing%', { other: 'x' }), undefined);
		assert.strictEqual(resolveNls('%missing%'), undefined);
	});

	test('anything that is not text gives nothing', () => {
		for (const value of [undefined, null, 5, {}, [], '']) {
			assert.strictEqual(resolveNls(value), undefined, JSON.stringify(value));
		}
	});
});

suite('pickFolder', () => {
	const folders = ['a.b-1.0.0', 'a.b-1.10.0', 'a.b-1.9.0', 'a.b-c.d-2.0.0', 'ms-python.debugpy-2026.7.1-linux-x64', 'github.copilot-1.2.3', 'x.y-3.0.0'];

	test('the exact version when it is there', () => {
		assert.strictEqual(pickFolder(folders, 'a.b', '1.9.0'), 'a.b-1.9.0');
	});

	test('a version from the CLI with a platform (id@version@platform) matches its platform-specific folder', () => {
		assert.strictEqual(pickFolder(folders, 'ms-python.debugpy', '2026.7.1@linux-x64'), 'ms-python.debugpy-2026.7.1-linux-x64');
	});

	test('the id is compared case-insensitively, since folders are lower-case', () => {
		assert.strictEqual(pickFolder(folders, 'GitHub.Copilot', '1.2.3'), 'github.copilot-1.2.3');
	});

	test('without a version, or when that version is gone, the latest one, comparing numbers and not text', () => {
		assert.strictEqual(pickFolder(folders, 'a.b'), 'a.b-1.10.0');
		assert.strictEqual(pickFolder(folders, 'a.b', '0.0.1'), 'a.b-1.10.0');
	});

	test('a longer id that merely starts with the id is not the same extension', () => {
		assert.strictEqual(pickFolder(['a.b-c.d-2.0.0'], 'a.b'), undefined);
	});

	test('an extension that is not there gives nothing', () => {
		assert.strictEqual(pickFolder(folders, 'no.such'), undefined);
		assert.strictEqual(pickFolder([], 'a.b'), undefined);
	});
});

suite('ExtensionCatalog', () => {
	let dir: string;
	const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

	const install = (folder: string, manifest: object | string, extra: Record<string, string | Buffer> = {}) => {
		fs.mkdirSync(path.join(dir, folder), { recursive: true });
		fs.writeFileSync(path.join(dir, folder, 'package.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
		for (const [name, content] of Object.entries(extra)) {
			fs.mkdirSync(path.dirname(path.join(dir, folder, name)), { recursive: true });
			fs.writeFileSync(path.join(dir, folder, name), content);
		}
	};

	setup(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-catalog-'));
	});
	teardown(() => fs.rmSync(dir, { recursive: true, force: true }));

	test('reads the display name, publisher, description, version and the icon like the Extensions list shows them', async () => {
		install('aaron-bond.better-comments-3.1.1', { name: 'better-comments', displayName: 'Better Comments', publisher: 'aaron-bond', version: '3.1.1', description: 'Improve your code commenting', icon: 'images/icon.png' }, { 'images/icon.png': PNG });
		const info = await new ExtensionCatalog(() => dir).lookup('aaron-bond.better-comments', '3.1.1');
		assert.deepStrictEqual(info, {
			name: 'Better Comments',
			publisher: 'aaron-bond',
			description: 'Improve your code commenting',
			version: '3.1.1',
			iconPath: path.join(dir, 'aaron-bond.better-comments-3.1.1', 'images', 'icon.png'),
		});
	});

	test('a localised display name is resolved through package.nls.json', async () => {
		install('p.installed-1.0.0', { name: 'installed', displayName: '%displayName%', publisher: 'p', version: '1.0.0', description: '%description%' }, { 'package.nls.json': JSON.stringify({ displayName: 'Installed Thing', description: { message: 'Does things' } }) });
		const info = await new ExtensionCatalog(() => dir).lookup('p.installed');
		assert.strictEqual(info?.name, 'Installed Thing');
		assert.strictEqual(info?.description, 'Does things');
	});

	test('without a display name the name is used, and an unresolvable placeholder falls back to it', async () => {
		install('x.plain-2.0.0', { name: 'plain', publisher: 'x', version: '2.0.0' });
		install('x.broken-nls-1.0.0', { name: 'broken-nls', displayName: '%gone%', publisher: 'x', version: '1.0.0' });
		const catalog = new ExtensionCatalog(() => dir);
		assert.strictEqual((await catalog.lookup('x.plain'))?.name, 'plain');
		assert.strictEqual((await catalog.lookup('x.broken-nls'))?.name, 'broken-nls');
	});

	test('no icon, or an icon file that is missing, gives no icon path', async () => {
		install('x.noicon-1.0.0', { name: 'noicon', publisher: 'x', version: '1.0.0' });
		install('x.gone-icon-1.0.0', { name: 'gone-icon', publisher: 'x', version: '1.0.0', icon: 'icon.png' });
		const catalog = new ExtensionCatalog(() => dir);
		assert.strictEqual((await catalog.lookup('x.noicon'))?.iconPath, undefined);
		assert.strictEqual((await catalog.lookup('x.gone-icon'))?.iconPath, undefined);
	});

	test('an icon that points outside the extension folder is ignored', async () => {
		fs.writeFileSync(path.join(dir, 'secret.png'), PNG);
		install('x.sneaky-1.0.0', { name: 'sneaky', publisher: 'x', version: '1.0.0', icon: '../secret.png' });
		install('x.absolute-1.0.0', { name: 'absolute', publisher: 'x', version: '1.0.0', icon: path.join(dir, 'secret.png') });
		const catalog = new ExtensionCatalog(() => dir);
		assert.strictEqual((await catalog.lookup('x.sneaky'))?.iconPath, undefined);
		assert.strictEqual((await catalog.lookup('x.absolute'))?.iconPath, undefined);
	});

	test('a broken manifest, an unknown id and a missing folder all give nothing, without an error', async () => {
		install('x.broken-1.0.0', '{ nope');
		const catalog = new ExtensionCatalog(() => dir);
		assert.strictEqual(await catalog.lookup('x.broken'), undefined);
		assert.strictEqual(await catalog.lookup('no.such'), undefined);
		assert.strictEqual(await new ExtensionCatalog(() => path.join(dir, 'does-not-exist')).lookup('x.broken'), undefined);
		assert.strictEqual(await new ExtensionCatalog(() => undefined).lookup('x.broken'), undefined);
	});

	test('what was read is kept until clear(), which makes it look at the folder again', async () => {
		const catalog = new ExtensionCatalog(() => dir);
		assert.strictEqual(await catalog.lookup('late.comer'), undefined);
		install('late.comer-1.0.0', { name: 'late-comer', displayName: 'Late Comer', publisher: 'late', version: '1.0.0' });
		assert.strictEqual(await catalog.lookup('late.comer'), undefined, 'still the old answer');
		catalog.clear();
		assert.strictEqual((await catalog.lookup('late.comer'))?.name, 'Late Comer');
	});

	test('the folder is read again when the extensions directory changes', async () => {
		install('x.here-1.0.0', { name: 'here', publisher: 'x', version: '1.0.0' });
		let current: string | undefined = path.join(dir, 'other');
		const catalog = new ExtensionCatalog(() => current);
		assert.strictEqual(await catalog.lookup('x.here'), undefined);
		current = dir;
		assert.strictEqual((await catalog.lookup('x.here'))?.name, 'here');
	});
});
