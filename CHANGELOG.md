# Change Log

All notable changes to the "better-profiles" extension are documented here.

## [Unreleased]

### Changed

- The extension's settings are now application-scoped (shared by all profiles, still impossible to set from a
  workspace). They were machine-scoped, which is still per profile.
- Actions in the Better Profiles tab are instant: a removal takes the extension out of the tree, and an install shows it (marked
  "installing…"), before the command line has done anything; what could not be done comes back with a message. Confirmation
  questions appear at once. Measured in a real VS Code: the question after 44 ms (was 514 ms), the extension gone 84 ms after
  confirming, and an installed extension shown 30 ms after the drop.
- The extensions of a profile are read from the `extensions.json` VS Code keeps for it, a few milliseconds instead of a start of the
  command line, and re-read only when the file changed. The tree redraws when something else changes one. The command line is the
  fallback (a missing or unreadable file) and `betterProfiles.listFromFiles` turns the files off.
- The extension catalog is incremental: what was read of an extension is kept (checked by one look at its `package.json`), so changes
  to the groups no longer read every extension again.
- The sync's cleanup uninstalls everything it was told to in one run of the command line, and shows the result at once.

### Fixed

- A removal could report dozens of extensions as failed with "Extension 'x' is not installed" (one id, the same message on every line)
  when the first extension it asked for was not installed any more. VS Code's command line checks each extension right before it
  uninstalls it and stops with that error, before printing any progress line, so the extension could not be told which one it had
  stopped at and gave up on all the rest. An extension that is not installed is now treated as done, the rest goes on, and a failure
  after some went is attributed to the next extension in the list. Every run of the command line is now written to the log (exit code
  and its last lines), and the profile is read again quietly afterwards so the tree shows what is really installed.
- The message "Kept x: this extension, what keepExtensions lists and what every profile has is never uninstalled." listed every possible
  reason and never said which one applied, nor what to do. It now says the reason for each extension ("VS Code applies it to all
  profiles, so removing it here would remove it from every profile. To remove it from just this profile, turn off Apply Extension to all
  Profiles for it in the Extensions view first."), and the question before the uninstall says it too.
- Only what VS Code marks as applied to all profiles is protected from a per-profile removal when its files can be read. An extension that
  merely happens to be installed in every profile can be removed from one (it was kept before). The command line's lists, which cannot
  tell the two apart, still use the old guess.
- Removing several extensions from a profile failed as a whole when one of them could not be uninstalled: VS Code's command line stops at
  the first extension it cannot remove (for example Java language support, which the Java test runner needs) and does not try the
  rest, and every extension was reported with that one error (or with its "Uninstalling x..." progress line). The extension it stopped
  at is now put last and the others are tried again; most dependencies are then gone and it goes too. One that fails even last is
  reported with the real reason and the others still go.
- Removing a group or an extension from a profile was slow: the profiles were listed one after the other before the question
  appeared (with nothing on screen), each extension was uninstalled by a separate start of VS Code's command line, and the tree
  listed the profile again afterwards. Now the profile is listed first (and the others only when something may have to be
  protected, all at once), a progress message shows at once, all the extensions go in one run of the command line, and the tree
  drops them from the list it already has. With three extensions the part after the confirmation went from about 2.4 s to 1.1 s on
  a small scratch setup; more extensions and more profiles gain more.
- A group inside a profile counted an extension the profile had removed out of its total ("2 of 2 installed"); the group has three, so
  it reads "2 of 3 installed", and the tooltip says which one was removed from the profile (a sync does not install it).
- The Profiles tree kept showing a profile's old list of extensions after something was installed into or uninstalled from it: the
  refresh named an item object VS Code did not know and was ignored. It now redraws the whole tree.
- The **New Group** button of the Groups view did not ask for a name when a group was selected: VS Code runs a title-bar
  button with the item that is focused in the tree, and the command took that group's name as the new name ("There is already a
  group ..."). It now always asks. A program can still pass `{ groupName }`.
- The Profiles tree of the Better Profiles tab did not follow changes to the groups: a group given to a profile (by a drop,
  a command or the groups file) only showed in it after Refresh. It now redraws at once, without asking the command line again.
- Dragging from one tree of the Better Profiles tab onto the other did nothing (an extension onto a group, a group onto a
  profile, extensions onto a profile). VS Code delivered its own entry for the dragged tree next to ours under the same type
  name, and ours was never read. Drags now carry their own type and every entry of it is read. Drags inside one tree were fine.
- The status bar showed `Default` in a non-default profile whenever the folder path had spaces or accents,
  the window was a multi-root workspace, or no folder was open. VS Code stores workspace URIs percent-encoded
  and keys a multi-root window by its `.code-workspace` file; detection now matches both.
- A workspace VS Code has not recorded a profile for now shows a neutral `Profile` instead of a wrong `Default`.
- A profile without an icon no longer renders a blank icon slot.
- `better-profiles.activate` was declared but never registered, so running it failed. It is removed.
- `getProfiles` returned nothing and showed a popup; it now returns the profiles.

### Added

- Several selected items can be added or removed at once, from the right-click menu or the quick button: Add to Group, Install in
  Other Profiles, Give To A Profile, Copy Extension Id, Remove From Group, Remove From Profile (extensions and groups) and Delete Group
  act on the whole selection, with one question and one run of the command line instead of one per item.
- A graph view of extensions, groups and profiles, opened from a button at the top of the Better Profiles tab or with
  `Better Profiles: Show Graph`. Pointing at a node lights up what it connects to; clicking an extension opens its page.
- **Remove From Profile** now uninstalls. On an extension inside a profile it uninstalls it from that profile only and records an
  `"excludes"` entry so a sync does not bring it back; the real group and the other profiles are untouched. On a group inside a profile
  it makes the profile stop following the group and uninstalls the group's extensions from it, except those another followed group still
  wants. Both ask first, and never uninstall this extension, `keepExtensions` or what every profile has. In the Profiles tree the
  extension entries no longer offer Remove From Group (that edits the real group and is only in the Groups tree).
- A group shown inside a profile has **Remove From Profile** (a right-click entry and a quick **×** button) instead of Delete Group:
  the profile stops following the group, which and whose extensions stay. Extensions inside such a group have the quick **×** too.
- Double-clicking an extension in the Better Profiles tab opens its page. Right-clicking an extension offers Open Extension Page,
  Add to Group, Install in Other Profiles and Copy Extension Id (and Remove From Group inside a group); groups shown inside a
  profile now have the same right-click menu as in the Groups tree.
- In the Better Profiles tab, a profile lists the groups it follows first, each with the group's extensions that the profile has
  ("2 of 3 installed"), then the extensions that are in none of those groups.
- Profiles in the Better Profiles tab show their own icon (the one set in VS Code) when they have a valid one.
- Extensions in the Better Profiles tab are shown like in VS Code's Extensions list: their icon image and display name (localised names
  resolved), the publisher or version beside them, and the id and description in the tooltip. Read from each extension's own folder, so
  nothing is fetched. New `betterProfiles.extensionsDir` setting, also used to point the command line at the right installation.
