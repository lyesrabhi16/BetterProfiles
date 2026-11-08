// A real VS Code in a folder of its own: its command line, and real windows with a debugging port so that a test can look at
// the page and click on it. Nothing here touches the user's own VS Code: everything is under a temporary folder, and the
// sandbox refuses to start if the command line does not see that folder alone.

import { ChildProcess, execFile, spawn } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { Cdp } from './cdp';
import { FixtureExtension, buildVsix } from './vsix';

export interface VsCode {
	/** The executable (the one that is also the editor). */
	binary: string;
	/** Where `out/cli.js` lives. */
	appRoot: string;
}

/** BETTER_PROFILES_VSCODE (as for the other tests), else the stable VS Code, downloaded once into .vscode-test. */
export async function locateVsCode(): Promise<VsCode> {
	let binary = process.env.BETTER_PROFILES_VSCODE;
	if (!binary) {
		const { downloadAndUnzipVSCode } = await import('@vscode/test-electron');
		binary = await downloadAndUnzipVSCode(process.env.VSCODE_VERSION ?? 'stable');
	}
	const appRoot = path.join(path.dirname(binary), 'resources', 'app');
	if (!fs.existsSync(path.join(appRoot, 'out', 'cli.js'))) {
		throw new Error(`Cannot find VS Code's command line next to ${binary} (looked for ${path.join(appRoot, 'out', 'cli.js')}).`);
	}
	return { binary, appRoot };
}

export interface CliResult {
	code: number;
	stdout: string;
	stderr: string;
}

const freePort = () => new Promise<number>((resolve, reject) => {
	const server = net.createServer();
	server.listen(0, '127.0.0.1', () => {
		const { port } = server.address() as net.AddressInfo;
		server.close(() => resolve(port));
	});
	server.on('error', reject);
});

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Flags that a virtual display needs (no GPU, X11, no sandbox). */
const headlessFlags = () => (process.env.BETTER_PROFILES_HEADLESS ? ['--disable-gpu', '--ozone-platform=x11', '--no-sandbox'] : []);

/** What a window or the command line is started with: nothing from the environment of the person running the tests. */
const cleanEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => {
	const env: NodeJS.ProcessEnv = { ...process.env };
	// what the person running the tests has set must not leak in (a VS Code terminal sets some of these) ...
	delete env.WAYLAND_DISPLAY;
	delete env.ELECTRON_RUN_AS_NODE;
	delete env.VSCODE_IPC_HOOK_CLI;
	delete env.VSCODE_IPC_HOOK;
	// ... and what this run asks for comes after
	return { ...env, ...extra };
};

export class Window {
	private closed = false;

	constructor(readonly child: ChildProcess, readonly port: number) { }

	/** A debugging connection to the page of the workbench. */
	async connect(timeoutMs = 60_000): Promise<Cdp> {
		const end = Date.now() + timeoutMs;
		let lastError: unknown;
		while (Date.now() < end) {
			try {
				const targets = await (await fetch(`http://127.0.0.1:${this.port}/json`)).json() as { type: string; url: string; webSocketDebuggerUrl: string }[];
				const page = targets.find(t => t.type === 'page' && /workbench/.test(t.url));
				if (page) {
					return await Cdp.connect(page.webSocketDebuggerUrl);
				}
			} catch (error) {
				lastError = error;
			}
			await sleep(250);
		}
		throw new Error(`The window did not open its debugging port in ${timeoutMs} ms${lastError ? `: ${String(lastError)}` : ''}.`);
	}

	/** Closes the window: politely first, then for good. */
	async close(): Promise<void> {
		if (this.closed) {
			return;
		}
		this.closed = true;
		const gone = new Promise<void>(resolve => this.child.once('exit', () => resolve()));
		const signal = (name: NodeJS.Signals) => { try { process.kill(-this.child.pid!, name); } catch { /* already gone */ } };
		signal('SIGTERM');
		await Promise.race([gone, sleep(8000)]);
		signal('SIGKILL');
	}
}

export class Sandbox {
	readonly userData: string;
	readonly extensions: string;
	readonly workspace: string;
	readonly groupsFile: string;
	private readonly windows: Window[] = [];

	private constructor(readonly vscode: VsCode, readonly root: string) {
		this.userData = path.join(root, 'user-data');
		this.extensions = path.join(root, 'extensions');
		this.workspace = path.join(root, 'workspace');
		this.groupsFile = path.join(root, 'groups.json');
	}

