// Runs VS Code's own CLI (`--list-extensions`, `--install-extension`, `--profile`). No `vscode` import.

import { execFile } from 'child_process';
import * as path from 'path';
import { isExtensionId } from './groups';

export const DEFAULT_PROFILE_NAME = 'Default';

export interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

export type Runner = (command: string, args: string[], env: Record<string, string>) => Promise<RunResult>;

export interface CliInvocation {
	command: string;
	/** Arguments that always come first (the CLI script and the instance's directories). */
	args: string[];
	env: Record<string, string>;
}

export interface ResolveOptions {
	/** `betterProfiles.codeCommand`: an executable to use instead of the built-in CLI. */
	command?: string;
	/** `betterProfiles.codeArgs`: arguments that always precede ours (for example --user-data-dir). */
	args?: string[];
	execPath: string;
	appRoot: string;
	userDataDir: string;
	extensionsDir?: string;
}

export interface InstalledExtension {
	id: string;
	version?: string;
	/** Its folder in the extensions folder, when the source of the list says (the command line does not). */
	folder?: string;
	/** VS Code applies it to all profiles (one copy for every profile). Known from VS Code's files, not from the command line. */
	applicationScoped?: boolean;
}

export interface InstallResult {
	id: string;
	ok: boolean;
	message: string;
}

export class CliError extends Error {
	constructor(message: string, readonly code?: number) {
		super(message);
		this.name = 'CliError';
	}
}

/**
 * How to run the CLI. By default that is what the `code` launcher does (the editor binary run as node on
 * `resources/app/out/cli.js`), pointed at THIS instance's directories. When those directories cannot be
 * established it refuses, because a CLI left on its defaults could change a different installation.
 */
export function resolveCli(options: ResolveOptions): CliInvocation | { error: string } {
	const configured = options.command?.trim();
	if (configured) {
		return { command: configured, args: [...(options.args ?? [])], env: {} };
	}
	if (!options.extensionsDir) {
		return {
			error: 'Cannot tell which extensions folder this VS Code uses (no installed extension to go on). '
				+ 'Set betterProfiles.codeCommand and betterProfiles.codeArgs (for example --user-data-dir and --extensions-dir) to point at it.',
		};
	}
	return {
		command: options.execPath,
		args: [path.join(options.appRoot, 'out', 'cli.js'), '--user-data-dir', options.userDataDir, '--extensions-dir', options.extensionsDir],
		env: { ELECTRON_RUN_AS_NODE: '1' },
	};
}

/** `<user-data-dir>/User/globalStorage/<extension id>` -> `<user-data-dir>`. */
export function userDataDirFromGlobalStorage(globalStoragePath: string): string {
	return path.dirname(path.dirname(path.dirname(globalStoragePath)));
}

/** storage.json lives in <user data folder>/User/globalStorage: where that folder is, or undefined for a file kept elsewhere. */
export function userDataDirFromStorageFile(storageFile: string): string | undefined {
	const normalised = storageFile.replace(/\\/g, '/');
	return normalised.endsWith('/User/globalStorage/storage.json') ? path.dirname(path.dirname(path.dirname(storageFile))) : undefined;
}

/** The folder most installed extensions live in, or undefined when there is nothing to go on. */
export function pickExtensionsDir(extensionPaths: string[]): string | undefined {
	const counts = new Map<string, number>();
	for (const extensionPath of extensionPaths) {
		const dir = path.dirname(extensionPath);
		counts.set(dir, (counts.get(dir) ?? 0) + 1);
	}
	let best: string | undefined;
	let bestCount = 0;
	for (const [dir, count] of counts) {
		if (count > bestCount) {
			best = dir;
			bestCount = count;
		}
	}
	return best;
}

const LIST_LINE = /^([a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9._-]*)(?:@(.+))?$/i;

export function parseExtensionList(stdout: string): InstalledExtension[] {
	const extensions: InstalledExtension[] = [];
	for (const line of stdout.split(/\r?\n/)) {
		const match = LIST_LINE.exec(line.trim());
		if (match) {
			extensions.push(match[2] === undefined ? { id: match[1] } : { id: match[1], version: match[2] });
		}
	}
	return extensions;
}

const profileArgs = (profile?: string): string[] => (profile && profile !== DEFAULT_PROFILE_NAME ? ['--profile', profile] : []);

