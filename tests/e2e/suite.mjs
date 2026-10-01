#!/usr/bin/env node
// End-to-end suite. Drives disposable apps through the official cua_repl MCP
// server exactly as Codex does, and checks results inside the apps themselves.
// Run from a logged-in Hyprland session after ./install:  ./test --host
// Output (results.json, logs) goes to $E2E_OUT, default a temporary directory.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Provider } from './mcp.mjs';
import { resolveRuntime } from '../../scripts/launch.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const fixtures = join(root, 'tests/e2e/fixtures');
const out = resolve(process.env.E2E_OUT ?? mkdtempSync(join(tmpdir(), 'codex-hyprland-e2e-')));
const only = process.env.E2E_ONLY ? new RegExp(process.env.E2E_ONLY, 'i') : null;
mkdirSync(join(out, 'applications'), { recursive: true });

const which = (...names) => names.find((name) => {
  try { execFileSync('sh', ['-c', `command -v ${name}`], { stdio: 'ignore' }); return true; } catch { return false; }
});
const python = (module) => {
  try { execFileSync('python3', ['-c', `import ${module}`], { stdio: 'ignore' }); return true; } catch { return false; }
};
const hypr = (...args) => JSON.parse(execFileSync('hyprctl', ['-j', ...args], { encoding: 'utf8' }));
const clients = () => hypr('clients');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// Disposable apps, reached through desktop entries the way a user's apps are.
const apps = {};
function entry(id, name, exec, extra = '') {
  writeFileSync(join(out, 'applications', `${id}.desktop`),
    `[Desktop Entry]\nType=Application\nName=${name}\nExec=${exec}\nStartupWMClass=${id}\n${extra}`);
  apps[id] = { id, name, state: join(out, `${id}.json`) };
}
const gtkFixture = join(fixtures, 'gtk.py');
entry('codex-e2e-gtk', 'Codex E2E GTK', `/usr/bin/env GDK_BACKEND=wayland python3 ${gtkFixture} ${join(out, 'codex-e2e-gtk.json')} codex-e2e-gtk`);
entry('codex-e2e-xgtk', 'Codex E2E XWayland', `/usr/bin/env GDK_BACKEND=x11 python3 ${gtkFixture} ${join(out, 'codex-e2e-xgtk.json')} codex-e2e-xgtk`);
if (python('PyQt6')) {
  entry('codex-e2e-qt', 'Codex E2E Qt', `/usr/bin/env QT_QPA_PLATFORM=wayland python3 ${join(fixtures, 'qt.py')} ${join(out, 'codex-e2e-qt.json')} codex-e2e-qt`);
}
const browser = which('chromium', 'google-chrome-stable');
if (browser) {
  entry('codex-e2e-browser', 'Codex E2E Browser', `${browser} --user-data-dir=${join(out, 'browser')} --no-first-run `
    + `--no-default-browser-check --ozone-platform=wayland --class=codex-e2e-browser --app=file://${join(fixtures, 'page.html')}`);
}
const terminal = which('foot', 'kitty');
if (terminal) {
  const shell = `bash --norc --noprofile`;
  const exec = terminal === 'foot' ? `foot --app-id=codex-e2e-terminal --title=Codex-E2E-Terminal ${shell}`
    : `kitty --class codex-e2e-terminal --title Codex-E2E-Terminal -o confirm_os_window_close=0 ${shell}`;
  entry('codex-e2e-terminal', 'Codex E2E Terminal', exec, 'Categories=System;TerminalEmulator;\n');
}

const state = (id) => JSON.parse(readFileSync(apps[id].state, 'utf8'));
async function until(check, describe, timeout = 5000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { last = check(); if (last === true) return; } catch (error) { last = error.message; }
    await sleep(100);
  }
  throw new Error(`${describe} (last: ${JSON.stringify(last)})`);
}
const client = (id) => clients().find((c) => c.class === id || c.initialClass === id);

// Helpers defined inside the REPL; sent as source to avoid string escaping.
function e2eIndex(tree, name, role) {
  // Lines are "<id> <role> (<states>) <name>…"; a role picks e.g. an entry over its label.
  const line = tree.split(String.fromCharCode(10)).find((l) => l.includes(name)
    && (role === undefined || l.trim().replace(/^\d+ /, '').startsWith(role)));
  if (line === undefined) throw new Error(`No element named ${name} in:\n${tree.slice(0, 2000)}`);
  return Number(line.trim().match(/^(\d+)/)[1]);
}
async function e2eFind(app, name, role) {
  return e2eIndex(await app.getAXState({ emit: false, disableDiffing: true }), name, role);
}

