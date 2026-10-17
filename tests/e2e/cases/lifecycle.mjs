// Window, dialog and app lifecycle edge cases: windows that come and go while
// the agent works, dialogs inside dialogs, file choosers, apps that crash or
// were already running, windows resized or changed under the agent, and
// outputs that are scaled or added. Every result is read from the app itself.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bind, client, clients, ensure, entry, expect, fixtures, hypr, js, out, provider, root, seat, sleep, strict,
  until, userWindows, which } from '../lib.mjs';

const fixture = join(fixtures, 'lifecycle.py');
const evidence = join(out, 'lifecycle');
mkdirSync(evidence, { recursive: true });
const statePath = (id) => join(out, `${id}.json`);
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const life = (id) => read(statePath(id));
// Throwaway settings: GTK's file chooser would otherwise remember folders in the user's dconf.
const quiet = `GSETTINGS_BACKEND=memory XDG_CONFIG_HOME=${join(out, 'lifecycle-config')}`;
function app(id, name, mode, { backend = 'wayland', env = '', state = statePath(id) } = {}) {
  entry(id, name, `/usr/bin/env GDK_BACKEND=${backend} ${quiet} ${env} python3 ${fixture} ${state} ${id} "${name}" ${mode}`,
    `StartupWMClass=${id}\n`);
}

// A populated directory for the file chooser: the target sorts last, so it
// starts out of view, between decoys whose names differ by one character.
const pick = join(out, 'lifecycle-pick');
const start = join(out, 'lifecycle-start');
const saveIn = join(out, 'lifecycle-save');
for (const dir of [pick, start, saveIn]) { rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true }); }
for (let n = 0; n < 40; n++) writeFileSync(join(pick, `file-${String(n).padStart(2, '0')}.txt`), `file ${n}\n`);
for (const name of ['target-alpha.txt', 'target-beta.txt', 'target-betb.txt']) writeFileSync(join(pick, name), `${name}\n`);

app('codex-e2e-life-dialogs', 'Codex E2E Life Dialogs', 'dialogs', { env: `LIFECYCLE_OPEN_FROM=${start} LIFECYCLE_SAVE_IN=${saveIn}` });
app('codex-e2e-life-crash', 'Codex E2E Life Crash', 'dialogs', { state: join(out, 'life-crash-{pid}.json') });
app('codex-e2e-life-running', 'Codex E2E Life Running', 'dialogs');
app('codex-e2e-life-layout', 'Codex E2E Life Layout', 'layout');
app('codex-e2e-life-targets', 'Codex E2E Life Targets', 'targets');
app('codex-e2e-life-xtargets', 'Codex E2E Life XTargets', 'targets', { backend: 'x11' });
app('codex-e2e-life-xdialogs', 'Codex E2E Life XDialogs', 'dialogs', { backend: 'x11' });

const lua = (() => { try { return hypr('status').configProvider === 'lua'; } catch { return false; } })();
const luaOnly = lua ? null : 'needs a Lua Hyprland config (hyprctl dispatch syntax)';
function hyprctl(...args) {
  const result = execFileSync('hyprctl', args, { encoding: 'utf8' }).trim();
  if (result !== 'ok') throw new Error(`hyprctl ${args.join(' ')}: ${result}`);
}
const dispatch = (call) => hyprctl('dispatch', call);
const windows = (title) => clients().filter((c) => c.title === title);
const one = (title) => { const found = windows(title); return found.length === 1 ? found[0] : null; };
const address = (c) => `address:${c.address}`;
const monitorOf = (c) => hypr('monitors').find((m) => m.id === c.monitor);
const inside = (c, m) => c.at[0] >= m.x && c.at[1] >= m.y && c.at[0] + c.size[0] <= m.x + m.width / m.scale + 1
  && c.at[1] + c.size[1] <= m.y + m.height / m.scale + 1;
/** A window the app opened must stay out of the user's way. */
function background(c, workspace = 'codex') {
  expect(c.workspace.name === workspace, `${c.title} opened on workspace ${c.workspace.name}, not ${workspace}`);
  expect(hypr('activewindow').address !== c.address, `${c.title} took focus`);
}

// REPL helpers: find elements by role and exact name in the formatted tree
// ("<id> <role> (<states>) <name>, <details>"), and wait for windows.
function lifeIds(tree, source) {
  const pattern = new RegExp(source);
  return tree.split(String.fromCharCode(10)).map((line) => line.trim().match(/^(\d+) (.*)$/))
    .filter((m) => m && pattern.test(m[2])).map((m) => Number(m[1]));
}
async function lifeOne(app, source) {
  const tree = await app.getAXState({ emit: false, disableDiffing: true });
  const ids = lifeIds(tree, source);
  if (ids.length !== 1) throw new Error(`Expected one element matching /${source}/, found ${ids.length} in:\n${tree.slice(0, 6000)}`);
  return ids[0];
}
async function lifeLast(app, source) {
  // Nested matches (a table cell inside a cell of the same name): the innermost.
  const tree = await app.getAXState({ emit: false, disableDiffing: true });
  const ids = lifeIds(tree, source);
  if (!ids.length) throw new Error(`No element matching /${source}/ in:\n${tree.slice(0, 6000)}`);
  return ids.at(-1);
}
async function lifeWait(check, describe, timeout = 10000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { last = await check(); if (last === true) return; } catch (error) { last = String(error && error.message || error); }
    await new Promise((done) => setTimeout(done, 150));
  }
  throw new Error(`${describe} (last: ${String(last).slice(0, 4000)})`);
}
async function lifeBind(title, timeout = 10000) {
  let found;
  await lifeWait(async () => {
    const all = (await cua.listWindows({ emit: false })).filter((w) => w.title === title);
    if (all.length === 1) { found = all[0]; return true; }
    return `${all.length} windows titled ${title}`;
  }, `window ${title}`, timeout);
  return cua.getApp({ windowId: found.id });
}
const replHelpers = `${lifeIds}; ${lifeOne}; ${lifeLast}; ${lifeWait}; ${lifeBind};
  Object.assign(globalThis, { lifeIds, lifeOne, lifeLast, lifeWait, lifeBind });`;
const esc = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const BUTTON = '(?:push )?button';
const ENTRY = 'text|entry';
/** Pattern for an element with this role (regex source) and exactly this name;
 *  text fields must be settable (a label next to one shares role and name). */
const el = (role, name) => (role === ENTRY ? `^(?:${role}) \\([^)]*settable[^)]*\\) ${esc(name)}(?:,|$)`
  : `^(?:${role})(?: \\([^)]*\\))? ${esc(name)}(?:,|$)`);
const find = (app, role, name) => `await lifeOne(${app}, ${JSON.stringify(el(role, name))})`;

/** Poll an async check (a value of true ends it); the last value explains a timeout. */
async function eventually(check, describe, timeout = 10000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { last = await check(); if (last === true) return; } catch (error) { last = error.message; }
    await sleep(200);
  }
  throw new Error(`${describe} (last: ${JSON.stringify(last)?.slice(0, 3000)})`);
}
/** Run js and parse the JSON it writes after a marker. */
async function data(code, options) {
  const text = await js(`${code}`, options);
  const at = text.indexOf('E2E-DATA');
  if (at < 0) throw new Error(`no data in: ${text.slice(-1500)}`);
  return JSON.parse(text.slice(at + 8));
}
const write = (expr) => `await nodeRepl.write("E2E-DATA" + JSON.stringify(${expr}));`;
/** Run fn; on failure keep the given windows' trees as evidence and say where,
 *  and close the given windows it left open (a modal dialog left behind would
 *  take the keys later tests send to its app's other windows). */
