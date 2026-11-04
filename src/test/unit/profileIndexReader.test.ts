import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ProfileIndexReader } from '../../profileIndexReader';

const entry = (id: string, version = '1.0.0') => ({ identifier: { id }, version, relativeLocation: `${id}-${version}`, metadata: { isApplicationScoped: false } });

suite('ProfileIndexReader', () => {
	let dir: string;
	let file: string;
	setup(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-index-'));
		file = path.join(dir, 'extensions.json');
	});
	teardown(() => fs.rmSync(dir, { recursive: true, force: true }));

	const write = (list: unknown[], mtimeSeconds?: number) => {
		fs.writeFileSync(file, JSON.stringify(list));
		if (mtimeSeconds !== undefined) {
			fs.utimesSync(file, mtimeSeconds, mtimeSeconds);
		}
	};

	test('reads the file', async () => {
		write([entry('a.b')]);
		const reader = new ProfileIndexReader();
		assert.deepStrictEqual((await reader.read(file))?.map(e => e.id), ['a.b']);
	});

	test('a file that did not change since the last read is not read again, only looked at', async () => {
		write([entry('a.b')], 1_000_000);
		const reader = new ProfileIndexReader();
		await reader.read(file);
		await reader.read(file);
		await reader.read(file);
		assert.strictEqual(reader.stats.reads, 1);
		assert.strictEqual(reader.stats.looks, 3);
	});

	test('a file that changed is read again, and only that one', async () => {
		const other = path.join(dir, 'other.json');
		write([entry('a.b')], 1_000_000);
		fs.writeFileSync(other, JSON.stringify([entry('c.d')]));
		const reader = new ProfileIndexReader();
		await reader.read(file);
		await reader.read(other);
		write([entry('a.b'), entry('x.y')], 1_000_100);
		assert.deepStrictEqual((await reader.read(file))?.map(e => e.id), ['a.b', 'x.y']);
		await reader.read(other);
		assert.strictEqual(reader.stats.reads, 3, 'two first reads and the one that changed');
	});

	test('a change of size is noticed even when the time did not move', async () => {
		write([entry('a.b')], 1_000_000);
		const reader = new ProfileIndexReader();
		await reader.read(file);
		write([entry('a.b'), entry('x.y')], 1_000_000);
		assert.strictEqual((await reader.read(file))?.length, 2);
	});

	test('a missing file is an empty profile, not an error', async () => {
		const reader = new ProfileIndexReader();
		assert.deepStrictEqual(await reader.read(path.join(dir, 'nope.json')), []);
	});

	test('a file that cannot be understood gives undefined, so that the caller asks the command line', async () => {
		fs.writeFileSync(file, '{ broken');
		const reader = new ProfileIndexReader();
		assert.strictEqual(await reader.read(file), undefined);
		fs.writeFileSync(file, '{"not":"a list"}');
		assert.strictEqual(await reader.read(file), undefined);
	});

	test('forget makes the next read read the file', async () => {
		write([entry('a.b')], 1_000_000);
		const reader = new ProfileIndexReader();
		await reader.read(file);
		reader.forget(file);
		await reader.read(file);
		assert.strictEqual(reader.stats.reads, 2);
	});

	test('what is returned cannot be changed behind the reader\'s back', async () => {
		write([entry('a.b')], 1_000_000);
		const reader = new ProfileIndexReader();
		const first = (await reader.read(file))!;
		first.pop();
		assert.strictEqual((await reader.read(file))?.length, 1);
	});
});
