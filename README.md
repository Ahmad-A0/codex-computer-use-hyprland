# Codex computer use for Hyprland

Lets [Codex](https://github.com/openai/codex) operate native Linux apps on
[Hyprland](https://hypr.land) the way it does on macOS: it can look at an app's
windows (accessibility tree and screenshots), click, type, paste, scroll, drag,
use menus and dialogs, and launch apps, without taking over your mouse,
keyboard or focus.

OpenAI's Linux computer-use runtime ships with a deliberately limited native
interface. This provider keeps Codex's official `cua_repl` tool and JavaScript
API unchanged and supplies a Hyprland backend underneath, so agents written for
macOS behave the same here.

## What it does

- **Works in the background.** Apps the agent launches open silently on their own
  `codex` workspace. Input goes straight to the target app: your focus, cursor and
  current workspace never change, and you can keep working while it does. Switch to
  the `codex` workspace to watch or take over.
- **Same API as macOS.** `cua.getApp("Calculator")` launches or reuses an app by name;
  `getAXState()` returns the same accessibility diffs as macOS; `setValue`,
  `selectText`, rich `paste`, page scrolling, any-button element clicks, menus, dialogs
  and macOS key names (`cmd+a`) all work.
- **Asks before using an app.** Like macOS, the first action on an app asks "Allow
  Computer Use to use …?" in Codex; Codex remembers "for this session" or "always".
  System authentication dialogs are never driven.
- **Toolkits** (covered by the test suite): GTK 3/4, Qt 6, Chromium, terminals, and X11
  apps via XWayland. Electron and Firefox should work through the same paths but aren't
  tested yet. Apps launched by the agent get their accessibility switched on
  automatically. Terminals have no accessibility tree; the agent uses screenshots there.

## Requirements

- Arch Linux (or similar) with Hyprland 0.56 or later.
- The ChatGPT/Codex desktop package (`chatgpt-bin`, from OpenAI's repository). It
  provides the computer-use runtime this provider builds on; you don't need to use
  the desktop app itself.
- The Codex CLI or app.
- Build tools: the provider compiles a small Hyprland plugin for your exact Hyprland
  version on first use (`gcc`, `pkgconf` and Hyprland's headers, which come with the
  `hyprland` package).

## Install

From the AUR (once published):

```sh
yay -S codex-computer-use-hyprland
codex-computer-use-hyprland register
```

From a git checkout (needs `uv`, `python-gobject`, `at-spi2-core`, `python-pillow`):

```sh
git clone https://github.com/Ahmad-A0/codex-computer-use-hyprland
cd codex-computer-use-hyprland
./install
```

`register` (or `./install`) adds a `cua_repl` entry to `~/.codex/config.toml`
(backing up the original; other settings are untouched) and enables a small user
service that rebuilds the plugin after Hyprland updates. Start a new Codex session
to use it.

Check everything with `codex-computer-use-hyprland doctor` (or `./doctor`).

## What changes on your system

- `~/.codex/config.toml`: one `cua_repl` entry pointing at this provider.
- `~/.cache/codex-computer-use-hyprland/`: the compiled plugin (per Hyprland version)
  and a patched private copy of OpenAI's runtime packages. Installed OpenAI files are
  never modified.
- Your Hyprland session: the provider loads its plugin into the running compositor
  on first use. It stays loaded until Hyprland restarts.
- The desktop's accessibility flag is switched on (as a screen reader would), so
  Chromium, Electron and Firefox expose their interfaces.
- A `codex` workspace appears while the agent has apps open.

## Settings

Set these under `[mcp_servers.cua_repl.env]` in `~/.codex/config.toml`:

| Variable | Default | Effect |
| --- | --- | --- |
| `CODEX_HYPRLAND_LAUNCH_WORKSPACE` | `name:codex` | Where launched apps open. Any Hyprland workspace (`3`, `special:codex`), or `current` for your current one. |
| `CODEX_HYPRLAND_CONFINE` | unset | Restrict the agent to `class:a,b`, `workspace:x,y` or `launched` apps. |
| `CODEX_HYPRLAND_AUTH_GUARD` | `1` | Refuse system authentication dialogs; `strict` also refuses typing into password fields; `0` disables. |
| `CODEX_HYPRLAND_APP_APPROVAL` | on | `0` skips the per-app approval prompt (for unattended test runs only). |
| `CODEX_CUA_RUNTIME` | auto | Path to OpenAI's `cua_node` runtime if not in the usual place. |

## Updates

- **Hyprland updates** need nothing: the plugin is rebuilt for the new version
  automatically (right after the update, or on first use after you log in again).
- **Codex updates** usually need nothing either. The provider adapts to OpenAI's
  runtime at startup; if OpenAI changes something it genuinely depends on, it stops
  with a clear error naming the file, and a provider update is needed. Every new
  ChatGPT/Codex and Hyprland release is tested automatically (see below).

## Troubleshooting

- `codex-computer-use-hyprland doctor` checks the runtime, plugin, accessibility and
  registration.
- An app's tree is empty ("exposes no accessible content"): Chromium/Electron apps
  you started yourself before the provider ran need a restart, or launch them through
  the agent.
- "Hyprland was upgraded … log out and back in": the running compositor is older than
  the installed one; the plugin for the new version is ready after you log in again.

## Uninstall

```sh
codex-computer-use-hyprland unregister   # removes only this provider's cua_repl entry
```

Then remove the package (or the checkout) and `~/.cache/codex-computer-use-hyprland/`.

## Known differences from macOS

- `getApp` binds one window; macOS binds a whole app.
- Dragging between a native Wayland window and an XWayland window isn't supported.
- Computer-audio recording isn't implemented (not planned for now).

## Development

- `./test --host` runs the end-to-end suite in your session: disposable apps (GTK,
  Qt, Chromium, a terminal, GNOME Text Editor, Calculator…) are driven through the real
  `cua_repl` server exactly as Codex drives them, on the `codex` workspace, and results
  are checked in the apps themselves. `E2E_ONLY=<regex>` selects tests; each run writes
  an HTML report with screenshots.
- `./test` does the same in a disposable Arch VM: OpenAI's package from its repository,
  Hyprland, `./install` as a user would, then the suite. `E2E_HYPRLAND=git ./test`
  uses Hyprland's development branch instead, built from source in the VM.
- CI runs the VM suite on every push. New ChatGPT/Codex and Hyprland releases are
  tested as soon as they appear (a poller, `scripts/release/poller/`, triggers the
  check; a daily schedule is the fallback). A failure opens an issue and a Claude Code
  agent proposes a fix as a pull request, which is then verified independently: a fresh
  VM run, a check that existing tests are unchanged, and a second agent's review. A fix
  that passes all three is merged, tested on main and released automatically. One that
  fails the suite or the review goes back to the agent with the findings, for up to three
  rounds; one that changes existing tests, or still fails, waits for the maintainer. Any merged change that passes on main is released.
- A daily job also runs the suite against each new commit of Hyprland's `main`, as an
  early warning before a release ships the change; failures open a `hyprland-main`
  issue and start the same fix agent. Its fixes must pass on both Hyprland `main` and
  the released version, and then merge and release like any other.
- [docs/DESIGN.md](docs/DESIGN.md) covers the architecture and implementation details;
  [AGENTS.md](AGENTS.md) the rules for automated contributors.

## Legal

This project is not affiliated with OpenAI. It distributes none of OpenAI's code: at
run time it makes a private, patched copy of the runtime packages from your own
ChatGPT/Codex installation, on your machine, and leaves the installed files untouched.

Released under the [MIT License](LICENSE).
