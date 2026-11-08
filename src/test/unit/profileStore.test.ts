import * as assert from 'assert';
import { InstalledExtension } from '../../cli';
import { ProfileStore } from '../../profileStore';

/** A store over fake profiles; `fetches` says how often each was read. */
function makeStore(initial: Record<string, InstalledExtension[]>, options: { now?: () => number } = {}) {
	const state: Record<string, InstalledExtension[]> = JSON.parse(JSON.stringify(initial));
	const fetches: string[] = [];
	let fail = false;
	const store = new ProfileStore(async profile => {
		fetches.push(profile);
		if (fail) {
			throw new Error('cli down');
		}
		await Promise.resolve();
		return JSON.parse(JSON.stringify(state[profile] ?? []));
	}, options);
	return { store, state, fetches, failNext: (value: boolean) => { fail = value; } };
}

const ids = (list: { id: string }[]) => list.map(e => e.id);

suite('ProfileStore lists', () => {
	test('reads a profile once and keeps it', async () => {
		const { store, fetches } = makeStore({ P: [{ id: 'a.b', version: '1.0.0' }] });
		assert.deepStrictEqual(ids(await store.list('P')), ['a.b']);
		await store.list('P');
		assert.deepStrictEqual(fetches, ['P']);
	});

	test('two asks at the same time share one read', async () => {
		const { store, fetches } = makeStore({ P: [{ id: 'a.b' }] });
		await Promise.all([store.list('P'), store.list('P')]);
		assert.strictEqual(fetches.length, 1);
	});

	test('a failed read is not kept, and the next ask reads again', async () => {
		const { store, fetches, failNext } = makeStore({ P: [{ id: 'a.b' }] });
		failNext(true);
		await assert.rejects(store.list('P'), /cli down/);
		failNext(false);
		assert.deepStrictEqual(ids(await store.list('P')), ['a.b']);
		assert.strictEqual(fetches.length, 2);
	});

	test('peek answers at once with what is known, and nothing before it was read', async () => {
		const { store } = makeStore({ P: [{ id: 'a.b' }] });
		assert.strictEqual(store.peek('P'), undefined);
		await store.list('P');
		assert.deepStrictEqual(ids(store.peek('P')!), ['a.b']);
	});

	test('a list read a moment ago can be asked for as fresh enough, an older one is read again', async () => {
		let now = 1000;
		const { store, fetches } = makeStore({ P: [{ id: 'a.b' }] }, { now: () => now });
		await store.list('P');
		now += 2000;
		await store.list('P', { maxAgeMs: 3000 });
		assert.strictEqual(fetches.length, 1, 'young enough');
		now += 2000;
		await store.list('P', { maxAgeMs: 3000 });
		assert.strictEqual(fetches.length, 2, 'too old');
	});

	test('invalidate makes the next ask read again, for one profile or for all', async () => {
		const { store, fetches } = makeStore({ P: [{ id: 'a.b' }], Q: [{ id: 'c.d' }] });
		await Promise.all([store.list('P'), store.list('Q')]);
		store.invalidate('P');
		await Promise.all([store.list('P'), store.list('Q')]);
		assert.deepStrictEqual(fetches, ['P', 'Q', 'P']);
		store.invalidate();
		await Promise.all([store.list('P'), store.list('Q')]);
		assert.strictEqual(fetches.length, 5);
	});
});

