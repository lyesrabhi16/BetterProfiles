import { defineConfig } from '@vscode/test-cli';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Every run gets its own user-data and extensions dirs, so the tests never touch your real VS Code profiles.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'better-profiles-test-'));

// BETTER_PROFILES_VSCODE: path to an installed VS Code executable (the Nix dev shell sets it). Without it VS Code is
// downloaded: the latest stable one, or VSCODE_VERSION ("insiders", or a version such as 1.95.0).
const installation = process.env.BETTER_PROFILES_VSCODE
	? { useInstallation: { fromPath: process.env.BETTER_PROFILES_VSCODE } }
	: { version: process.env.VSCODE_VERSION ?? 'stable' };

// BETTER_PROFILES_HEADLESS=1 adds the flags needed under Xvfb (no GPU, X11, no sandbox).
const headless = process.env.BETTER_PROFILES_HEADLESS ? ['--disable-gpu', '--ozone-platform=x11', '--no-sandbox'] : [];

const common = name => ({
	...installation,
	launchArgs: [
		'--user-data-dir', path.join(scratch, name, 'user-data'),
		'--extensions-dir', path.join(scratch, name, 'extensions'),
		'--disable-workspace-trust',
		'--skip-welcome',
		'--skip-release-notes',
		...headless,
	],
	mocha: { ui: 'tdd', timeout: 30000 },
});

// Two runs, each in its own VS Code window: the workspace decides what VS Code records and what can be searched.
export default defineConfig([
	{
		label: 'single folder',
		files: ['out/test/*.test.js', 'out/test/unit/**/*.test.js'],
		// The folder name has spaces and an accent on purpose: VS Code stores its URI percent-encoded.
		workspaceFolder: './test-fixtures/workspace é with spaces',
		...common('single-folder'),
	},
	{
		label: 'multi-root',
		files: 'out/test/multiroot/*.test.js',
		// Two folders, a/ and b/; only b/ contains a pubspec.yaml.
		workspaceFolder: './test-fixtures/multi-root/multi.code-workspace',
		...common('multi-root'),
	},
]);
