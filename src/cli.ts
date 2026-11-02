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

/** Never throws for a failed install, so one bad extension does not stop the rest of a sync. */
export async function installExtension(cli: CliInvocation, runner: Runner, id: string, profile?: string): Promise<InstallResult> {
	if (!isExtensionId(id)) {
		return { id, ok: false, message: `"${id}" is not a valid extension id (expected publisher.name).` };
	}
	try {
		const result = await run(cli, runner, installArgs(id, profile));
		return result.code === 0
			? { id, ok: true, message: lastLine(result.stdout) }
			: { id, ok: false, message: firstLine(result.stderr) || firstLine(result.stdout) || `The CLI exited with code ${result.code}.` };
	} catch (error) {
		return { id, ok: false, message: error instanceof Error ? error.message : String(error) };
	}
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
