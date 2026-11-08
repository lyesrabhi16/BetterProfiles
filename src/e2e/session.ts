// What every end-to-end suite starts from: a sandbox with the extension under test installed, a few profiles, fixture extensions
// in them, a groups file, and a real window in one of the profiles with the Better Profiles tab open.

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CliInvocation, defaultRunner, uninstallExtensions } from '../cli';
import { Sandbox, VsCode, Window, locateVsCode } from './sandbox';
import { Ui } from './ui';
import { FixtureExtension } from './vsix';

export const SELF = 'lyesrabhi.better-profiles';

const fixture = (name: string, displayName: string, dependencies: string[] = []): FixtureExtension => ({ publisher: 'bptest', name, version: '1.0.0', displayName, dependencies });

/** Small extensions with known ids; `dependant` needs `base`, so VS Code will not remove `base` while `dependant` is there. */
export const EXT = {
	alpha: fixture('alpha', 'Alpha Tool'),
	beta: fixture('beta', 'Beta Tool'),
	gamma: fixture('gamma', 'Gamma Tool'),
	other: fixture('other', 'Other Tool'),
	base: fixture('base', 'Base Library'),
	dependant: fixture('dependant', 'Dependant Plugin', ['bptest.base']),
};

export const idOf = (extension: FixtureExtension) => `${extension.publisher}.${extension.name}`;

let located: Promise<VsCode> | undefined;
let packaged: string | undefined;

/** The extension under test, packaged once per run (or the file BETTER_PROFILES_VSIX points to, as CI builds it once). */
export function packagedExtension(): string {
	const given = process.env.BETTER_PROFILES_VSIX;
	if (given) {
		if (!fs.existsSync(given)) {
			throw new Error(`BETTER_PROFILES_VSIX points to ${given}, which does not exist.`);
		}
		return given;
	}
	if (!packaged) {
		const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bp-e2e-vsix-')), 'better-profiles.vsix');
		const root = path.resolve(__dirname, '../..');
		execFileSync(process.execPath, [path.join(root, 'node_modules', '@vscode', 'vsce', 'vsce'), 'package', '--no-dependencies', '--allow-missing-repository', '-o', out], { cwd: root, stdio: 'pipe' });
		packaged = out;
	}
	return packaged;
}

export interface SessionOptions {
	/** The profiles to make besides Default; the window is opened in the first one. */
	profiles: string[];
	/** Fixture extensions to put in each profile (Default included). */
	extensions?: Record<string, FixtureExtension[]>;
	groups: { groups: Record<string, string[]>; profiles: Record<string, string[]> };
}

export class Session {
	/** What the default profile's list looked like before any test touched it (see `restoreDefaultIndex`). */
	private defaultIndex: string | undefined;

	constructor(readonly sandbox: Sandbox, readonly window: Window, readonly ui: Ui, readonly profile: string) {
		this.defaultIndex = fs.readFileSync(sandbox.indexFile('Default'), 'utf8');
	}

	/**
	 * A test that makes an extension "applied to all profiles" has to write that into the default profile's list by hand (VS Code only
	 * offers it on a screen of its own). This puts the list back, so that the next test does not start with that extension protected.
	 */
	restoreDefaultIndex(): void {
		if (this.defaultIndex !== undefined) {
			fs.writeFileSync(this.sandbox.indexFile('Default'), this.defaultIndex);
		}
	}

	/** The command line of the sandbox, as the extension itself would run it. */
	invocation(): CliInvocation {
		return {
			command: this.sandbox.vscode.binary,
			args: [path.join(this.sandbox.vscode.appRoot, 'out', 'cli.js'), '--user-data-dir', this.sandbox.userData, '--extensions-dir', this.sandbox.extensions],
			env: { ELECTRON_RUN_AS_NODE: '1' },
		};
	}

	/** The fixture extensions that a profile has (the ones of the extension under test are left out). */
	async fixtures(profile: string): Promise<string[]> {
		return (await this.sandbox.list(profile)).filter(id => id.startsWith('bptest.'));
	}

