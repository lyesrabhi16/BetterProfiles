import * as assert from 'assert';
import {
	CliError,
	CliInvocation,
	RunResult,
	Runner,
	installArgs,
	isInstalledExtensionPath,
	installExtension,
	uninstallArgs,
	uninstallExtension,
	uninstallExtensions,
	uninstallManyArgs,
	listArgs,
	listExtensions,
	parseExtensionList,
	pickExtensionsDir,
	resolveCli,
	userDataDirFromGlobalStorage,
	userDataDirFromStorageFile,
} from '../../cli';

const cli: CliInvocation = { command: '/bin/vscode', args: ['/app/out/cli.js', '--user-data-dir', '/ud', '--extensions-dir', '/ex'], env: { ELECTRON_RUN_AS_NODE: '1' } };

/** A fake runner that records what it was asked to run. */
function fakeRunner(result: Partial<RunResult> | ((args: string[]) => Partial<RunResult>)) {
	const calls: { command: string; args: string[]; env: Record<string, string> }[] = [];
	const run: Runner = async (command, args, env) => {
		calls.push({ command, args, env });
		const r = typeof result === 'function' ? result(args) : result;
		return { code: 0, stdout: '', stderr: '', ...r };
	};
	return { run, calls };
}

suite('resolveCli', () => {
	const base = { execPath: '/bin/vscode', appRoot: '/opt/vscode/resources/app', userDataDir: '/home/u/.config/Code', extensionsDir: '/home/u/.vscode/extensions' };

	test('by default runs the editor binary on its own cli.js, as the "code" launcher does, with this instance\'s directories', () => {
		const r = resolveCli(base);
		assert.deepStrictEqual(r, {
			command: '/bin/vscode',
			args: ['/opt/vscode/resources/app/out/cli.js', '--user-data-dir', '/home/u/.config/Code', '--extensions-dir', '/home/u/.vscode/extensions'],
			env: { ELECTRON_RUN_AS_NODE: '1' },
		});
	});

	test('refuses to guess when the extensions folder is unknown (it could hit the wrong installation)', () => {
		const r = resolveCli({ ...base, extensionsDir: undefined });
		assert.ok('error' in r);
		assert.ok(/extensions/i.test(r.error), r.error);
	});

	test('a configured command is used as is, with the configured arguments and nothing derived', () => {
		const r = resolveCli({ ...base, command: '/usr/bin/code-insiders', args: ['--user-data-dir', '/custom'], extensionsDir: undefined });
		assert.deepStrictEqual(r, { command: '/usr/bin/code-insiders', args: ['--user-data-dir', '/custom'], env: {} });
	});

	test('a blank configured command counts as not configured', () => {
		const r = resolveCli({ ...base, command: '   ' });
		assert.ok(!('error' in r) && r.command === '/bin/vscode');
	});
});

suite('userDataDirFromGlobalStorage', () => {
	test('goes up from <user-data-dir>/User/globalStorage/<extension>', () => {
		assert.strictEqual(userDataDirFromGlobalStorage('/home/u/.config/Code/User/globalStorage/lyesrabhi.better-profiles'), '/home/u/.config/Code');
	});

	test('works for a custom user-data-dir', () => {
		assert.strictEqual(userDataDirFromGlobalStorage('/tmp/x/user-data/User/globalStorage/pub.ext'), '/tmp/x/user-data');
	});
});

suite('pickExtensionsDir', () => {
	test('is the folder most installed extensions share', () => {
		assert.strictEqual(
			pickExtensionsDir(['/h/.vscode/extensions/a.b-1.0.0', '/h/.vscode/extensions/c.d-2.0.0', '/elsewhere/x.y-1.0.0']),
			'/h/.vscode/extensions',
		);
	});

	test('is undefined when there are no extensions to go on', () => {
		assert.strictEqual(pickExtensionsDir([]), undefined);
	});

	test('on a tie the first folder seen wins', () => {
		assert.strictEqual(pickExtensionsDir(['/one/a.b-1', '/two/c.d-1']), '/one');
	});
});