	static async create(vscode: VsCode, name: string): Promise<Sandbox> {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), `bp-e2e-${name}-`));
		const sandbox = new Sandbox(vscode, root);
		fs.mkdirSync(sandbox.workspace, { recursive: true });
		fs.mkdirSync(path.join(sandbox.userData, 'User'), { recursive: true });
		fs.mkdirSync(sandbox.extensions, { recursive: true });
		fs.writeFileSync(path.join(sandbox.workspace, 'README.md'), '# workspace for the end-to-end tests\n');
		// Never trust a path: the command line must see this folder alone, and nothing installed in it yet.
		const listed = await sandbox.cli(['--list-extensions']);
		if (listed.code !== 0 || listed.stdout.trim() !== '') {
			await sandbox.dispose();
			throw new Error(`The sandbox is not isolated (the command line lists ${JSON.stringify(listed.stdout.trim())}, exit ${listed.code}): refusing to go on.`);
		}
		return sandbox;
	}

	/** The user settings of the default profile (where the application-scoped settings of the extension live). */
	writeSettings(settings: Record<string, unknown>): void {
		fs.writeFileSync(path.join(this.userData, 'User', 'settings.json'), JSON.stringify({
			'betterProfiles.groupsFile': this.groupsFile,
			'betterProfiles.autoSync': 'off',
			'window.dialogStyle': 'custom', // a dialog the page can be asked about, not a window of its own
			'workbench.startupEditor': 'none',
			'telemetry.telemetryLevel': 'off',
			'update.mode': 'none',
			'extensions.autoUpdate': false,
			'extensions.autoCheckUpdates': false,
			'chat.commandCenter.enabled': false,
			...settings,
		}, null, 2));
	}

	writeGroups(config: { groups: Record<string, string[]>; profiles: Record<string, string[]>; excludes?: Record<string, string[]> }): void {
		fs.writeFileSync(this.groupsFile, JSON.stringify(config, null, 2) + '\n');
	}

	readGroups(): { groups: Record<string, string[]>; profiles: Record<string, string[]>; excludes?: Record<string, string[]> } {
		return JSON.parse(fs.readFileSync(this.groupsFile, 'utf8'));
	}

	/** VS Code's command line, pointed at this sandbox. */
	cli(args: string[], timeoutMs = 120_000): Promise<CliResult> {
		const full = [path.join(this.vscode.appRoot, 'out', 'cli.js'), '--user-data-dir', this.userData, '--extensions-dir', this.extensions, ...args];
		return new Promise(resolve => {
			execFile(this.vscode.binary, full, { env: cleanEnv({ ELECTRON_RUN_AS_NODE: '1' }), timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
				resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr });
			});
		});
	}

	/** The ids that a profile has, as the command line lists them (sorted). */
	async list(profile?: string): Promise<string[]> {
		const result = await this.cli(['--list-extensions', ...(profile && profile !== 'Default' ? ['--profile', profile] : [])]);
		if (result.code !== 0) {
			throw new Error(`Listing the extensions of ${profile ?? 'Default'} failed: ${result.stderr.trim() || result.stdout.trim()}`);
		}
		return result.stdout.split(/\r?\n/).map(line => line.trim().toLowerCase()).filter(Boolean).sort();
	}

	/** Installs fixture extensions (one run of the command line for all of them) into a profile. */
	async install(extensions: FixtureExtension[], profile?: string): Promise<void> {
		const dir = path.join(this.root, 'vsix');
		fs.mkdirSync(dir, { recursive: true });
		const files = extensions.map(extension => {
			const file = path.join(dir, `${extension.publisher}.${extension.name}-${extension.version}.vsix`);
			fs.writeFileSync(file, buildVsix(extension));
			return file;
		});
		const result = await this.cli([...files.flatMap(file => ['--install-extension', file]), ...(profile && profile !== 'Default' ? ['--profile', profile] : [])]);
		if (result.code !== 0) {
			throw new Error(`Installing ${files.map(f => path.basename(f)).join(', ')} into ${profile ?? 'Default'} failed: ${result.stderr.trim() || result.stdout.trim()}`);
		}
	}

	/** Installs a packaged extension (the one under test) into a profile. */
	async installFile(file: string, profile?: string): Promise<void> {
		const result = await this.cli(['--install-extension', file, '--force', ...(profile && profile !== 'Default' ? ['--profile', profile] : [])]);
		if (result.code !== 0) {
			throw new Error(`Installing ${file} failed: ${result.stderr.trim() || result.stdout.trim()}`);
		}
	}

	/** Opens a window of this VS Code on the workspace folder, in a profile (created when it does not exist yet). */
	async launch(options: { profile?: string; folder?: string } = {}): Promise<Window> {
		const port = await freePort();
		const args = [
			'--user-data-dir', this.userData,
			'--extensions-dir', this.extensions,
			`--remote-debugging-port=${port}`,
			'--disable-workspace-trust',
			'--skip-welcome',
			'--skip-release-notes',
			'--disable-telemetry',
			...headlessFlags(),
			...(options.profile ? ['--profile', options.profile] : []),
			options.folder ?? this.workspace,
		];
		const child = spawn(this.vscode.binary, args, { env: cleanEnv(), detached: true, stdio: 'ignore' });
		const window = new Window(child, port);
		this.windows.push(window);
		return window;
	}

	/** A profile exists only once a window has been opened with it: this opens one, waits until VS Code has written it, and closes it. */
	async createProfile(name: string): Promise<void> {
		const window = await this.launch({ profile: name });
		try {
			const storage = path.join(this.userData, 'User', 'globalStorage', 'storage.json');
			const end = Date.now() + 90_000;
			while (Date.now() < end) {
				try {
					const profiles = JSON.parse(fs.readFileSync(storage, 'utf8')).userDataProfiles as { name: string }[] | undefined;
					if (profiles?.some(p => p.name === name)) {
						await sleep(1500); // let it finish writing its folder
						return;
					}
				} catch {
					// not written yet
				}
				await sleep(300);
			}
			throw new Error(`VS Code did not record the profile "${name}" in 90 s.`);
		} finally {
			await window.close();
		}
	}

	/** The `extensions.json` that VS Code keeps for a profile. */
	indexFile(profile?: string): string {
		if (!profile || profile === 'Default') {
			return path.join(this.extensions, 'extensions.json');
		}
		const storage = JSON.parse(fs.readFileSync(path.join(this.userData, 'User', 'globalStorage', 'storage.json'), 'utf8')) as { userDataProfiles: { name: string; location: string }[] };
		const found = storage.userDataProfiles.find(p => p.name === profile);
		if (!found) {
			throw new Error(`No profile "${profile}" in this sandbox.`);
		}
		return path.join(this.userData, 'User', 'profiles', found.location, 'extensions.json');
	}

	async dispose(): Promise<void> {
		await Promise.all(this.windows.map(w => w.close()));
		fs.rmSync(this.root, { recursive: true, force: true });
	}
}