const runtime = resolveRuntime();
const provider = new Provider({
  node: join(runtime, 'bin/node'),
  launcher: join(root, 'scripts/launch.mjs'),
  env: { ...process.env, CODEX_CUA_RUNTIME: runtime, CUA_REPL_ENABLED_SURFACES: 'computer', XDG_DATA_HOME: out },
});
const js = (code, options) => provider.js(code, options);
const seat = () => JSON.stringify([hypr('activewindow').address, hypr('activeworkspace').id, hypr('cursorpos')]);
// In the VM nobody else uses the desktop, so focus, workspace and pointer must be
// exactly unchanged. On a live desktop the user may move them; then check only
// that our actions never focused a test app or switched to its workspace.
const strict = process.env.E2E_STRICT_SEAT === '1';
function seatViolation(before) {
  if (strict) return seat() === before ? null : `desktop changed: ${before} -> ${seat()}`;
  const active = hypr('activewindow');
  if (String(active.class ?? '').startsWith('codex-e2e')) return `focus moved to ${active.class}`;
  if (hypr('activeworkspace').name === 'codex') return 'switched to the codex workspace';
  return null;
}
const original = new Set(clients().map((c) => c.address));

const tests = [];
const test = (name, run, { needs } = {}) => tests.push({ name, run, needs });
// Never drive the user's own windows: getApp reuses any existing window of the
// app, so refuse when the backend already maps one to this desktop entry.
function existingWindows(app) {
  const code = 'import json,sys; from codex_hyprland.backend import Backend; b=Backend(); '
    + 'print(json.dumps([w for a in b.list_apps({}) if a["id"]==sys.argv[1] for w in a["windows"]]))';
  return JSON.parse(execFileSync(join(root, '.venv/bin/python'), ['-c', code, app],
    { encoding: 'utf8', env: { ...process.env, XDG_DATA_HOME: out } })).filter((w) => original.has(`0x${w.id.toString(16)}`));
}
async function bind(variable, app, options) {
  const existing = existingWindows(app);
  if (existing.length) throw new Error(`refusing: ${app} would reuse existing windows ${JSON.stringify(existing)}`);
  await js(`globalThis.${variable} = await cua.getApp(${JSON.stringify(app)});`, options);
}

test('Codex resolves cua_repl to this provider', async () => {
  const output = execFileSync('codex', ['mcp', 'get', 'cua_repl'], { encoding: 'utf8' });
  if (!output.includes(join(root, 'scripts/launch.mjs'))) throw new Error(output);
}, { needs: which('codex') ? null : 'codex CLI not installed' });

test('official MCP tools and native instructions', async () => {
  const tools = await provider.tools();
  const tool = tools.find((t) => t.name === 'js');
  if (!tool?.description.includes('cua.getApp("Example App")')) throw new Error(JSON.stringify(tools.map((t) => t.name)));
  await js(`${e2eIndex}; ${e2eFind}; globalThis.e2eIndex = e2eIndex; globalThis.e2eFind = e2eFind;`);
});

test('native inventory', async () => {
  const text = await js(`const s = await cua.getState({ emit: false });
    if (s.errors?.length) throw new Error(JSON.stringify(s.errors));
    const w = await cua.listWindows({ emit: false });
    await nodeRepl.write(JSON.stringify({ apps: s.apps.length, windows: w.length, target: cua.computer.target }));`);
  if (!text.includes('"target":"linux"')) throw new Error(text);
});

test('GTK: getApp launches silently, asks approval, enables accessibility', async () => {
  await bind('gtk', 'codex-e2e-gtk.desktop', { timeout: 30000 });
  const c = client('codex-e2e-gtk');
  if (c.workspace.name !== 'codex') throw new Error(`launched on workspace ${c.workspace.name}`);
  const environment = readFileSync(`/proc/${c.pid}/environ`, 'utf8').split('\0');
  for (const variable of ['ACCESSIBILITY_ENABLED=1', 'QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1', 'GNOME_ACCESSIBILITY=1']) {
    if (!environment.includes(variable)) throw new Error(`missing ${variable}`);
  }
  if (!provider.elicitations.some((e) => e.message === 'Allow Computer Use to use "Codex E2E GTK"?'
    && e._meta?.connector_id === 'computer-use')) throw new Error(JSON.stringify(provider.elicitations));
});

test('GTK: setValue with Unicode', async () => {
  await js(`await gtk.setValue(await e2eFind(gtk, "E2E entry"), "first café / second café");`);
  await until(() => state('codex-e2e-gtk').text === 'first café / second café', 'entry text');
});

test('GTK: selectText with prefix', async () => {
  await js(`await gtk.selectText(await e2eFind(gtk, "E2E entry"), "café", { prefix: "second " });`);
  await until(() => JSON.stringify(state('codex-e2e-gtk').selection) === '[20,24]', 'selection');
});

