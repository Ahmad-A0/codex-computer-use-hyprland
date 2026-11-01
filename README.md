# codex-computer-use-hyprland

Computer use for [Codex](https://github.com/openai/codex) on [Hyprland](https://hypr.land).
Codex can see and operate native Linux apps the way it does on macOS, in the
background, without touching your cursor, keyboard focus or current workspace.

![Codex building a budget in LibreOffice Calc, painting a sunset in GIMP and setting it as the wallpaper](docs/demo.gif)

<sub>Codex (left) turns trip notes into a Calc budget with a chart, paints a sunset by hand in GIMP, then sets it as the wallpaper. Each app is driven through accessibility and synthetic input. Sped up 16×.</sub>

## What you get

- **The same API as macOS.** Codex's own `cua_repl` tool is unchanged:
  `cua.getApp("Calculator")`, accessibility-tree diffs, `click`, `typeText`,
  `setValue`, rich `paste`, `scroll`, `drag`, menus and dialogs. Prompts and
  skills written for macOS work as-is.
- **Background input.** Events go straight to the target window through a small
  Hyprland plugin. You can keep working while the agent does, even on a hidden
  workspace.
- **Real apps.** GTK 3/4, Qt 6, Chromium, Firefox, LibreOffice, terminals and
  X11 apps via XWayland are covered by an end-to-end suite that runs on every
  new Codex and Hyprland release.

## Install

You need Arch Linux (or similar) with Hyprland 0.56+, the Codex CLI, and the
ChatGPT desktop package (`chatgpt-bin` from OpenAI's repository, or
`chatgpt-desktop` from the AUR), which ships the computer-use runtime this builds
on. You don't have to use the desktop app itself.

```sh
git clone https://github.com/Ahmad-A0/codex-computer-use-hyprland ~/.local/share/codex-computer-use-hyprland
~/.local/share/codex-computer-use-hyprland/scripts/update.sh --enable
```

This installs the latest release, registers the provider in `~/.codex/config.toml`
and keeps it updated. Start a new Codex session and ask it to use an app.
`codex-computer-use-hyprland doctor` checks the setup.

## How it works

OpenAI's computer-use runtime (`cua_repl`) talks to a platform backend called Sky.
On Linux, the stock backend is deliberately limited. This project replaces it with
a Hyprland backend: AT-SPI for the accessibility tree and element actions, and a
compositor plugin for window screenshots and input that targets one window's
Wayland surface directly instead of the focused one. Nothing of OpenAI's is
redistributed; a patched copy of the runtime is made locally from your own install.
[docs/DESIGN.md](docs/DESIGN.md) has the details, and [docs/USAGE.md](docs/USAGE.md)
covers settings, updates and uninstalling.

## Limitations

- `getApp` binds one window; macOS binds the whole app.
- Drag and drop between a Wayland window and an XWayland window isn't supported.
- Terminals have no accessibility tree, so the agent works from screenshots there.
- No computer-audio recording.

## License

MIT. Not affiliated with OpenAI or Hyprland.
