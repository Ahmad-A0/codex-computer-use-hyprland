# Codex computer use for Hyprland

A Hyprland implementation of the official Codex `cua_repl` / NodeREPL native-app
API. Public JavaScript signatures, app bindings, accessibility indices,
observation emission, and image return types remain upstream.

```text
Codex → official cua_repl / NodeREPL → private official cua / Sky copy
                                      ↓ OAI_SKY_LINUX_BIN
                               bin/sky-hyprland
                                      ↓
                    Hyprland module / Wayland / AT-SPI / XInput2
```

`prepare-runtime.mjs` makes an ignored local copy of the installed `@oai/cua`
and `@oai/sky` packages. Narrow, exact-match patches remove Linux-only method
rejections and forward the same public calls to our backend. Only the required
code replacements must match once; package versions are recorded for diagnosis.
Documentation updates and unrelated source changes do not block startup. Source
hashes refresh the cache when the installed packages change. Installed Codex files
are never edited. The incompatible community `native-client.mjs` API is not used.

## Setup

Hypruse is not a runtime dependency. Session discovery, IPC, key parsing,
input guards, and output capture are implemented locally. Guard settings use
`CODEX_HYPRLAND_` prefixes; legacy `HYPRUSE_` variables remain accepted on upgrade.

Requires the official Codex `cua_node` runtime, Hyprland, `uv`, `hyprctl`, `grim`
with `-T` support, system Python with Gio/AT-SPI/Pillow, a C++23 compiler,
matching Hyprland development headers, `pkg-config`, `xkbcommon`, `json-c`,
X11/XInput2/XTest/XComposite/XRes development libraries, and Hyprland's build dependencies.
On Arch the Python bindings are `python-gobject`, `at-spi2-core`, and
`python-pillow`. Use the distribution Python to access those bindings.

```sh
./install
./doctor
```

`./install` uses the committed `uv.lock` to install Python dependencies, builds
the native helpers, prepares the compatible runtime overlay, and registers
`cua_repl` in `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`). Other config
settings and comments are preserved, with a backup before changes. Use
`./install --project` to register only for this checkout. Start a new Codex
session to use the provider; its native module loads on first use.

uv manages the generated `.venv` using the distribution Python and its
Gio/AT-SPI/Pillow bindings. No environment activation is needed. The package is
installed normally rather than editable; rerun `./install` after source changes.
`./doctor` checks the locked environment, native prerequisites, compatible Codex
runtime, Python bindings, and desktop inventory. System libraries and development
headers are installed through your distribution's package manager.

The launcher discovers the Codex runtime in `/usr/lib/chatgpt/resources/cua_node`
or `/opt/codex-desktop/resources/cua_node`; override it with `CODEX_CUA_RUNTIME`.
`HYPRLAND_PYTHON` selects the distribution interpreter used for setup.
`./bin/cua-repl-hyprland` launches the standard MCP stdio server directly.
`./install` registers both native apps and the official browser surface with
`CUA_REPL_ENABLED_SURFACES="browser,computer"`. Direct launcher calls default to
`computer`; set `CUA_REPL_ENABLED_SURFACES` to select the surfaces explicitly.

Browser mode loads the official bundled browser service, with Chrome/extension
and Codex in-app browser discovery. It requires a connected ChatGPT browser
extension in a supported browser, or an available Codex in-app browser host.
Enabling the surface does not install an extension or create a browser connection.
Zen/Firefox remains accessible through the native Hyprland app surface.
`cua.listBrowsers()` checks discovery; `cua.createBrowserTab(...)` and
`cua.getTab(...)` use the official browser API. Browser calls need the session and
turn metadata that Codex attaches to MCP calls; a bare standalone MCP client
without that metadata cannot validate browser connectivity. Custom trusted browser
services and browser environment settings are preserved.

