# Shared by shell entry points; Codex supplies the JavaScript runtime.
if [ -z "${CODEX_CUA_RUNTIME:-}" ]; then
  for candidate in /usr/lib/chatgpt/resources/cua_node /opt/codex-desktop/resources/cua_node; do
    if [ -x "$candidate/bin/node" ]; then
      CODEX_CUA_RUNTIME=$candidate
      break
    fi
  done
fi
if [ -z "${CODEX_CUA_RUNTIME:-}" ] || [ ! -x "$CODEX_CUA_RUNTIME/bin/node" ]; then
  echo 'Codex cua_node runtime not found; set CODEX_CUA_RUNTIME.' >&2
  exit 1
fi
export CODEX_CUA_RUNTIME
