// Reads how an installed extension presents itself (name, publisher, description, icon) from its folder in the
// extensions directory, which holds every extension of every profile. No `vscode` import.

export interface ExtensionInfo {
	/** The display name, like VS Code's Extensions list: `displayName`, else `name`. */
	name: string;
	publisher?: string;
	description?: string;
	version?: string;
	/** Absolute path of the icon image, only when it exists inside the extension's own folder. */
	iconPath?: string;
}

/** Resolves a `%key%` placeholder through the extension's package.nls.json. Plain text is returned as it is. */
export function resolveNls(_value: unknown, _nls?: Record<string, unknown>): string | undefined {
	throw new Error('not implemented');
}

/**
 * The folder of an installed extension: `<id>-<version>[-<platform>]`, lower-case. With a version it picks that one
 * (CLI versions look like `1.2.3` or `1.2.3@linux-x64`); without one, or when that folder is gone, the latest.
 */
export function pickFolder(_folders: string[], _id: string, _version?: string): string | undefined {
	throw new Error('not implemented');
}

export class ExtensionCatalog {
	constructor(private readonly dir: () => string | undefined) { }

	/** Forgets what was read, so the next lookup sees the extensions folder as it is then. */
	clear(): void {
		throw new Error('not implemented');
	}

	async lookup(_id: string, _version?: string): Promise<ExtensionInfo | undefined> {
		void this.dir;
		throw new Error('not implemented');
	}
}
