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
rejections and forward the same public calls to our backend. Both package
versions and source snippets are checked before patching. Installed Codex files
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
./scripts/setup.sh
./scripts/build-native.sh
.venv/bin/python scripts/load-native.py
npm run doctor
node scripts/configure.mjs --write
```

The final command registers `cua_repl` in this workspace's `.codex/config.toml`.
It refuses to overwrite an existing config; without `--write`, it prints the
entry to merge. Start a new Codex session to use this provider.

The runtime defaults to `/opt/codex-desktop/resources/cua_node`; override it
with `CODEX_CUA_RUNTIME`. `HYPRLAND_PYTHON` selects the setup interpreter.
`./bin/cua-repl-hyprland` launches the standard MCP stdio server directly.
`CUA_REPL_ENABLED_SURFACES` defaults to `computer`; browser surfaces remain
upstream when enabled and supplied by the host.

A new provider process loads the built native module if needed after compositor
restart. It compares build IDs before reusing a loaded module. Upgrades drain
clipboard resources and refuse to unload while a transaction or client offer
remains active. All native binaries compile before publication; shared objects
are replaced atomically. The module checks the compositor/header ABI. Rebuild
and validate after Hyprland upgrades; incompatible binaries are never forced in.

To unload safely, send `hyprctl codex-background '{"op":"drain"}'`, wait until
`{"op":"status"}` reports `busy: false` and `offers: 0`, then run
`hyprctl plugin unload "$PWD/build/codex-background.so"` in the intended session.
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
| Accessibility observations | Window-scoped AT-SPI; explicit compositor-only fallback when unavailable |
| Screenshot / combined observation | Exact toplevel plus isolated owned-popup capture; coordinates follow the latest app screenshot |
| Element click / secondary action | Exposed AT-SPI action or verified element bounds |
| Coordinate click, move, scroll | Direct Wayland client events; XInput2 private master devices for XWayland |
| `typeText`, `pressKey` | Targeted keyboard events; XWayland Unicode uses the focused AT-SPI editable control |
| `selectText` | Text match, prefix/suffix disambiguation, selection or before/after caret placement; verified result |
| `setValue` | Editable text replacement or finite, range-checked numeric value; verified result |
| `paste` | Text/HTML/Markdown on Wayland and XWayland; Markdown rendered to HTML |
| Page-count scroll | Nearest accessible viewport extent; window extent for coordinate targets; pixel form also supported |
| `drag` | Timed pointer motion and native data transfer between Wayland windows/apps and between XWayland windows |

Window-bound operations never call compositor focus or physical cursor movement
functions. Same-client keyboard routing persists across automation calls so
Chromium retains selections, then returns to the physical foreground surface
before physical input. Explicit `activate_window` remains explicit activation.

Private Wayland clipboard offers preserve the desktop selection. XWayland paste
snapshots every available clipboard data format, temporarily owns the X selection,
and restores the previous formats unless a newer copy replaced the selection. A
small owner process retains the restored data until the next copy or X server exit.
Snapshot limits fail before changing ownership; abandoned pastes restore on EOF or
timeout. Clipboard managers can observe the temporary X selection. Transfers have
bounded payloads, nonblocking writes, failure reporting, and abandoned-operation
cleanup. Large requests use private temporary files to avoid argv limits.
Drag transactions intercept only their own source; ordinary desktop DND retains
Hyprland's implementation. No global virtual keyboard/pointer fallback is used.

## Remaining parity gaps

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
X11 popups must have a verifiable transient-parent chain to the target window.

Lower-level Sky features outside the public native-app CUA surface, such as
audio and arbitrary multi-point held-key gestures, are not implemented.
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

Validated versions: Hyprland 0.56.2, `@oai/cua` 0.2.5, `@oai/sky` 0.7.1,
`@oai/cua-repl` 0.1.0. Upstream runtime upgrades require reviewing
the exact patches and internal Sky executable protocol.

## References

Ignored reference checkouts include [Hypruse](https://github.com/IlyasKhallouki/hypruse),
[computer-use-linux](https://github.com/agent-sh/computer-use-linux),
[Hyprland](https://github.com/hyprwm/Hyprland), and
[codex-desktop-linux](https://github.com/ilysenko/codex-desktop-linux).
The installed official JavaScript sources and declarations define the public
contract. The [background-input prototype](https://github.com/Gabriel-Kahen/hyprland-codex-background-computer-use)
informed investigation; our compositor implementation routes per-client resources
without replacing the global seat focus.
