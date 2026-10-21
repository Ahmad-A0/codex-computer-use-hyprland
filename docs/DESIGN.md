# Design and implementation notes

Technical reference for contributors; see the [README](../README.md) for users.

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
and `@oai/sky` packages. Upstream code is minified and its local names change on
every rebuild, so the copy depends only on what minification preserves: file
paths, module export names, string literals, property names and `.d.ts` types.
CUA's Linux app binding (`bind_linux_app.js`) is replaced by our readable
`scripts/runtime/bind_linux_app.js`, which implements the macOS behaviour of the
same `App` methods. Sky's Linux `create_client.js` is generated from the
`create_<command>` modules beside it, plus our extra backend commands and the app
approval gate. The one remaining patch lets `getApp` take an app name; it is
anchored on literals. Missing exports, a changed typed interface, or a failed load
check of the finished copy stop startup with a message naming the change; package
versions are recorded for diagnosis. Documentation updates and unrelated source
changes do not block startup. Source hashes refresh the cache when the installed
packages change. Installed Codex files are never edited. The incompatible
community `native-client.mjs` API is not used.

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

From a source checkout:

```sh
./install
./doctor
```

As an Arch package (`packaging/aur/PKGBUILD`; not yet published), run once per
user after installing it:

```sh
codex-computer-use-hyprland register   # unregister removes the entry again
codex-computer-use-hyprland doctor
```

The package installs read-only files in `/usr/lib/codex-computer-use-hyprland/`,
the Python package into the system site-packages (no virtual environment), and
the prebuild user unit in `/usr/lib/systemd/user/`. Per-user builds go to
`${XDG_CACHE_HOME:-~/.cache}/codex-computer-use-hyprland/` and locks to
`$XDG_RUNTIME_DIR/codex-computer-use-hyprland/`; a checkout keeps both in `build/`.
A root containing `pyproject.toml` is a checkout (`src/codex_hyprland/paths.py`,
mirrored by `scripts/paths.sh` and `scripts/paths.mjs`); `CODEX_HYPRLAND_CACHE_DIR`
overrides the cache directory. `register` builds the plugin, merges `cua_repl`
into the Codex config like `./install`, and enables the prebuild unit;
`unregister` removes only this installation's `cua_repl` entry (with a backup)
and disables the unit. `packaging/aur/build-local.sh` test-builds the package
from the working tree with `makepkg` without installing it.

`./install` uses the committed `uv.lock` to install Python dependencies, builds
the native helpers, prepares the compatible runtime overlay, and registers
`cua_repl` in `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`). Other config
settings and comments are preserved, with a backup before changes. Use
`./install --project` to register only for this checkout. Start a new Codex
session to use the provider; its native module loads on first use. `./install`
and `./doctor` run the same `bin/codex-computer-use-hyprland register`/`doctor`
commands as the package.

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
`<cache>/native/<abi>/`, `<cache>` being the directory above (the ABI string is the one `hyprctl version` reports as
`abiHash`). A new provider process loads the build for the running compositor,
compiling it first if needed (about 20 seconds). After a Hyprland upgrade the
running session keeps its old build; the new one is used after the next login.
Registration also enables a user `codex-hyprland-prebuild.path` unit that compiles
for the new headers as soon as pacman installs them, so that login needs no build.
A compile failure means Hyprland changed an internal API the plugin uses, which
needs a provider update. The plugin builds against both released Hyprland and its
development branch; because the branch keeps the last release's version number,
`native/compat.hpp` tells their APIs apart by the headers main introduced
(`__has_include`) instead of version macros. On main, hyprctl JSON gives only
numbered workspaces an `id` and identifies every workspace by its `address`;
`backend.workspace_key` compares workspaces by either. Upgrades drain clipboard resources and refuse to unload
while a transaction or client offer remains active. Shared objects are replaced
atomically, and the module still checks the compositor ABI when loading.

