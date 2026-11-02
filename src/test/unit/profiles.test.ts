import * as assert from 'assert';
import {
	DEFAULT_ICON,
	DEFAULT_PROFILE_ID,
	Detection,
	Profile,
	StorageSnapshot,
	associationKey,
	detectProfile,
	parseStorage,
	statusText,
	statusTooltip,
} from '../../profiles';

// Shapes copied from a real VS Code storage.json: association keys are Uri.toString() (percent-encoded).
const PY: Profile = { name: 'Python', location: '25bf4367', icon: 'snake', useDefaultFlags: { settings: true, tasks: true } };
const BDDA: Profile = { name: 'BDDA', location: '7f4f163a', icon: 'database' };
const NO_ICON: Profile = { name: 'Agents', location: 'agents' };

const storageText = (profiles: unknown[], workspaces: Record<string, unknown>) =>
	JSON.stringify({
		backupWorkspaces: { workspaces: [], folders: [] },
		userDataProfiles: profiles,
		profileAssociations: { workspaces, emptyWindows: {} },
	});

const snapshot = (profiles: Profile[], workspaces: Record<string, string>): StorageSnapshot => ({ profiles, workspaces });

suite('parseStorage', () => {
	test('reads profiles and workspace associations', () => {
		const s = parseStorage(storageText([PY, BDDA], { 'file:///home/u/app': PY.location, 'file:///home/u/old': DEFAULT_PROFILE_ID }));
		assert.deepStrictEqual(s.profiles, [PY, BDDA]);
		assert.deepStrictEqual(s.workspaces, { 'file:///home/u/app': '25bf4367', 'file:///home/u/old': DEFAULT_PROFILE_ID });
	});

	test('a storage file without profiles or associations is empty, not an error', () => {
		assert.deepStrictEqual(parseStorage('{}'), { profiles: [], workspaces: {} });
		assert.deepStrictEqual(parseStorage(JSON.stringify({ profileAssociations: {} })), { profiles: [], workspaces: {} });
	});

	test('skips malformed profile entries but keeps the valid ones', () => {
		const s = parseStorage(storageText([null, 'x', { name: 'NoLocation' }, { location: 'nameless' }, { name: 3, location: 'n' }, PY], {}));
		assert.deepStrictEqual(s.profiles, [PY]);
	});

	test('keeps the icon only when it is a string', () => {
		const s = parseStorage(storageText([{ name: 'A', location: 'a', icon: 42 }, { name: 'B', location: 'b', icon: 'flame' }], {}));
		assert.strictEqual(s.profiles[0].icon, undefined);
		assert.strictEqual(s.profiles[1].icon, 'flame');
	});

	test('ignores associations whose value is not a string', () => {
		const s = parseStorage(storageText([], { 'file:///a': 'abc', 'file:///b': 7, 'file:///c': null }));
		assert.deepStrictEqual(s.workspaces, { 'file:///a': 'abc' });
	});

	test('throws on invalid JSON so the caller can report it', () => {
		assert.throws(() => parseStorage('{ not json'), SyntaxError);
	});
});

suite('associationKey', () => {
	test('a single folder uses its URI', () => {
		assert.strictEqual(associationKey({ folders: ['file:///home/u/app'] }), 'file:///home/u/app');
	});

	test('the workspace file wins over the folders it contains (multi-root)', () => {
		const key = associationKey({ workspaceFile: 'file:///home/u/x.code-workspace', folders: ['file:///home/u/a', 'file:///home/u/b'] });
		assert.strictEqual(key, 'file:///home/u/x.code-workspace');
	});

	test('an empty window has no key', () => {
		assert.strictEqual(associationKey({ folders: [] }), undefined);
	});
});