The compositor plugin is cached per Hyprland plugin ABI in
`build/native/<abi>/` (the ABI string is the one `hyprctl version` reports as
`abiHash`). A new provider process loads the build for the running compositor,
compiling it first if needed (about 20 seconds). After a Hyprland upgrade the
running session keeps its old build; the new one is used after the next login.
`./install` also enables a user `codex-hyprland-prebuild.path` unit that compiles
for the new headers as soon as pacman installs them, so that login needs no build.
A compile failure means Hyprland changed an internal API the plugin uses, which
needs a provider update. Upgrades drain clipboard resources and refuse to unload
while a transaction or client offer remains active. Shared objects are replaced
atomically, and the module still checks the compositor ABI when loading.

To unload safely, send `hyprctl codex-background '{"op":"drain"}'`, wait until
`{"op":"status"}` reports `busy: false` and `offers: 0`, then run
`hyprctl plugin unload "$PWD/build/native/<abi>/codex-background.so"` in the intended session.
Do not forcibly unload a module whose clipboard offers are still held by apps.

## API coverage

Use real app IDs, window IDs and fresh accessibility indices from observations.

```js
await cua.listApps();
await cua.listWindows();
let app = await cua.getApp("Example App"); // name, inventory ID, or desktop path
// Or bind an exact existing window:
let window = await cua.getApp({ windowId: 123 });
await app.getAXState();
await app.setValue(7, "first café / second café");
await app.selectText(7, "café", { prefix: "second " });
await app.paste("**Formatted** text", { format: "md" });
await app.scroll(12, "down", 1);
await app.drag([100, 200], [300, 250]);
await app.getAXStateAndScreenshot();
```

| Public call | Implementation |
| --- | --- |
| App/window inventory | Gio desktop entries and Hyprland clients |
| `getApp(string)` | Resolve name, inventory ID, or desktop-file path; launch in background when needed |
| `getApp({windowId})` | Bind the exact mapped window with identity checks |
| Accessibility observations | Window-scoped AT-SPI; explicit compositor-only fallback when unavailable. As on macOS, `getAXState()` returns a diff from the window's previous observation (`~` changed, `+` added, removed ID ranges, or a no-change notice) unless `disableDiffing` is set. Open context menus and popup menus of the window are part of its tree (see below) |
| App approval | As on macOS, the first action on an app asks "Allow Computer Use to use X?" through a Codex elicitation; Codex remembers session/always answers |
| Screenshot / combined observation | Exact toplevel plus isolated owned-popup capture, also for windows on hidden workspaces; coordinates follow the latest app screenshot |
| Element click / secondary action | Exposed AT-SPI action for one left/right click; any button and click count at the element's centre otherwise, as on macOS. Items of an open popup menu are clicked at their centre, so the menu closes as a user's click closes it |
| Coordinate click, move, scroll | Direct Wayland client events; XInput2 private master devices for XWayland |
| `typeText`, `pressKey` | Targeted keyboard events; XWayland Unicode uses the focused AT-SPI editable control. macOS key names work: `cmd`/`command` is Ctrl and `option` is Alt; `super` stays Super |
| `selectText` | Text match, prefix/suffix disambiguation, selection or before/after caret placement; verified result |
| `setValue` | Editable text replacement or finite, range-checked numeric value; verified result |
| `paste` | Text/HTML/Markdown on Wayland and XWayland; Markdown rendered to HTML |
| Page-count scroll | Nearest accessible viewport extent; window extent for coordinate targets; pixel form also supported |
| `drag` | Timed pointer motion and native data transfer between Wayland windows/apps and between XWayland windows |

The full Sky Linux client surface is also served: `key_down`/`key_up`, the `key`
chord on `click`, `scroll`, `drag`, `move` and `move_relative`, `click.duration`
and `press_key.duration` (0–10000 ms), `type_text.element_id`, `drag_handle`,
and `clipboard_read`/`clipboard_write`/`clipboard_release`.

Held chords belong to their target window (or, without a window, to the window
active at `key_down`). Repeating a parsed chord is a no-op; aliases and case
normalize but chord order is part of the chord. A key shared by several chords
stays down until none needs it, and releasing an absent chord is a no-op. Held
modifiers apply to later keyboard and pointer input to that window. Only the
target client's keyboard (Wayland) or the private X11 keyboard sees them; the
compositor seat is untouched. Physical input releases every hold and the next
action reports it instead of acting without the expected modifiers. Closing the
window, exiting the provider (the module reaps holds of a dead provider within a
second) or unloading the module also releases them. An X11 hold left by a
killed provider persists on the private device until the next X11 action.