async function withTrees(name, globals, fn, leftovers = []) {
  try {
    return await fn();
  } catch (error) {
    let trees = '';
    try {
      trees = await js(`const result = [];
        for (const name of ${JSON.stringify(globals)}) {
          if (globalThis[name] === undefined) continue;
          try { result.push("== " + name + "\\n" + await globalThis[name].getAXState({ emit: false, disableDiffing: true })); }
          catch (e) { result.push("== " + name + ": " + e.message); }
        }
        await nodeRepl.write(result.join("\\n"));`);
    } catch (e) { trees = `trees unavailable: ${e.message}`; }
    const file = join(evidence, `${name}.txt`);
    writeFileSync(file, `${error.stack}\n\n${trees}\n\nclients:\n${JSON.stringify(clients(), null, 1)}`);
    await closeLeftovers(leftovers);
    error.message += `\n(trees and clients in ${file})`;
    throw error;
  }
}

async function closeLeftovers(titles) {
  const open = () => clients().filter((c) => titles.includes(c.title));
  for (const c of open()) try { dispatch(`hl.dsp.window.close({ window = "${address(c)}" })`); } catch {}
  try { await until(() => open().length === 0, 'leftover windows closed', 5000); } catch {}
}

/** The focused window, workspace and pointer as they were (see seat()). Adding
 *  or removing an output makes Hyprland focus and warp to a monitor itself. */
async function restoreSeat(saved, log) {
  const [window, , cursor] = JSON.parse(saved);
  log.push(`restore to ${saved} from ${seat()}`);
  await until(() => {
    if (seat() === saved) return true;
    const now = hypr('cursorpos');
    if (now.x !== cursor.x || now.y !== cursor.y) dispatch(`hl.dsp.cursor.move({ x = ${cursor.x}, y = ${cursor.y} })`);
    log.push(`cursor moved: ${seat()}`);
    if (window && hypr('activewindow').address !== window) dispatch(`hl.dsp.focus({ window = "address:${window}" })`);
    log.push(`window focused: ${seat()}`);
    return seat();
  }, `desktop restored to ${saved}`, 3000);
}

/** Width and height of a JPEG from its frame header. */
function jpegSize(bytes) {
  for (let i = 2; i + 9 < bytes.length;) {
    if (bytes[i] !== 0xff) { i++; continue; }
    const marker = bytes[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) };
    }
    i += 2 + bytes.readUInt16BE(i + 2);
  }
  throw new Error('screenshot is not a JPEG');
}
/** The agent's screenshot of a bound app, saved for analysis and the report. */
async function shot(app, name) {
  const text = await js(`const bytes = await ${app}.getScreenshot({ emit: false });
    await nodeRepl.write("E2E-B64:" + Buffer.from(bytes).toString("base64") + ":E2E-END");`, { timeout: 30000 });
  const bytes = Buffer.from(text.slice(text.indexOf('E2E-B64:') + 8, text.indexOf(':E2E-END')), 'base64');
  const path = join(evidence, `${name}.jpg`);
  writeFileSync(path, bytes);
  return { path, ...jpegSize(bytes) };
}
/** Bounding boxes [left, top, right, bottom, pixels] of solid colours in an image. */
function boxes(path, colours) {
  const code = `import json, sys
from PIL import Image
image = Image.open(sys.argv[1]).convert('RGB'); width, height = image.size; pixels = image.load()
found = {}
for name, (r, g, b) in json.loads(sys.argv[2]).items():
    xs, ys = [], []
    for y in range(height):
        for x in range(width):
            p = pixels[x, y]
            if abs(p[0] - r) < 48 and abs(p[1] - g) < 48 and abs(p[2] - b) < 48:
                xs.append(x); ys.append(y)
    found[name] = [min(xs), min(ys), max(xs), max(ys), len(xs)] if len(xs) >= 200 else None
print(json.dumps(found))`;
  return JSON.parse(execFileSync(join(root, '.venv/bin/python'), ['-c', code, path, JSON.stringify(colours)], { encoding: 'utf8' }));
}
const centre = (box) => [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];

// The user's own focused window (the isolation decoy) must never get our input.
const decoyPath = statePath('codex-e2e-shared');
const decoy = () => (existsSync(decoyPath) ? read(decoyPath) : null);
const decoyInput = (before) => {
  const now = decoy();
  if (!before || !now) return null;
  const keys = (d) => d.keys.filter((key) => key !== 'Shift_L');
  return now.text !== before.text || keys(now).length !== keys(before).length || now.clicks !== before.clicks
    ? `the user's window received input: ${JSON.stringify(now)}` : null;
};

