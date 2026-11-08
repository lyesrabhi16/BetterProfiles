import * as assert from 'assert';
import * as zlib from 'zlib';
import { buildVsix, crc32, FixtureExtension } from '../../e2e/vsix';

/** Reads a zip the way any reader does, from its end: enough to check what buildVsix wrote. */
function readZip(zip: Buffer): Map<string, Buffer> {
	const entries = new Map<string, Buffer>();
	const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
	assert.ok(end >= 0, 'no end of central directory record');
	const count = zip.readUInt16LE(end + 10);
	let at = zip.readUInt32LE(end + 16);
	for (let i = 0; i < count; i++) {
		assert.strictEqual(zip.readUInt32LE(at), 0x02014b50, 'central directory entry');
		const method = zip.readUInt16LE(at + 10);
		const crc = zip.readUInt32LE(at + 16);
		const compressed = zip.readUInt32LE(at + 20);
		const size = zip.readUInt32LE(at + 24);
		const nameLength = zip.readUInt16LE(at + 28);
		const extraLength = zip.readUInt16LE(at + 30);
		const commentLength = zip.readUInt16LE(at + 32);
		const local = zip.readUInt32LE(at + 42);
		const name = zip.toString('utf8', at + 46, at + 46 + nameLength);
		assert.strictEqual(zip.readUInt32LE(local), 0x04034b50, 'local header of ' + name);
		const dataAt = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
		const raw = zip.subarray(dataAt, dataAt + compressed);
		const data = method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw);
		assert.strictEqual(data.length, size, 'size of ' + name);
		assert.strictEqual(crc32(data), crc, 'crc of ' + name);
		entries.set(name, data);
		at += 46 + nameLength + extraLength + commentLength;
	}
	return entries;
}

const base: FixtureExtension = { publisher: 'bptest', name: 'base', version: '1.0.0' };

suite('crc32', () => {
	test('is the checksum zip files use (known values)', () => {
		assert.strictEqual(crc32(Buffer.from('')), 0);
		assert.strictEqual(crc32(Buffer.from('123456789')), 0xcbf43926);
		assert.strictEqual(crc32(Buffer.from('a')), 0xe8b7be43);
	});
});

suite('buildVsix', () => {
	test('is a valid zip whose entries all check out', () => {
		const entries = readZip(buildVsix(base));
		assert.deepStrictEqual([...entries.keys()].sort(), ['[Content_Types].xml', 'extension.vsixmanifest', 'extension/README.md', 'extension/extension.js', 'extension/package.json'].sort());
	});

	test('the extension\'s manifest names it, with an entry point and no activation, so that it never runs', () => {
		const manifest = JSON.parse(readZip(buildVsix({ ...base, displayName: 'Base Thing' })).get('extension/package.json')!.toString());
		assert.strictEqual(manifest.name, 'base');
		assert.strictEqual(manifest.publisher, 'bptest');
		assert.strictEqual(manifest.version, '1.0.0');
		assert.strictEqual(manifest.displayName, 'Base Thing');
		assert.deepStrictEqual(manifest.activationEvents, []);
		assert.ok(manifest.main && manifest.engines.vscode);
	});

	test('the package manifest carries identity, dependencies and the engine', () => {
		const xml = readZip(buildVsix({ ...base, name: 'dependant', dependencies: ['bptest.base'] })).get('extension.vsixmanifest')!.toString();
		assert.ok(xml.includes('Id="dependant"') && xml.includes('Publisher="bptest"') && xml.includes('Version="1.0.0"'), xml);
		assert.ok(xml.includes('Microsoft.VisualStudio.Code.ExtensionDependencies" Value="bptest.base"'), xml);
		assert.ok(/Microsoft\.VisualStudio\.Code\.Engine" Value="\^1\./.test(xml), xml);
	});

	test('dependencies are also in the extension\'s own manifest', () => {
		const manifest = JSON.parse(readZip(buildVsix({ ...base, dependencies: ['x.y', 'a.b'] })).get('extension/package.json')!.toString());
		assert.deepStrictEqual(manifest.extensionDependencies, ['x.y', 'a.b']);
	});

	test('what goes into the XML is escaped', () => {
		const xml = readZip(buildVsix({ ...base, displayName: 'A & B <"x">' })).get('extension.vsixmanifest')!.toString();
		assert.ok(xml.includes('A &amp; B &lt;&quot;x&quot;&gt;'), xml);
		assert.ok(!xml.includes('<"x">'));
	});

	test('the same input gives the same bytes: a fixture is stable', () => {
		assert.deepStrictEqual(buildVsix(base), buildVsix(base));
	});

	test('an id that could not be an extension id is refused, so a fixture cannot be a path', () => {
		for (const bad of [{ ...base, publisher: '../x' }, { ...base, name: 'a b' }, { ...base, version: 'one' }]) {
			assert.throws(() => buildVsix(bad), /invalid/i);
		}
	});

	test('an extension can carry an icon, which is then in the package and named in its manifest', () => {
		const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
		const entries = readZip(buildVsix({ ...base, icon: png }));
		assert.deepStrictEqual(entries.get('extension/icon.png'), png);
		assert.strictEqual(JSON.parse(entries.get('extension/package.json')!.toString()).icon, 'icon.png');
	});
});
