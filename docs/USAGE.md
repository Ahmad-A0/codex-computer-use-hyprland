# Usage

## Settings

Set these under `[mcp_servers.cua_repl.env]` in `~/.codex/config.toml` (with the
Codex plugin, export them in the shell that starts Codex instead):

| Variable | Default | Effect |
| --- | --- | --- |
| `CODEX_HYPRLAND_LAUNCH_WORKSPACE` | `name:codex` | Where launched apps open: any Hyprland workspace (`3`, `special:codex`), or `current`. |
| `CODEX_HYPRLAND_CONFINE` | unset | Restrict the agent to `class:a,b`, `workspace:x,y` or `launched` apps. |
| `CODEX_HYPRLAND_AUTH_GUARD` | `1` | Refuse system authentication dialogs; `strict` also refuses password fields; `0` disables. |
| `CODEX_HYPRLAND_APP_APPROVAL` | on | `0` skips the per-app "Allow Computer Use to use …?" prompt. |
| `CODEX_CUA_RUNTIME` | auto | Path to OpenAI's `cua_node` runtime if it isn't in the usual place. |

## What it changes

- `~/.codex/config.toml`: one `cua_repl` entry (the original is backed up). The
  Codex plugin adds no entry: its `cua_repl` replaces the one in OpenAI's bundled
  `unified-computer-use` plugin. A `cua_repl` entry in the config takes precedence
  over both.
- `~/.cache/codex-computer-use-hyprland/`: the compiled Hyprland plugin and a
  patched private copy of OpenAI's runtime. Installed OpenAI files are never modified.
- The running compositor: the plugin is loaded on first use and stays until
  Hyprland restarts. A user service rebuilds it after Hyprland updates.
- The desktop accessibility flag is switched on, as a screen reader would, so
  Chromium, Electron and Firefox expose their UI.
- While a Codex session runs, a private socket in
  `$XDG_RUNTIME_DIR/codex-computer-use-hyprland/` connects the session's sandboxed
  computer-use code to the backend, which runs outside the sandbox (as on macOS).
  The model's own code stays sandboxed.

## Updates

Hyprland and Codex updates normally need nothing: the plugin is rebuilt for the
new Hyprland, and the provider adapts to OpenAI's runtime at startup (if a change
breaks something it depends on, it stops with an error naming the file). A git
install set up with `scripts/update.sh --enable` follows new releases hourly;
a checkout on a branch or with local changes is never moved.

## Troubleshooting

- `codex-computer-use-hyprland doctor` (or `./doctor`) checks the runtime,
  plugin, accessibility and registration.
- An app shows no accessibility tree: Chromium/Electron apps started before the
  provider first ran need a restart (or let the agent launch them).
- "Hyprland was upgraded … log out and back in": the running compositor is older
  than the installed one; the matching plugin is ready after you log in again.

## Uninstall

The Codex plugin:

```sh
codex plugin remove hyprland-computer-use@codex-computer-use-hyprland
~/.local/share/codex-computer-use-hyprland/scripts/update.sh --disable
```

A config registration:

```sh
codex-computer-use-hyprland unregister   # removes only this provider's cua_repl entry
```

Then remove the checkout (`~/.local/share/codex-computer-use-hyprland`) and
`~/.cache/codex-computer-use-hyprland/`.

## Tests and CI

`./test --host` runs the end-to-end suite in your session against disposable apps
(GTK, Qt, Chromium, Firefox, LibreOffice, terminals, XWayland), driving the real
`cua_repl` server the way Codex does and checking results in the apps themselves.
`./test` runs the same suite in a throwaway Arch VM; `E2E_HYPRLAND=git ./test`
uses Hyprland's development branch.

CI runs the VM suite on every push and whenever a new ChatGPT/Codex or Hyprland
release appears. A failure opens an issue and a Claude Code agent fixes it, running
the suite itself as it works; its fix is merged and released once a fresh VM run passes.
See [DESIGN.md](DESIGN.md) for the
architecture and [AGENTS.md](../AGENTS.md) for the rules automated contributors follow.