suite('parseExtensionList', () => {
	test('reads "id@version" lines', () => {
		assert.deepStrictEqual(parseExtensionList('ms-python.python@2024.1.0\naaron-bond.better-comments@3.1.1\n'), [
			{ id: 'ms-python.python', version: '2024.1.0' },
			{ id: 'aaron-bond.better-comments', version: '3.1.1' },
		]);
	});

	test('reads plain ids when versions were not requested', () => {
		assert.deepStrictEqual(parseExtensionList('a.b\nc.d\n'), [{ id: 'a.b' }, { id: 'c.d' }]);
	});

	test('keeps platform-specific version suffixes', () => {
		assert.deepStrictEqual(parseExtensionList('ms-python.debugpy@2026.7.1@linux-x64\n')[0], { id: 'ms-python.debugpy', version: '2026.7.1@linux-x64' });
	});

	test('ignores blank lines, CRLF and anything that is not an extension id', () => {
		const out = 'Extensions installed on this machine:\r\na.b@1.0.0\r\n\r\n(node:12) Warning: something\r\nc.d@2.0.0\r\n';
		assert.deepStrictEqual(parseExtensionList(out).map(e => e.id), ['a.b', 'c.d']);
	});
});

suite('listArgs / installArgs', () => {
	test('list asks for versions and omits --profile for the Default profile', () => {
		assert.deepStrictEqual(listArgs(), ['--list-extensions', '--show-versions']);
		assert.deepStrictEqual(listArgs('Default'), ['--list-extensions', '--show-versions']);
	});

	test('a named profile is one separate argument, even with spaces', () => {
		assert.deepStrictEqual(listArgs('My Python'), ['--list-extensions', '--show-versions', '--profile', 'My Python']);
		assert.deepStrictEqual(installArgs('a.b', 'My Python'), ['--install-extension', 'a.b', '--profile', 'My Python']);
	});

	test('install into Default has no --profile', () => {
		assert.deepStrictEqual(installArgs('a.b'), ['--install-extension', 'a.b']);
	});
});

suite('listExtensions', () => {
	test('runs the CLI with its fixed arguments first and parses the output', async () => {
		const { run, calls } = fakeRunner({ stdout: 'a.b@1.0.0\nc.d@2.0.0\n' });
		const list = await listExtensions(cli, run, 'Python');
		assert.deepStrictEqual(list.map(e => e.id), ['a.b', 'c.d']);
		assert.deepStrictEqual(calls, [{ command: '/bin/vscode', args: [...cli.args, '--list-extensions', '--show-versions', '--profile', 'Python'], env: cli.env }]);
	});

	test('throws a CliError with the CLI message when it fails', async () => {
		const { run } = fakeRunner({ code: 1, stderr: "Profile 'Nope' not found.\n" });
		await assert.rejects(listExtensions(cli, run, 'Nope'), (e: unknown) => e instanceof CliError && /Profile 'Nope' not found/.test(e.message) && e.code === 1);
	});
});

suite('installExtension', () => {
	test('installs one extension into the profile and reports success', async () => {
		const { run, calls } = fakeRunner({ stdout: "Installing extensions...\nExtension 'a.b' v1.0.0 was successfully installed.\n" });
		const r = await installExtension(cli, run, 'a.b', 'Python');
		assert.strictEqual(r.ok, true);
		assert.deepStrictEqual(calls[0].args, [...cli.args, '--install-extension', 'a.b', '--profile', 'Python']);
	});

	test('reports a failure without throwing, so one bad extension does not stop a sync', async () => {
		const { run } = fakeRunner({ code: 1, stderr: "Extension 'x.y' not found.\n" });
		const r = await installExtension(cli, run, 'x.y');
		assert.strictEqual(r.ok, false);
		assert.ok(r.message.includes("'x.y' not found"), r.message);
	});

	test('never passes anything that is not a plain extension id to the CLI', async () => {
		const { run, calls } = fakeRunner({});
		for (const bad of ['--uninstall-extension', '-x.y', '../evil.vsix', '/tmp/a.vsix', 'python']) {
			const r = await installExtension(cli, run, bad, 'Python');
			assert.strictEqual(r.ok, false, bad);
		}
		assert.deepStrictEqual(calls, []);
	});
});

