# Change Log

All notable changes to the "better-profiles" extension are documented here.

## [Unreleased]

### Changed

- The extension's settings are now application-scoped (shared by all profiles, still impossible to set from a
  workspace). They were machine-scoped, which is still per profile.

### Fixed

- The status bar showed `Default` in a non-default profile whenever the folder path had spaces or accents,
  the window was a multi-root workspace, or no folder was open. VS Code stores workspace URIs percent-encoded
  and keys a multi-root window by its `.code-workspace` file; detection now matches both.
- A workspace VS Code has not recorded a profile for now shows a neutral `Profile` instead of a wrong `Default`.
- A profile without an icon no longer renders a blank icon slot.
- `better-profiles.activate` was declared but never registered, so running it failed. It is removed.
- `getProfiles` returned nothing and showed a popup; it now returns the profiles.

### Added

- The Extensions view gear menu now shows `[Better Profiles] Remove from Group…` only for extensions that are in a group, and the
  `[Better Profiles] Add to Group…` list marks the groups that already hold the extension. (A menu label is fixed text, so the
  group names themselves cannot be shown in the menu.)
- The notifications after adding an extension to a group, or giving a group to a profile, now have a button for the next
  step (`Sync Profile…`, or `Give Group To A Profile…` when no profile follows the group) instead of telling you which command
  to run.
- Three entries in the Extensions view gear menu (the `extension/context` menu, next to "Apply Extension to all Profiles"):
  `[Better Profiles] Add to Group…`, `[Better Profiles] Remove from Group…` and `[Better Profiles] Install in Other Profiles…`. Removing from a
  group never uninstalls anything, and installing only offers profiles that lack the extension.
- Development: `flake.nix` with a default and a headless dev shell, and install / run-from-source / test instructions in the README.
- Install when needed: a group can have workspace triggers (globs such as `**/pubspec.yaml`). The automatic check
  only offers a triggered group in a workspace that matches one of its patterns, names the group in the notification,
  and **Sync** installs exactly what was announced. `Set Workspace Triggers For A Group…` edits them. An explicit sync
  still installs every group, and cleanup still counts every assigned group.
- Staying in sync: shortly after startup, and when the groups file is saved, the current profile is checked against
  its groups. `betterProfiles.autoSync` is `ask` (default: Sync / Not now / Stop asking, and "Not now" is remembered
  for that exact set), `auto` or `off`. The automatic check only installs. `Reset Sync Prompts` clears the memory.
- Uninstalling extensions a profile has but its groups do not mention: only through `Sync Profile With Its Groups…`,
  as a checkbox list with nothing ticked followed by a confirmation. Extensions every profile has (application
  scoped), this extension and `betterProfiles.keepExtensions` are never offered; neither is a profile whose groups
  are incomplete.
- `betterProfiles.autoSync` and `betterProfiles.keepExtensions` settings.
- Extension groups: `Add Extensions To Group…`, `Give A Group To A Profile…`, `Compare Extensions Across Profiles`,
  `Sync Profile With Its Groups…` and `Edit Groups File`, plus the `betterProfiles.groupsFile`,
  `betterProfiles.codeCommand` and `betterProfiles.codeArgs` settings.
- `Better Profiles: Switch Profile` command (the status bar item runs it).
- `activate()` returns a small API; `betterProfiles.storageFile` setting.
- A README, unit tests for the detection logic, and Extension Host tests that run against a real VS Code.
- The status bar refreshes when workspace folders change and when the window regains focus.
