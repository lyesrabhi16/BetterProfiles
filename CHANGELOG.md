# Change Log

All notable changes to the "better-profiles" extension are documented here.

## [Unreleased]

### Fixed

- The status bar showed `Default` in a non-default profile whenever the folder path had spaces or accents,
  the window was a multi-root workspace, or no folder was open. VS Code stores workspace URIs percent-encoded
  and keys a multi-root window by its `.code-workspace` file; detection now matches both.
- A workspace VS Code has not recorded a profile for now shows a neutral `Profile` instead of a wrong `Default`.
- A profile without an icon no longer renders a blank icon slot.
- `better-profiles.activate` was declared but never registered, so running it failed. It is removed.
- `getProfiles` returned nothing and showed a popup; it now returns the profiles.

### Added

- Extension groups: `Add Extensions To Group…`, `Give A Group To A Profile…`, `Compare Extensions Across Profiles`,
  `Sync Profile With Its Groups…` and `Edit Groups File`, plus the `betterProfiles.groupsFile`,
  `betterProfiles.codeCommand` and `betterProfiles.codeArgs` settings. Sync only installs, never removes.
- `Better Profiles: Switch Profile` command (the status bar item runs it).
- `activate()` returns a small API; `betterProfiles.storageFile` setting.
- A README, unit tests for the detection logic, and Extension Host tests that run against a real VS Code.
- The status bar refreshes when workspace folders change and when the window regains focus.
