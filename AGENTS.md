Preserve the official `cua_repl` / `node_repl` JavaScript API. Implement platform
differences below Sky's Linux executable protocol where possible. The user has
authorized narrow frontend patches for parity: keep them version-checked in a
private runtime copy, preserve public signatures, and do not edit installed Codex
packages or monkey-patch live cua objects.

Do not add unit tests (user request). Validate changes with syntax checks and
bounded live runs against a disposable native application. Do not use the user's
documents or existing application windows as input fixtures.

Reference repositories under `reference/` are ignored research checkouts. Keep
implementation changes in this repository, not in installed Codex packages.

Window-bound input and screenshots must not implicitly focus windows, switch
workspaces, or move the physical cursor. Use the native target-client module
and exact toplevel capture; never fall back to foreground Hypruse input. Test
native-module changes in a disposable compositor before loading them in the
working desktop. Build shared libraries to a temporary path and rename them
atomically, because the old library may be mapped in a running compositor.
