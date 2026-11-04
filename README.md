# Better Profiles

Shows which VS Code profile the current window uses, right in the status bar, and switches profile in one click.

## What it does

- **Status bar item** with the profile's icon and name. Click it to open VS Code's profile switcher.
- **Command Palette:** `Better Profiles: Switch Profile`.
- Works for a single folder (spaces and accents in the path included) and for multi-root `.code-workspace` windows.
- **Extension groups:** define sets of extensions once ("web", "python"…), give them to profiles, compare what each
  profile has, and install what a profile is missing. See [Extension groups](#extension-groups).
- **Honest when it cannot tell.** The item then reads `Profile`, and its tooltip says why:
  - no folder is open (an empty window),
  - VS Code has not recorded a profile for this workspace yet,
  - the workspace uses a profile that was deleted.

## Install

There is no Marketplace listing yet, so build a `.vsix` from this repository and install that. You need Node.js and npm
(or the [Nix dev shell](#with-nix), which has them).

```bash
git clone https://github.com/lyesrabhi16/BetterProfiles.git
cd BetterProfiles
npm ci
npx @vscode/vsce package                              # writes better-profiles-1.0.0.vsix
code --install-extension better-profiles-1.0.0.vsix
```

No `code` command on your PATH? In VS Code open the Extensions view, choose **…** then **Install from VSIX…**, and pick the file.

An extension is installed per profile. The command above installs it into the Default profile; for another profile add
`--profile`:

```bash
code --install-extension better-profiles-1.0.0.vsix --profile Python
```

To have it in every profile at once, right-click it in the Extensions view and choose **Apply Extension to all Profiles**.
VS Code may ask you to reload the window before the status bar item appears.

## How it works

VS Code gives extensions no API for the current profile, and the Extension Host exposes nothing about it either
(no environment variable, and the global storage path is the same in every profile). The only place the answer
lives is VS Code's own `storage.json`, which records `userDataProfiles` and, for each workspace, which profile it
opens with. Better Profiles reads that file and looks up your window using the same URI string VS Code stores.

That file is internal and undocumented, so a future VS Code release could change it. The tests would catch that
(see below).

## Settings

| Setting | Default | Purpose |
|---|---|---|
| `betterProfiles.storageFile` | empty | Advanced. Path to a different `storage.json`. Empty means the one next to the extension's global storage. |
| `betterProfiles.groupsFile` | empty | Where the extension groups are kept. Empty means `groups.json` in the extension's global storage. |
| `betterProfiles.autoSync` | `ask` | `off`, `ask` or `auto`: what to do when the current profile lacks extensions of its groups. See [Staying in sync](#staying-in-sync). |
| `betterProfiles.keepExtensions` | `[]` | Extension ids that are never offered for uninstalling. |
| `betterProfiles.codeCommand` | empty | Advanced. Run this executable instead of VS Code's own command line to list and install extensions. |
| `betterProfiles.codeArgs` | `[]` | Advanced. Arguments that always come first for `codeCommand`, for example `--user-data-dir` and `--extensions-dir`. |

## Extension groups

VS Code profiles each keep their own extension list, so the same extensions end up installed and forgotten in
several places. Groups let you name a set once and give it to the profiles that need it.

| Command | What it does |
|---|---|
| `Better Profiles: Add Extensions To Group…` | Pick a group (or make one) and tick extensions from a profile that already has them. |
| `Better Profiles: Give A Group To A Profile…` | Make a profile (or all of them) follow a group. |
| `Better Profiles: Compare Extensions Across Profiles` | Opens a table: one row per extension, one column per profile. |
| `Better Profiles: Sync Profile With Its Groups…` | Installs what a profile is missing (after you confirm), then offers to uninstall what its groups do not mention (you tick what goes). |
| `Better Profiles: Set Workspace Triggers For A Group…` | Tell a group which files mean "this workspace needs me" (see [Install when needed](#install-when-needed)). |
| `Better Profiles: Reset Sync Prompts` | Forget "Not now" answers so the prompt below can appear again. |
| `Better Profiles: Edit Groups File` | Opens the JSON file below. |

The groups live in one file shared by every profile (VS Code settings are per profile, which would split them):

```json
{
  "groups": {
    "web": ["dbaeumer.vscode-eslint", "esbenp.prettier-vscode"],
    "python": ["ms-python.python"]
  },
  "profiles": {
    "*": ["web"],
    "Python": ["python"]
  }
}
```

`"*"` means every profile; `Default` is the default profile. The file is in this extension's global storage unless
`betterProfiles.groupsFile` points elsewhere (for example into a dotfiles repository).

Extensions VS Code installs once for all profiles ("application scoped") count as present everywhere, and they
show up in every column of the comparison.

### Staying in sync

Shortly after startup, and whenever you save the groups file, Better Profiles checks whether this window's profile
has every extension of its groups. What happens next is `betterProfiles.autoSync`:

- `ask` (default): a notification names the profile and what is missing, with **Sync**, **Not now** and **Stop asking**.
  *Not now* is remembered for that exact set of extensions, so it does not nag until the set changes
  (`Reset Sync Prompts` clears it). *Stop asking* sets `autoSync` to `off`.
- `auto`: installs what is missing without asking.
- `off`: never checks.

Nothing is checked, and no command line is started, for a profile that has no groups, or when the window's
profile cannot be determined (see Known limits). **The automatic check only ever installs.**

### Install when needed

A group can name the files that show a workspace needs it:

```json
{
  "groups": { "flutter": ["dart-code.flutter"], "python": ["ms-python.python"] },
  "profiles": { "Mobile": ["flutter", "python"] },
  "triggers": {
    "flutter": ["**/pubspec.yaml"],
    "python": ["**/pyproject.toml", "**/requirements.txt"]
  }
}
```

The patterns are globs relative to each workspace folder (no absolute paths, no `..`); `node_modules` and `.git`
are not searched. A group **without** triggers is always wanted, as before. A group **with** triggers is only wanted
by the automatic check when one of its patterns matches a file in the open workspace. In the example, opening a
Flutter project in the "Mobile" profile offers `dart-code.flutter` but not `ms-python.python`; the notification names
the group it matched, and **Sync** installs exactly what it announced.

The check runs when the window starts, when the workspace folders change, and when you save the groups file. It does
not watch for matching files appearing later.

The search stops at the first match and runs outside the editor process. Measured on a synthetic workspace of 200,000
files (100,000 of them under `node_modules`), a pattern that matches nothing took about 30 ms, the same as ripgrep on its
own. Those were warm-cache numbers on an SSD; a cold disk or a far larger repository will take longer.

Triggers only decide what the *automatic* check offers:

- `Sync Profile With Its Groups…` is an explicit request, so it installs every group of the profile, triggers or not.
- Cleanup considers all the profile's groups, matched or not. Another workspace may need a group this one does not,
  so its extensions are never offered for removal just because this workspace does not match. For the same reason
  nothing tells you an extension is "no longer needed".

### Uninstalling

Removing extensions is never automatic. It only happens through `Sync Profile With Its Groups…` (also offered after
you click **Sync** in the notification), in three steps: a checkbox list of the *extras* with **nothing ticked**,
you tick what should go, then a confirmation that lists exactly those.

An extra is an extension the profile has that none of its groups mention. The list is only offered when the groups
describe the profile completely, that is the profile has groups and every group it refers to exists. These are never
offered, whatever the groups say:

- extensions that every profile has, because VS Code installs some once for all profiles ("application scoped")
  and removing one from a single profile would remove it everywhere;
- this extension itself;
- anything in `betterProfiles.keepExtensions`.

A failed uninstall (for example because another extension depends on it) is reported and the rest still run.

**How it installs.** VS Code has no extension API for installing into another profile, so it runs VS Code's own
command line, `--list-extensions` and `--install-extension` with `--profile`, the same way the `code` launcher does,
and always against *this* VS Code's user-data and extensions folders. If it cannot tell which extensions folder
that is, it stops and tells you instead of guessing. Extension ids are checked first (`publisher.name`, never a
flag or a file path). `betterProfiles.codeCommand` and `betterProfiles.codeArgs` let you point it at another build
or a portable install; both are application-scoped: shared by every profile, and a workspace cannot set them.

Every command also accepts arguments, so it can be driven without prompts (see `src/groupCommands.ts`).

## Using it from other extensions

`activate()` returns an API (see `src/api.ts`): `getCurrentProfile()`, `getProfiles()`, `refresh()` and the
`statusBarItem`. The same data is available as the commands `better-profiles.getCurrentProfile` and
`better-profiles.getProfiles`.

## Known limits

- **Empty windows** cannot be identified, and neither can windows VS Code has not recorded yet. This includes
  Extension Development Host windows, which never record their profile.
- **Remote windows (SSH, WSL, containers) are untested.** The extension declares `extensionKind: ["workspace", "ui"]`, so in a
  remote window it would run on the remote side, where VS Code's local profile records are not available: expect the
  `Profile` label there. Whether `["ui", "workspace"]` would let it run on the local side instead, and so see them, has
  not been tried.
- The startup timer of the automatic check is not covered by the tests (they call `checkSync()` directly, because a
  timer would race with them). The notification and the checkbox list were checked on screen in a scratch VS Code.
- Whether a window already open in a profile picks up extensions installed into it by a sync without a reload is
  untested.

## Development

### With Nix

`flake.nix` has two dev shells for Linux (x86_64 and aarch64). They use the `vscode` package from nixpkgs, which is
unfree, to run the tests in a real VS Code; `flake.lock` pins it.

```bash
nix develop            # Node.js 22, vsce, and a VS Code for the tests
npm ci
npm run test:unit      # pure logic, no VS Code needed
npm test               # runs inside a real VS Code Extension Host; opens windows, so it needs a display
```

Without a display (CI, a server), use the headless shell, which adds `xvfb-run`:

```bash
nix develop .#headless -c xvfb-run -a npm test
```

The shell sets `BETTER_PROFILES_VSCODE` to that VS Code. It is not put on your PATH, so it never replaces the `code` you
use; set the variable yourself first to test against another build. The tests pass on VS Code 1.119.0 and on 1.144.0,
the version `flake.lock` pins at the time of writing. `nix flake update` moves the pin. A flake only sees files git knows
about, so `git add` new files before running `nix develop`. With direnv, `echo "use flake" > .envrc` loads the shell
automatically.

### Without Nix

Install Node.js and npm, then:

```bash
npm ci
npm run test:unit      # pure logic, no VS Code needed
npm test               # also runs inside a real VS Code Extension Host
```

`npm test` downloads the latest stable VS Code. To use one you already have instead, and to run without a display:

```bash
BETTER_PROFILES_VSCODE=/path/to/the/vscode/executable \
BETTER_PROFILES_HEADLESS=1 \
xvfb-run -a npm test
```

(I have not run the download path myself; the tests were run with an installed VS Code.)

### Run it from source

Open the folder in VS Code, accept the recommended extensions (`amodio.tsl-problem-matcher` supplies the problem matcher that
the watch task uses), run `npm ci`, and press **F5**. The `Run Extension` launch configuration starts `npm: watch` (webpack) and
opens an *Extension Development Host* window with the extension loaded. After an edit, webpack rebuilds; reload the
host window to pick it up.

Or without the editor's debugger:

```bash
npm run compile
code --extensionDevelopmentPath="$PWD"
```

An Extension Development Host window cannot tell which profile it is in (see Known limits), so its status bar reads
`Profile`. Install the `.vsix` to see the real behaviour.

### How the tests run

Every run uses its own throwaway user-data and extensions directories, so it never touches your real profiles, and
`npm test` makes two windows: a single folder, and the two-folder workspace in `test-fixtures/multi-root`. The single folder
(`test-fixtures/workspace é with spaces`) is named with spaces and an accent on purpose: VS Code stores its URI
percent-encoded, which is what the old detection got wrong.

## What it cannot do: enabling and disabling extensions

"Only activate an extension where it is needed" would mean enabling and disabling other extensions per workspace.
An extension cannot do that in VS Code 1.119. Checked in the `1.119.0` source of microsoft/vscode:

- Per-extension enable and disable exist only as UI actions (`EnableForWorkspaceAction`, `DisableForWorkspaceAction`
  and two more in `extensionsActions.ts`). Each holds an `extension` that the menu sets, and `run()` calls an internal service.
  They are not registered as commands.
- The only enablement commands in `extensions.contribution.ts` are all-or-nothing:
  `workbench.extensions.action.enableAll`, `disableAll` and their `…Workspace` variants.
- `vscode.d.ts` has nothing for it: `Extension<T>` has no enable or disable, and neither does the `extensions` namespace.
- The command line's `--disable-extension` hides an extension for that launch only.

What is available by extension id is installing and uninstalling, so this extension brings in what a workspace needs
(see above) and offers to remove what no group wants, and leaves enabling to VS Code's own lazy activation.