export default function (test) {
  test('lifecycle: nested modal dialogs follow their parent anywhere, stay silent, and are driven in order', async () => {
    await js(replHelpers);
    await ensure('lifeDlg', 'codex-e2e-life-dialogs.desktop', { timeout: 30000 });
    await withTrees('nested', ['lifeDlg', 'lifeOuter', 'lifeInner'], async () => {
      const main = one('Codex E2E Life Dialogs');
      await js(`await lifeDlg.click(${find('lifeDlg', BUTTON, 'Open modal')});`);
      await until(() => Boolean(one('Codex E2E Life Outer')), 'outer dialog', 10000);
      const outer = one('Codex E2E Life Outer');
      background(outer);
      expect(outer.pid === main.pid, 'the outer dialog belongs to another process');
      // The user (or a rule) moves the dialog to another hidden workspace; the
      // dialog it opens must follow it there, not the app's launch workspace.
      dispatch(`hl.dsp.window.move({ workspace = "name:codex-e2e-aside", follow = false, window = "${address(outer)}" })`);
      await until(() => one('Codex E2E Life Outer')?.workspace.name === 'codex-e2e-aside', 'outer dialog moved aside');
      await js(`globalThis.lifeOuter = await lifeBind("Codex E2E Life Outer");
        await lifeOuter.setValue(${find('lifeOuter', ENTRY, 'Outer entry')}, "outer value");
        await lifeOuter.click(${find('lifeOuter', BUTTON, 'Open nested')});`);
      await until(() => Boolean(one('Codex E2E Life Inner')), 'inner dialog', 10000);
      background(one('Codex E2E Life Inner'), 'codex-e2e-aside');
      // Both dialogs and the main window are listed and observable while stacked.
      const listed = await data(`globalThis.lifeInner = await lifeBind("Codex E2E Life Inner");
        const all = (await cua.listWindows({ emit: false })).filter((w) => w.pid === ${main.pid}).map((w) => w.title).sort();
        const outerShot = await lifeOuter.getScreenshot({ emit: false });
        const mainShot = await lifeDlg.getScreenshot({ emit: false });
        ${write('{ all, outer: outerShot.length, main: mainShot.length }')}`);
      expect(JSON.stringify(listed.all) === JSON.stringify(['Codex E2E Life Dialogs', 'Codex E2E Life Inner', 'Codex E2E Life Outer']),
        `listWindows: ${JSON.stringify(listed.all)}`);
      expect(listed.outer > 1000 && listed.main > 1000, `screenshots under a modal dialog: ${JSON.stringify(listed)}`);
      await js(`await lifeInner.setValue(${find('lifeInner', ENTRY, 'Inner entry')}, "inner value");
        await lifeInner.click(${find('lifeInner', BUTTON, 'Inner OK')});`);
      await until(() => life('codex-e2e-life-dialogs').inner === 'inner value' && !one('Codex E2E Life Inner'), 'inner dialog result');
      // The outer dialog shows the nested result; the closed inner one gives a clear error.
      const outerTree = await data(`await lifeWait(async () => (await lifeOuter.getAXState({ emit: false, disableDiffing: true }))
          .includes("Outer status: inner value") || "outer status not updated", "outer status");
        let stale = null; try { await lifeInner.setValue(0, "stale"); } catch (e) { stale = e.message; }
        ${write('{ stale }')}`);
      expect(/unavailable|reused/i.test(outerTree.stale ?? ''), `stale inner binding: ${outerTree.stale}`);
      await js(`await lifeOuter.click(${find('lifeOuter', BUTTON, 'Outer OK')});`);
      await until(() => life('codex-e2e-life-dialogs').outer === 'outer value|inner value' && !one('Codex E2E Life Outer'),
        'outer dialog result');
      // The main window is usable again and never left its workspace.
      await js(`await lifeDlg.setValue(${find('lifeDlg', ENTRY, 'Main entry')}, "after dialogs");`);
      await until(() => life('codex-e2e-life-dialogs').main === 'after dialogs', 'main window after the dialogs');
      background(one('Codex E2E Life Dialogs'));
    }, ['Codex E2E Life Inner', 'Codex E2E Life Outer']);
  }, { needs: luaOnly });

  test('lifecycle: file chooser — type a path, pick files in a long list, create a folder and save into it', async () => {
    await js(replHelpers);
    await ensure('lifeDlg', 'codex-e2e-life-dialogs.desktop', { timeout: 30000 });
    await withTrees('chooser', ['lifeOpen', 'lifeSave'], async () => {
      await js(`await lifeDlg.click(${find('lifeDlg', BUTTON, 'Open file')});`);
      await until(() => Boolean(one('Codex E2E Life Open File')), 'open dialog', 10000);
      background(one('Codex E2E Life Open File'));
      const openId = parseInt(one('Codex E2E Life Open File').address, 16);
      // Type the folder's path, as a user does (Ctrl+L, path, Enter), and wait for its files.
      const cell = (name) => JSON.stringify(el('table cell', name));
      await js(`globalThis.lifeOpen = await lifeBind("Codex E2E Life Open File");
        await lifeOpen.pressKey("ctrl+l");
        await lifeOpen.typeText(${JSON.stringify(`${pick}/`)});`);
      const typed = await data(write('await lifeOpen.getAXState({ emit: false, disableDiffing: true })'));
      writeFileSync(join(evidence, 'chooser-typed.txt'), typed);
      await shot('lifeOpen', 'chooser-typed');
      await js(`await lifeOpen.pressKey("Return");`);
      await shot('lifeOpen', 'chooser-return');
      await js(`await lifeWait(async () => lifeIds(await lifeOpen.getAXState({ emit: false, disableDiffing: true }), ${cell('file-03.txt')}).length > 0
          || "file-03.txt not listed", "typed folder opened", 15000);`, { timeout: 40000 });
      // Files selected in the list (the chooser may preselect one on entering the folder).
      const picked = () => (life('codex-e2e-life-dialogs').opened_selected ?? []).filter((f) => f.startsWith(`${pick}/`));
      const baseline = picked().length;
      // A visible row: the click selects exactly that file.
      await js(`await lifeOpen.click(await lifeLast(lifeOpen, ${cell('file-03.txt')}));`);
      await until(() => picked().at(-1) === join(pick, 'file-03.txt'), 'file-03.txt selected');
      // A row out of view: clicking it must select it or fail clearly, never
      // select another file or press something else at that point.
      const direct = await data(`let error = null;
        try { await lifeOpen.click(await lifeLast(lifeOpen, ${cell('target-beta.txt')})); } catch (e) { error = e.message; }
        ${write('{ error }')}`);
      if (direct.error) {
        expect(/outside|bounds|visible|view|scroll/i.test(direct.error), `unclear error for an out-of-view row: ${direct.error}`);
        // Then scroll the list as a user would until the row is in view, and pick it.
        await js(`const table = await lifeOne(lifeOpen, ${JSON.stringify(el('(?:tree )?table', 'Files'))});
          await lifeWait(async () => {
            const row = await lifeLast(lifeOpen, ${cell('target-beta.txt')});
            try { await lifeOpen.click(row); return true; } catch (e) {
              if (!/outside|bounds|visible|view|scroll/i.test(e.message)) throw e;
              await lifeOpen.scroll(table, "down", 1);
              return e.message;
            }
          }, "scrolled to target-beta.txt", 20000);`, { timeout: 40000 });
      }
      await until(() => picked().at(-1) === join(pick, 'target-beta.txt'), 'target-beta.txt selected');
      const path = picked().slice(baseline);
      expect(JSON.stringify(path) === JSON.stringify([join(pick, 'file-03.txt'), join(pick, 'target-beta.txt')]),
        `the agent's clicks selected: ${JSON.stringify(path)}`);
      expect(life('codex-e2e-life-dialogs').opened === undefined, 'a file was opened before the agent pressed Open');
      await js(`await lifeOpen.click(${find('lifeOpen', BUTTON, 'Open')});`);
      await until(() => life('codex-e2e-life-dialogs').opened === join(pick, 'target-beta.txt'), 'the picked file was opened');
      await until(() => !one('Codex E2E Life Open File'), 'open dialog closed');

      // Save: create a folder from inside the chooser, then save into it.
      await js(`await lifeDlg.click(${find('lifeDlg', BUTTON, 'Save file')});`);
      await until(() => Boolean(one('Codex E2E Life Save File')), 'save dialog', 10000);
      background(one('Codex E2E Life Save File'));
      // The closed Open dialog's binding must not reach the Save dialog, even
      // when Hyprland gives the new dialog the closed one's address (window ID),
      // as it often does for a window of the same app.
      const reused = parseInt(one('Codex E2E Life Save File').address, 16) === openId;
      const stale = await data(`let error = null; try { await lifeOpen.pressKey("Escape"); } catch (e) { error = e.message; }
        ${write('{ error }')}`);
      expect(/unavailable|reused/i.test(stale.error ?? ''), `stale Open dialog binding (address reused: ${reused}): ${stale.error}`);
      expect(one('Codex E2E Life Save File') && !life('codex-e2e-life-dialogs').events.some((e) => e[0] === 'saved-closed'),
        `Escape sent to the closed Open dialog closed the Save dialog (address reused: ${reused})`);
      // The folder name field appears in a popover (focused, and a new text
      // element in the tree): type the name and press Enter.
      const created = await data(`globalThis.lifeSave = await lifeBind("Codex E2E Life Save File");
        const fields = (tree) => lifeIds(tree, ${JSON.stringify(`^(?:${ENTRY}) \\([^)]*settable[^)]*\\)`)});
        const before = fields(await lifeSave.getAXState({ emit: false, disableDiffing: true }));
        const createFolder = ${find('lifeSave', 'toggle button|(?:push )?button', 'Create Folder')};
        await lifeSave.click(createFolder);
        const clicked = await lifeSave.getAXState({ emit: false, disableDiffing: true });
        let added = [];
        const opened = () => lifeWait(async () => {
          added = fields(await lifeSave.getAXState({ emit: false, disableDiffing: true })).filter((id) => !before.includes(id));
          return added.length === 1 || "no new folder name field";
        }, "folder name field in the tree", 3000).then(() => true, () => false);
        const byAction = await opened();
        // Diagnostic: the same button pressed by the pointer instead.
        let byPointer = null;
        if (!byAction) {
          const w = (await cua.listWindows({ emit: false })).find((w) => w.title === "Codex E2E Life Save File");
          await cua.computer.click({ window: w, element_id: String(createFolder), duration: 30 });
          byPointer = await opened();
        }
        if (added.length === 1) await lifeSave.click(added[0]);
        await lifeSave.typeText("made-by-agent");
        await lifeSave.pressKey("Return");
        const tree = added.length === 1 ? null
          : \`\${clicked}\n\n5 s later:\n\${await lifeSave.getAXState({ emit: false, disableDiffing: true })}\`;
        ${write('{ field: byAction, byPointer, tree }')}`, { timeout: 40000 });
      if (created.tree) {
        writeFileSync(join(evidence, 'chooser-create-folder.txt'), created.tree);
        await shot('lifeSave', 'chooser-create-folder');
      }
      expect(created.field, `clicking Create Folder did not show its popover's name field (by the pointer: ${created.byPointer})`);
      await until(() => existsSync(join(saveIn, 'made-by-agent')), 'folder created on disk', 10000);
      await js(`await lifeWait(async () => (await lifeSave.getAXState({ emit: false, disableDiffing: true })).includes("made-by-agent")
          || "the new folder is not shown", "chooser shows the new folder");
        await lifeSave.setValue(${find('lifeSave', ENTRY, 'Name')}, "agent-note.txt");
        await lifeSave.click(${find('lifeSave', BUTTON, 'Save')});`, { timeout: 30000 });
      const saved = join(saveIn, 'made-by-agent', 'agent-note.txt');
      await until(() => life('codex-e2e-life-dialogs').saved === saved && existsSync(saved), 'saved inside the new folder', 10000);
      expect(readdirSync(saveIn).join() === 'made-by-agent', `unexpected entries: ${readdirSync(saveIn)}`);
      await until(() => !one('Codex E2E Life Save File'), 'save dialog closed');
    }, ['Codex E2E Life Open File', 'Codex E2E Life Save File']);
  });

  test('lifecycle: identical extra toplevels of one app are each addressed exactly, and one closing leaves the other bound', async () => {
    await js(replHelpers);
    await ensure('lifeDlg', 'codex-e2e-life-dialogs.desktop', { timeout: 30000 });
    await withTrees('extras', ['lifeDlg', 'lifeQuick'], async () => {
      const pid = one('Codex E2E Life Dialogs').pid;
      await js(`const button = ${find('lifeDlg', BUTTON, 'New window')};
        await lifeDlg.click(button); await lifeDlg.click(button);`);
      const extras = () => windows('Codex E2E Life Extra');
      await until(() => extras().length === 2, 'two extra windows', 10000);
      for (const c of extras()) { background(c); expect(c.pid === pid, 'an extra window belongs to another process'); }
      // Then a window that closes when it loses keyboard focus takes the app's focus.
      await js(`await lifeDlg.click(${find('lifeDlg', BUTTON, 'Quick search')});`);
      await until(() => Boolean(one('Codex E2E Life Quick')), 'quick window', 10000);
      await js(`globalThis.lifeQuick = await lifeBind("Codex E2E Life Quick");
        const q = ${find('lifeQuick', ENTRY, 'Quick entry')}; await lifeQuick.click(q); await lifeQuick.typeText("kept open");`);
      await until(() => life('codex-e2e-life-dialogs').quick.focused, 'quick window focused within its app');
      // Same process, same title, same size: only the window ID tells them apart.
      const ids = await data(`const ws = (await cua.listWindows({ emit: false })).filter((w) => w.title === "Codex E2E Life Extra");
        globalThis.lifeExtras = {};
        for (const w of ws) {
          const bound = lifeExtras[w.id] = await cua.getApp({ windowId: w.id });
          await bound.setValue(${find('bound', ENTRY, 'Extra entry')}, "extra " + w.id);
        }
        ${write('ws.map((w) => w.id)')}`);
      const texts = () => Object.values(life('codex-e2e-life-dialogs').extras).filter((e) => e.open).map((e) => e.text).sort();
      await until(() => JSON.stringify(texts()) === JSON.stringify(ids.map((id) => `extra ${id}`).sort()), 'each extra got its own text');
      // Telling identical windows apart takes the app's keyboard focus for a
      // moment (see the known-limitation test below), so the focus-sensitive
      // window may close meanwhile: observing must cope with a window of the
      // app vanishing mid-identification (it once failed with a raw AT-SPI
      // "Process is defunct" error).
      const quick = life('codex-e2e-life-dialogs').quick;
      expect(quick.open || quick.closed_by === 'focus-out', `quick window: ${JSON.stringify(quick)}`);
      if (quick.open) {
        // Untouched otherwise, it submits normally (clicking a button in
        // another of its windows, next, would move its focus).
        await js(`await lifeQuick.typeText(" too"); await lifeQuick.pressKey("Return");`);
        await until(() => life('codex-e2e-life-dialogs').quick.closed_by === 'enter', 'quick window submitted');
        expect(life('codex-e2e-life-dialogs').quick.value === 'kept open too', JSON.stringify(life('codex-e2e-life-dialogs').quick));
      }
      // Close the first through its own button; exactly that window goes.
      const [first, second] = ids;
      await js(`await lifeExtras[${first}].click(${find(`lifeExtras[${first}]`, BUTTON, 'Close extra')});`);
      await until(() => !clients().some((c) => parseInt(c.address, 16) === first), 'the addressed window closed');
      expect(clients().some((c) => parseInt(c.address, 16) === second), 'the other extra window closed too');
      const closed = Object.values(life('codex-e2e-life-dialogs').extras).filter((e) => !e.open).map((e) => e.text);
      expect(closed.includes(`extra ${first}`) && !closed.includes(`extra ${second}`), `wrong window closed: ${JSON.stringify(closed)}`);
      const stale = await data(`let error = null; try { await lifeExtras[${first}].typeText("stale"); } catch (e) { error = e.message; }
        await lifeExtras[${second}].setValue(${find(`lifeExtras[${second}]`, ENTRY, 'Extra entry')}, "still bound");
        ${write('{ error }')}`);
      expect(/unavailable|reused/i.test(stale.error ?? ''), `stale extra binding: ${stale.error}`);
      await until(() => JSON.stringify(texts()) === '["still bound"]', 'the remaining window is still driven');
      await js(`await lifeExtras[${second}].click(${find(`lifeExtras[${second}]`, BUTTON, 'Close extra')});`);
      await until(() => extras().length === 0, 'extra windows closed');
    }, ['Codex E2E Life Extra', 'Codex E2E Life Quick']);
  });

  test('lifecycle (known limitation): telling identical windows apart leaves the app\'s focused window alone', async () => {
    await js(replHelpers);
    await ensure('lifeDlg', 'codex-e2e-life-dialogs.desktop', { timeout: 30000 });
    await withTrees('probe', ['lifeDlg', 'lifeQuick'], async () => {
      await js(`const button = ${find('lifeDlg', BUTTON, 'New window')}; await lifeDlg.click(button); await lifeDlg.click(button);
        await lifeDlg.click(${find('lifeDlg', BUTTON, 'Quick search')});`);
      await until(() => windows('Codex E2E Life Extra').length === 2 && Boolean(one('Codex E2E Life Quick')), 'windows', 10000);
      await js(`globalThis.lifeQuick = await lifeBind("Codex E2E Life Quick");
        await lifeQuick.click(${find('lifeQuick', ENTRY, 'Quick entry')});`);
      await until(() => life('codex-e2e-life-dialogs').quick.focused, 'quick window focused');
      await js(`for (const w of (await cua.listWindows({ emit: false })).filter((w) => w.title === "Codex E2E Life Extra")) {
        const bound = await cua.getApp({ windowId: w.id }); await bound.getAXState({ emit: false }); }`);
      expect(life('codex-e2e-life-dialogs').quick.open, `observing other windows closed the quick window: ${
        JSON.stringify(life('codex-e2e-life-dialogs').quick)}`);
    }, ['Codex E2E Life Extra', 'Codex E2E Life Quick']);
    await closeLeftovers(['Codex E2E Life Extra', 'Codex E2E Life Quick']);
  }, { needs: 'known limitation: identical windows of one process (same title and size) are told apart by a brief '
    + 'keyboard-focus probe (accessibility.py root()); the app sees its focused window lose focus, so a window that '
    + 'closes on focus loss closes when the agent merely observes its twins' });

  test('lifecycle: a focus-dismissed window survives background work and closes only on genuine focus loss', async () => {
    await js(replHelpers);
    await ensure('lifeDlg', 'codex-e2e-life-dialogs.desktop', { timeout: 30000 });
    await ensure('lifeLayout', 'codex-e2e-life-layout.desktop', { timeout: 30000 });
    await withTrees('quick', ['lifeDlg', 'lifeQuick'], async () => {
      const quick = () => life('codex-e2e-life-dialogs').quick;
      await js(`await lifeDlg.click(${find('lifeDlg', BUTTON, 'Quick search')});`);
      await until(() => Boolean(one('Codex E2E Life Quick')) && quick()?.open && quick().closed_by === null, 'quick window', 10000);
      background(one('Codex E2E Life Quick'));
      await js(`globalThis.lifeQuick = await lifeBind("Codex E2E Life Quick");
        const q = ${find('lifeQuick', ENTRY, 'Quick entry')}; await lifeQuick.click(q); await lifeQuick.typeText("first");
        await lifeQuick.getScreenshot({ emit: false });`);
      await until(() => quick().focused, 'quick window received focus');
      // Observing its parent, working in another app, and the user typing in
      // their own window are no focus change for this app.
      await js(`await lifeDlg.getAXStateAndScreenshot({ emit: false });
        await lifeLayout.setValue(${find('lifeLayout', ENTRY, 'Target field')}, "other app");
        await lifeLayout.click(${find('lifeLayout', BUTTON, 'Corner TL')});`);
      if (strict && which('wtype')) execFileSync('wtype', ['-k', 'Shift_L']);
      await until(() => life('codex-e2e-life-layout').clicks['Corner TL'] >= 1, 'other app clicked');
      expect(quick().open && one('Codex E2E Life Quick'), `the quick window closed without losing focus: ${JSON.stringify(quick())}`);
      await js(`await lifeQuick.typeText(" second"); await lifeQuick.pressKey("Return");`);
      await until(() => quick().closed_by === 'enter' && quick().value === 'first second', 'typed across calls and submitted');
      // Clicking into the parent window moves the app's focus: like on a real
      // desktop, the quick window then closes itself.
      await js(`await lifeDlg.click(${find('lifeDlg', BUTTON, 'Quick search')});`);
      await until(() => quick().open && quick().closed_by === null && Boolean(one('Codex E2E Life Quick')), 'quick window again', 10000);
      await js(`globalThis.lifeQuick = await lifeBind("Codex E2E Life Quick");
        await lifeQuick.click(${find('lifeQuick', ENTRY, 'Quick entry')});`);
      await until(() => quick().focused, 'quick window focused again');
      await js(`await lifeDlg.click(${find('lifeDlg', ENTRY, 'Main entry')});`);
      await until(() => quick().closed_by === 'focus-out' && !one('Codex E2E Life Quick'), 'closed by the focus change');
    }, ['Codex E2E Life Quick']);
  });

  test('lifecycle: an app crashing mid-task gives clear errors, misdirects nothing, and getApp relaunches it', async () => {
    await js(replHelpers);
    const crashState = (pid) => read(join(out, `life-crash-${pid}.json`));
    const before = decoy();
    await bind('lifeCrash', 'codex-e2e-life-crash.desktop', { timeout: 30000 });
    await withTrees('crash', ['lifeCrash'], async () => {
      const first = client('codex-e2e-life-crash');
      // The app dies while handling the agent's input.
      await js(`globalThis.lifeCrashEntry = ${find('lifeCrash', ENTRY, 'Main entry')};
        globalThis.lifeCrashButton = ${find('lifeCrash', BUTTON, 'New window')};
        try { await lifeCrash.setValue(lifeCrashEntry, "crash now"); } catch {}`);
      await until(() => !clients().some((c) => c.pid === first.pid), 'crashed window gone', 10000);
      // The agent carries on with its stale binding: every call fails clearly.
      const errors = await data(`const errors = {};
        const calls = {
          typeText: () => lifeCrash.typeText("misdirected"),
          pressKey: () => lifeCrash.pressKey("ctrl+a"),
          clickElement: () => lifeCrash.click(lifeCrashButton),
          clickPoint: () => lifeCrash.click([60, 60]),
          scroll: () => lifeCrash.scroll([60, 60], "down", 1),
          setValue: () => lifeCrash.setValue(lifeCrashEntry, "misdirected"),
          paste: () => lifeCrash.paste("misdirected paste"),
          getAXState: () => lifeCrash.getAXState({ emit: false }),
          getScreenshot: () => lifeCrash.getScreenshot({ emit: false }),
        };
        for (const [name, call] of Object.entries(calls)) {
          try { await call(); errors[name] = null; } catch (e) { errors[name] = e.message; }
        }
        ${write('errors')}`);
      for (const [name, error] of Object.entries(errors)) {
        expect(error !== null, `${name} on a crashed window reported success`);
        expect(/Window \d+ is unavailable|reused/i.test(error), `${name}: unclear error: ${error}`);
      }
      const misdirected = decoyInput(before);
      expect(!misdirected, misdirected);
      // getApp starts it again: a new process and window, silently, and usable.
      await js(`globalThis.lifeCrash2 = await cua.getApp("codex-e2e-life-crash.desktop");`, { timeout: 30000 });
      const second = client('codex-e2e-life-crash');
      expect(second && second.pid !== first.pid, 'no new process was started');
      background(second);
      await js(`await lifeCrash2.setValue(${find('lifeCrash2', ENTRY, 'Main entry')}, "after relaunch");`);
      await until(() => crashState(second.pid).main === 'after relaunch', 'relaunched app driven');
      // The old binding never reaches the new window, even if Hyprland reused its address.
      const stale = await data(`let error = null; try { await lifeCrash.typeText("stale binding"); } catch (e) { error = e.message; }
        ${write('{ error }')}`);
      expect(/unavailable|reused/i.test(stale.error ?? ''), `stale binding after relaunch: ${stale.error}`);
      await js(`await lifeCrash2.getAXState({ emit: false });`);
      expect(crashState(second.pid).main === 'after relaunch', `the new window received stale input: ${crashState(second.pid).main}`);
      const asked = provider.elicitations.filter((e) => e._meta?.tool_params?.app === 'codex-e2e-life-crash.desktop').length;
      expect(asked <= 1, `approval was asked ${asked} times for the relaunched app`);
    });
  });

  test('lifecycle: an app the user already runs is reused, and its dialog does not take focus or the user\'s workspace', async () => {
    await js(replHelpers);
    // Started by the user, not the agent, on a background workspace of theirs.
    const command = readFileSync(join(out, 'applications', 'codex-e2e-life-running.desktop'), 'utf8').match(/^Exec=(.*)$/m)[1];
    hyprctl('dispatch', `hl.dsp.exec_cmd(${JSON.stringify(`[workspace name:codex-e2e-user silent; no_initial_focus on] ${command}`)})`);
    await until(() => Boolean(client('codex-e2e-life-running')), 'user-started window', 15000);
    const running = client('codex-e2e-life-running');
    expect(running.workspace.name === 'codex-e2e-user', `started on ${running.workspace.name}`);
    const userWorkspace = hypr('activeworkspace').name;
    await withTrees('running', ['lifeRunning', 'lifeRunningOuter'], async () => {
      await js(`globalThis.lifeRunning = await cua.getApp("Codex E2E Life Running");`, { timeout: 30000 });
      await js(`await lifeRunning.setValue(${find('lifeRunning', ENTRY, 'Main entry')}, "reused");`);
      await until(() => life('codex-e2e-life-running').main === 'reused', 'the running window was driven');
      expect(life('codex-e2e-life-running').pid === running.pid, 'a second instance was launched');
      expect(clients().filter((c) => c.class === 'codex-e2e-life-running').length === 1, 'a second window was opened');
      // Its dialog: macOS opens it with the app in the background; it must not
      // land on the user's workspace or take their focus.
      await js(`await lifeRunning.click(${find('lifeRunning', BUTTON, 'Open modal')});`);
      await until(() => Boolean(one('Codex E2E Life Outer') && one('Codex E2E Life Outer').pid === running.pid), 'dialog of the running app', 10000);
      const dialog = clients().find((c) => c.title === 'Codex E2E Life Outer' && c.pid === running.pid);
      expect(hypr('activewindow').address !== dialog.address, 'the dialog took focus');
      expect(dialog.workspace.name === running.workspace.name,
        `the dialog opened on workspace ${dialog.workspace.name} (the user's is ${userWorkspace}), not beside its window`);
      await js(`globalThis.lifeRunningOuter = await cua.getApp({ windowId: ${parseInt(dialog.address, 16)} });
        await lifeRunningOuter.setValue(${find('lifeRunningOuter', ENTRY, 'Outer entry')}, "from a running app");
        await lifeRunningOuter.click(${find('lifeRunningOuter', BUTTON, 'Outer OK')});`);
      await until(() => life('codex-e2e-life-running').outer === 'from a running app|None', 'dialog result');
      expect(client('codex-e2e-life-running').workspace.name === 'codex-e2e-user', 'the running window was moved');
    }, ['Codex E2E Life Outer']);
  }, { needs: luaOnly });

  test('lifecycle: tooltips and both kinds of GTK popover on a hidden window are captured and usable', async () => {
    await js(replHelpers);
    await ensure('lifeTargets', 'codex-e2e-life-targets.desktop', { timeout: 30000 });
    await withTrees('popovers', ['lifeTargets'], async () => {
      await checkTooltip('lifeTargets', 'Codex E2E Life Targets', 'tooltip');
      for (const kind of ['Inline', 'Detached']) {
        const closedBefore = () => life('codex-e2e-life-targets').events.filter((e) => e[0] === 'popover-closed' && e[1] === kind).length;
        const closings = closedBefore();
        const opened = await data(`const opener = ${find('lifeTargets', 'toggle button|(?:push )?button', `${kind} popover`)};
          const closed = await lifeTargets.getScreenshot({ emit: false });
          await lifeTargets.getAXState({ emit: false });
          await lifeTargets.click(opener);
          const added = await lifeTargets.getAXState({ emit: false });
          const open = await lifeTargets.getScreenshot({ emit: false });
          ${write('{ added, changed: Buffer.compare(Buffer.from(closed), Buffer.from(open)) !== 0 }')}`);
        await shot('lifeTargets', `popover-${kind}`);
        // Click into its entry (a pointer click at the element) and type, as a user would.
        const result = await data(`await lifeTargets.click(${find('lifeTargets', ENTRY, `${kind} popover entry`)});
          await lifeTargets.typeText("${kind.toLowerCase()} text");
          await lifeTargets.click(${find('lifeTargets', BUTTON, `${kind} popover action`)});
          await lifeTargets.pressKey("Escape");
          const gone = await lifeTargets.getAXState({ emit: false });
          ${write('{ gone }')}`);
        Object.assign(result, opened);
        const state = life('codex-e2e-life-targets');
        expect(result.changed, `${kind}: the screenshot did not show the popover`);
        expect(closedBefore() === closings + 1, `${kind}: the popover closed ${closedBefore() - closings} times (clicking into it closed it?)`);
        expect(result.added.split('\n').some((l) => l.startsWith('+\t') && l.includes(`${kind} popover entry`)),
          `${kind}: popover contents were not added to the tree:\n${result.added}`);
        expect(state[`${kind.toLowerCase()}_popover_text`] === `${kind.toLowerCase()} text`, `${kind}: popover entry: ${JSON.stringify(state)}`);
        expect(state.clicks[`${kind} popover action`] === 1, `${kind}: popover action: ${JSON.stringify(state.clicks)}`);
        await until(() => life('codex-e2e-life-targets').events.some((e) => e[0] === 'popover-closed' && e[1] === kind), `${kind} popover closed`);
        expect(!result.gone.includes(`${kind} popover entry`) || result.gone.includes('Removed element IDs'),
          `${kind}: the closed popover is still in the tree:\n${result.gone}`);
      }
    });
  });

  test('lifecycle: windows resized far beyond the monitor and to a sliver keep exact screenshots and input', async () => {
    await js(replHelpers);
    await ensure('lifeLayout', 'codex-e2e-life-layout.desktop', { timeout: 30000 });
    const c = () => one('Codex E2E Life Layout');
    const original = c().size;
    const earlier = (life('codex-e2e-life-layout').presses ?? []).length;
    const presses = () => (life('codex-e2e-life-layout').presses ?? []).slice(earlier);
    await withTrees('resize', ['lifeLayout'], async () => {
      try {
        const monitor = monitorOf(c());
        const huge = [Math.round(monitor.width / monitor.scale) + 600, Math.round(monitor.height / monitor.scale) + 400];
        dispatch(`hl.dsp.window.resize({ x = ${huge[0]}, y = ${huge[1]}, window = "${address(c())}" })`);
        await until(() => c().size[0] === huge[0] && c().size[1] === huge[1], `resized to ${huge}`);
        let image = await shot('lifeLayout', 'resize-huge');
        expect(image.width === huge[0] && image.height === huge[1], `huge screenshot is ${image.width}x${image.height}, window ${huge}`);
        // The bottom-right corner lies beyond the monitor; a click there reaches it exactly.
        const point = [image.width - 12, image.height - 9];
        await js(`await lifeLayout.click(${JSON.stringify(point)}); await lifeLayout.getAXState({ emit: false });`);
        await until(() => presses().length === 1, 'corner pressed beyond the monitor edge');
        const far = presses()[0];
        expect(far.target === 'Corner BR' && Math.abs(far.x - (point[0] - (image.width - far.width))) <= 3
          && Math.abs(far.y - (point[1] - (image.height - far.height))) <= 3, `press landed at ${JSON.stringify(far)}`);
        // Shrunk to a sliver between screenshot and click: the old point is refused.
        const tiny = [240, 170];
        dispatch(`hl.dsp.window.resize({ x = ${tiny[0]}, y = ${tiny[1]}, window = "${address(c())}" })`);
        await until(() => c().size[0] === tiny[0] && c().size[1] === tiny[1], `resized to ${tiny}`);
        const refused = await data(`let error = null; try { await lifeLayout.click(${JSON.stringify(point)}); } catch (e) { error = e.message; }
          ${write('{ error }')}`);
        expect(/outside/i.test(refused.error ?? ''), `a click outside the shrunken window: ${refused.error}`);
        expect(presses().length === 1 && life('codex-e2e-life-layout').clicks.Danger === 0, `stale click landed: ${JSON.stringify(presses())}`);
        image = await shot('lifeLayout', 'resize-tiny');
        expect(image.width === tiny[0] && image.height === tiny[1], `tiny screenshot is ${image.width}x${image.height}`);
        const near = [image.width - 6, image.height - 5];
        await js(`await lifeLayout.click(${JSON.stringify(near)}); await lifeLayout.getAXState({ emit: false });`);
        await until(() => presses().length === 2, 'corner pressed in the sliver');
        const small = presses()[1];
        expect(small.target === 'Corner BR' && Math.abs(small.x - (near[0] - (image.width - small.width))) <= 3
          && Math.abs(small.y - (near[1] - (image.height - small.height))) <= 3, `press landed at ${JSON.stringify(small)}`);
        background(c());
      } finally {
        dispatch(`hl.dsp.window.resize({ x = ${original[0]}, y = ${original[1]}, window = "${address(c())}" })`);
      }
    });
  }, { needs: luaOnly });

  test('lifecycle: content that moves or is replaced between observation and action is never misclicked', async () => {
    await js(replHelpers);
    await ensure('lifeLayout', 'codex-e2e-life-layout.desktop', { timeout: 30000 });
    const pid = one('Codex E2E Life Layout').pid;
    await withTrees('moved', ['lifeLayout'], async () => {
      await js(`globalThis.lifeTarget = ${find('lifeLayout', ENTRY, 'Target field')};
        globalThis.lifeReplace = ${find('lifeLayout', BUTTON, 'Replace me')};
        await lifeLayout.setValue(lifeTarget, ""); await lifeLayout.getScreenshot({ emit: false });`);
      // The app inserts a banner on its own: the field moves down, and a
      // Danger button now sits where the field was when the agent looked.
      process.kill(pid, 'SIGUSR1');
      await until(() => life('codex-e2e-life-layout').shifted, 'layout shifted');
      await js(`await lifeLayout.click(lifeTarget); await lifeLayout.typeText("typed after the shift");
        await lifeLayout.getAXState({ emit: false });`);
      await until(() => life('codex-e2e-life-layout').target === 'typed after the shift', 'the moved field received the text');
      expect(life('codex-e2e-life-layout').clicks.Danger === 0, 'the click hit what replaced the field at its old position');
      // The app replaces a button with an identical new one: the old ID is stale.
      process.kill(pid, 'SIGUSR2');
      await until(() => life('codex-e2e-life-layout').replaced, 'button replaced');
      const stale = await data(`let error = null; try { await lifeLayout.click(lifeReplace); } catch (e) { error = e.message; }
        ${write('{ error }')}`);
      expect(/changed|stale|refresh|no longer/i.test(stale.error ?? ''), `click on a replaced element: ${stale.error}`);
      const { clicks } = life('codex-e2e-life-layout');
      expect(clicks['Replace me'] === 0 && clicks['Replace me (new)'] === 0 && clicks.Danger === 0, `misclick: ${JSON.stringify(clicks)}`);
      await js(`await lifeLayout.click(${find('lifeLayout', BUTTON, 'Replace me')}); await lifeLayout.getAXState({ emit: false });`);
      await until(() => life('codex-e2e-life-layout').clicks['Replace me (new)'] === 1, 'the refreshed element works');
    });
  });

  test('lifecycle: screenshots, coordinates and popups stay exact at a fractional output scale (Wayland and XWayland)', async () => {
    await js(replHelpers);
    await ensure('lifeTargets', 'codex-e2e-life-targets.desktop', { timeout: 30000 });
    await ensure('lifeXTargets', 'codex-e2e-life-xtargets.desktop', { timeout: 30000 });
    expect(client('codex-e2e-life-xtargets').xwayland, 'the X targets fixture is not running under XWayland');
    const monitor = monitorOf(one('Codex E2E Life Targets'));
    const cursor = hypr('cursorpos');
    await withTrees('scale', ['lifeTargets', 'lifeXTargets'], async () => {
      try {
        hyprctl('eval', `hl.monitor({ output = "${monitor.name}", mode = "preferred", position = "auto", scale = "1.5" })`);
        await until(() => Math.abs(hypr('monitors').find((m) => m.name === monitor.name).scale - 1.5) < 0.01, 'output scale 1.5');
        const before = seat();
        for (const [name, title] of [['lifeTargets', 'Codex E2E Life Targets'], ['lifeXTargets', 'Codex E2E Life XTargets']]) {
          await checkTargets(name, title, `scaled-${name}`);
          if (client(stateId(name)).xwayland) await keepUserCursorOutside(name, title, hypr('monitors').find((m) => m.name === monitor.name));
          await checkTooltip(name, title, `scaled-tooltip-${name}`);
        }
        expect(seat() === before, `desktop changed at scale 1.5: ${before} -> ${seat()}`);
      } finally {
        hyprctl('eval', `hl.monitor({ output = "${monitor.name}", mode = "preferred", position = "auto", scale = "${monitor.scale}" })`);
        await until(() => hypr('monitors').find((m) => m.name === monitor.name).scale === monitor.scale, 'output scale restored');
        // Rescaling the output may move the pointer; put it back (input above was checked at scale).
        const now = hypr('cursorpos');
        if (now.x !== cursor.x || now.y !== cursor.y) dispatch(`hl.dsp.cursor.move({ x = ${cursor.x}, y = ${cursor.y} })`);
      }
    });
  }, { needs: strict ? luaOnly : 'VM only (changes the output scale)' });

  test('lifecycle: an XWayland app and its nested dialogs on a hidden workspace of a second monitor', async () => {
    await js(replHelpers);
    // The agent's workspace lives on another monitor, right of the user's.
    await ensure('lifeTargets', 'codex-e2e-life-targets.desktop', { timeout: 30000 });
    const home = monitorOf(one('Codex E2E Life Targets'));
    const name = 'codex-e2e-out';
    const extra = () => hypr('monitors').find((m) => m.name === name);
    const start = seat();
    const log = [];
    await withTrees('monitor', ['lifeXDlg', 'lifeXOuter', 'lifeXInner'], async () => {
      let before = start;
      try {
        hyprctl('eval', `hl.monitor({ output = "${name}", mode = "1600x900", position = "${home.x + Math.round(home.width / home.scale)}x${home.y}", scale = "1" })`);
        hyprctl('output', 'create', 'headless', name);
        await until(() => Boolean(extra()), 'headless output', 10000);
        dispatch(`hl.dsp.workspace.move({ monitor = "${name}", workspace = "name:codex" })`);
        await until(() => hypr('workspaces').find((w) => w.name === 'codex')?.monitor === name, 'codex workspace moved');
        // Hyprland focuses a new output (and warps the pointer there) itself;
        // from here on the provider must change nothing.
        before = seat();
        log.push(`output added: ${start} -> ${before}`);
        await bind('lifeXDlg', 'codex-e2e-life-xdialogs.desktop', { timeout: 30000 });
        const main = one('Codex E2E Life XDialogs');
        expect(main.xwayland, 'not an XWayland window');
        background(main);
        expect(main.monitor === extra().id && inside(main, extra()), `main window not on the second monitor: ${JSON.stringify(main.at)}`);
        await js(`const entry = ${find('lifeXDlg', ENTRY, 'Main entry')};
          await lifeXDlg.click(entry); await lifeXDlg.typeText("typed on the second monitor");
          await lifeXDlg.click(${find('lifeXDlg', BUTTON, 'Open modal')});`);
        await until(() => life('codex-e2e-life-xdialogs').main === 'typed on the second monitor', 'X11 typing');
        await until(() => Boolean(one('Codex E2E Life Outer') && one('Codex E2E Life Outer').xwayland), 'X11 outer dialog', 10000);
        // X11 windows ask for X positions that Hyprland maps to the first
        // monitor; the dialog must still end up beside its parent, capturable.
        const placed = () => { const d = clients().find((c) => c.title === 'Codex E2E Life Outer' && c.xwayland); return d && inside(d, extra()) || JSON.stringify(d?.at); };
        await until(placed, 'X11 dialog on its workspace\'s monitor');
        background(clients().find((c) => c.title === 'Codex E2E Life Outer' && c.xwayland));
        const sizes = await data(`globalThis.lifeXOuter = await lifeBind("Codex E2E Life Outer");
          const shotOuter = await lifeXOuter.getScreenshot({ emit: false });
          await lifeXOuter.click(${find('lifeXOuter', ENTRY, 'Outer entry')});
          await lifeXOuter.typeText("x outer");
          await lifeXOuter.click(${find('lifeXOuter', BUTTON, 'Open nested')});
          globalThis.lifeXInner = await lifeBind("Codex E2E Life Inner");
          const shotInner = await lifeXInner.getScreenshot({ emit: false });
          await lifeXInner.click(${find('lifeXInner', ENTRY, 'Inner entry')});
          await lifeXInner.typeText("x inner");
          await lifeXInner.click(${find('lifeXInner', BUTTON, 'Inner OK')});
          ${write('{ outer: shotOuter.length, inner: shotInner.length }')}`, { timeout: 60000 });
        expect(sizes.outer > 1000 && sizes.inner > 1000, `dialog screenshots: ${JSON.stringify(sizes)}`);
        const inner = () => clients().find((c) => c.title === 'Codex E2E Life Inner' && c.xwayland);
        await until(() => life('codex-e2e-life-xdialogs').inner === 'x inner' && !inner(), 'X11 inner dialog result');
        await js(`await lifeXOuter.click(${find('lifeXOuter', BUTTON, 'Outer OK')});`);
        await until(() => life('codex-e2e-life-xdialogs').outer === 'x outer|x inner', 'X11 outer dialog result');
        expect(seat() === before, `desktop changed: ${before} -> ${seat()}`);
      } finally {
        try { dispatch(`hl.dsp.workspace.move({ monitor = "${home.name}", workspace = "name:codex" })`); } catch {}
        try { hyprctl('output', 'remove', name); } catch {}
        await until(() => !extra(), 'headless output removed', 10000);
        await until(() => hypr('workspaces').find((w) => w.name === 'codex')?.monitor === home.name, 'codex workspace back');
        log.push(`output removed: ${seat()}`);
        try { await restoreSeat(start, log); } finally { writeFileSync(join(evidence, 'monitor-seat.txt'), log.join('\n')); }
      }
    }, ['Codex E2E Life Inner', 'Codex E2E Life Outer']);
  }, { needs: strict ? luaOnly : 'VM only (adds an output)' });
}

