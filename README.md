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
| `Better Profiles: Sync Profile With Its Groups…` | Shows what is missing from a profile and installs it after you confirm. |
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

**Sync only adds.** It never uninstalls or disables anything, and it skips what the profile already has.
Extensions VS Code installs once for all profiles ("application scoped") count as present everywhere, and they
show up in every column of the comparison.

**How it installs.** VS Code has no extension API for installing into another profile, so it runs VS Code's own
command line, `--list-extensions` and `--install-extension` with `--profile`, the same way the `code` launcher does,
and always against *this* VS Code's user-data and extensions folders. If it cannot tell which extensions folder
that is, it stops and tells you instead of guessing. Extension ids are checked first (`publisher.name`, never a
flag or a file path). `betterProfiles.codeCommand` and `betterProfiles.codeArgs` let you point it at another build
or a portable install; both are machine-scoped, so a workspace cannot set them.

Every command also accepts arguments, so it can be driven without prompts (see `src/groupCommands.ts`).

## Using it from other extensions

`activate()` returns an API (see `src/api.ts`): `getCurrentProfile()`, `getProfiles()`, `refresh()` and the
`statusBarItem`. The same data is available as the commands `better-profiles.getCurrentProfile` and
`better-profiles.getProfiles`.

## Known limits

- **Empty windows** cannot be identified, and neither can windows VS Code has not recorded yet. This includes
  Extension Development Host windows, which never record their profile.
- Remote windows (SSH, WSL, containers) are untested.
- Whether a window already open in a profile picks up extensions installed into it by a sync without a reload is
  untested.

## Development

```bash
npm ci
npm run test:unit      # pure logic, no VS Code needed
npm test               # also runs inside a real VS Code Extension Host
```

`npm test` downloads VS Code. To use an installed one instead (needed on NixOS), and to run without a display:

```bash
BETTER_PROFILES_VSCODE=/path/to/vscode/executable \
BETTER_PROFILES_HEADLESS=1 \
xvfb-run -a npm test
```

Every run uses its own throwaway user-data and extensions directories, so it never touches your real profiles.
The workspace opened by the tests (`test-fixtures/workspace é with spaces`) is named with spaces and an accent on
purpose: VS Code stores its URI percent-encoded, which is what the old detection got wrong.

## Not built yet

Planned, not implemented: enabling extensions only when a workspace needs them. VS Code has no public API for one
extension to enable or disable another, so this needs a workaround that has not been tried yet.
