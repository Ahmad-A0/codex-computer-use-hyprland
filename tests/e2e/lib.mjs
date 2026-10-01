// Shared context for the end-to-end cases: the provider, disposable apps and
// helpers that read results from the apps and the compositor.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Provider } from './mcp.mjs';
import { resolveRuntime } from '../../scripts/launch.mjs';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const fixtures = join(root, 'tests/e2e/fixtures');
export const out = resolve(process.env.E2E_OUT ?? mkdtempSync(join(tmpdir(), 'codex-hyprland-e2e-')));
// In the VM nobody uses the desktop: exact seat checks, a focused decoy, and
// clipboard checks are safe there and only there.
export const strict = process.env.E2E_STRICT_SEAT === '1';
mkdirSync(join(out, 'applications'), { recursive: true });
mkdirSync(join(out, 'bin'), { recursive: true });

export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
export const hypr = (...args) => JSON.parse(execFileSync('hyprctl', ['-j', ...args], { encoding: 'utf8' }));
export const clients = () => hypr('clients');
export const which = (...names) => names.find((name) => {
  try { execFileSync('sh', ['-c', `command -v ${name}`], { stdio: 'ignore' }); return true; } catch { return false; }
});
export const python = (module) => {
  try { execFileSync('python3', ['-c', `import ${module}`], { stdio: 'ignore' }); return true; } catch { return false; }
};
export const original = new Set(clients().map((c) => c.address));
// Windows standing in for the user's own apps: original ones plus decoys.
export const userWindows = new Set(original);
export const windowId = (c) => parseInt(c.address, 16);

/** Poll until check() returns true; its last value or error explains a timeout. */
export async function until(check, describe, timeout = 5000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { last = check(); if (last === true) return; } catch (error) { last = error.message; }
    await sleep(100);
  }
  throw new Error(`${describe} (last: ${JSON.stringify(last)})`);
}

export function expect(condition, message) {
  if (!condition) throw new Error(message);
}

// Disposable apps, reached through desktop entries the way a user's apps are.
export const apps = {};
// Window classes our entries launch, including real apps, for cleanup.
export const launchedClasses = new Set();
export function entry(id, name, exec, extra = '') {
  const wmclass = extra.match(/^StartupWMClass=(.*)$/m)?.[1];
  if (wmclass) launchedClasses.add(wmclass);
  writeFileSync(join(out, 'applications', `${id}.desktop`),
    `[Desktop Entry]\nType=Application\nName=${name}\nExec=${exec}\n${extra}`);
  apps[id] = { id, name };
}
export const gtkFixture = join(fixtures, 'gtk.py');
export const statePath = (id) => join(out, `${id}.json`);
// Each fixture window gets a unique title (its name) so lookups can't confuse them.
export const gtk = (id, name, { backend = 'wayland', title = name } = {}) => entry(id, name,
  `/usr/bin/env GDK_BACKEND=${backend} python3 ${gtkFixture} ${statePath(id)} ${id} "${title}"`,
  `StartupWMClass=${id}\n`);
export const state = (id) => JSON.parse(readFileSync(statePath(id), 'utf8'));
export const stateOf = (pid) => JSON.parse(readFileSync(join(out, `twin-${pid}.json`), 'utf8'));
export const client = (id) => clients().find((c) => c.class === id || c.initialClass === id);

/** Start an app outside the provider, as the user would have it running. */
export function launchDirect(command, { silent = true } = {}) {
  const rules = silent ? '[workspace name:codex silent; no_initial_focus on] ' : '';
  execFileSync('hyprctl', ['dispatch', `hl.dsp.exec_cmd(${JSON.stringify(rules + command)})`]);
}

/** A program shared by several desktop entries, like kitty or a browser. */
export function sharedProgram(name) {
  const path = join(out, 'bin', name);
  writeFileSync(path, `#!/bin/sh\nexec python3 ${gtkFixture} "$@"\n`);
  chmodSync(path, 0o755);
  return path;
}