suite('ProfileStore pending changes', () => {
	test('an extension being installed is shown at once, marked, after what is there', async () => {
		const { store } = makeStore({ P: [{ id: 'a.b', version: '1.0.0' }] });
		store.installing('P', ['x.y']);
		assert.deepStrictEqual(await store.entries('P'), [{ id: 'a.b', version: '1.0.0' }, { id: 'x.y', installing: true }]);
	});

	test('one already there is not shown twice, whatever the case', async () => {
		const { store } = makeStore({ P: [{ id: 'A.B', version: '1.0.0' }] });
		store.installing('P', ['a.b']);
		assert.deepStrictEqual(ids(await store.entries('P')), ['A.B']);
	});

	test('an extension being removed is hidden at once', async () => {
		const { store } = makeStore({ P: [{ id: 'a.b' }, { id: 'c.d' }] });
		store.removing('P', ['C.D']);
		assert.deepStrictEqual(ids(await store.entries('P')), ['a.b']);
	});

	test('settling puts things back as they are: a removal that did not happen shows the extension again, an install that did not happen drops it', async () => {
		const { store } = makeStore({ P: [{ id: 'a.b' }] });
		store.removing('P', ['a.b']);
		store.installing('P', ['x.y']);
		store.settle('P', ['a.b', 'x.y']);
		assert.deepStrictEqual(ids(await store.entries('P')), ['a.b']);
	});

	test('added: the install happened, so it is in the list for good and no longer marked', async () => {
		const { store } = makeStore({ P: [{ id: 'a.b' }] });
		store.installing('P', ['x.y']);
		store.added('P', ['x.y']);
		assert.deepStrictEqual(await store.entries('P'), [{ id: 'a.b' }, { id: 'x.y' }]);
	});

	test('removed: the uninstall happened, so it is out of the list for good and no longer marked', async () => {
		const { store } = makeStore({ P: [{ id: 'a.b' }, { id: 'c.d' }] });
		store.removing('P', ['c.d']);
		store.removed('P', ['c.d']);
		assert.deepStrictEqual(ids(await store.entries('P')), ['a.b']);
		assert.deepStrictEqual(ids(await store.list('P')), ['a.b']);
	});

	test('added and removed work on a list that was not read yet: the read comes first', async () => {
		const { store } = makeStore({ P: [{ id: 'a.b' }, { id: 'c.d' }] });
		store.removed('P', ['c.d']);
		store.added('P', ['x.y']);
		assert.deepStrictEqual(ids(await store.list('P')), ['a.b', 'x.y']);
	});

	test('marks belong to one profile', async () => {
		const { store } = makeStore({ P: [{ id: 'a.b' }], Q: [{ id: 'a.b' }] });
		store.removing('P', ['a.b']);
		assert.deepStrictEqual(ids(await store.entries('P')), []);
		assert.deepStrictEqual(ids(await store.entries('Q')), ['a.b']);
	});

	test('marks survive a re-read: what is being done is still being done', async () => {
		const { store } = makeStore({ P: [{ id: 'a.b' }] });
		store.removing('P', ['a.b']);
		store.installing('P', ['x.y']);
		store.invalidate('P');
		assert.deepStrictEqual(await store.entries('P'), [{ id: 'x.y', installing: true }]);
	});

	test('what the profile really has wins once a re-read shows it: an extension that arrived is no longer "installing"', async () => {
		const { store, state } = makeStore({ P: [] });
		store.installing('P', ['x.y']);
		state.P.push({ id: 'x.y', version: '2.0.0' });
		store.invalidate('P');
		assert.deepStrictEqual(await store.entries('P'), [{ id: 'x.y', version: '2.0.0' }]);
	});

	test('entries read the profile when it was not read yet', async () => {
		const { store, fetches } = makeStore({ P: [{ id: 'a.b' }] });
		store.installing('P', ['x.y']);
		assert.deepStrictEqual(ids(await store.entries('P')), ['a.b', 'x.y']);
		assert.deepStrictEqual(fetches, ['P']);
	});

	test('entriesNow answers without waiting, from what is known, or nothing', async () => {
		const { store } = makeStore({ P: [{ id: 'a.b' }] });
		assert.strictEqual(store.entriesNow('P'), undefined);
		await store.list('P');
		store.installing('P', ['x.y']);
		assert.deepStrictEqual(store.entriesNow('P'), [{ id: 'a.b' }, { id: 'x.y', installing: true }]);
	});
});

suite('ProfileStore reload and notifications', () => {
	test('reload reads the profile again quietly and replaces what was known', async () => {
		const { store, state } = makeStore({ P: [{ id: 'a.b' }] });
		await store.list('P');
		state.P.push({ id: 'c.d', version: '3.0.0' });
		assert.strictEqual(await store.reload('P'), true);
		assert.deepStrictEqual(ids(store.peek('P')!), ['a.b', 'c.d']);
	});

	test('a reload that fails keeps what was known and does not throw', async () => {
		const { store, failNext } = makeStore({ P: [{ id: 'a.b' }] });
		await store.list('P');
		failNext(true);
		assert.strictEqual(await store.reload('P'), false);
		assert.deepStrictEqual(ids(store.peek('P')!), ['a.b']);
	});

	test('everything that changes what is shown tells the listeners, and a listener can stop listening', async () => {
		const { store } = makeStore({ P: [{ id: 'a.b' }] });
		await store.list('P');
		const seen: (string | undefined)[] = [];
		const stop = store.onDidChange(profile => seen.push(profile));
		store.installing('P', ['x.y']);
		store.removing('P', ['a.b']);
		store.settle('P', ['x.y']);
		store.added('P', ['z.z']);
		store.removed('P', ['a.b']);
		await store.reload('P');
		store.invalidate('P');
		assert.deepStrictEqual(seen, ['P', 'P', 'P', 'P', 'P', 'P', 'P']);
		stop();
		store.installing('P', ['q.q']);
		assert.strictEqual(seen.length, 7);
	});

	test('invalidate of everything says so with no profile', () => {
		const { store } = makeStore({ P: [] });
		const seen: (string | undefined)[] = [];
		store.onDidChange(profile => seen.push(profile));
		store.invalidate();
		assert.deepStrictEqual(seen, [undefined]);
	});
});