`type_text` with an element validates that it is editable and visible, focuses it
through AT-SPI, and restores its caret and selection (GTK selects all on focus).
`drag_handle` presses at `start` (desktop coordinates, like the official client),
moves the pressed button with `move_to`, and releases at `end`; app-started
drag-and-drop goes to the window under the point. Pointer actions are refused
while a handle is pressed; physical button input or 10 idle minutes cancel it.

`clipboard_read` sends the app's Copy shortcut (terminal-aware, like paste). On
Wayland the module keeps that client's new selection private, reads every
offered format through a pipe and cancels it, so the desktop clipboard never
changes. On XWayland the helper snapshots the previous formats, captures every
format the app's new selection offers, and restores the previous contents (which
moves ownership to the helper, as paste does). Snapshots stay in the provider
(64 MiB each, 32 handles, 256 MiB in total) and paste byte-exact into any
window with `clipboard_write`, across transports and repeatedly, through the
private-offer paste path. Audio recording (`SKY_ENABLE_AUDIO`) is not implemented.

Window-bound operations never call compositor focus or physical cursor movement
functions. Same-client keyboard routing persists across automation calls so
Chromium retains selections, then returns to the physical foreground surface
before physical input. Explicit `activate_window` remains explicit activation.

Private Wayland clipboard offers preserve the desktop selection. XWayland paste
snapshots every available clipboard data format, temporarily owns the X selection,
and restores the previous formats unless a newer copy replaced the selection. A
small owner process retains the restored data until the next copy or X server exit.
For a Wayland-owned clipboard, `wl-paste` (from `wl-clipboard`) snapshots the
formats without activating an XWayland window. The X11 helper accepts that
snapshot only for a verified compositor-owned selection; changes detected before
paste abort the operation.

Paste triggers the application's normal keyboard paste operation. Terminal
accessibility roles and desktop-entry categories (including executable matching
for custom window classes) select Ctrl+Shift+V for terminal emulators and Ctrl+V
for other applications. Custom shortcut remappings may require an explicit key
command. Failed transfers are reported without replaying another shortcut.

Background captures temporarily resume the target's rendering and service its
frame callbacks, including subsurfaces and owned popups. They restore suspension
after capture; abandoned capture leases expire automatically. Window visibility,
workspace selection, compositor focus and the physical cursor are unchanged.
Long typing batches give the client bounded opportunities to process input and
render between chunks. Applications without AT-SPI still require screenshots;
this does not synthesize a terminal accessibility tree.

`getApp` reuses a running application and launches only when needed, waiting for
its initial window. Like a macOS background launch, a new app opens without focus
and silently on the `codex` workspace, leaving your layout untouched; switch to
that workspace to watch or use it. `CODEX_HYPRLAND_LAUNCH_WORKSPACE` selects
another workspace (for example `special:codex` or `3`), and `current` opens it on
your current workspace. `launch_app` acknowledges desktop launch success or failure;
it does not promise a new window. Use normal app UI actions to create additional
windows, and compare inventories before treating a window as disposable.

Actions mark the next target observation for a 250 ms settling interval, measured
from action completion. Inventory reads and subsequent observations do not repeat
that wait. Rendering refresh remains separate so hidden apps can submit new frames.
This follows the macOS service's action-driven observation contract; Linux uses
Wayland frame callbacks rather than claiming to reproduce its AX event debounce.

