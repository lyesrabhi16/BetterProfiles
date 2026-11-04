import * as assert from 'assert';
import { DragSource, planDrop } from '../../dnd';

const ext = (id: string, type: 'group' | 'profile', name: string): DragSource => ({ kind: 'extension', id, from: { type, name } });
const group = (name: string): DragSource => ({ kind: 'group', name });

suite('planDrop: extensions dropped on a group', () => {
	test('adds them to the group', () => {
		assert.deepStrictEqual(planDrop([ext('a.one', 'profile', 'Python'), ext('b.two', 'profile', 'Python')], { kind: 'group', name: 'web' }), [
			{ op: 'addToGroup', group: 'web', ids: ['a.one', 'b.two'] },
		]);
	});

	test('from another group is a copy: the source group is untouched', () => {
		const ops = planDrop([ext('a.one', 'group', 'tools')], { kind: 'group', name: 'web' });
		assert.deepStrictEqual(ops, [{ op: 'addToGroup', group: 'web', ids: ['a.one'] }]);
		assert.ok(ops.every(o => o.op === 'addToGroup'), 'nothing is removed from the source');
	});

	test('dropping an extension on the group it came from does nothing', () => {
		assert.deepStrictEqual(planDrop([ext('a.one', 'group', 'web')], { kind: 'group', name: 'web' }), []);
	});

	test('ids are de-duplicated, case-insensitively, keeping the first spelling', () => {
		assert.deepStrictEqual(planDrop([ext('A.One', 'profile', 'P'), ext('a.one', 'group', 'g'), ext('b.two', 'profile', 'P')], { kind: 'group', name: 'web' }), [
			{ op: 'addToGroup', group: 'web', ids: ['A.One', 'b.two'] },
		]);
	});

	test('anything that is not an extension id is dropped from the plan', () => {
		assert.deepStrictEqual(planDrop([ext('--evil', 'profile', 'P'), ext('../x.vsix', 'profile', 'P'), ext('a.one', 'profile', 'P')], { kind: 'group', name: 'web' }), [
			{ op: 'addToGroup', group: 'web', ids: ['a.one'] },
		]);
	});
});

suite('planDrop: extensions dropped on a profile', () => {
	test('installs them into that profile', () => {
		assert.deepStrictEqual(planDrop([ext('a.one', 'group', 'web'), ext('b.two', 'profile', 'Rust')], { kind: 'profile', name: 'Python' }), [
			{ op: 'installInProfile', profile: 'Python', ids: ['a.one', 'b.two'] },
		]);
	});

	test('one that came from that same profile is left out', () => {
		assert.deepStrictEqual(planDrop([ext('a.one', 'profile', 'Python'), ext('b.two', 'group', 'web')], { kind: 'profile', name: 'Python' }), [
			{ op: 'installInProfile', profile: 'Python', ids: ['b.two'] },
		]);
	});

	test('only ones from that profile: nothing to do', () => {
		assert.deepStrictEqual(planDrop([ext('a.one', 'profile', 'Python')], { kind: 'profile', name: 'Python' }), []);
	});

	test('a profile and a group that happen to share a name are not confused', () => {
		assert.deepStrictEqual(planDrop([ext('a.one', 'group', 'Python')], { kind: 'profile', name: 'Python' }), [
			{ op: 'installInProfile', profile: 'Python', ids: ['a.one'] },
		]);
	});
});

suite('planDrop: groups', () => {
	test('a group dropped on a profile is given to it', () => {
		assert.deepStrictEqual(planDrop([group('web'), group('tools')], { kind: 'profile', name: 'Python' }), [
			{ op: 'assignGroup', profile: 'Python', group: 'web' },
			{ op: 'assignGroup', profile: 'Python', group: 'tools' },
		]);
	});

	test('the same group twice is given once', () => {
		assert.deepStrictEqual(planDrop([group('web'), group('web')], { kind: 'profile', name: 'Python' }), [
			{ op: 'assignGroup', profile: 'Python', group: 'web' },
		]);
	});

	test('a group dropped on a group does nothing (merging groups is not supported)', () => {
		assert.deepStrictEqual(planDrop([group('web')], { kind: 'group', name: 'tools' }), []);
	});

	test('extensions and groups dropped on a profile together give both operations', () => {
		assert.deepStrictEqual(planDrop([ext('a.one', 'group', 'web'), group('tools')], { kind: 'profile', name: 'Python' }), [
			{ op: 'installInProfile', profile: 'Python', ids: ['a.one'] },
			{ op: 'assignGroup', profile: 'Python', group: 'tools' },
		]);
	});

	test('an empty drop does nothing', () => {
		assert.deepStrictEqual(planDrop([], { kind: 'group', name: 'web' }), []);
	});
});