test('GTK: click, cmd+a, paste', async () => {
  await js(`const i = await e2eFind(gtk, "E2E entry"); await gtk.click(i); await gtk.pressKey("cmd+a");
    await gtk.paste("Pasted 世界 ✓", { format: "text" }); await gtk.getAXState({ emit: false });`);
  await until(() => state('codex-e2e-gtk').text === 'Pasted 世界 ✓', 'pasted text');
});

test('GTK: typeText', async () => {
  await js(`const i = await e2eFind(gtk, "E2E entry"); await gtk.click(i); await gtk.pressKey("ctrl+a");
    await gtk.typeText("typed é"); await gtk.getAXState({ emit: false });`);
  await until(() => state('codex-e2e-gtk').text === 'typed é', 'typed text');
});

test('GTK: numeric setValue', async () => {
  await js(`await gtk.setValue(await e2eFind(gtk, "E2E slider"), "37");`);
  await until(() => state('codex-e2e-gtk').value === 37, 'slider value');
});

test('GTK: element click on a button', async () => {
  await js(`await gtk.click(await e2eFind(gtk, "E2E button")); await gtk.getAXState({ emit: false });`);
  await until(() => state('codex-e2e-gtk').clicks === 1, 'button clicks');
});

test('GTK: element double-click selects a word', async () => {
  await js(`const i = await e2eFind(gtk, "E2E entry"); await gtk.setValue(i, Array(30).fill("wordy").join(" "));
    await gtk.click(i, { clickCount: 2 }); await gtk.getAXState({ emit: false });`);
  await until(() => { const [a, b] = state('codex-e2e-gtk').selection; return b - a === 5; }, 'word selection');
});

test('GTK: scroll one page', async () => {
  await js(`await gtk.scroll(await e2eFind(gtk, "E2E viewport"), "down", 1); await gtk.getAXState({ emit: false });`);
  await until(() => state('codex-e2e-gtk').scroll > 0, 'scrolled');
});

test('GTK: macOS-format diffs and no-change notice', async () => {
  const text = await js(`await gtk.getAXState({ emit: false, disableDiffing: true });
    await gtk.setValue(await e2eFind(gtk, "E2E entry"), "diff check");
    await e2eFind(gtk, "E2E slider"); // full-tree read resets the baseline after the change
    await gtk.setValue(await e2eFind(gtk, "E2E entry"), "diff check two");
    const changed = await gtk.getAXState({ emit: false }); const same = await gtk.getAXState({ emit: false });
    await nodeRepl.write(JSON.stringify({ changed, same }));`);
  const { changed, same } = JSON.parse(text.slice(text.indexOf('{"changed"')));
  if (!changed.includes('The following is a diff from the previous accessibility tree')
    || !changed.split('\n').some((l) => l.startsWith('~\t'))) throw new Error(changed);
  if (!same.includes('There has been no change in the accessibility tree')) throw new Error(same);
});

test('GTK: screenshots', async () => {
  const text = await js(`const shot = await gtk.getScreenshot({ emit: false });
    const both = await gtk.getAXStateAndScreenshot({ emit: false });
    await nodeRepl.write(String(shot instanceof Uint8Array && shot.length > 1000 && both.screenshot?.length > 1000));`);
  if (!text.trim().endsWith('true')) throw new Error(text);
});

test('GTK: getApp reuses the running app', async () => {
  const before = clients().length;
  await js(`await cua.getApp("Codex E2E GTK");`);
  if (clients().length !== before) throw new Error('a second window was opened');
});

test('XWayland: setValue, Unicode typing, click, paste', async () => {
  await bind('xgtk', 'codex-e2e-xgtk.desktop', { timeout: 30000 });
  if (!client('codex-e2e-xgtk').xwayland) throw new Error('fixture is not running under XWayland');
  await js(`await xgtk.setValue(await e2eFind(xgtk, "E2E entry"), "x11 value");`);
  await until(() => state('codex-e2e-xgtk').text === 'x11 value', 'setValue');
  await js(`const i = await e2eFind(xgtk, "E2E entry"); await xgtk.click(i); await xgtk.pressKey("ctrl+a");
    await xgtk.typeText("ünïcødé"); await xgtk.getAXState({ emit: false });`);
  await until(() => state('codex-e2e-xgtk').text === 'ünïcødé', 'typed text');
  await js(`await xgtk.click(await e2eFind(xgtk, "E2E button")); await xgtk.getAXState({ emit: false });`);
  await until(() => state('codex-e2e-xgtk').clicks === 1, 'button click');
  await js(`const i = await e2eFind(xgtk, "E2E entry"); await xgtk.click(i); await xgtk.pressKey("ctrl+a");
    await xgtk.paste("x11 paste", { format: "text" }); await xgtk.getAXState({ emit: false });`);
  await until(() => state('codex-e2e-xgtk').text === 'x11 paste', 'pasted text');
});