suite('isInstalledExtensionPath', () => {
	test('an installed extension lives in a folder named <id>-<version>', () => {
		assert.ok(isInstalledExtensionPath('ms-python.python', '/h/.vscode/extensions/ms-python.python-2024.1.0'));
	});

	test('a platform suffix is fine', () => {
		assert.ok(isInstalledExtensionPath('ms-python.debugpy', '/h/.vscode/extensions/ms-python.debugpy-2026.7.1-linux-x64'));
	});

	test('the id is compared case-insensitively (folders are lower-case)', () => {
		assert.ok(isInstalledExtensionPath('GitHub.copilot', '/h/.vscode/extensions/github.copilot-1.2.3'));
	});

	test('a development checkout is not an installed extension', () => {
		assert.ok(!isInstalledExtensionPath('lyesrabhi.better-profiles', '/home/u/Projects/BetterProfiles'));
	});

	test('an extension built into VS Code is not one either', () => {
		assert.ok(!isInstalledExtensionPath('vscode.git', '/opt/vscode/resources/app/extensions/git'));
	});

	test('a folder that merely starts with the id is not enough: a version must follow', () => {
		assert.ok(!isInstalledExtensionPath('a.b', '/ex/a.b-c.d-1.0.0'));
		assert.ok(!isInstalledExtensionPath('a.b', '/ex/a.b'));
	});
});

suite('uninstallArgs', () => {
	test('uninstalls one extension, with --profile only for a named profile, as separate arguments', () => {
		assert.deepStrictEqual(uninstallArgs('a.b'), ['--uninstall-extension', 'a.b']);
		assert.deepStrictEqual(uninstallArgs('a.b', 'Default'), ['--uninstall-extension', 'a.b']);
		assert.deepStrictEqual(uninstallArgs('a.b', 'My Python'), ['--uninstall-extension', 'a.b', '--profile', 'My Python']);
	});
});

suite('uninstallExtension', () => {
	test('runs the CLI for that profile and reports success', async () => {
		const { run, calls } = fakeRunner({ stdout: "Uninstalling a.b...\nExtension 'a.b' was successfully uninstalled!\n" });
		const r = await uninstallExtension(cli, run, 'a.b', 'Python');
		assert.strictEqual(r.ok, true);
		assert.deepStrictEqual(calls[0].args, [...cli.args, '--uninstall-extension', 'a.b', '--profile', 'Python']);
	});

	test('reports a failure (for example a dependency) without throwing', async () => {
		const { run } = fakeRunner({ code: 1, stderr: "Cannot uninstall extension 'a.b'. Extension 'c.d' depends on this.\n" });
		const r = await uninstallExtension(cli, run, 'a.b');
		assert.strictEqual(r.ok, false);
		assert.ok(r.message.includes('depends on this'), r.message);
	});

	test('never passes anything that is not a plain extension id', async () => {
		const { run, calls } = fakeRunner({});
		for (const bad of ['--install-extension', '-x.y', '../evil.vsix', '/tmp/a.vsix', 'python', 'evil.vsix']) {
			assert.strictEqual((await uninstallExtension(cli, run, bad, 'Python')).ok, false, bad);
		}
		assert.deepStrictEqual(calls, []);
	});
});

suite('uninstallManyArgs', () => {
	test('one flag per extension, then the profile once, as separate arguments', () => {
		assert.deepStrictEqual(uninstallManyArgs(['a.b', 'c.d'], 'My Python'), ['--uninstall-extension', 'a.b', '--uninstall-extension', 'c.d', '--profile', 'My Python']);
		assert.deepStrictEqual(uninstallManyArgs(['a.b'], 'Default'), ['--uninstall-extension', 'a.b']);
	});
});