Implementation references: the [native input research](https://github.com/hqhq1025/codex-computer-use-lab/blob/main/docs/20-last-window-input-dispatch-and-event-backend.md),
[conditional observation settling](https://github.com/hqhq1025/codex-computer-use-lab/blob/main/docs/12-native-function-callgraph.md),
and the installed official macOS client/docs. The research does not specify the
newer paste action's internal trigger; Linux shortcut selection is our platform
implementation of the documented pasteboard/clipboard-preservation contract.


## Remaining parity gaps

The goal is macOS behaviour under the same calls. Approval decisions mirror the
macOS `getAppPolicy` shape: system authentication dialogs are forbidden, terminal
emulators are high risk, and `CODEX_HYPRLAND_CONFINE` refuses apps outside its scope.
Set `CODEX_HYPRLAND_APP_APPROVAL=0` only for unattended runs, such as the
disposable-app validation. macOS binds a whole app; `getApp` here binds one window.

macOS apps answer accessibility clients by default; Linux toolkits often need a
switch. The provider sets the session's AT-SPI `IsEnabled` flag when it starts,
and apps launched through `getApp` also get `ACCESSIBILITY_ENABLED=1`,
`QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1` and `GNOME_ACCESSIBILITY=1`. Chromium or
Electron apps started earlier while the flag was off may need a restart. Terminal
emulators expose no accessibility tree; use screenshots and coordinates there.

The previously missing rich paste, cross-window X11 drag, popup routing/capture,
and identical-window binding paths are implemented. Platform-specific limits remain:

- Mixed Wayland-to-XWayland and XWayland-to-Wayland drops are still rejected.
  X11 pointer targets and drag endpoints obscured by another X11 window are
  rejected before sending pointer input. Indexed accessibility actions still
  work for covered controls when the toolkit exposes them.
  XWayland wheel scrolling uses legacy wheel steps rather than exact pixel axes.
  Unicode typing requires an accessible focused editable control.
- Toolkit support still matters: inaccessible controls and applications that
  reject text/value changes or do not acknowledge focus notifications return
  explicit errors. No tree is guessed when identity cannot be verified.
- Layer-shell panels are not application targets. Popup capture has live
  validation on unrotated outputs; rotated-output popup capture needs validation.

Startup discovery uses Hyprland’s live-instance list and the matching Wayland
socket, ignoring stale socket directories left by stopped compositors.

Identical-window resolution uses exact geometry where reliable and a bounded
client-side focus probe when needed. The probe clears the client's accessibility
active state, enters the requested surface, observes the responding frame, and
restores routing. It never activates the window in Hyprland or changes its title,
size, position, or contents. Existing verified bindings survive title changes.

Automation-created Wayland popup grabs stay private. Their keyboard events go to
the owned popup, and the compositor's synthetic motion refresh cannot refocus the
physical desktop. Physical input dismisses private grabs and resumes normal
routing. X11 activation requests from drag icons and accessible actions are
suppressed during the operation. Explicit user focus actions remain available.

App screenshots composite owned popup surfaces without sampling unrelated desktop
pixels. Coordinate input translates the latest screenshot origin, including
negative popup offsets; accessibility-only observations retain that mapping.
X11 popups must have a verifiable transient-parent chain to the target window;
a popup belongs to the nearest managed window in that chain (a dialog's menu is
the dialog's). Hidden-workspace popups are rendered directly from their surfaces,
because Hyprland's own popup snapshot skips windows it is not drawing.

As on macOS, an open menu is part of its window's accessibility tree: its items
get element IDs, can be clicked or given secondary actions by index, and diffs
show the menu appear and disappear. Toolkits expose menus differently: GTK 3 and
Chromium list them as separate application children, Qt announces its popups
only through AT-SPI showing events, GTK 4 keeps popovers in the window's tree
(an entry's context menu is reached through focus events) and names menu items
through labelled-by relations. The provider listens for those events from
startup and attaches a showing popup only when the compositor (or the X11
transient chain) shows a popup of the same size on the bound window and on no
other window of the app, so other windows' menus never enter the tree. Menus are
the window's last children. Qt on Wayland ignores a second right-click at
exactly the same point after its context menu closed. An event-only menu (Qt,
a GTK 4 entry's) opened before the provider started appears once it is reopened.

Sky audio recording is not implemented; `drag` still takes a two-point path.
Provider-owned input guards enforce confinement and authentication checks. Input remains serialized under the seat lock;
locked sessions, conflicting grabs, physical held buttons and ordinary desktop
DND prevent conflicting native delivery.

## Live validation

No unit tests are included or added, per the user's request. Disposable GTK and
browser fixtures exercise real app behavior in a separate Hyprland compositor.
Development evidence is kept under ignored `.artifacts/`.

Verified through the official MCP `js` interface and original public CUA methods:

- app-name resolution and background launch;
- Unicode `setValue`, repeated-text `selectText`, caret positioning, numeric values;
- plain, HTML, and rendered Markdown paste, and page scrolling;
- real accessibility observations and screenshot emission;
- unchanged compositor focus and physical cursor during the native fixture run.

Additional live checks verified a 108 KB Unicode clipboard transfer; browser
DND within and between windows; actual Chrome-to-GTK MIME transfer; same-client
background navigation and physical-key routing restoration; XWayland GTK input
including Unicode editing; fractional-scale logical screenshots and coordinate
input on two monitors; safe resource draining and module reload. Further live checks verify XWayland HTML/Markdown paste and restoration of both
HTML and Unicode clipboard formats; cross-window X11 MIME transfer; overlapping,
identically named/sized GTK windows on both transports; and popup keyboard and
screenshot-coordinate actions through the official MCP interface. The native
module is validated in a disposable compositor before working-desktop deployment.

An earlier authorized `gpt-5.6-sol` run performed browser research across five
tabs through this interface. It encountered and reported website challenges.
Its report is `.artifacts/sol-background/report.md`.

The current runtime overlay targets the October 1, 2026 installed bundle:
`@oai/cua` 0.2.5, `@oai/sky` 0.7.4, and `@oai/cua-repl` 0.1.0. CUA's Linux app
binding moved out of `create_tinysky_alt.js` into `bind_linux_app.js`; the patches
now follow that layout. Browser bindings, observations, declaration files, and
MCP tool descriptions come from the current official packages. An older private
`build/cua-node-runtime` snapshot is no longer the configured runtime.

The public `openai/codex` repository supplies the CLI/MCP host, but its current
tree does not include the bundled `@oai/cua`, `@oai/sky`, or `@oai/cua-repl`
implementation. Those installed JavaScript sources and declarations define the
interface audited here. Matching public method signatures does not imply
identical platform behavior; the remaining parity gaps above still apply.
Upstream runtime versions are not pinned. Bundles continue to work when the
required patch sites still match. Documentation wording and unrelated file
changes only refresh cached copies. A changed patch site requires updating the
adapter; an incompatible Sky protocol may require backend changes. Hyprland's
native ABI check remains necessary for loading the compositor plugin.

The October 1 audit verified that all 366 shipped CUA/Sky declaration files are
unchanged in the overlay. A fresh official MCP provider exposed `js`,
`js_add_node_module_dir`, `js_reset`, and `turn_ended`; native inventory through
`cua.getState()` and `cua.listWindows()` reported 105 apps and 7 windows. Patched
JavaScript files passed syntax checks. A first GUI fixture run from the Codex
sandbox was blocked by a read-only `/run/user/1000`; the run below, from a
normal desktop session, completed.

On October 1, 2026 the bounded `.artifacts/current-interface-live.mjs` run passed
against a disposable GTK app through the official MCP `js` tool: app approval
prompt, macOS-format diffs and no-change notices, element double-click, `setValue`
(text and numeric), `selectText`, `paste`, page scroll, screenshots, and app reuse,
with compositor focus, workspace and cursor unchanged.

## References

Ignored reference checkouts include [Hypruse](https://github.com/IlyasKhallouki/hypruse),
[computer-use-linux](https://github.com/agent-sh/computer-use-linux),
[Hyprland](https://github.com/hyprwm/Hyprland), and
[codex-desktop-linux](https://github.com/ilysenko/codex-desktop-linux).
The installed official JavaScript sources and declarations define the public
contract. The [background-input prototype](https://github.com/Gabriel-Kahen/hyprland-codex-background-computer-use)
informed investigation; our compositor implementation routes per-client resources
without replacing the global seat focus.