To unload safely, send `hyprctl codex-background '{"op":"drain"}'`, wait until
`{"op":"status"}` reports `busy: false` and `offers: 0`, then run
`hyprctl plugin unload "<cache>/native/<abi>/codex-background.so"` in the intended session.
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
| Accessibility observations | Window-scoped AT-SPI; explicit compositor-only fallback when unavailable. As on macOS, `getAXState()` returns a diff from the window's previous observation (`~` changed, `+` added, removed ID ranges, or a no-change notice) unless `disableDiffing` is set. Open context menus and popup menus of the window are part of its tree (see below). As in a macOS tree, hidden controls (neither visible nor showing: a hidden widget, a closed GTK 3 popover, a closed menu or combo box list, an inactive Qt tab, `display:none` web content) and the pages of a GTK 3 notebook other than the current one are left out, as are the items of a closed menu that its toolkit keeps visible (GTK 3 lists every item of a menu bar, about 1,300 in LibreOffice) and the off-screen children of a container that manages more descendants than an observation can list (a spreadsheet's cells); other content scrolled out of view stays. Sliders, spin buttons, progress and scroll bars show their numeric value and combo boxes their selected choice; hypertext object characters (U+FFFC) are not shown as text |
| App approval | As on macOS, the first action on an app asks "Allow Computer Use to use X?" through a Codex elicitation; Codex remembers session/always answers |
| Screenshot / combined observation | Exact toplevel plus isolated owned-popup capture, also for windows on hidden workspaces; coordinates follow the latest app screenshot |
| Element click / secondary action | Exposed AT-SPI action for one left/right click; any button and click count at the element's centre otherwise, as on macOS. A coordinate click goes to the centre of the element's part inside the window and its scrolling ancestors; an element not wholly shown is first scrolled into view like macOS `AXScrollToVisible` (AT-SPI `ScrollTo`, or a GTK 4 list item's scroll-to action), and one still not on screen (a list row scrolled away, which would otherwise be clicked through to the control drawn there) is refused. An element without extents yet (Firefox page content changed since its last paint) gets a moment while the window renders. Items of an open popup menu, and the menus of a visible menu bar, are clicked at their centre, as a user's click opens or closes them (GTK 3's action on a menu bar item opens the bar's first menu) |
| Coordinate click, move, scroll | Direct Wayland client events; XInput2 private master devices for XWayland. As on macOS, separate clicks stay single: toolkits count clicks from the time and distance between presses, so a press near the previous one waits out the desktop's double-click time |
| `typeText`, `typeCharacters`, `pressKey` | Targeted keyboard events; `typeText(text, elementIndex)` first focuses that editable element. XWayland Unicode uses the focused AT-SPI editable control; `typeCharacters` sends printable keys only (no field lookup or paste) and refuses non-ASCII on XWayland. macOS key names work: `cmd`/`command` is Ctrl and `option` is Alt; `super` stays Super |
| `selectText` | Text match, prefix/suffix disambiguation, selection or before/after caret placement; verified result |
| `setValue` | Editable text replacement or finite, range-checked numeric value, under the app's keyboard focus; verified result, allowing for apps that apply it late (rendering a hidden Chromium window meanwhile; Firefox applies values in its content process). A number sets a spin button's value, not its text, which GTK would apply only on activation. A field whose app ignores the replacement (Firefox web pages) is focused, its text selected and the value typed; so is rich text without a replaceable value (a web contenteditable) |
| `paste` | Text/HTML/Markdown on Wayland and XWayland; Markdown rendered to HTML |
| Page-count scroll | Nearest accessible viewport extent (or the item view that scrolls itself); window extent for coordinate targets; pixel form also supported. The input is chosen per toolkit so that the content moves by the requested distance (see below) |
| `drag` | Timed pointer motion and native data transfer between Wayland windows/apps and between XWayland windows |

The full Sky Linux client surface is also served: `key_down`/`key_up`, the `key`
chord on `click`, `scroll`, `drag`, `move` and `move_relative`, `click.duration`
and `press_key.duration` (0–10000 ms), `type_text.element_id`, `type_characters`, `drag_handle`,
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
A window on a hidden workspace gets no frame callbacks, and GTK then holds its
input, so the motions of separate steps would merge and a drag-and-drop the app
starts on the way never would: each step services the hidden source's and
target's frame callbacks, as an observation does.

A global coordinate (no window) targets the topmost window on a shown
workspace. The end of a drag that leaves its window, and a drag handle's moves,
target windows on the source window's workspace only: windows of other
workspaces share the coordinates, and a user's window there never receives the
agent's drop.

`clipboard_read` sends the app's Copy shortcut (terminal-aware, like paste). On
Wayland the module keeps that client's new selection private, reads every
offered format through a pipe and cancels it, so the desktop clipboard never
changes. X selection requests that some toolkits also list as formats
(`SAVE_TARGETS`, `TARGETS`, `MULTIPLE`, `DELETE`, ...) are not data and are not
requested; GTK 3 never answers `SAVE_TARGETS`. On XWayland the helper snapshots the previous formats, captures every
format the app's new selection offers, and restores the previous contents (which
moves ownership to the helper, as paste does). Snapshots stay in the provider
(64 MiB each, 32 handles, 256 MiB in total) and paste byte-exact into any
window with `clipboard_write`, across transports and repeatedly, through the
private-offer paste path. Audio recording (`SKY_ENABLE_AUDIO`) is not implemented.

Window-bound operations never call compositor focus or physical cursor movement
functions. Same-client keyboard routing persists across automation calls so
Chromium retains selections, then returns to the physical foreground surface
before physical input. Explicit `activate_window` remains explicit activation.