suite('uninstallExtensions (many in one run of the CLI)', () => {
	const lines = (...ids: string[]) => ids.map(id => `Uninstalling ${id}...\nExtension '${id}' was successfully uninstalled!`).join('\n') + '\n';

	test('starts the CLI once for all of them', async () => {
		const { run, calls } = fakeRunner({ stdout: lines('a.b', 'c.d') });
		const results = await uninstallExtensions(cli, run, ['a.b', 'c.d'], 'Python');
		assert.strictEqual(calls.length, 1);
		assert.deepStrictEqual(calls[0].args, [...cli.args, '--uninstall-extension', 'a.b', '--uninstall-extension', 'c.d', '--profile', 'Python']);
		assert.deepStrictEqual(results.map(r => [r.id, r.ok]), [['a.b', true], ['c.d', true]]);
	});

	test('when it exits with 0 they all went, whatever it printed', async () => {
		const { run } = fakeRunner({ stdout: 'something else\n' });
		assert.ok((await uninstallExtensions(cli, run, ['a.b', 'c.d'])).every(r => r.ok));
	});

	test('when it fails, the ones it says went are told apart from the others', async () => {
		const { run } = fakeRunner({ code: 1, stdout: lines('a.b'), stderr: "Cannot uninstall 'c.d' extension. 'x.y' extension depends on this.\n" });
		const [first, second] = await uninstallExtensions(cli, run, ['a.b', 'c.d']);
		assert.strictEqual(first.ok, true);
		assert.strictEqual(second.ok, false);
		assert.ok(second.message.includes('c.d') && second.message.includes('depends on this'), second.message);
	});

	test('an id is recognised in its output whatever the case', async () => {
		const { run } = fakeRunner({ code: 1, stdout: lines('A.B'), stderr: 'boom\n' });
		const [first, second] = await uninstallExtensions(cli, run, ['a.b', 'x.y']);
		assert.deepStrictEqual([first.ok, second.ok], [true, false]);
	});

	test('when it fails and says nothing about an extension, that one counts as not uninstalled, with the first error line', async () => {
		const { run } = fakeRunner({ code: 3, stderr: 'Cannot uninstall: busy\n' });
		const results = await uninstallExtensions(cli, run, ['a.b', 'c.d']);
		assert.ok(results.every(r => !r.ok && r.message.includes('busy')));
	});

	test('what is not a plain extension id is never passed, and the others still run in one go', async () => {
		const { run, calls } = fakeRunner({ stdout: lines('a.b') });
		const results = await uninstallExtensions(cli, run, ['--install-extension', 'a.b', '../x.vsix'], 'P');
		assert.deepStrictEqual(results.map(r => [r.id, r.ok]), [['--install-extension', false], ['a.b', true], ['../x.vsix', false]]);
		assert.strictEqual(calls.length, 1);
		assert.deepStrictEqual(calls[0].args, [...cli.args, '--uninstall-extension', 'a.b', '--profile', 'P']);
	});

	test('nothing to uninstall: the CLI is not started', async () => {
		const { run, calls } = fakeRunner({});
		assert.deepStrictEqual(await uninstallExtensions(cli, run, [], 'P'), []);
		assert.deepStrictEqual(calls, []);
	});

	test('a CLI that cannot be run fails them all without throwing', async () => {
		const run: Runner = async () => { throw new Error('ENOENT'); };
		const results = await uninstallExtensions(cli, run, ['a.b', 'c.d']);
		assert.ok(results.every(r => !r.ok && r.message.includes('ENOENT')));
	});

	test('one extension behaves like uninstallExtension', async () => {
		const { run } = fakeRunner({ stdout: lines('a.b') });
		const [only] = await uninstallExtensions(cli, run, ['a.b']);
		assert.deepStrictEqual(only, await uninstallExtension(cli, run, 'a.b'));
	});
});

