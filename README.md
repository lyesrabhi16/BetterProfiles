# Better Profiles

Shows which VS Code profile the current window uses, right in the status bar, and switches profile in one click.

## What it does

- **Status bar item** with the profile's icon and name. Click it to open VS Code's profile switcher.
- **Command Palette:** `Better Profiles: Switch Profile`.
- Works for a single folder (spaces and accents in the path included) and for multi-root `.code-workspace` windows.
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

## Using it from other extensions

`activate()` returns an API (see `src/api.ts`): `getCurrentProfile()`, `getProfiles()`, `refresh()` and the
`statusBarItem`. The same data is available as the commands `better-profiles.getCurrentProfile` and
`better-profiles.getProfiles`.

## Known limits

- **Empty windows** cannot be identified, and neither can windows VS Code has not recorded yet. This includes
  Extension Development Host windows, which never record their profile.
- Remote windows (SSH, WSL, containers) are untested.

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

Planned, not implemented: grouping extensions across profiles and keeping profiles in sync with a group, and
enabling extensions only when a workspace needs them.