// Helpers defined inside the REPL; sent as source to avoid string escaping.
function e2eIndex(tree, name, role) {
  // Lines are "<id> <role> (<states>) <name>, <details>". Match the name itself,
  // never an ID or another field; a role picks e.g. an entry over its label.
  const line = tree.split(String.fromCharCode(10)).find((l) => {
    const rest = l.trim().replace(/^\d+ /, '');
    if (role !== undefined && !(rest === role || rest.startsWith(`${role} `))) return false;
    const label = role === undefined ? rest : rest.slice(role.length).trim().replace(/^\([^)]*\) ?/, '');
    return role === undefined ? label.includes(name) : label === name || label.startsWith(`${name},`);
  });
  if (line === undefined) throw new Error(`No ${role ?? 'element'} named ${name} in:\n${tree.slice(0, 2500)}`);
  return Number(line.trim().match(/^(\d+)/)[1]);
}
async function e2eFind(app, name, role) {
  return e2eIndex(await app.getAXState({ emit: false, disableDiffing: true }), name, role);
}
async function e2eWindow(title, app) {
  const windows = (await cua.listWindows({ emit: false })).filter((w) => w.title === title && (app === undefined || w.app === app));
  if (windows.length !== 1) throw new Error(`Expected one window titled ${title}, found ${windows.length}`);
  return windows[0];
}

const runtime = resolveRuntime();
export const provider = new Provider({
  node: join(runtime, 'bin/node'),
  launcher: join(root, 'scripts/launch.mjs'),
  env: { ...process.env, CODEX_CUA_RUNTIME: runtime, CUA_REPL_ENABLED_SURFACES: 'computer', XDG_DATA_HOME: out,
    PATH: `${join(out, 'bin')}:${process.env.PATH}` },
});
export const js = (code, options) => provider.js(code, options);
export const helpers = `${e2eIndex}; ${e2eFind}; ${e2eWindow};
  globalThis.e2eIndex = e2eIndex; globalThis.e2eFind = e2eFind; globalThis.e2eWindow = e2eWindow;`;

/** Expect a js call to fail with a message matching pattern. */
export async function rejects(code, pattern) {
  try { await js(code); } catch (error) {
    expect(pattern.test(error.message), `unexpected error: ${error.message.slice(-800)}`);
    return error.message;
  }
  throw new Error(`expected an error matching ${pattern}`);
}

// Never drive the user's own windows: getApp reuses any existing window of the
// app, so refuse when the backend already maps one to this desktop entry.
export function existingWindows(app) {
  const code = 'import json,sys; from codex_hyprland.backend import Backend; b=Backend(); '
    + 'print(json.dumps([w for a in b.list_apps({}) if a["id"]==sys.argv[1] for w in a["windows"]]))';
  return JSON.parse(execFileSync(join(root, '.venv/bin/python'), ['-c', code, app],
    { encoding: 'utf8', env: { ...process.env, XDG_DATA_HOME: out } }))
    .filter((w) => userWindows.has(`0x${w.id.toString(16)}`));
}
export async function bind(variable, app, options) {
  const existing = existingWindows(app);
  if (existing.length) throw new Error(`refusing: ${app} would reuse existing windows ${JSON.stringify(existing)}`);
  await js(`globalThis.${variable} = await cua.getApp(${JSON.stringify(app)});`, options);
}

/** Bind an app unless an earlier test already did, so any test can run alone. */
export async function ensure(variable, app, options) {
  const bound = await js(`await nodeRepl.write(String(typeof globalThis.${variable} !== "undefined"))`);
  if (!bound.trim().endsWith('true')) await bind(variable, app, options);
}

/**
 * macOS context-menu behavior through the public API: right-clicking an element
 * opens its menu, the menu's items appear in getAXState (the diff adds them),
 * screenshots show it, and an item is chosen by index, closing the menu (the
 * diff removes it). With reopen, the menu is opened again and closed by Escape.
 * Escape always runs on failure so no menu stays open for later tests.
 */
