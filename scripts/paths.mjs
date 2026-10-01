// Installed package or git checkout; mirrors src/codex_hyprland/paths.py.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'codex-computer-use-hyprland';
export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const checkout = existsSync(join(root, 'pyproject.toml'));
export const python = checkout ? join(root, '.venv/bin/python') : '/usr/bin/python3';

/** Writable per-user builds: native/<abi>/ plugins and runtime/<hash>/ overlays. */
export function cacheDir(env = process.env) {
  if (env.CODEX_HYPRLAND_CACHE_DIR) return resolve(env.CODEX_HYPRLAND_CACHE_DIR);
  if (checkout) return join(root, 'build');
  const base = isAbsolute(env.XDG_CACHE_HOME ?? '') ? env.XDG_CACHE_HOME : join(homedir(), '.cache');
  return join(base, name);
}