- A Better Profiles tab in the Activity Bar with a Groups tree and a Profiles tree, and drag and drop between them: an extension onto
  a group adds it (a copy), an extension onto a profile installs it there, a group onto a profile gives it. Plus New Group, Delete Group,
  Remove From Group, Sync Profile With Its Groups, Set Workspace Triggers and Give To A Profile on the trees. Nothing dropped ever
  uninstalls anything.
- `[Better Profiles] Add to Group` is now a multiple-select checklist: tick several groups at once, and **New group** to start another next to
  them (`[Better Profiles] Remove from Group` already was one). The follow-up button is `Sync Profile` if any of the groups is followed by a
  profile. The checklists no longer say "uninstall" in their placeholder when they are not about uninstalling.
- The Extensions view gear menu now shows `[Better Profiles] Remove from Group` only for extensions that are in a group, and the
  `[Better Profiles] Add to Group` list marks the groups that already hold the extension. (A menu label is fixed text, so the
  group names themselves cannot be shown in the menu.)
- The notifications after adding an extension to a group, or giving a group to a profile, now have a button for the next
  step (`Sync Profile`, or `Give Group To A Profile` when no profile follows the group) instead of telling you which command
  to run.
- Three entries in the Extensions view gear menu (the `extension/context` menu, next to "Apply Extension to all Profiles"):
  `[Better Profiles] Add to Group`, `[Better Profiles] Remove from Group` and `[Better Profiles] Install in Other Profiles`. Removing from a
  group never uninstalls anything, and installing only offers profiles that lack the extension.
- Development: `flake.nix` with a default and a headless dev shell, and install / run-from-source / test instructions in the README.
- Install when needed: a group can have workspace triggers (globs such as `**/pubspec.yaml`). The automatic check
  only offers a triggered group in a workspace that matches one of its patterns, names the group in the notification,
  and **Sync** installs exactly what was announced. `Set Workspace Triggers For A Group` edits them. An explicit sync
  still installs every group, and cleanup still counts every assigned group.
- Staying in sync: shortly after startup, and when the groups file is saved, the current profile is checked against
  its groups. `betterProfiles.autoSync` is `ask` (default: Sync / Not now / Stop asking, and "Not now" is remembered
  for that exact set), `auto` or `off`. The automatic check only installs. `Reset Sync Prompts` clears the memory.
- Uninstalling extensions a profile has but its groups do not mention: only through `Sync Profile With Its Groups`,
  as a checkbox list with nothing ticked followed by a confirmation. Extensions every profile has (application
  scoped), this extension and `betterProfiles.keepExtensions` are never offered; neither is a profile whose groups
  are incomplete.
- `betterProfiles.autoSync` and `betterProfiles.keepExtensions` settings.
- Extension groups: `Add Extensions To Group`, `Give A Group To A Profile`, `Compare Extensions Across Profiles`,
  `Sync Profile With Its Groups` and `Edit Groups File`, plus the `betterProfiles.groupsFile`,
  `betterProfiles.codeCommand` and `betterProfiles.codeArgs` settings.
- `Better Profiles: Switch Profile` command (the status bar item runs it).
- `activate()` returns a small API; `betterProfiles.storageFile` setting.
- A README, unit tests for the detection logic, and Extension Host tests that run against a real VS Code.
- The status bar refreshes when workspace folders change and when the window regains focus.