/** Click two solid targets at points read from the agent's own screenshot; the
 *  app reports where each press landed inside the target. */
async function checkTargets(app, title, label) {
  const c = one(title);
  const image = await shot(app, label);
  expect(image.width === c.size[0] && image.height === c.size[1],
    `${title}: screenshot ${image.width}x${image.height} for a ${c.size[0]}x${c.size[1]} window`);
  const found = boxes(image.path, { magenta: [255, 0, 255], cyan: [0, 255, 255] });
  for (const [colour, target] of [['magenta', 'Magenta target'], ['cyan', 'Cyan target']]) {
    const box = found[colour];
    expect(box, `${title}: no ${colour} target in the screenshot ${image.path}`);
    const [x, y] = centre(box).map(Math.round);
    const count = (life(stateId(app)).presses ?? []).length;
    await js(`await ${app}.click([${x}, ${y}]); await ${app}.getAXState({ emit: false });`);
    await until(() => (life(stateId(app)).presses ?? []).length === count + 1, `${title}: ${target} pressed`);
    const press = life(stateId(app)).presses.at(-1);
    const expected = [press.width / 2 + (x - (box[0] + box[2]) / 2), press.height / 2 + (y - (box[1] + box[3]) / 2)];
    expect(press.target === target && Math.abs(press.x - expected[0]) <= 3 && Math.abs(press.y - expected[1]) <= 3,
      `${title}: clicked ${target} at screenshot ${x},${y} (box ${box}) but the app saw ${JSON.stringify(press)}`);
    // The colour box is the widget: same size in screenshot pixels as in the app.
    expect(Math.abs(box[2] - box[0] + 1 - press.width) <= 3 && Math.abs(box[3] - box[1] + 1 - press.height) <= 3,
      `${title}: ${target} is ${box[2] - box[0] + 1}x${box[3] - box[1] + 1} in the screenshot, ${press.width}x${press.height} in the app`);
  }
}

