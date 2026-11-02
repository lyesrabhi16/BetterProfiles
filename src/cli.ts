// Runs VS Code's own CLI (`--list-extensions`, `--install-extension`, `--profile`). No `vscode` import.

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

export function resolveCli(_options: ResolveOptions): CliInvocation | { error: string } {
	throw new Error('not implemented');
}

/** `<user-data-dir>/User/globalStorage/<extension id>` -> `<user-data-dir>`. */
export function userDataDirFromGlobalStorage(_globalStoragePath: string): string {
	throw new Error('not implemented');
}

/** The folder most installed extensions live in, or undefined when there is nothing to go on. */
export function pickExtensionsDir(_extensionPaths: string[]): string | undefined {
	throw new Error('not implemented');
}

export function parseExtensionList(_stdout: string): InstalledExtension[] {
	throw new Error('not implemented');
}

export function listArgs(_profile?: string): string[] {
	throw new Error('not implemented');
}

export function installArgs(_id: string, _profile?: string): string[] {
	throw new Error('not implemented');
}

export async function listExtensions(_cli: CliInvocation, _run: Runner, _profile?: string): Promise<InstalledExtension[]> {
	throw new Error('not implemented');
}

export async function installExtension(_cli: CliInvocation, _run: Runner, _id: string, _profile?: string): Promise<InstallResult> {
	throw new Error('not implemented');
}