suite('userDataDirFromStorageFile', () => {
	test('storage.json lives in <user-data-dir>/User/globalStorage', () => {
		assert.strictEqual(userDataDirFromStorageFile('/home/u/.config/Code/User/globalStorage/storage.json'), '/home/u/.config/Code');
	});

	test('a file anywhere else says nothing about the user data folder', () => {
		assert.strictEqual(userDataDirFromStorageFile('/tmp/x/storage.json'), undefined);
		assert.strictEqual(userDataDirFromStorageFile('/home/u/.config/Code/User/globalStorage/other.json'), undefined);
		assert.strictEqual(userDataDirFromStorageFile(''), undefined);
	});
});

/**
 * A CLI that behaves like the real one when given several --uninstall-extension: one after the other, and it STOPS at the
 * first one it cannot do. \`dependants\` says which extensions need which (an extension cannot go while one of those is there).
 */
function realisticCli(installed: string[], dependants: Record<string, string[]> = {}, alwaysFail: string[] = []) {
	const have = new Set(installed.map(id => id.toLowerCase()));
	const launches: string[][] = [];
	const run: Runner = async (_command, args) => {
		const ids = args.flatMap((arg, i) => (arg === '--uninstall-extension' ? [args[i + 1]] : []));
		launches.push(ids);
		let stdout = '';
		for (const id of ids) {
			stdout += `Uninstalling ${id}...\n`;
			const blocker = (dependants[id.toLowerCase()] ?? []).find(other => have.has(other.toLowerCase()));
			if (alwaysFail.includes(id) || blocker) {
				const stderr = blocker ? `Cannot uninstall '${id}' extension. '${blocker}' extension depends on this.\n` : `Extension '${id}' cannot be uninstalled.\n`;
				return { code: 1, stdout, stderr };
			}
			have.delete(id.toLowerCase());
			stdout += `Extension '${id}' was successfully uninstalled!\n`;
		}
		return { code: 0, stdout, stderr: '' };
	};
	return { run, launches, left: () => [...have].sort() };
}