Private Wayland clipboard offers preserve the desktop selection. After a paste
only the client with the keyboard focus gets the desktop selection back; another
client keeps the private offer (the compositor sends it the desktop selection
when it gains focus). An app may read a new selection as soon as it is offered
(Chromium does) and handle the paste shortcut much later, after input still
queued before it, such as a long typed text. The transaction therefore ends only
after a read that follows the shortcut, with the window's frame callbacks
serviced meanwhile if it is hidden (an app that read the offer at once and reads
no more gets five seconds); a paste must never find the user's clipboard or no
selection at all. XWayland paste
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
Hyprland copies a toplevel only while it overlaps the monitor of its workspace;
a window lying entirely outside it gets an immediate capture error instead of a hang.
Long typing batches give the client bounded opportunities to process input and
render between chunks. Applications without AT-SPI still require screenshots;
this does not synthesize a terminal accessibility tree.

`getApp` reuses a running application and launches only when needed, waiting for
its initial window. Like a macOS background launch, a new app opens without focus
and silently on the `codex` workspace, leaving your layout untouched; switch to
that workspace to watch or use it. `CODEX_HYPRLAND_LAUNCH_WORKSPACE` selects
another workspace (for example `special:codex` or `3`), and `current` opens it on
your current workspace. Windows the app opens later (dialogs, further windows,
X11 menus) follow it as on macOS: they map directly on the workspace of their
parent window (wherever you have since moved it), or of the app's other windows,
without taking focus and without appearing on your workspace first. Launched
windows float; Hyprland floats an X11 window that chose no position at the X origin,
which may be another monitor than its workspace's, so such a window is moved onto
its workspace's monitor (centred on its parent there, else in the work area). The launcher
registers the app's process with the compositor module and marks its environment;
only such processes, their children and windows parented to theirs are affected,
never your own apps' windows otherwise. The exception is a window the agent causes
in an app you started: one whose parent window it acted on in the last two seconds
(a dialog after its click) opens beside that parent without focus, as a macOS sheet
does, instead of on your workspace. While you are using the app (one of its windows is focused on
that workspace), its new windows open normally. `launch_app` acknowledges desktop launch success or failure;
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


Wayland keys do not depend on the seat's current keymap either. The seat's map
is that of the last keyboard used, and after a virtual keyboard such as `wtype`
it holds only that tool's keys. The module sends the target client a map that
has every key (the seat's own when it does and no key is held, else a full US
map with any extra Unicode characters), then the keys. GTK 3 reads a batch of
protocol events before handling them and resolves key bindings (Ctrl+A, End,
Escape on a menu) by keycode against the map current when it handles each key,
so that map stays until the client answers an `xdg_wm_base` ping sent after the
keys (observed through a protocol logger, so Hyprland's own ping handling is
untouched). Only then does the client get the seat's current map back, with its
modifiers; a later batch reuses the map still installed when it can, and a
client that does not answer gets the seat's map after five seconds. The user's
own keys always use the seat's map: a physical key for that client restores it
first. The seat and the physical keyboard are never changed.

Key names are X keysym names, case-sensitive as for xdotool and the X11 helper
(`Z` is the shifted letter); a character key missing from both the seat's
layout and US is bound like typed text. Extra characters go on keys that
Chromium treats as inert (F13 to F24, the 102nd, Ro and Yen keys, and the extra
keypad comma, equal and parentheses): Chromium also maps a key code to a
physical key and acts on some (evdev `KEY_CLOSE` closes its window), and drops
codes it does not know, so a batch carries at most 16 distinct characters
beyond ASCII. A Chromium key event carries one UTF-16 unit, so characters beyond
the Basic Multilingual Plane (emoji) are pasted into Chromium between the typed
runs, as macOS types any Unicode string. Chromium lets a page read the clipboard
only within five seconds of input reaching the browser, and a window on a hidden
workspace handles typed text only as it gets frame callbacks, so a long text can
queue up there for longer; before each such paste the window's frame callbacks
are serviced until it has handled the text typed before it, as its focused
field's text before the caret shows (else the paste reads nothing).

Wayland leaves the scale of scroll input to each toolkit, and most read axis
values as wheel units (ten per wheel click), not as pixels. The scroll is chosen
per toolkit, from the application's AT-SPI toolkit and the element (or the
element under the point), to move the content by the requested pixels:

- GTK 3 scrolls `min(page^(2/3), page/2)` of the scrolled view per ten touchpad
  units, so it gets the units that move the requested pixels of the nearest
  viewport; on XWayland, where the helper sends wheel clicks (one per 40 units)
  and GTK scrolls one such step per click, the clicks that come closest.
