import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { prepareRuntime } from './prepare-runtime.mjs';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const providerNotice = 'Hyprland provider: the standard cua API is unchanged. Input targets the selected application without activating its desktop window or moving the physical cursor. App screenshots include owned popups; coordinate actions follow the latest screenshot. Native Wayland clipboard offers are private; XWayland paste restores the previous clipboard formats. Dragging between windows is supported within Wayland and within XWayland; mixed-protocol drops are rejected. Covered X11 pointer targets are rejected; use indexed accessibility actions when available. An accessibility source of hyprland means compositor metadata only; use screenshot coordinates.';

export function environment(input = process.env) {
  const runtime = input.CODEX_CUA_RUNTIME ?? '/opt/codex-desktop/resources/cua_node';
  const modules = join(runtime, 'lib/node_modules');
  const executable = join(runtime, 'bin/node');
  const launcher = join(modules, '@oai/cua-repl/bin/cua-repl.mjs');
  const repl = input.CUA_REPL_NODE_REPL_PATH ?? join(runtime, 'bin/node_repl');
  const backend = join(root, 'bin/sky-hyprland');
  for (const path of [executable, launcher, repl, backend, join(root, '.venv/bin/python')]) {
    if (!existsSync(path)) throw new Error(`Missing ${path}; run scripts/setup.sh or set CODEX_CUA_RUNTIME.`);
  }
  const surfaces = input.CUA_REPL_ENABLED_SURFACES ?? 'computer';
  const overlay = prepareRuntime(runtime);
  const services = JSON.parse(input.NODE_REPL_TRUSTED_SERVICES ?? '{}');
  if (surfaces.split(',').map(s => s.trim()).includes('computer')) services.sky = join(overlay, '@oai/sky/dist/project/cua/sky_js/src/service.js');
  if (surfaces.split(',').map(s => s.trim()).includes('browser')) services.browser ??= '@oai/browser-desktop/service';
  return { executable, launcher, env: {
    ...input,
    OAI_SKY_LINUX_BIN: backend,
    CUA_REPL_ENABLED_SURFACES: surfaces,
    CUA_REPL_NODE_REPL_PATH: repl,
    NODE_REPL_NODE_PATH: executable,
    NODE_REPL_NODE_MODULE_DIRS: [overlay, modules, input.NODE_REPL_NODE_MODULE_DIRS].filter(Boolean).join(':'),
    NODE_REPL_TRUSTED_CODE_PATHS: [overlay, modules, input.NODE_REPL_TRUSTED_CODE_PATHS].filter(Boolean).join(':'),
    NODE_REPL_TRUSTED_SERVICES: JSON.stringify(services),
    // The private upstream copy has narrowly patched Linux method bodies; public signatures are unchanged.
    NODE_REPL_JS_BANNER: `await import("@oai/cua/tinyskyAlt"); await nodeRepl.write(${JSON.stringify(providerNotice)});`,
  }};
}

export async function launch() {
  const config = environment();
  const child = spawn(config.executable, [config.launcher], { stdio: 'inherit', env: config.env });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await launch();
