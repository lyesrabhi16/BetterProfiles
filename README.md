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
| `betterProfiles.extensionsDir` | empty | Advanced. The folder where VS Code keeps installed extensions, to read their names and icons. Empty means it is found from the extensions that are installed. |
| `betterProfiles.listFromFiles` | `true` | Read each profile's list of extensions from the files VS Code keeps instead of starting its command line for every list. See [Speed](#speed). |
| `betterProfiles.codeCommand` | empty | Advanced. Run this executable instead of VS Code's own command line to list and install extensions. |
| `betterProfiles.codeArgs` | `[]` | Advanced. Arguments that always come first for `codeCommand`, for example `--user-data-dir` and `--extensions-dir`. |

## Extension groups

VS Code profiles each keep their own extension list, so the same extensions end up installed and forgotten in
several places. Groups let you name a set once and give it to the profiles that need it.

| Command | What it does |
|---|---|
| `Better Profiles: Add Extensions To Group` | Pick a group (or make one) and tick extensions from a profile that already has them. |
| `Better Profiles: Give A Group To A Profile` | Make a profile (or all of them) follow a group. |
| `Better Profiles: Compare Extensions Across Profiles` | Opens a table: one row per extension, one column per profile. |
| `Better Profiles: Sync Profile With Its Groups` | Installs what a profile is missing (after you confirm), then offers to uninstall what its groups do not mention (you tick what goes). |
| `Better Profiles: Set Workspace Triggers For A Group` | Tell a group which files mean "this workspace needs me" (see [Install when needed](#install-when-needed)). |
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
  },
  "excludes": {
    "Python": ["esbenp.prettier-vscode"]
  }
}
```

`"*"` means every profile; `Default` is the default profile. `"excludes"` (optional) lists extensions a profile does not want although a
group it follows has them; it is written by **Remove From Profile** on an extension. The file is in this extension's global storage unless
`betterProfiles.groupsFile` points elsewhere (for example into a dotfiles repository).

Extensions VS Code installs once for all profiles ("application scoped") count as present everywhere, and they
show up in every column of the comparison.

### The Better Profiles tab

An icon in the Activity Bar opens two trees:

- **Groups**: every group, how many extensions it has and which profiles follow it. Expand one to see its extensions.
- **Profiles**: Default and every profile, each with its own icon when it has one and the current one marked. Expanding a profile asks VS Code's command line what it
  has, once; **Refresh** asks again. Inside a profile come first the groups it follows (a group given to all profiles included), each
  marked "2 of 3 installed" and listing the group's extensions that the profile has; the tooltip names what is missing. After
  them come the extensions that are in none of those groups. An extension of two followed groups shows under both.

Extensions are shown the way VS Code's own Extensions list shows them: the icon image and the display name, with the
publisher (in a group) or the version (in a profile) beside it, and the id and description in the tooltip. They are read from
each extension's own folder in VS Code's extensions folder, which holds every profile's extensions, so nothing is fetched from
the network. An extension without an image gets the generic extension icon, and one that cannot be found is shown by its id
(a group marks it "not installed").

**The graph** (the graph button at the top of either tree, or `Better Profiles: Show Graph`) opens a tab that draws the groups file
as three columns: the extensions that are in a group, the groups, and the profiles, with a line from each extension to its groups and
from each group to the profiles that follow it (dashed when it goes to all profiles). Point at anything, or move to it with the
keyboard, to light up what it connects to; click an extension to open its page. It names extensions and shows their icons like the
trees do, marks the profile of the window, redraws when the groups change, and has a Refresh button. It shows what the groups file
says, not what is installed in each profile (the Profiles tree has that).

**Double-click an extension** (in either tree) to open its page, the one the Extensions view shows. The tree only tells an
extension about clicks, so two clicks within half a second on the same item count as a double click; if VS Code is set to open
items on a double click (`workbench.list.openMode`), its own double click is used.

**Right-click** an extension for **Open Extension Page**, **Add to Group**, **Install in Other Profiles** and **Copy Extension Id**.
In the Groups tree it also has **Remove From Group** (it only edits the groups file; nothing is uninstalled). In the Profiles tree it has
**Remove From Profile** instead, which never touches the group the other profiles share:

- on an extension, it asks, then uninstalls it from that profile only. If a group the profile follows has it, the profile is also
  told not to want it (an `"excludes"` entry in the groups file, see below), so the next sync does not bring it back. Installing it
  into that profile again lifts the exclusion.
- on a group inside a profile, it asks, then makes the profile stop following the group and uninstalls the group's extensions from it,
  except those that another group the profile follows (or a group given to all profiles) still wants. The group and the other profiles
  stay as they are. A group that goes to all profiles cannot leave just one: it offers to remove it from all profiles, without
  uninstalling anything.

These never uninstall this extension, anything listed in `betterProfiles.keepExtensions`, or anything installed in every profile (VS Code
installs those once for all of them). Anything else the command line cannot remove is reported. Deleting a profile can only be done
through VS Code's own screens (its Delete Profile command takes no arguments). A new, empty profile can be made by opening a window
with `code --profile NAME`, but deleting and rebuilding a profile would lose its settings, keybindings and snippets, so this
extension does not do it.

Right-click a group in the Groups tree for **Give To A Profile**, **Set Workspace Triggers** and **Delete Group** (the group itself); a
group inside a profile has the first two and **Remove From Profile**. A profile has **Sync Profile With Its Groups**. The quick **×**
button does the same as the right-click entry that removes (from the group in the Groups tree, from the profile in the Profiles tree).

**Select several** (Ctrl or Shift click) and use the right-click menu or the quick **×** on one of them: the command acts on all the selected
items of the kind it is for, with one question and one run of the command line. This works for Add to Group, Install in Other Profiles,
Give To A Profile, Copy Extension Id, Remove From Group, Remove From Profile (extensions and groups) and Delete Group. Items of other
kinds in the selection are left out, and if the clicked item is not part of the selection only the clicked item is used. Extensions
selected in several profiles are each removed from their own profile, with one question per profile. Open Extension Page,
Set Workspace Triggers and Sync Profile take one item.

Drag and drop works between the two trees and inside them:

| Drag | Onto | Result |
|---|---|---|
| an extension | a group | it is added to that group (a copy: the group it came from keeps it) |
| an extension | a profile | it is installed into that profile, if the profile does not have it |
| a group | a profile | the profile follows the group |

The groups and extensions inside a profile drag like their counterparts in the Groups tree, and dropping on them counts as
dropping on the profile.

**Dropping never removes or uninstalls anything.** The buttons and context menus add **New Group**, **Delete Group**
(it asks first, and the extensions stay installed), **Remove From Group** (nothing is uninstalled), **Sync Profile With Its
Groups**, **Set Workspace Triggers** and **Give To A Profile**.

VS Code only lets an extension add views to the Explorer, Run and Debug, Source Control and Test containers, not to its own
Extensions tab, which is why this has a tab of its own. I found no drag support in the built-in Extensions list, so extensions
are dragged from the trees here.

### From an extension's gear menu

In the Extensions view, the gear menu of an installed extension (and its right-click menu) has three more entries, in
their own group just under **Apply Extension to all Profiles**. They act on the extension you opened the menu for, and
they are not in the Command Palette because they need an extension to act on.

| Entry | What it does |
|---|---|
| **[Better Profiles] Add to Group** | A checklist of the groups, with nothing ticked: tick one or more (and **New group** to start another) and the extension is added to each. The notification that follows has a button for the next step: **Sync Profile**, or **Give Group To A Profile** if no profile follows the group yet. |
| **[Better Profiles] Remove from Group** | A checklist of the groups that hold it: tick one or more to take it out of. This only edits the groups file: nothing is uninstalled. It only appears for extensions that are in a group, so seeing it tells you the extension is grouped; the list it opens names the groups. |
| **[Better Profiles] Install in Other Profiles** | Lists the profiles that do not have the extension yet, with nothing ticked, and installs it into the ones you tick. |

A menu entry's label is fixed text in VS Code, so group names cannot be written into the menu itself; the **Add** list marks the groups that already hold the extension.
They show for installed extensions that are not built into VS Code. "[Better Profiles] Install in Other Profiles" asks the command line
about every profile first, so an extension that every profile already has (application scoped) gets a message and
nothing else.

### Speed

Starting VS Code's command line costs a few hundred milliseconds each time, so the tab avoids it where it can:

- **Lists come from VS Code's own files.** Each profile has an `extensions.json` (the default profile's is in the extensions folder, the
  others under `User/profiles/<id>/` in the user data folder). Reading one takes a few milliseconds, and a file is read again only when its
  size or time changed, as git does with its index. A watcher notices when something else changes one (the Extensions view, another
  window) and the tree redraws without a Refresh. If a file is missing, cannot be understood, or the profile has no folder, the command
  line is used instead; `betterProfiles.listFromFiles` turns the files off altogether. I checked that the files and the command line
  agree on a real VS Code, but the file format is VS Code's own and may change: the fallback is there for that.
- **Extension names and icons are read once.** An extension's folder name has its version in it, so what was read is kept and checked
  with one look at its `package.json`; changing the groups no longer reads every extension again, and the files name each extension's
  folder, so nothing is searched for.
- **What you do shows first.** A removal takes the extension out of the tree at once and an install puts it there at once, marked
  "installing…", while the command line works in the background; what it could not do comes back. The questions are built from the lists
  above, so they appear immediately, and several extensions are uninstalled in one run of the command line. Right before anything is
  uninstalled, the lists of all profiles are read again (a few milliseconds from the files) so the rule that nothing installed in every
  profile is removed is checked on current data.

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

- `Sync Profile With Its Groups` is an explicit request, so it installs every group of the profile, triggers or not.
- Cleanup considers all the profile's groups, matched or not. Another workspace may need a group this one does not,
  so its extensions are never offered for removal just because this workspace does not match. For the same reason
  nothing tells you an extension is "no longer needed".

### Uninstalling

Removing extensions is never automatic. It only happens through `Sync Profile With Its Groups` (also offered after
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
- Drag and drop is tested with `DataTransfer` objects handed to the drop handlers, including one shaped like what VS Code delivers
  for a drop from one tree onto the other. A real drag was also driven once through Chromium's debugging protocol (xdotool cannot
  start a drag on the virtual display): a profile's extension onto a group, and a group onto a profile.
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
about, so `git add` new files before running `nix develop`.

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