- GTK 4 moves 2.5 pixels per touchpad unit (`MAGIC_SCROLL_FACTOR`).
- Chromium moves twelve pixels per touchpad unit and starts a fling when a later
  frame stops the scroll, so it gets a twelfth of the pixels with the axis stop
  first in the same frame: the page moves exactly that far at once (a wheel
  would animate, which a window on a hidden workspace does not render).
- Qt scrolls three rows (item views) or lines (plain text) per wheel notch,
  at most a page per event, so it gets wheel `value120` for the whole rows or
  lines that fit in the requested pixels.

Touchpad scrolls otherwise end with an axis stop, in its own frame and at the
scroll's own timestamp: toolkits derive a kinetic fling from the motion's
duration. The pointer leaves the window only in a later event batch (before any
further synthetic pointer input, or after 100 ms): Qt 6 dispatches wheel events
after reading the whole batch, from an idle timer, and drops them when the
pointer has already left.

X11 keys do not depend on the seat's current keymap. XWayland's core keymap is
that of the last Wayland keyboard used; after a virtual keyboard such as `wtype`
it holds only that tool's keys. A key or character the core map lacks is bound,
for the duration of one helper run, to a core keycode without symbols (the
private keyboard's own keycode for it when free), and that key is restored once
the target has answered a `_NET_WM_PING` sent after the input. Physical
keyboards and other X devices keep their maps. A binding replaced by a new seat
keymap is not touched, and bindings left by a killed helper are undone by the
next run (a root-window journal records them).

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
  XWayland wheel scrolling uses legacy wheel steps rather than exact pixel axes
  (GTK 3 gets as many as come closest to the requested pixels).
  Unicode typing requires an accessible focused editable control. X11 clients that
  read the core pointer (GTK 3 places tooltips by it) see the user's cursor, not
  the private XInput2 pointer, which never moves the core one. GTK 3 also shows
  a tooltip for the widget under that cursor and hides one that opens beneath
  it, so an agent-hovered XWayland tooltip appears reliably only while the
  user's cursor is outside the window.
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
The app does see its focused window lose keyboard focus during the probe, so a
window that closes on focus loss (a quick switcher) closes; observations treat
windows and elements that vanish meanwhile as gone, not as errors.

Automation-created Wayland popup grabs stay private. Their keyboard events go to
the owned popup, and the compositor's synthetic motion refresh cannot refocus the
physical desktop. A grab is the user's only when its app has the seat's keyboard
or pointer focus (or was just acted on), so a menu the app opens late, or while
you type elsewhere, never takes your focus. As on macOS, a physical click outside
the menu closes it; typing and pointer motion elsewhere leave it open. X11
activation requests from drag icons and accessible actions are suppressed during
the operation. Explicit user focus actions remain available.

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
the window's last children. Clicks move the pointer onto their point first, as a
user's pointer arrives, so Qt reopens a context menu right-clicked again at the
same point. An event-only menu (Qt, a GTK 4 entry's) opened before the provider
started appears once it is reopened.

Sky audio recording is not implemented; `drag` still takes a two-point path.
Provider-owned input guards enforce confinement and authentication checks. Input remains serialized under the seat lock;
locked sessions, conflicting grabs, physical held buttons and ordinary desktop
DND prevent conflicting native delivery.

## Validation

Behaviour is checked by the end-to-end suite in `tests/e2e/` (see the README), locally with
`./test --host` and in a disposable Arch VM with `./test`, which CI runs on every push.
`.github/workflows/watch-upstream.yml` reruns it when OpenAI's package or Arch's
Hyprland changes. `.github/workflows/hyprland-main.yml` runs it daily against each new
commit of Hyprland's `main` (`E2E_HYPRLAND=git`): `tests/e2e/vm/hyprland-git.sh` builds that
commit in the guest and installs it over Arch's package, together with any hyprwm library
it needs newer than Arch ships (at the revisions in Hyprland's `flake.lock`), so the
provider compiles its plugin against those headers exactly as against a release. The last
passing commit is kept in `upstream.json` (`hyprland-main`); failures open a
`hyprland-main` issue and start the fix agent (`fix.yml`).

## References

Ignored reference checkouts include [Hypruse](https://github.com/IlyasKhallouki/hypruse),
[computer-use-linux](https://github.com/agent-sh/computer-use-linux),
[Hyprland](https://github.com/hyprwm/Hyprland), and
[codex-desktop-linux](https://github.com/ilysenko/codex-desktop-linux).
The installed official JavaScript sources and declarations define the public
contract. The [background-input prototype](https://github.com/Gabriel-Kahen/hyprland-codex-background-computer-use)
informed investigation; our compositor implementation routes per-client resources
without replacing the global seat focus.