suite('uninstallExtensions when the CLI stops at the first extension it cannot remove', () => {
	test('a blocked extension is tried again after the others, when whatever blocked it is gone', async () => {
		const sim = realisticCli(['base.ext', 'other.ext', 'dependant.ext'], { 'base.ext': ['dependant.ext'] });
		const results = await uninstallExtensions(cli, sim.run, ['base.ext', 'other.ext', 'dependant.ext'], 'P');
		assert.deepStrictEqual(results.map(r => [r.id, r.ok]), [['base.ext', true], ['other.ext', true], ['dependant.ext', true]]);
		assert.deepStrictEqual(sim.left(), []);
		assert.strictEqual(sim.launches.length, 2, 'the whole list, then the same without the blocked one first');
		assert.deepStrictEqual(sim.launches[1], ['other.ext', 'dependant.ext', 'base.ext']);
	});

	test('one that cannot be removed at all does not stop the others, and says why', async () => {
		const sim = realisticCli(['bad.ext', 'a.b', 'c.d'], {}, ['bad.ext']);
		const results = await uninstallExtensions(cli, sim.run, ['bad.ext', 'a.b', 'c.d']);
		assert.deepStrictEqual(results.map(r => [r.id, r.ok]), [['bad.ext', false], ['a.b', true], ['c.d', true]]);
		assert.deepStrictEqual(sim.left(), ['bad.ext']);
		assert.ok(results[0].message.includes('cannot be uninstalled'), results[0].message);
	});

	test('the reason is the CLI\'s error, never its progress line', async () => {
		const sim = realisticCli(['base.ext', 'dependant.ext'], { 'base.ext': ['dependant.ext'], 'dependant.ext': ['base.ext'] });
		const results = await uninstallExtensions(cli, sim.run, ['base.ext', 'dependant.ext']);
		assert.ok(results.every(r => !r.ok));
		assert.ok(results.every(r => /depends on this/.test(r.message) && !/^Uninstalling/.test(r.message)), results.map(r => r.message).join(' | '));
	});

	test('a failure in the middle: what came before went, what comes after is still tried', async () => {
		const sim = realisticCli(['a.b', 'bad.ext', 'c.d'], {}, ['bad.ext']);
		const results = await uninstallExtensions(cli, sim.run, ['a.b', 'bad.ext', 'c.d']);
		assert.deepStrictEqual(results.map(r => [r.id, r.ok]), [['a.b', true], ['bad.ext', false], ['c.d', true]]);
	});

	test('it gives up on an extension that fails even when it comes last, and does not loop', async () => {
		const sim = realisticCli(['x.y', 'bad.ext'], {}, ['bad.ext']);
		const results = await uninstallExtensions(cli, sim.run, ['x.y', 'bad.ext']);
		assert.strictEqual(sim.launches.length, 1, 'it was already last, so the first answer was final');
		assert.deepStrictEqual(results.map(r => r.ok), [true, false]);
	});

	test('a few blocked extensions are each tried again, and the number of runs stays small', async () => {
		const ids = ['java.base', 'java.test', 'java.debug', 'go.lang'];
		const sim = realisticCli(ids, { 'java.base': ['java.test', 'java.debug'] });
		const results = await uninstallExtensions(cli, sim.run, ids);
		assert.ok(results.every(r => r.ok));
		assert.ok(sim.launches.length <= 3, String(sim.launches.length));
	});

	test('when it fails without saying which extension it was at, nothing is retried', async () => {
		const run: Runner = async () => ({ code: 1, stdout: '', stderr: 'Profile not found.\n' });
		const calls: number[] = [];
		const counting: Runner = async (...a) => { calls.push(1); return run(...a); };
		const results = await uninstallExtensions(cli, counting, ['a.b', 'c.d'], 'Ghost');
		assert.strictEqual(calls.length, 1);
		assert.ok(results.every(r => !r.ok && r.message === 'Profile not found.'));
	});
});

/**
 * The real CLI checks that each extension is installed right before it does it, and THROWS if it is not, before it prints
 * any progress line for it (extensionManagementCLI.ts). One after the other, so the ones before it have been done.
 */
function strictCli(installed: string[], dependants: Record<string, string[]> = {}) {
	const have = new Set(installed.map(id => id.toLowerCase()));
	const launches: string[][] = [];
	const run: Runner = async (_command, args) => {
		const ids = args.flatMap((arg, i) => (arg === '--uninstall-extension' ? [args[i + 1]] : []));
		launches.push(ids);
		let stdout = '';
		for (const id of ids) {
			if (!have.has(id.toLowerCase())) {
				return { code: 1, stdout, stderr: `Extension '${id}' is not installed.\nMake sure you use the full extension ID, including the publisher, e.g.: ms-dotnettools.csharp\n` };
			}
			stdout += `Uninstalling ${id}...\n`;
			const blocker = (dependants[id.toLowerCase()] ?? []).find(other => have.has(other.toLowerCase()));
			if (blocker) {
				return { code: 1, stdout, stderr: `Cannot uninstall '${id}' extension. '${blocker}' extension depends on this.\n` };
			}
			have.delete(id.toLowerCase());
			stdout += `Extension '${id}' was successfully uninstalled!\n`;
		}
		return { code: 0, stdout, stderr: '' };
	};
	return { run, launches, left: () => [...have].sort() };
}