export async function contextMenu(app, target, role, item, { reopen = false } = {}) {
  const text = await js(`const i = await e2eFind(${app}, ${JSON.stringify(target)}, ${JSON.stringify(role)});
    const result = {};
    const closedShot = await ${app}.getScreenshot({ emit: false });
    await ${app}.getAXState({ emit: false }); // the diff baseline
    await ${app}.click(i, { mouseButton: "right" });
    try {
      result.opened = await ${app}.getAXState({ emit: false });
      const openShot = await ${app}.getScreenshot({ emit: false });
      result.shotChanged = Buffer.compare(Buffer.from(closedShot), Buffer.from(openShot)) !== 0;
      const full = await ${app}.getAXState({ emit: false, disableDiffing: true });
      await ${app}.click(e2eIndex(full, ${JSON.stringify(item)})); // menu items are listed by name alone
      result.chosen = await ${app}.getAXState({ emit: false });
      if (${reopen}) {
        await ${app}.click(i, { mouseButton: "right" });
        result.reopened = await ${app}.getAXState({ emit: false, disableDiffing: true });
        await ${app}.pressKey("Escape");
        result.escaped = await ${app}.getAXState({ emit: false });
      }
    } catch (error) {
      await ${app}.pressKey("Escape");
      throw error;
    }
    await nodeRepl.write(JSON.stringify(result));`);
  const result = JSON.parse(text.slice(text.indexOf('{"opened"')));
  writeFileSync(join(out, `menu-${app}.json`), JSON.stringify(result, null, 2)); // evidence for failures
  const added = (diff) => diff.split('\n').some((l) => l.startsWith('+\t') && l.includes(item));
  const removed = (diff) => diff.includes('Removed element IDs') && !diff.includes(item);
  expect(added(result.opened), `menu items were not added to the tree:\n${result.opened}`);
  expect(result.shotChanged, 'the screenshot did not change while the menu was open');
  expect(removed(result.chosen), `the chosen menu did not close in the tree:\n${result.chosen}`);
  if (reopen) {
    expect(result.reopened.includes(item), `the reopened menu is missing:\n${result.reopened}`);
    expect(removed(result.escaped), `Escape did not remove the menu from the tree:\n${result.escaped}`);
  }
  return result;
}

export const seat = () => JSON.stringify([hypr('activewindow').address, hypr('activeworkspace').id, hypr('cursorpos')]);
/** Background control must never move focus, switch workspaces or move the pointer. */
export function seatViolation(before) {
  if (strict) return seat() === before ? null : `desktop changed: ${before} -> ${seat()}`;
  // On a live desktop the user may move these; check only what we could cause.
  const active = hypr('activewindow');
  if (String(active.class ?? '').startsWith('codex-e2e') || String(active.title ?? '').startsWith('Codex E2E')) {
    // The workspace tells our doing apart from the user looking at the codex workspace.
    return `focus moved to ${active.class} (${active.title}) on workspace ${hypr('activeworkspace').name}`;
  }
  if (hypr('activeworkspace').name === 'codex') return 'switched to the codex workspace';
  return null;
}

/** Screenshots of every test window (never the user's) for the report. */
export function snap(label) {
  const addresses = clients().filter(ours).map((c) => c.address);
  if (!addresses.length) return [];
  try {
    return execFileSync(join(root, '.venv/bin/python'), [join(root, 'tests/e2e/snap.py'), out, label, ...addresses],
      { encoding: 'utf8', env: { ...process.env, XDG_DATA_HOME: out }, timeout: 60000 })
      .split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    return [{ error: `snapshot failed: ${error.message.slice(0, 300)}` }];
  }
}

/** Full accessibility trees of whatever apps the REPL has bound, for failures. */
export async function trees() {
  const names = ['gtk', 'xgtk', 'qt', 'page', 'term', 'calc', 'editor', 'save', 'dlg', 'custom'];
  try {
    const text = await js(`const result = {};
      for (const name of ${JSON.stringify(names)}) {
        if (typeof globalThis[name] === "undefined") continue;
        try { result[name] = await globalThis[name].getAXState({ emit: false, disableDiffing: true }); }
        catch (error) { result[name] = String(error); }
      }
      await nodeRepl.write("E2E-TREES" + JSON.stringify(result));`);
    return JSON.parse(text.slice(text.indexOf('E2E-TREES') + 9));
  } catch (error) {
    return { error: error.message.slice(0, 500) };
  }
}

export const ours = (c) => !original.has(c.address) && (String(c.class).startsWith('codex-e2e')
  || String(c.title).startsWith('Codex E2E') || launchedClasses.has(c.class));