test('Qt: accessibility tree, setValue, click', async () => {
  await bind('qt', 'codex-e2e-qt.desktop', { timeout: 30000 });
  await js(`await qt.setValue(await e2eFind(qt, "Qt entry"), "qt value");`);
  await until(() => state('codex-e2e-qt').text === 'qt value', 'Qt entry text');
  await js(`await qt.click(await e2eFind(qt, "Qt button")); await qt.getAXState({ emit: false });`);
  await until(() => state('codex-e2e-qt').clicks === 1, 'Qt button click');
}, { needs: apps['codex-e2e-qt'] ? null : 'PyQt6 not installed' });

test('Chromium: accessibility tree, typing, click', async () => {
  // Chromium names --app windows after the page, so use the documented Linux
  // flow: launch_app, then bind the new window found by title.
  await js(`await cua.computer.launch_app({ app: "codex-e2e-browser.desktop" });`);
  await until(() => clients().some((c) => c.title.startsWith('Codex E2E Page')), 'browser window', 30000);
  const window = () => clients().find((c) => c.title.startsWith('Codex E2E Page'));
  if (window().workspace.name !== 'codex') throw new Error(`browser opened on workspace ${window().workspace.name}`);
  await js(`globalThis.page = await cua.getApp({ windowId: ${parseInt(window().address, 16)} });`);
  const title = () => window()?.title ?? '';
  await js(`const i = await e2eFind(page, "Page input", "entry"); await page.click(i); await page.typeText("from codex");
    await page.getAXState({ emit: false });`);
  await until(() => title().startsWith('Codex E2E Page|from codex|'), 'page input', 8000);
  await js(`await page.click(await e2eFind(page, "Page button", "button")); await page.getAXState({ emit: false });`);
  await until(() => title().endsWith('|1'), 'page button click', 8000);
}, { needs: browser ? null : 'no Chromium-based browser' });

test('Terminal: typing and terminal paste shortcut', async () => {
  const typed = join(out, 'terminal-typed.txt');
  const pasted = join(out, 'terminal-pasted.txt');
  await bind('term', 'codex-e2e-terminal.desktop', { timeout: 30000 });
  await js(`await term.typeText(${JSON.stringify(`printf typed-ok > ${typed}`)}); await term.pressKey("Return");
    await term.getScreenshot({ emit: false });`);
  await until(() => readFileSync(typed, 'utf8') === 'typed-ok', 'typed command ran');
  await js(`await term.paste(${JSON.stringify(`printf pasted-ok > ${pasted}`)}); await term.pressKey("Return");
    await term.getScreenshot({ emit: false });`);
  await until(() => readFileSync(pasted, 'utf8') === 'pasted-ok', 'pasted command ran');
}, { needs: terminal ? null : 'no foot or kitty' });

test('approval was asked once per app', async () => {
  const asked = provider.elicitations.map((e) => e._meta?.tool_params?.app);
  if (new Set(asked).size !== asked.length) throw new Error(`repeated prompts: ${JSON.stringify(asked)}`);
});

// Run.
const results = [];
let failed = 0;
const before = seat();
try {
  await provider.start();
  for (const t of tests) {
    if (only && !only.test(t.name)) continue;
    const started = Date.now();
    if (t.needs) {
      results.push({ name: t.name, status: 'skipped', reason: t.needs });
      console.log(`SKIP ${t.name} (${t.needs})`);
      continue;
    }
    try {
      await t.run();
      // Background control must never move the user's focus, workspace or pointer.
      const violation = seatViolation(before);
      if (violation) throw new Error(violation);
      results.push({ name: t.name, status: 'passed', ms: Date.now() - started });
      console.log(`PASS ${t.name}`);
    } catch (error) {
      failed++;
      results.push({ name: t.name, status: 'failed', ms: Date.now() - started, error: error.message });
      console.log(`FAIL ${t.name}\n  ${error.message.split('\n').join('\n  ')}`);
    }
  }
} finally {
  provider.stop();
  for (const c of clients()) {
    if (!original.has(c.address) && (String(c.class).startsWith('codex-e2e') || c.title.startsWith('Codex E2E'))) {
      try { process.kill(c.pid, 'SIGTERM'); } catch {}
    }
  }
  writeFileSync(join(out, 'results.json'), JSON.stringify({ results, elicitations: provider.elicitations }, null, 2));
  writeFileSync(join(out, 'provider.log'), provider.stderr);
}
console.log(`${results.filter((r) => r.status === 'passed').length} passed, ${failed} failed, `
  + `${results.filter((r) => r.status === 'skipped').length} skipped. Results: ${out}`);
process.exit(failed ? 1 : 0);