/** GTK 3 on X11 shows and places a tooltip by the X core pointer, the user's
 *  cursor, which the provider's private pointer does not move (by design): it
 *  hides a tooltip that opens under that cursor, and re-shows one while the
 *  cursor rests on its widget. Since Hyprland configures X11 windows at their
 *  real position (no longer at 0,0), the VM's resting cursor lies inside the
 *  window, where the tooltip opens. Keep the user's cursor outside the window,
 *  as a user working elsewhere would, and start the agent's pointer inside it. */
async function keepUserCursorOutside(app, title, monitor) {
  const c = one(title);
  const [px, py] = life(stateId(app)).core_pointer.map((v, i) => v + c.at[i]);
  const [width, height] = [monitor.width / monitor.scale, monitor.height / monitor.scale];
  const spot = [[20, 20], [width - c.size[0] - 20, 20], [20, height - c.size[1] - 20], [width - c.size[0] - 20, height - c.size[1] - 20]]
    .map(([x, y]) => [Math.round(monitor.x + x), Math.round(monitor.y + y)])
    .find(([x, y]) => px < x - 40 || px > x + c.size[0] + 40 || py < y - 40 || py > y + c.size[1] + 40);
  expect(spot, `${title}: no place on the monitor keeps the user's cursor (${px},${py}) outside the window`);
  if (spot[0] !== c.at[0] || spot[1] !== c.at[1]) {
    dispatch(`hl.dsp.window.move({ x = ${spot[0]}, y = ${spot[1]}, window = "${address(c)}" })`);
    await until(() => one(title).at[0] === spot[0] && one(title).at[1] === spot[1], `${title} moved to ${spot}`);
  }
  // A pointer entering the window ends on a motion the toplevel receives, and
  // GTK then looks for the tooltip widget under the core pointer: none.
  await js(`await cua.computer.move({ window: (await cua.listWindows({ emit: false }))
    .find((w) => w.title === ${JSON.stringify(title)}), x: 3, y: 3 });`);
}