	/** Makes a profile have exactly these fixture extensions, whatever it had: the tests start from a known state. */
	async setFixtures(profile: string, wanted: FixtureExtension[]): Promise<void> {
		this.restoreDefaultIndex();
		const want = new Set(wanted.map(idOf));
		const have = await this.fixtures(profile);
		const extra = have.filter(id => !want.has(id));
		if (extra.length > 0) {
			const results = await uninstallExtensions(this.invocation(), defaultRunner, extra, profile, {});
			const failed = results.filter(r => !r.ok);
			if (failed.length > 0) {
				throw new Error(`Could not clear ${failed.map(r => r.id).join(', ')} from ${profile}: ${failed[0].message}`);
			}
		}
		const missing = wanted.filter(e => !have.includes(idOf(e)));
		if (missing.length > 0) {
			await this.sandbox.install(missing, profile);
		}
	}

	/** Makes the trees read everything again: the groups file is written from outside, which nothing watches. */
	async refresh(): Promise<void> {
		await this.ui.pressTitleButton('GROUPS', 'Refresh');
	}

	async stop(): Promise<void> {
		this.ui.cdp.close();
		await this.sandbox.dispose();
	}
}

/** Starts a session. It takes a while (a real VS Code, a window per profile created): do it once per suite. */
export async function startSession(name: string, options: SessionOptions): Promise<Session> {
	located ??= locateVsCode();
	const vscode = await located;
	const sandbox = await Sandbox.create(vscode, name);
	try {
		sandbox.writeSettings({});
		sandbox.writeGroups(options.groups);
		const extension = packagedExtension();
		await sandbox.installFile(extension);
		for (const profile of options.profiles) {
			await sandbox.createProfile(profile);
			await sandbox.installFile(extension, profile);
		}
		for (const [profile, extensions] of Object.entries(options.extensions ?? {})) {
			await sandbox.install(extensions, profile);
		}
		const profile = options.profiles[0];
		const window = await sandbox.launch({ profile });
		const cdp = await window.connect();
		const ui = new Ui(cdp);
		await ui.openBetterProfiles();
		return new Session(sandbox, window, ui, profile);
	} catch (error) {
		await sandbox.dispose();
		throw error;
	}
}

/** Saves what the window looked like, for a test that failed (CI keeps the folder). */
export async function captureOnFailure(session: Session | undefined, test: Mocha.Test | undefined): Promise<void> {
	if (!session || !test || test.state !== 'failed') {
		return;
	}
	try {
		const dir = process.env.BP_E2E_ARTIFACTS ?? path.resolve(__dirname, '../../e2e-artifacts');
		fs.mkdirSync(dir, { recursive: true });
		const name = test.fullTitle().replace(/[^a-z0-9]+/gi, '-').slice(0, 120);
		fs.writeFileSync(path.join(dir, `${name}.png`), await session.ui.cdp.screenshot());
		fs.writeFileSync(path.join(dir, `${name}.txt`), JSON.stringify({ groups: await session.ui.rows('GROUPS'), profiles: await session.ui.rows('PROFILES'), notifications: await session.ui.notifications(), dialog: await session.ui.dialog(), tabs: await session.ui.tabs(), groupsFile: session.sandbox.readGroups(), fixturesInProfiles: Object.fromEntries(await Promise.all(['Default', session.profile].map(async p => [p, await session.sandbox.list(p)]))), extensionLog: extensionLog(session.sandbox.userData) }, null, 2));
	} catch {
		// a failing screenshot must not hide the failure of the test
	}
}

/** The last lines of what the extension under test wrote to its log (VS Code keeps one folder of logs per window). */
function extensionLog(userData: string): string[] {
	const found: string[] = [];
	const walk = (dir: string, depth: number) => {
		if (depth > 5) {
			return;
		}
		for (const entry of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full, depth + 1);
			} else if (entry.name === 'Better Profiles.log') {
				found.push(...fs.readFileSync(full, 'utf8').split(/\r?\n/).filter(Boolean).slice(-60));
			}
		}
	};
	walk(path.join(userData, 'logs'), 0);
	return found;
}