export function listArgs(profile?: string): string[] {
	return ['--list-extensions', '--show-versions', ...profileArgs(profile)];
}

export function installArgs(id: string, profile?: string): string[] {
	return ['--install-extension', id, ...profileArgs(profile)];
}

const firstLine = (text: string): string => text.split(/\r?\n/).map(l => l.trim()).find(l => l !== '') ?? '';
const lastLine = (text: string): string => text.split(/\r?\n/).map(l => l.trim()).filter(l => l !== '').pop() ?? '';

async function run(cli: CliInvocation, runner: Runner, args: string[]): Promise<RunResult> {
	try {
		return await runner(cli.command, [...cli.args, ...args], cli.env);
	} catch (error) {
		throw new CliError(`Could not run ${cli.command}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export async function listExtensions(cli: CliInvocation, runner: Runner, profile?: string): Promise<InstalledExtension[]> {
	const result = await run(cli, runner, listArgs(profile));
	if (result.code !== 0) {
		throw new CliError(firstLine(result.stderr) || firstLine(result.stdout) || `The CLI exited with code ${result.code}.`, result.code);
	}
	return parseExtensionList(result.stdout);
}

/** Runs one install or uninstall. Never throws, so one bad extension does not stop the rest of a batch. */
async function changeExtension(cli: CliInvocation, runner: Runner, id: string, args: string[]): Promise<InstallResult> {
	if (!isExtensionId(id)) {
		return { id, ok: false, message: `"${id}" is not a valid extension id (expected publisher.name).` };
	}
	try {
		const result = await run(cli, runner, args);
		return result.code === 0
			? { id, ok: true, message: lastLine(result.stdout) }
			: { id, ok: false, message: firstLine(result.stderr) || firstLine(result.stdout) || `The CLI exited with code ${result.code}.` };
	} catch (error) {
		return { id, ok: false, message: error instanceof Error ? error.message : String(error) };
	}
}

export const installExtension = (cli: CliInvocation, runner: Runner, id: string, profile?: string): Promise<InstallResult> =>
	changeExtension(cli, runner, id, installArgs(id, profile));

export const uninstallExtension = (cli: CliInvocation, runner: Runner, id: string, profile?: string): Promise<InstallResult> =>
	changeExtension(cli, runner, id, uninstallArgs(id, profile));

/** One flag per extension and the profile once: the CLI takes several in a single run, and each run costs a start-up. */
export function uninstallManyArgs(ids: string[], profile?: string): string[] {
	return [...ids.flatMap(id => ['--uninstall-extension', id]), ...profileArgs(profile)];
}

const PROGRESS = /^Uninstalling\s/i;

/**
 * Uninstalls several extensions in as few runs of the CLI as it can (starting it is most of the cost of each). Never throws.
 *
 * The real CLI does them one after the other and STOPS at the first one it cannot do (typically because another extension
 * needs it), without trying the rest. So when it stops, the extension it stopped at is put last and the others are tried
 * again: they go, and that one then often goes too (what needed it is gone). One that fails even when it comes last is
 * reported, with the CLI's own reason, and the rest still go.
 */
export async function uninstallExtensions(
	cli: CliInvocation,
	runner: Runner,
	ids: string[],
	profile?: string,
	options: { /** Told about every run of the CLI, to be logged. */ onRun?: (run: { ids: string[]; code: number; stdout: string; stderr: string }) => void } = {},
): Promise<InstallResult[]> {
	const invalid = (id: string): InstallResult => ({ id, ok: false, message: `"${id}" is not a valid extension id (expected publisher.name).` });
	const key = (id: string) => id.toLowerCase();
	const valid = [...new Map(ids.filter(isExtensionId).map(id => [key(id), id])).values()];
	if (valid.length === 0) {
		return ids.map(invalid);
	}
	const results = new Map<string, InstallResult>();
	const succeed = (id: string, message: string) => { results.set(key(id), { id, ok: true, message }); };
	/** The line that says this extension went, else the last line of the run. */
	const wentLine = (stdout: string, id: string) => stdout.split(/\r?\n/).map(l => l.trim()).find(l => /was successfully uninstalled/i.test(l) && key(l).includes(`'${key(id)}'`)) ?? lastLine(stdout);
	const fail = (id: string, message: string) => { results.set(key(id), { id, ok: false, message }); };
	const reasonOf = (result: RunResult, id?: string): string => {
		const lines = `${result.stderr}\n${result.stdout}`.split(/\r?\n/).map(l => l.trim()).filter(l => l !== '' && !PROGRESS.test(l) && !/was successfully uninstalled/i.test(l));
		return (id === undefined ? undefined : lines.find(line => key(line).includes(key(id)))) ?? lines[0] ?? `The CLI exited with code ${result.code}.`;
	};

	let remaining = [...valid];
	const deferred = new Set<string>();
	for (let round = 0; remaining.length > 0 && round < valid.length * 2 + 2; round++) {
		let result: RunResult;
		try {
			result = await run(cli, runner, uninstallManyArgs(remaining, profile));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			remaining.forEach(id => fail(id, message));
			remaining = [];
			break;
		}
		options.onRun?.({ ids: [...remaining], code: result.code, stdout: result.stdout, stderr: result.stderr });
		if (result.code === 0) {
			remaining.forEach(id => succeed(id, wentLine(result.stdout, id)));
			remaining = [];
			break;
		}
		const went = new Set([...result.stdout.matchAll(/Extension '([^']+)' was successfully uninstalled/gi)].map(m => key(m[1])));
		remaining.filter(id => went.has(key(id))).forEach(id => succeed(id, wentLine(result.stdout, id)));
		const left = remaining.filter(id => !went.has(key(id)));

		// The CLI checks that an extension is installed right before it uninstalls it, and says if it is not (before any
		// progress line for it). Not installed is what was asked for: it is done, and the others go on.
		const absent = left.find(id => key(id) === key(/Extension '([^']+)' is not installed/i.exec(result.stderr)?.[1] ?? ''));
		if (absent !== undefined) {
			succeed(absent, `${absent} was not installed.`);
			remaining = left.filter(id => id !== absent);
			continue;
		}

		// The CLI names the extension it was at in its last "Uninstalling x..." line. Without one, it failed right after
		// the ones that went, so it was at the next one. With nothing done and nothing said it failed as a whole.
		const attempted = [...result.stdout.matchAll(/^Uninstalling (\S+?)\.\.\./gm)].map(m => key(m[1]));
		const unfinished = left.find(id => key(id) === attempted[attempted.length - 1]);
		const stoppedAt = unfinished ?? (went.size > 0 ? left[0] : undefined);
		if (stoppedAt === undefined) {
			left.forEach(id => fail(id, reasonOf(result, id))); // it failed without saying where: nothing to retry
			remaining = [];
			break;
		}
		if (deferred.has(stoppedAt) || left[left.length - 1] === stoppedAt) {
			fail(stoppedAt, reasonOf(result)); // it failed after everything else was done, or after being tried last already
			remaining = left.filter(id => id !== stoppedAt);
		} else {
			deferred.add(stoppedAt);
			remaining = [...left.filter(id => id !== stoppedAt), stoppedAt];
		}
	}
	remaining.forEach(id => fail(id, 'The CLI could not uninstall it.'));
	return ids.map(id => (isExtensionId(id) ? results.get(key(id))! : invalid(id)));
}

/** Real runner: the CLI is slow to start but never needs a shell, so arguments are passed as they are. */
export const defaultRunner: Runner = (command, args, env) =>
	new Promise((resolve, reject) => {
		execFile(command, args, { env: { ...process.env, ...env }, timeout: 180_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
			if (error && typeof error.code !== 'number') {
				reject(error);
			} else {
				resolve({ code: error ? (error.code as number) : 0, stdout, stderr });
			}
		});
	});

/**
 * Whether `extensionPath` is where VS Code unpacked an installed extension: a folder named
 * `<publisher.name>-<version>[-<platform>]`. Development checkouts and built-in extensions are not.
 */
export function isInstalledExtensionPath(id: string, extensionPath: string): boolean {
	const folder = path.basename(extensionPath).toLowerCase();
	const prefix = `${id.toLowerCase()}-`;
	return folder.startsWith(prefix) && /^\d/.test(folder.slice(prefix.length));
}

export function uninstallArgs(id: string, profile?: string): string[] {
	return ['--uninstall-extension', id, ...profileArgs(profile)];
}