suite('uninstallExtensions when the CLI says an extension is not installed', () => {
	test('an extension that is not installed counts as done, and the others still go (it is first)', async () => {
		const sim = strictCli(['a.b', 'c.d']);
		const results = await uninstallExtensions(cli, sim.run, ['ghost.one', 'a.b', 'c.d']);
		assert.deepStrictEqual(results.map(r => [r.id, r.ok]), [['ghost.one', true], ['a.b', true], ['c.d', true]]);
		assert.deepStrictEqual(sim.left(), []);
		assert.strictEqual(sim.launches.length, 2, 'the first run stops at the ghost, the second does the rest');
		assert.deepStrictEqual(sim.launches[1], ['a.b', 'c.d']);
	});

	test('so do the ones before and after it in the middle of the list', async () => {
		const sim = strictCli(['a.b', 'c.d']);
		const results = await uninstallExtensions(cli, sim.run, ['a.b', 'ghost.one', 'c.d']);
		assert.ok(results.every(r => r.ok));
		assert.deepStrictEqual(sim.left(), []);
	});

	test('a long list whose first extension is not installed (as in a real report) still removes the rest', async () => {
		const ids = Array.from({ length: 35 }, (_, i) => `pub.ext${i}`);
		const sim = strictCli(ids.slice(1)); // the first one is not installed
		const results = await uninstallExtensions(cli, sim.run, ids);
		assert.ok(results.every(r => r.ok), results.filter(r => !r.ok).map(r => r.message).join(' | '));
		assert.deepStrictEqual(sim.left(), []);
		assert.strictEqual(sim.launches.length, 2);
	});

	test('it says that it was not installed, so that nothing claims it just uninstalled it', async () => {
		const sim = strictCli(['a.b']);
		const [ghost] = await uninstallExtensions(cli, sim.run, ['ghost.one', 'a.b']);
		assert.ok(/not installed/i.test(ghost.message), ghost.message);
	});

	test('ids are compared without regard to case', async () => {
		const sim = strictCli(['a.b']);
		const results = await uninstallExtensions(cli, sim.run, ['GHOST.One', 'a.b']);
		assert.ok(results.every(r => r.ok));
	});

	test('when it fails after some went, without a progress line for the one it failed at, that one is the next in the list', async () => {
		// built-in notices and the like come before the progress line
		const run: Runner = async (_c, args) => {
			const ids = args.flatMap((arg, i) => (arg === '--uninstall-extension' ? [args[i + 1]] : []));
			let stdout = '';
			for (const id of ids) {
				if (id === 'odd.one') {
					return { code: 1, stdout, stderr: 'Something odd about odd.one\n' };
				}
				stdout += `Uninstalling ${id}...\nExtension '${id}' was successfully uninstalled!\n`;
			}
			return { code: 0, stdout, stderr: '' };
		};
		const results = await uninstallExtensions(cli, run, ['a.b', 'odd.one', 'c.d']);
		assert.deepStrictEqual(results.map(r => [r.id, r.ok]), [['a.b', true], ['odd.one', false], ['c.d', true]]);
		assert.ok(results[1].message.includes('odd.one'), results[1].message);
	});

	test('each extension that went is reported with its own success line, not the last line of the run', async () => {
		const sim = strictCli(['a.b', 'c.d']);
		const [first, second] = await uninstallExtensions(cli, sim.run, ['a.b', 'c.d']);
		assert.ok(first.message.includes('a.b') && !first.message.includes('c.d'), first.message);
		assert.ok(second.message.includes('c.d'), second.message);
	});

	test('each run of the command line can be seen, for the log', async () => {
		const sim = strictCli(['a.b']);
		const seen: { ids: string[]; code: number; stderr: string }[] = [];
		await uninstallExtensions(cli, sim.run, ['ghost.one', 'a.b'], 'P', { onRun: r => seen.push({ ids: r.ids, code: r.code, stderr: r.stderr }) });
		assert.strictEqual(seen.length, 2);
		assert.deepStrictEqual(seen[0].ids, ['ghost.one', 'a.b']);
		assert.strictEqual(seen[0].code, 1);
		assert.ok(seen[0].stderr.includes('ghost.one'));
		assert.strictEqual(seen[1].code, 0);
	});
});
