import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { prepareRuntime } from './prepare-runtime.mjs';
import { root, checkout, python, cacheDir } from './paths.mjs';

export { root };
export function resolveRuntime(input = process.env) {
  if (input.CODEX_CUA_RUNTIME) return resolve(input.CODEX_CUA_RUNTIME);
  const candidates = ['/usr/lib/chatgpt/resources/cua_node', '/opt/codex-desktop/resources/cua_node'];
  const runtime = candidates.find(path => existsSync(join(path, 'bin/node')));
  if (!runtime) throw new Error('Codex cua_node runtime not found. Set CODEX_CUA_RUNTIME to its directory.');
  return runtime;
}
export const providerNotice = 'Hyprland provider: the standard cua API is unchanged. Input targets the selected application without activating its desktop window or moving the physical cursor. App screenshots include owned popups; coordinate actions follow the latest screenshot. Native Wayland clipboard offers are private; XWayland paste restores the previous clipboard formats. Dragging between windows is supported within Wayland and within XWayland; mixed-protocol drops are rejected. Covered X11 pointer targets are rejected; use indexed accessibility actions when available. An accessibility source of hyprland means compositor metadata only; use screenshot coordinates.';

export function environment(input = process.env) {
  const runtime = resolveRuntime(input);
  const modules = join(runtime, 'lib/node_modules');
  const executable = join(runtime, 'bin/node');
  const launcher = join(modules, '@oai/cua-repl/bin/cua-repl.mjs');
  const repl = input.CUA_REPL_NODE_REPL_PATH ?? join(runtime, 'bin/node_repl');
  const backend = join(root, 'bin/sky-hyprland');
  for (const path of [executable, launcher, repl, backend, python]) {
    if (!existsSync(path)) throw new Error(`Missing ${path}; ${checkout ? 'run scripts/setup.sh' : 'reinstall the package'} or set CODEX_CUA_RUNTIME.`);
  }
  const surfaces = input.CUA_REPL_ENABLED_SURFACES ?? 'computer';
  const overlay = prepareRuntime(runtime);
  const services = JSON.parse(input.NODE_REPL_TRUSTED_SERVICES ?? '{}');
  if (surfaces.split(',').map(s => s.trim()).includes('computer')) services.sky = join(overlay, '@oai/sky/dist/project/cua/sky_js/src/service.js');
  const browserEnabled = surfaces.split(',').map(s => s.trim()).includes('browser');
  const browserEnv = {};
  if (browserEnabled) {
    const browserService = join(modules, '@oai/browser-desktop/scripts/browser-service.mjs');
    if (!services.browser && !existsSync(browserService)) throw new Error('This Codex runtime does not include the official browser service.');
    services.browser ??= browserService;
    browserEnv.BROWSER_USE_AVAILABLE_BACKENDS = input.BROWSER_USE_AVAILABLE_BACKENDS ?? 'chrome,iab';
    browserEnv.BROWSER_USE_TINYSKY_ENABLED = input.BROWSER_USE_TINYSKY_ENABLED ?? '1';
    browserEnv.CUA_REPL_BROWSER_ENV = input.CUA_REPL_BROWSER_ENV ?? 'codex-app';
    const cli = input.CODEX_CLI_PATH ?? join(runtime, '..', 'codex');
    if (existsSync(cli)) browserEnv.CODEX_CLI_PATH = cli;
  }
  return { executable, launcher, env: {
    ...input,
    ...browserEnv,
    CODEX_HYPRLAND_ROOT: root,
    CODEX_HYPRLAND_CACHE_DIR: cacheDir(input),
    OAI_SKY_LINUX_BIN: backend,
    CUA_REPL_ENABLED_SURFACES: surfaces,
    CUA_REPL_NODE_REPL_PATH: repl,
    NODE_REPL_NODE_PATH: executable,
    NODE_REPL_NODE_MODULE_DIRS: [overlay, modules, input.NODE_REPL_NODE_MODULE_DIRS].filter(Boolean).join(':'),
    NODE_REPL_TRUSTED_CODE_PATHS: [overlay, modules, input.NODE_REPL_TRUSTED_CODE_PATHS].filter(Boolean).join(':'),
    NODE_REPL_TRUSTED_SERVICES: JSON.stringify(services),
    // The private upstream copy replaces the Linux app binding and Sky client; public signatures are unchanged.
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