/** Hover the orange button and expect its tooltip (a solid yellow 150x50
 *  block) composited below it; moving away removes it again. */
async function checkTooltip(app, title, label) {
  const image = await shot(app, `${label}-before`);
  const found = boxes(image.path, { orange: [255, 128, 0], tip: [255, 255, 0] });
  expect(found.orange, `${title}: the hover button is not visible in ${image.path}`);
  expect(!found.tip, `${title}: a tooltip is already showing in ${image.path}`);
  const point = centre(found.orange).map(Math.round);
  const move = (x, y) => js(`await cua.computer.move({ window: (await cua.listWindows({ emit: false }))
    .find((w) => w.title === ${JSON.stringify(title)}), x: ${x}, y: ${y} });`);
  await move(...point);
  let tip = null;
  await eventually(async () => {
    tip = boxes((await shot(app, `${label}-shown`)).path, { tip: [255, 255, 0] }).tip;
    return Boolean(tip) || 'no tooltip in the screenshot yet';
  }, `${title}: tooltip shown in the screenshot`, 10000);
  expect(life(stateId(app)).tooltip, `${title}: the app never showed its tooltip`);
  const [w, h] = [tip[2] - tip[0] + 1, tip[3] - tip[1] + 1];
  expect(Math.abs(w - 150) <= 4 && Math.abs(h - 50) <= 4, `${title}: tooltip is ${w}x${h} in the screenshot, 150x50 in the app`);
  // GTK anchors a tooltip below its (short) widget, centred on the pointer.
  expect(tip[1] >= found.orange[3] && tip[1] <= found.orange[3] + 40,
    `${title}: tooltip at ${tip}, its widget at ${found.orange}`);
  // GTK 3 on X11 reads the pointer position from the X core pointer, which is
  // the user's cursor: the provider's private XInput2 pointer does not move it
  // (by design), so an XWayland tooltip slides towards the user's cursor.
  if (!client(stateId(app)).xwayland) {
    expect(Math.abs(centre(tip)[0] - point[0]) <= 24, `${title}: tooltip at ${tip} for a pointer at ${point}`);
  }
  await move(3, Math.round(found.orange[1] / 2));
  await eventually(async () => !boxes((await shot(app, `${label}-hidden`)).path, { tip: [255, 255, 0] }).tip
    || 'tooltip still in the screenshot', `${title}: tooltip gone after the pointer left`, 10000);
}

const stateId = (app) => ({ lifeTargets: 'codex-e2e-life-targets', lifeXTargets: 'codex-e2e-life-xtargets' })[app];