suite('detectProfile', () => {
	test('finds the named profile associated with the folder', () => {
		const d = detectProfile(snapshot([PY, BDDA], { 'file:///home/u/app': PY.location }), { folders: ['file:///home/u/app'] });
		assert.deepStrictEqual(d, { kind: 'profile', profile: PY });
	});

	test('a percent-encoded key (spaces, accents) matches the same encoded URI', () => {
		const key = 'file:///home/u/my%20proj%20%C3%A9';
		const d = detectProfile(snapshot([PY], { [key]: PY.location }), { folders: [key] });
		assert.strictEqual(d.kind, 'profile');
	});

	test('keys are compared exactly: an unencoded path does not match an encoded key', () => {
		const d = detectProfile(snapshot([PY], { 'file:///home/u/my%20proj': PY.location }), { folders: ['file:///home/u/my proj'] });
		assert.deepStrictEqual(d, { kind: 'unknown', reason: 'not-recorded' });
	});

	test('the default profile marker means Default', () => {
		const d = detectProfile(snapshot([PY], { 'file:///home/u/app': DEFAULT_PROFILE_ID }), { folders: ['file:///home/u/app'] });
		assert.strictEqual(d.kind, 'default');
		assert.ok(d.kind === 'default' && d.profile.name === 'Default' && d.profile.location === DEFAULT_PROFILE_ID);
	});

	test('multi-root: the association of the workspace file is used, not the first folder', () => {
		const d = detectProfile(
			snapshot([PY, BDDA], { 'file:///home/u/x.code-workspace': PY.location, 'file:///home/u/a': BDDA.location }),
			{ workspaceFile: 'file:///home/u/x.code-workspace', folders: ['file:///home/u/a', 'file:///home/u/b'] },
		);
		assert.deepStrictEqual(d, { kind: 'profile', profile: PY });
	});

	test('multi-root: never falls back to the first folder when the workspace file is not recorded', () => {
		const d = detectProfile(
			snapshot([BDDA], { 'file:///home/u/a': BDDA.location }),
			{ workspaceFile: 'file:///home/u/x.code-workspace', folders: ['file:///home/u/a', 'file:///home/u/b'] },
		);
		assert.deepStrictEqual(d, { kind: 'unknown', reason: 'not-recorded' });
	});

	test('an empty window cannot be detected', () => {
		const d = detectProfile(snapshot([PY], { 'file:///home/u/app': PY.location }), { folders: [] });
		assert.deepStrictEqual(d, { kind: 'unknown', reason: 'no-workspace' });
	});

	test('a folder VS Code has not recorded is unknown, not Default', () => {
		const d = detectProfile(snapshot([PY], {}), { folders: ['file:///home/u/new'] });
		assert.deepStrictEqual(d, { kind: 'unknown', reason: 'not-recorded' });
	});

	test('an association pointing to a profile that no longer exists is unknown', () => {
		const d = detectProfile(snapshot([PY], { 'file:///home/u/app': 'deleted1' }), { folders: ['file:///home/u/app'] });
		assert.deepStrictEqual(d, { kind: 'unknown', reason: 'unknown-location' });
	});
});

suite('statusText', () => {
	const profile = (p: Profile): Detection => ({ kind: 'profile', profile: p });

	test('shows the profile icon and name', () => {
		assert.strictEqual(statusText(profile(PY)), '$(snake) Python');
	});

	test('a profile without an icon gets the default icon, never "$(undefined)"', () => {
		assert.strictEqual(statusText(profile(NO_ICON)), `$(${DEFAULT_ICON}) Agents`);
	});

	test('an icon that is not a valid codicon id falls back to the default icon', () => {
		assert.strictEqual(statusText(profile({ name: 'X', location: 'x', icon: 'bad) icon' })), `$(${DEFAULT_ICON}) X`);
	});

	test('a profile name that looks like an icon reference is escaped', () => {
		assert.strictEqual(statusText(profile({ name: '$(rocket) Fast', location: 'f' })), `$(${DEFAULT_ICON}) \\$(rocket) Fast`);
	});

	test('Default', () => {
		const d: Detection = { kind: 'default', profile: { name: 'Default', location: DEFAULT_PROFILE_ID } };
		assert.strictEqual(statusText(d), `$(${DEFAULT_ICON}) Default`);
	});

	test('unknown shows a neutral label instead of guessing', () => {
		assert.strictEqual(statusText({ kind: 'unknown', reason: 'no-workspace' }), `$(${DEFAULT_ICON}) Profile`);
	});
});

suite('statusTooltip', () => {
	test('always tells the user the item switches profiles', () => {
		for (const d of [
			{ kind: 'profile', profile: PY },
			{ kind: 'default', profile: { name: 'Default', location: DEFAULT_PROFILE_ID } },
			{ kind: 'unknown', reason: 'no-workspace' },
			{ kind: 'unknown', reason: 'not-recorded' },
			{ kind: 'unknown', reason: 'unknown-location' },
		] as Detection[]) {
			assert.ok(statusTooltip(d).includes('Click to switch'), JSON.stringify(d));
		}
	});

	test('explains why the profile is unknown', () => {
		assert.ok(/folder/i.test(statusTooltip({ kind: 'unknown', reason: 'no-workspace' })));
		assert.ok(/recorded/i.test(statusTooltip({ kind: 'unknown', reason: 'not-recorded' })));
		assert.ok(/no longer exists|deleted/i.test(statusTooltip({ kind: 'unknown', reason: 'unknown-location' })));
	});

	test('names the profile when known', () => {
		assert.ok(statusTooltip({ kind: 'profile', profile: PY }).includes('Python'));
	});
});
