// Input fidelity and user isolation under stress: non-US layouts, long and
// rapid typing, exact clicks, drags, scroll precision, modifier chords, and a
// user working in another window of the same app while the agent acts. Every
// result is read from the apps themselves (fixture state files, page titles).
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { clients, ensure, entry, expect, fixtures, hypr, js, out, python, rejects, seat, statePath, strict, until,
  userWindows, which, windowId } from '../lib.mjs';

const fixture = join(fixtures, 'input.py');
const gtkInput = (id, title, backend = 'wayland', titles = `"${title}"`) => entry(id, title,
  `/usr/bin/env GDK_BACKEND=${backend} python3 ${fixture} ${statePath(id)} ${id} ${titles}`, `StartupWMClass=${id}\n`);
const INPUT = 'Codex E2E Input', INPUT2 = 'Codex E2E Input Two', XINPUT = 'Codex E2E X Input';
gtkInput('codex-e2e-input', INPUT);
gtkInput('codex-e2e-input2', INPUT2);
gtkInput('codex-e2e-xinput', XINPUT, 'x11');
// The user's own app with two windows in one process: the user works in one,
// the agent is given the other (like two windows of one browser).
const USER = 'Codex E2E User', AGENT = 'Codex E2E User Agent';
gtkInput('codex-e2e-userapp', 'Codex E2E User App', 'wayland', `"${USER}" "${AGENT}"`);
const qt = python('PyQt6');
if (qt) {
  // Qt's Wayland input log goes to qt-input.log.
  const launcher = join(out, 'bin', 'codex-e2e-qinput');
  writeFileSync(launcher, '#!/bin/sh\nexport QT_QPA_PLATFORM=wayland QT_WAYLAND_DISABLE_WINDOWDECORATION=1 '
    + `QT_LOGGING_RULES='qt.qpa.wayland.input*=true;qt.qpa.input*=true'\n`
    + `exec python3 ${join(fixtures, 'input_qt.py')} ${statePath('codex-e2e-qinput')} codex-e2e-qinput 2>>${join(out, 'qt-input.log')}\n`);
  chmodSync(launcher, 0o755);
  entry('codex-e2e-qinput', 'Codex E2E Qt Input', launcher, 'StartupWMClass=codex-e2e-qinput\n');
}
const browser = which('chromium', 'google-chrome-stable');
if (browser) {
  // The same profile as the toolkit tests' browser: a running instance opens
  // this as another window. A browser started here logs to chromium-keys.log.
  const launcher = join(out, 'bin', 'codex-e2e-keys-browser');
  // An absolute path, so the provider recognizes the wrapper as Chromium (and passes its accessibility switch).
  const program = execFileSync('sh', ['-c', `command -v ${browser}`], { encoding: 'utf8' }).trim();
  writeFileSync(launcher, `#!/bin/sh\nexec ${program} "$@" --user-data-dir=${join(out, 'browser')} --no-first-run `
    + `--no-default-browser-check --ozone-platform=wayland --enable-logging=stderr --app=file://${join(fixtures, 'input.html')} `
    + `2>>${join(out, 'chromium-keys.log')}\n`);
  chmodSync(launcher, 0o755);
  entry('codex-e2e-keys', 'Codex E2E Keys', launcher);
}
const wtype = which('wtype');
const vmOnly = (extra) => (strict ? extra ?? null : 'VM only (simulates user input or changes global input settings)');
const needsQt = qt ? null : 'PyQt6 not installed';
const needsBrowser = browser ? null : 'no Chromium-based browser';

// ---- reading the apps -------------------------------------------------------
const view = (id, title) => {
  const w = JSON.parse(readFileSync(statePath(id), 'utf8')).windows[title];
  if (!w) throw new Error(`no state for ${title} yet`);
  return w;
};
const gtkState = () => view('codex-e2e-input', INPUT);
const xState = () => view('codex-e2e-xinput', XINPUT);
const qtState = () => JSON.parse(readFileSync(statePath('codex-e2e-qinput'), 'utf8'));
const userState = () => view('codex-e2e-userapp', USER);
const agentState = () => view('codex-e2e-userapp', AGENT);
const keysWindow = () => clients().find((c) => c.title.startsWith('Codex E2E Keys|'));
const keysState = () => {
  const window = keysWindow();
  if (!window) throw new Error('the Chromium window is gone (see chromium-keys.log)');
  return JSON.parse(window.title.slice('Codex E2E Keys|'.length));
};
const fnv = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** Where two strings first differ, for readable failures. */
function difference(actual, expected) {
  if (actual === expected) return true;
  let i = 0;
  while (i < actual.length && actual[i] === expected[i]) i++;
  return `differs at ${i} of ${expected.length} (got ${actual.length}): got ${JSON.stringify(actual.slice(Math.max(0, i - 20), i + 30))}, `
    + `expected ${JSON.stringify(expected.slice(Math.max(0, i - 20), i + 30))}`;
}
/** Pad events after the count `before` (the pad keeps its last 300). */
const padSince = (read, before) => read().pad.filter((e) => e.seq > before);
const centre = ([x, y, w, h]) => [Math.round(x + w / 2), Math.round(y + h / 2)];
/** Poll until read() returns the same value for 600 ms (scrolling may coast). */
async function settled(read, describe, timeout = 8000) {
  let last, since = Date.now();
  await until(() => {
    const now = JSON.stringify(read());
    if (now !== last) { last = now; since = Date.now(); return now; }
    return Date.now() - since >= 600 || now;
  }, describe, timeout);
  return JSON.parse(last);
}

// ---- the desktop, as a user changes it (VM only) ---------------------------
function dispatch(lua) {
  const result = execFileSync('hyprctl', ['dispatch', lua], { encoding: 'utf8' }).trim();
  if (result !== 'ok') throw new Error(`hyprctl dispatch ${lua}: ${result}`);
}
const cursorTo = (x, y) => dispatch(`hl.dsp.cursor.move({ x = ${x}, y = ${y} })`);
const focusWindow = (address) => dispatch(`hl.dsp.focus({ window = "address:${address}" })`);
const moveWindow = (address, x, y) => dispatch(`hl.dsp.window.move({ x = ${x}, y = ${y}, window = "address:${address}" })`);
const toWorkspace = (address, workspace) =>
  dispatch(`hl.dsp.window.move({ workspace = "${workspace}", follow = false, window = "address:${address}" })`);
const byTitle = (title) => clients().find((c) => c.title === title);
/** The user typing on their keyboard (into whatever has focus). */
function userTypes(text, delay = 0) {
  const child = spawn('wtype', [...(delay ? ['-d', String(delay)] : []), text], { stdio: ['ignore', 'ignore', 'pipe'] });
  let error = '';
  child.stderr.on('data', (d) => { error += d; });
  child.done = new Promise((resolve, reject) => child.on('exit', (code) => (code ? reject(new Error(`wtype: ${error}`)) : resolve())));
  return child;
}
/** Restore focus, cursor and workspace exactly as they were before a test. */
async function restoreSeat(before) {
  const [address, , cursor] = JSON.parse(before);
  if (address && hypr('activewindow').address !== address) focusWindow(address);
  cursorTo(cursor.x, cursor.y);
  await until(() => seat() === before || seat(), 'desktop restored', 5000);
}
/** The seat must still be the user's: their window focused, their cursor, their workspace. */
function expectUserSeat(user, cursor, workspace, step) {
  const active = hypr('activewindow').address, now = hypr('cursorpos'), ws = hypr('activeworkspace').id;
  expect(active === user && now.x === cursor[0] && now.y === cursor[1] && ws === workspace,
    `after ${step}: focus ${active} (user ${user}), cursor ${JSON.stringify(now)} (user ${cursor}), workspace ${ws} (${workspace})`);
}

/**
 * Run with the user's app open on their workspace: two floating windows of one
 * process, the user's focused with the cursor over it. The agent binds the other
 * (globalThis.uw). The desktop is restored afterwards.
 */
async function withUserApp(run) {
  const before = seat();
  const command = `/usr/bin/env GDK_BACKEND=wayland python3 ${fixture} ${statePath('codex-e2e-userapp')} codex-e2e-userapp "${USER}" "${AGENT}"`;
  dispatch(`hl.dsp.exec_cmd(${JSON.stringify(`[float on] ${command}`)})`);
  let pid;
  try {
    await until(() => Boolean(byTitle(USER) && byTitle(AGENT)), 'user app windows', 15000);
    const user = byTitle(USER), agent = byTitle(AGENT);
    pid = user.pid;
    userWindows.add(user.address);
    moveWindow(user.address, 1000, 40);
    focusWindow(user.address);
    cursorTo(1300, 300);
    await until(() => (userState().active && !agentState().active && same(byTitle(USER).at, [1000, 40])
      && hypr('activewindow').address === user.address)
      || { user: userState().active, agent: agentState().active, at: byTitle(USER).at, focus: hypr('activewindow').address },
    'user window focused and placed', 8000);
    await js(`globalThis.uw = await cua.getApp({ windowId: ${windowId(agent)} });`);
    await run({ user: byTitle(USER), agent: byTitle(AGENT), workspace: hypr('activeworkspace').id });
  } finally {
    await js('delete globalThis.uw;').catch(() => {});
    if (pid) try { process.kill(pid, 'SIGTERM'); } catch {}
    await until(() => !byTitle(USER) && !byTitle(AGENT), 'user app closed', 8000).catch(() => {});
    for (const address of [...userWindows]) if (!clients().some((c) => c.address === address)) userWindows.delete(address);
    await restoreSeat(before);
  }
}

// ---- binding the apps -------------------------------------------------------
const ensureGtk = () => ensure('inp', 'codex-e2e-input.desktop', { timeout: 30000 });
const ensureX = () => ensure('xinp', 'codex-e2e-xinput.desktop', { timeout: 30000 });
const ensureQt = () => ensure('qinp', 'codex-e2e-qinput.desktop', { timeout: 30000 });
async function ensureKeys() {
  const bound = await js('await nodeRepl.write(String(typeof globalThis.kpage !== "undefined"));');
  if (bound.trim().endsWith('true') && keysWindow()) return;
  if (!keysWindow()) await js('await cua.computer.launch_app({ app: "codex-e2e-keys.desktop" });');
  await until(() => Boolean(keysWindow()), 'keys page window', 30000);
  await js(`globalThis.kpage = await cua.getApp({ windowId: ${windowId(keysWindow())} });`);
}
/** Empty the page's text area with keys (so the page sees input events) and focus it. */
const clearArea = `{ const i = e2eIndex(await kpage.getAXState({ emit: false, disableDiffing: true }), "Keys area");
  await kpage.click(i); await kpage.pressKey("ctrl+a"); await kpage.pressKey("BackSpace"); }`;

// ---- text -------------------------------------------------------------------
const ASCII = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join('');
// A dead key leaking from the user's layout would compose these into ê à ñ é ü.
const TRAPS = ' ^e `a ~n \'e "u ^^ `` ~~';
const UNICODE = ' äöüß ÄÖÜẞ €£µ§° éèêàçñ — “quoted” ‘single’ αβγ Жж 日本 😀';
// Key names a German layout puts on its third level (AltGr) or on its own keys.
const KEY_NAMES = ['z', 'y', 'Z', 'Y', 'at', 'bracketleft', 'backslash', 'asciitilde', 'EuroSign', 'adiaeresis', 'braceright'];
const KEY_TEXT = 'zyZY@[\\~€ä}';
const POOL = [...'äöüßÄÖÜẞ€£¥©®±×÷µ¶§°éèêëàçñøåæœðþłžčřğışțαβγδεζηθλμπσφωЖЗИЙ日本語中文한국어😀'];
/** Long text whose distinct non-ASCII characters exceed one key batch's keymap. */
function longText({ lines, tabs = true, unicode = true }) {
  let text = '';
  for (let i = 0; i < lines; i++) {
    const extra = unicode ? ` ${POOL[i % POOL.length]}${POOL[(i * 7 + 3) % POOL.length]}` : '';
    text += `${String(i).padStart(3, '0')}${tabs ? '\t' : ' '}The quick brown fox, (jumps) over [the] lazy dog #${i * 37 % 101}!${extra}\n`;
  }
  return text;
}
/** A deterministic edit sequence and the text it produces from `initial`. */
function keyScript(initial, count = 60) {
  let seed = 20261011;
  const random = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const choices = ['Left', 'Left', 'Right', 'Home', 'End', 'BackSpace', 'Delete', 'letter', 'letter', 'letter', 'letter'];
  const keys = ['End'];
  for (let i = 0; i < count; i++) {
    const choice = choices[random(choices.length)];
    keys.push(choice === 'letter' ? 'abcdefghijklmnopqrstuvwxyz'[random(26)] : choice);
  }
  const text = [...initial];
  let caret = text.length;
  for (const key of keys) {
    if (key === 'Left') caret = Math.max(0, caret - 1);
    else if (key === 'Right') caret = Math.min(text.length, caret + 1);
    else if (key === 'Home') caret = 0;
    else if (key === 'End') caret = text.length;
    else if (key === 'BackSpace') { if (caret > 0) text.splice(--caret, 1); }
    else if (key === 'Delete') { if (caret < text.length) text.splice(caret, 1); }
    else text.splice(caret++, 0, key);
  }
  return { keys, text: text.join('') };
}

// ---- keyboard layout (global; VM only) --------------------------------------
const keymaps = () => hypr('devices').keyboards.map((k) => k.active_keymap);
function originalLayout() {
  try { return hypr('getoption', 'input:kb_layout').str || 'us'; } catch { return 'us'; }
}
function setLayout(layout) {
  const lua = execFileSync('hyprctl', ['eval', `hl.config({ input = { kb_layout = "${layout}" } })`], { encoding: 'utf8' }).trim();
  if (lua === 'ok') return;
  const keyword = execFileSync('hyprctl', ['keyword', 'input:kb_layout', layout], { encoding: 'utf8' }).trim();
  if (keyword !== 'ok') throw new Error(`cannot set the keyboard layout: ${lua} / ${keyword}`);
}

export default function (test) {
  test('input: German and French layouts — ASCII, dead-key characters, AltGr keys and Unicode arrive exactly in GTK, XWayland, Qt and Chromium', async () => {
    // The user's layout must never shape the agent's text: every character
    // arrives as itself, the layout's dead keys (^ ` ´ ~) compose nothing, and
    // key names resolve to their symbols wherever the layout puts them.
    await ensureGtk();
    await ensureX();
    const layout = originalLayout();
    const typed = ASCII + TRAPS;
    try {
      for (const [name, pattern] of [['de', /German/], ['fr', /French/]]) {
        setLayout(name);
        await until(() => keymaps().some((k) => pattern.test(k)) || keymaps(), `${name} layout active`, 8000);
        // GTK on Wayland: the whole text, then key names.
        await js(`const i = await e2eFind(inp, "Input entry", "text"); await inp.setValue(i, ""); await inp.click(i);
          await inp.typeText(${JSON.stringify(typed + UNICODE)}); await inp.getAXState({ emit: false });`);
        await until(() => difference(gtkState().text, typed + UNICODE), `GTK text under ${name}`);
        await js(`const i = await e2eFind(inp, "Input entry", "text"); await inp.setValue(i, ""); await inp.click(i);
          for (const k of ${JSON.stringify(KEY_NAMES)}) await inp.pressKey(k); await inp.getAXState({ emit: false });`);
        await until(() => difference(gtkState().text, KEY_TEXT), `GTK key names under ${name}`);
        await js('await inp.pressKey("ctrl+a"); await inp.typeText("replaced"); await inp.getAXState({ emit: false });');
        await until(() => difference(gtkState().text, 'replaced'), `GTK ctrl+a under ${name}`);
        // XWayland: ASCII through the X keymap, Unicode through accessibility.
        await js(`const i = await e2eFind(xinp, "Input entry", "text"); await xinp.setValue(i, ""); await xinp.click(i);
          await xinp.typeText(${JSON.stringify(typed)}); await xinp.typeText(${JSON.stringify(UNICODE)});
          await xinp.getAXState({ emit: false });`, { timeout: 90000 });
        await until(() => difference(xState().text, typed + UNICODE), `XWayland text under ${name}`, 10000);
        await js(`const i = await e2eFind(xinp, "Input entry", "text"); await xinp.setValue(i, ""); await xinp.click(i);
          for (const k of ${JSON.stringify(KEY_NAMES)}) await xinp.pressKey(k); await xinp.getAXState({ emit: false });`);
        await until(() => difference(xState().text, KEY_TEXT), `XWayland key names under ${name}`);
        await js('await xinp.pressKey("ctrl+a"); await xinp.typeText("replaced"); await xinp.getAXState({ emit: false });');
        await until(() => difference(xState().text, 'replaced'), `XWayland ctrl+a under ${name}`);
        if (name !== 'de') continue;
        if (qt) {
          await ensureQt();
          await js(`const i = await e2eFind(qinp, "Qt input line", "text"); await qinp.setValue(i, ""); await qinp.click(i);
            await qinp.typeText(${JSON.stringify(typed + UNICODE)});
            for (const k of ${JSON.stringify(KEY_NAMES)}) await qinp.pressKey(k); await qinp.getAXState({ emit: false });`);
          await until(() => difference(qtState().text, typed + UNICODE + KEY_TEXT), 'Qt text under de');
        }
        if (browser) {
          await ensureKeys();
          await js(`${clearArea} await kpage.typeText(${JSON.stringify(typed + UNICODE)});
            for (const k of ${JSON.stringify(KEY_NAMES)}) await kpage.pressKey(k); await kpage.getAXState({ emit: false });`);
          const expected = typed + UNICODE + KEY_TEXT;
          await until(() => { const s = keysState(); return (s.n === expected.length && s.h === fnv(expected)) || s; },
            `Chromium text under de (expected tail ${JSON.stringify(expected.slice(-40))})`, 8000);
        }
        // The provider never changes the user's layout.
        expect(keymaps().some((k) => /German/.test(k)), `the layout changed: ${JSON.stringify(keymaps())}`);
      }
    } finally {
      setLayout(layout);
    }
  }, { needs: vmOnly() });

  test('input: long text and rapid key sequences arrive complete and in order in GTK, XWayland, Qt and Chromium', async () => {
    // Thousands of characters cross key-batch, keymap and Unicode-batch
    // boundaries; 60 separate key presses must apply in order.
    await ensureGtk();
    const long = longText({ lines: 70 });
    expect(new Set([...long].filter((c) => c.codePointAt(0) > 126)).size > 48, 'the text must exceed one Unicode batch');
    await js(`const i = await e2eFind(inp, "Input document", "text"); await inp.setValue(i, ""); await inp.click(i);
      await inp.typeText(${JSON.stringify(long)}); await inp.getAXState({ emit: false });`, { timeout: 120000 });
    await until(() => difference(gtkState().document, long), 'GTK document', 15000);
    const script = keyScript('0123456789');
    await js(`const i = await e2eFind(inp, "Input entry", "text"); await inp.setValue(i, "0123456789"); await inp.click(i);
      for (const k of ${JSON.stringify(script.keys)}) await inp.pressKey(k); await inp.getAXState({ emit: false });`, { timeout: 90000 });
    await until(() => difference(gtkState().text, script.text), 'GTK key sequence');

    await ensureX();
    const ascii = longText({ lines: 10, unicode: false });
    await js(`const i = await e2eFind(xinp, "Input document", "text"); await xinp.setValue(i, ""); await xinp.click(i);
      await xinp.typeText(${JSON.stringify(ascii)}); await xinp.getAXState({ emit: false });`, { timeout: 120000 });
    await until(() => difference(xState().document, ascii), 'XWayland document', 15000);
    await js(`const i = await e2eFind(xinp, "Input entry", "text"); await xinp.setValue(i, "0123456789"); await xinp.click(i);
      for (const k of ${JSON.stringify(script.keys)}) await xinp.pressKey(k); await xinp.getAXState({ emit: false });`, { timeout: 90000 });
    await until(() => difference(xState().text, script.text), 'XWayland key sequence');

    if (qt) {
      await ensureQt();
      await js(`const i = await e2eFind(qinp, "Qt input text", "text"); await qinp.setValue(i, ""); await qinp.click(i);
        await qinp.typeText(${JSON.stringify(long)}); await qinp.getAXState({ emit: false });`, { timeout: 120000 });
      await until(() => difference(qtState().document, long), 'Qt document', 15000);
      await js(`const i = await e2eFind(qinp, "Qt input line", "text"); await qinp.setValue(i, "0123456789"); await qinp.click(i);
        for (const k of ${JSON.stringify(script.keys)}) await qinp.pressKey(k); await qinp.getAXState({ emit: false });`, { timeout: 90000 });
      await until(() => difference(qtState().text, script.text), 'Qt key sequence');
    }
    if (browser) {
      // Tab moves focus out of a web text area, so the page gets no tabs.
      await ensureKeys();
      for (const web of [longText({ lines: 40, tabs: false, unicode: false }), longText({ lines: 70, tabs: false })]) {
        await js(`${clearArea} await kpage.typeText(${JSON.stringify(web)}); await kpage.getAXState({ emit: false });`, { timeout: 120000 });
        await until(() => { const s = keysState(); return (s.n === web.length && s.h === fnv(web)) || s; },
          `Chromium text area (expected ${web.length} characters ending ${JSON.stringify(web.slice(-40))})`, 15000);
      }
      await js(`${clearArea} await kpage.typeText("0123456789");
        for (const k of ${JSON.stringify(script.keys)}) await kpage.pressKey(k); await kpage.getAXState({ emit: false });`, { timeout: 90000 });
      await until(() => { const s = keysState(); return (s.h === fnv(script.text) && s.n === script.text.length) || s; },
        `Chromium key sequence (expected ${JSON.stringify(script.text)})`, 8000);
    }
  }, { needs: null });

  test('input: clicks land on the exact pixel, multi-clicks select words and lines, separate clicks stay single', async () => {
    await ensureGtk();
    await ensureX();
    for (const [app, read, title] of [['inp', gtkState, INPUT], ['xinp', xState, XINPUT]]) {
      const pad = read().geometry.pad;
      const p1 = [pad[0] + 37, pad[1] + 23], p2 = [pad[0] + pad[2] - 41, pad[1] + pad[3] - 17], p3 = [pad[0] + 300, pad[1] + 60];
      const events = async (code) => {
        const before = read().padCount;
        await js(`const w = await e2eWindow(${JSON.stringify(title)}); ${code} await ${app}.getAXState({ emit: false });`);
        await until(() => padSince(read, before).some((x) => x.kind === 'press') || 'no pad presses', `${app} pad events`);
        await settled(() => read().padCount, `${app} pad events settled`);
        return padSince(read, before).filter((x) => x.kind === 'press');
      };
      let e = await events(`await ${app}.click(${JSON.stringify(p1)});`);
      expect(e.length === 1 && same(e[0].at, p1) && e[0].button === 1 && e[0].n === 1, `${app}: left click at ${p1}: ${JSON.stringify(e)}`);
      e = await events(`await ${app}.click(${JSON.stringify(p2)}, { mouseButton: "right" });`);
      expect(e.length === 1 && same(e[0].at, p2) && e[0].button === 3, `${app}: right click at ${p2}: ${JSON.stringify(e)}`);
      e = await events(`await ${app}.click(${JSON.stringify(p1)}, { mouseButton: "middle" });`);
      expect(e.length === 1 && same(e[0].at, p1) && e[0].button === 2, `${app}: middle click at ${p1}: ${JSON.stringify(e)}`);
      // macOS posts each click with its own click count: two click calls are
      // two single clicks, never a double click the toolkit infers from timing.
      e = await events(`await ${app}.click(${JSON.stringify(p2)}); await ${app}.click(${JSON.stringify(p2)});`);
      expect(e.length === 2 && e.every((x) => x.n === 1 && same(x.at, p2)), `${app}: two separate clicks became ${JSON.stringify(e)}`);
      e = await events(`await ${app}.click(${JSON.stringify(p1)}, { clickCount: 2 });`);
      expect(e.some((x) => x.n === 2) && !e.some((x) => x.n === 3) && e.every((x) => same(x.at, p1)), `${app}: double click: ${JSON.stringify(e)}`);
      e = await events(`await ${app}.click(${JSON.stringify(p3)}, { clickCount: 3 });`);
      expect(e.some((x) => x.n === 3) && e.every((x) => same(x.at, p3)), `${app}: triple click: ${JSON.stringify(e)}`);

      // Word and line selection at exact characters of a document.
      const doc = 'first line here\nsecond alpha beta gamma\nthird line';
      await js(`await ${app}.setValue(await e2eFind(${app}, "Input document", "text"), ${JSON.stringify(doc)});`);
      await until(() => (read().document === doc && read().glyphs.length === doc.length + 1) || read().glyphs.length, `${app} glyphs`);
      const glyph = (offset) => { const [x, y, w, h] = read().glyphs[offset]; return [Math.round(x + w / 2), Math.round(y + h / 2)]; };
      const beta = doc.indexOf('beta'), lineStart = doc.indexOf('second'), lineEnd = doc.indexOf('\nthird');
      await js(`await ${app}.click(${JSON.stringify(glyph(beta + 1))}, { clickCount: 2 }); await ${app}.getAXState({ emit: false });`);
      await until(() => same(read().docSelection, [beta, beta + 4]) || read().docSelection, `${app}: double click selects "beta"`);
      await js(`await ${app}.click(${JSON.stringify(glyph(doc.indexOf('gamma') + 2))}, { clickCount: 3 }); await ${app}.getAXState({ emit: false });`);
      await until(() => [JSON.stringify([lineStart, lineEnd]), JSON.stringify([lineStart, lineEnd + 1])].includes(JSON.stringify(read().docSelection))
        || read().docSelection, `${app}: triple click selects the line [${lineStart}, ${lineEnd}]`);
    }
    if (browser) {
      await ensureKeys();
      await js(`const i = e2eIndex(await kpage.getAXState({ emit: false, disableDiffing: true }), "Keys words");
        await kpage.click(i, { clickCount: 2 }); await kpage.getAXState({ emit: false });`);
      await until(() => keysState().s === 'middleword' || keysState().s, 'Chromium double click selects the word');
      await js(`const i = e2eIndex(await kpage.getAXState({ emit: false, disableDiffing: true }), "Keys words");
        await kpage.click(i, { clickCount: 3 }); await kpage.getAXState({ emit: false });`);
      await until(() => keysState().s.trim() === 'ab cd middleword ef gh' || keysState().s, 'Chromium triple click selects the paragraph');
    }
  });

  test('input: modifier chords on clicks and scrolls — ctrl/shift multi-selection, held ctrl, ctrl/shift wheel — never stick', async () => {
    await ensureGtk();
    await ensureX();
    const lists = [['inp', gtkState, INPUT], ['xinp', xState, XINPUT]];
    if (qt) { await ensureQt(); lists.push(['qinp', qtState, 'Codex E2E Qt Input']); }
    for (const [app, read, title] of lists) {
      const row = (i) => centre(read().geometry.rows[i]);
      const step = async (code, expected, what) => {
        await js(`const w = await e2eWindow(${JSON.stringify(title)}); ${code} await ${app}.getAXState({ emit: false });`);
        await until(() => same(read().listSelection, expected) || read().listSelection, `${app}: ${what} selects ${JSON.stringify(expected)}`);
      };
      const click = (i, key) => `await cua.computer.click({ window: w, x: ${row(i)[0]}, y: ${row(i)[1]}${key ? `, key: "${key}"` : ''} });`;
      await step(click(1), [1], 'click row 1');
      await step(click(3, 'ctrl'), [1, 3], 'ctrl+click row 3');
      await step(click(1, 'ctrl'), [3], 'ctrl+click row 1 again');
      await step(click(5), [5], 'click row 5');
      await step(click(7, 'shift'), [5, 6, 7], 'shift+click row 7');
      await step(`await cua.computer.key_down({ window: w, key: "ctrl" });
        try { ${click(0)} ${click(2)} } finally { await cua.computer.key_up({ window: w, key: "ctrl" }); }`, [0, 2, 5, 6, 7], 'held ctrl, click rows 0 and 2');
      await step(click(4), [4], 'a plain click after key_up (ctrl released)');
    }
    // Chords on the wheel reach the app with the wheel events, and only them.
    for (const [app, read, title] of [['inp', gtkState, INPUT], ['xinp', xState, XINPUT]]) {
      const [x, y] = centre(read().geometry.pad);
      for (const key of ['ctrl', 'shift', null]) {
        const before = read().padCount;
        await js(`const w = await e2eWindow(${JSON.stringify(title)});
          await cua.computer.scroll({ window: w, x: ${x}, y: ${y}, direction: "down", pixels: 40${key ? `, key: "${key}"` : ''} });
          await ${app}.getAXState({ emit: false });`);
        await until(() => padSince(read, before).some((e) => e.kind === 'scroll' && (e.dy > 0 || e.dx > 0)) || padSince(read, before),
          `${app}: ${key ?? 'plain'} wheel reached the pad`);
        const moved = padSince(read, before).filter((e) => e.kind === 'scroll' && (e.dy || e.dx));
        expect(moved.every((e) => same(e.mods, key ? [key] : [])), `${app}: ${key ?? 'plain'} wheel arrived with ${JSON.stringify(moved)}`);
      }
    }
    if (browser) {
      // Shift turns the wheel horizontal in a browser.
      await ensureKeys();
      const before = keysState();
      await js(`const w = (await cua.listWindows({ emit: false })).find((x) => x.title.startsWith("Codex E2E Keys|"));
        const i = e2eIndex(await kpage.getAXState({ emit: false, disableDiffing: true }), "Keys scroller");
        await cua.computer.scroll({ window: w, element_id: String(i), direction: "down", pixels: 200, key: "shift" });
        await kpage.getAXState({ emit: false });`);
      const after = await settled(() => [keysState().x, keysState().y], 'Chromium shift+wheel settled');
      expect(after[0] > before.x && after[1] === before.y, `Chromium shift+wheel: ${JSON.stringify(before)} -> ${after}`);
    }
  });

  test('input: scrolling by pixels and pages moves exactly that far, and back, in GTK (Wayland and XWayland), Qt and Chromium', async () => {
    // macOS scrolls by the requested pixels, and a page is the viewport's
    // extent. Every toolkit is measured before any verdict (input-scroll.json).
    const results = {}, failures = [];
    const check = (ok, message) => { if (!ok) failures.push(message); };
    const lines = Array.from({ length: 400 }, (_, i) => `Line ${String(i).padStart(3, '0')}: scrolling document text`).join('\n');
    try {
      await ensureGtk();
      await ensureX();
      for (const [app, read, name] of [['inp', gtkState, 'GTK'], ['xinp', xState, 'XWayland GTK']]) {
        await js(`await ${app}.setValue(await e2eFind(${app}, "Input document", "text"), ${JSON.stringify(lines)});`);
        await until(() => read().document === lines, `${name} long document`);
        const scroll = async (direction, distance) => {
          await js(`await ${app}.scroll(await e2eFind(${app}, "Input document", "text"), "${direction}", ${JSON.stringify(distance)});
            await ${app}.getAXState({ emit: false });`);
          return settled(() => read().v.value, `${name} scrolling settled`);
        };
        await scroll('up', 40);
        const { page, upper } = read().v, line = read().lineHeight;
        expect(read().v.value === 0 && upper > page * 4, `${name} document not at the top: ${JSON.stringify(read().v)}`);
        const r = results[name] = { page, line, onePage: await scroll('down', 1) };
        r.threeLines = await scroll('down', { pixels: 3 * line }) - r.onePage;
        r.back = await scroll('up', { pixels: page + 3 * line });
        // XWayland wheel clicks come in GTK's steps (page^(2/3) px), so allow half a step there.
        const slack = app === 'xinp' ? page ** (2 / 3) / 2 : line / 2;
        check(Math.abs(r.onePage - page) <= Math.max(page * 0.03, slack), `${name}: one page moved ${r.onePage} px, the page is ${page} px`);
        check(Math.abs(r.threeLines - 3 * line) <= slack, `${name}: ${3 * line} px moved ${r.threeLines} px`);
        check(Math.abs(r.back) < 0.5, `${name}: scrolling back the same distance ended at ${r.back}`);
      }
      if (qt) {
        await ensureQt();
        // Qt's plain-text scroll bar counts lines.
        const scroll = async (direction, distance) => {
          await js(`await qinp.scroll(await e2eFind(qinp, "Qt input text", "text"), "${direction}", ${JSON.stringify(distance)});
            await qinp.getAXState({ emit: false });`);
          return settled(() => qtState().v.value, 'Qt scrolling settled');
        };
        await js(`await qinp.setValue(await e2eFind(qinp, "Qt input text", "text"), ${JSON.stringify(lines)});`);
        await until(() => qtState().document === lines, 'Qt long document');
        await scroll('up', 40);
        const q = results.qt = { page: qtState().v.page, start: qtState().v.value, onePage: await scroll('down', 1) };
        q.back = await scroll('up', 1);
        q.wheel = qtState().wheel.slice(-12);
        check(q.start === 0 && Math.abs(q.onePage - q.page) <= 1, `Qt: one page moved ${q.onePage} lines, the page is ${q.page} lines`);
        check(q.back === 0, `Qt: scrolling back one page ended at line ${q.back}`);
      }
      if (browser) {
        await ensureKeys();
        // Pages scroll the document by its viewport; pixels scroll the inner scroller.
        const scroll = async (target, direction, distance, read) => {
          await js(`const tree = await kpage.getAXState({ emit: false, disableDiffing: true });
            const i = ${target === 'document' ? 'Number(tree.split("\\n").find((l) => /^\\s*\\d+ document web\\b/.test(l)).trim().match(/^(\\d+)/)[1])' : 'e2eIndex(tree, "Keys scroller")'};
            await kpage.scroll(i, "${direction}", ${JSON.stringify(distance)}); await kpage.getAXState({ emit: false });`);
          return settled(read, 'Chromium scrolling settled');
        };
        const page = () => keysState().wy, inner = () => keysState().y;
        await scroll('document', 'up', 40, page);
        const c = results.chromium = { page: keysState().ih, start: keysState().wy, onePage: await scroll('document', 'down', 1, page) };
        c.back = await scroll('document', 'up', 1, page);
        await scroll('scroller', 'up', { pixels: 8000 }, inner);
        c.sixty = await scroll('scroller', 'down', { pixels: 60 }, inner);
        c.sixtyBack = await scroll('scroller', 'up', { pixels: 60 }, inner);
        check(c.start === 0 && Math.abs(c.onePage - c.page) <= 2, `Chromium: one page moved ${c.onePage} px, the page is ${c.page} px`);
        check(c.back === 0, `Chromium: scrolling back one page ended at ${c.back}`);
        check(Math.abs(c.sixty - 60) <= 1 && c.sixtyBack === 0, `Chromium: 60 px moved ${c.sixty} px, and back to ${c.sixtyBack}`);
      }
    } finally {
      writeFileSync(join(out, 'input-scroll.json'), JSON.stringify(results, null, 2));
    }
    expect(!failures.length, `${failures.join('\n')}\nmeasured: ${JSON.stringify(results)}`);
  });

  test('input: drags — the slider follows the pointer exactly, drag_handle holds across steps, dragging selects exact text', async () => {
    await ensureGtk();
    await ensureX();
    for (const [app, read, title] of [['inp', gtkState, INPUT], ['xinp', xState, XINPUT]]) {
      const knob = () => (read().geometry.knob[0] + read().geometry.knob[1]) / 2;
      const [sx, sy, sw, sh] = read().geometry.slider, y = Math.round(sy + sh / 2);
      const near = (x) => () => Math.abs(knob() - x) <= 2 || { knob: knob(), value: read().value };
      await js(`await ${app}.setValue(await e2eFind(${app}, "Input slider"), "500");`);
      await until(() => read().value === 500, `${app} slider at 500`);
      const target = Math.round(sx + sw * 0.3);
      await js(`await ${app}.drag([${Math.round(knob())}, ${y}], [${target}, ${y}]); await ${app}.getAXState({ emit: false });`);
      await until(near(target), `${app}: the knob followed the drag to x=${target}`);
      await js(`await ${app}.drag([${Math.round(knob())}, ${y}], [${sx + sw - 1}, ${y}]); await ${app}.getAXState({ emit: false });`);
      await until(() => read().value === 1000 || read().value, `${app}: dragging past the end reaches the maximum`);
      // Selecting text by dragging over exact characters, within and across lines.
      const doc = 'alpha beta gamma delta\nsecond line of text\nthird';
      await js(`await ${app}.setValue(await e2eFind(${app}, "Input document", "text"), ${JSON.stringify(doc)});`);
      await until(() => (read().document === doc && read().glyphs.length === doc.length + 1) || read().glyphs.length, `${app} glyphs`);
      const at = (offset) => { const [x, gy, w, h] = read().glyphs[offset]; return [Math.round(x + w / 4), Math.round(gy + h / 2)]; };
      for (const [from, to] of [[doc.indexOf('beta'), doc.indexOf('delta')], [doc.indexOf('line'), doc.indexOf('third') + 2]]) {
        await js(`await ${app}.click(${JSON.stringify(at(doc.length))}); await ${app}.drag(${JSON.stringify(at(from))}, ${JSON.stringify(at(to))});
          await ${app}.getAXState({ emit: false });`);
        await until(() => same(read().docSelection, [from, to]) || read().docSelection,
          `${app}: drag selects ${JSON.stringify(doc.slice(from, to))} [${from}, ${to}]`);
      }
      // Sky drag_handle on the event pad: the press, the motion with the button
      // held and the release reach the app at the exact points, in order, as
      // the steps are made (no observation in between, as in a quick script).
      const pad = read().geometry.pad;
      const points = [[pad[0] + 30, pad[1] + 30], [pad[0] + 200, pad[1] + 50], [pad[0] + 400, pad[1] + 80]];
      const since = read().padCount;
      // Points carry the window, so they are window coordinates (desktop ones otherwise).
      await js(`{ const w = await e2eWindow(${JSON.stringify(title)}); const handle = cua.computer.drag_handle();
        await handle.start({ window: w, x: ${points[0][0]}, y: ${points[0][1]} });
        try {
          for (const [x, y] of ${JSON.stringify(points.slice(1))}) await handle.move_to({ window: w, x, y });
        } finally { await handle.end(); } }`);
      const sequence = () => padSince(read, since).filter((e) => e.kind !== 'motion' || e.held)
        .map((e) => `${e.kind}@${e.at.map(Math.round)}`).join(' ');
      const expected = `press@${points[0]} motion@${points[1]} motion@${points[2]} release@${points[2]}`;
      const arrived = await until(() => sequence() === expected || sequence(), `${app}: drag_handle events before any observation`, 4000)
        .then(() => true, () => false);
      const before = sequence();
      if (!arrived) await js(`await ${app}.getAXState({ emit: false });`);
      writeFileSync(join(out, `input-drag-handle-${app}.json`), JSON.stringify({ expected, beforeObservation: before, after: sequence() }));
      expect(arrived, `${app}: drag_handle delivered ${JSON.stringify(before)} before an observation, ${JSON.stringify(sequence())} after; expected ${expected}`);
      // Sky drag_handle: the button stays pressed across calls, the selection
      // follows each step, other pointer actions are refused meanwhile.
      const start = doc.indexOf('gamma'), steps = [doc.indexOf('line') + 1, doc.indexOf('of') + 1, doc.indexOf('delta') + 3];
      await js(`await ${app}.click(${JSON.stringify(at(doc.length))}); globalThis.handleWindow = await e2eWindow(${JSON.stringify(title)});
        globalThis.textHandle = cua.computer.drag_handle();
        await textHandle.start({ window: handleWindow, x: ${at(start)[0]}, y: ${at(start)[1]} });`);
      try {
        for (const offset of steps) {
          await js(`await textHandle.move_to({ window: handleWindow, x: ${at(offset)[0]}, y: ${at(offset)[1]} });`);
          await until(() => same(read().docSelection, [start, offset].sort((a, b) => a - b)) || read().docSelection,
            `${app}: drag_handle at ${JSON.stringify(doc.slice(0, offset).slice(-6))}| selects from "gamma"`);
        }
        await rejects(`await ${app}.click(${JSON.stringify(at(0))});`, /drag handle is pressed/);
      } finally {
        await js('await textHandle.end();');
      }
      const released = [start, steps.at(-1)];
      await js(`await ${app}.getScreenshot({ emit: false });`);
      await until(() => same(read().docSelection, released) || read().docSelection, `${app}: the selection stays after release`);
      // Released for real: a click now places the caret.
      await js(`await ${app}.click(${JSON.stringify(at(1))}); await ${app}.getAXState({ emit: false });`);
      await until(() => (same(read().docSelection, []) && read().caret === 1) || [read().docSelection, read().caret], `${app}: click after release`);
    }
  });

  test('input: drag-and-drop within a window and between windows lands in the target, never in the user\'s overlapping window', async () => {
    // The agent's windows are on their own workspace; the user's window lies
    // over the same screen area on the visible one. A drop goes where the
    // agent's pointer is on the agent's workspace, as on screen.
    await ensureGtk();
    await js('globalThis.inp2 = globalThis.inp2 ?? await cua.getApp("codex-e2e-input2.desktop");', { timeout: 30000 });
    const second = () => view('codex-e2e-input2', INPUT2);
    for (const [title, x] of [[INPUT, 40], [INPUT2, 1000]]) {
      toWorkspace(byTitle(title).address, 'name:codex-dnd');
      moveWindow(byTitle(title).address, x, 40);
    }
    await until(() => (byTitle(INPUT).at[0] === 40 && byTitle(INPUT2).at[0] === 1000 && byTitle(INPUT).workspace.name === 'codex-dnd'
      && byTitle(INPUT2).workspace.name === 'codex-dnd') || [byTitle(INPUT).at, byTitle(INPUT2).at], 'windows placed');
    await withUserApp(async ({ user, workspace }) => {
      moveWindow(user.address, 1000, 40);
      await until(() => byTitle(USER).at[1] === 40 || byTitle(USER).at, 'user window over the second window');
      const cursor = [1500, 120];
      cursorTo(...cursor);
      const a = byTitle(INPUT), b = byTitle(INPUT2);
      const source = centre(gtkState().geometry.source), own = centre(gtkState().geometry.target);
      const [tx, ty] = centre(second().geometry.target);
      // B's target in A's coordinates (a drag may end outside its window).
      const there = [b.at[0] + tx - a.at[0], b.at[1] + ty - a.at[1]];
      const payload = `payload from ${INPUT} ✓`;
      await js(`await inp.drag(${JSON.stringify(source)}, ${JSON.stringify(own)});`);
      await until(() => same(gtkState().dropped, [payload]) || gtkState().dropped, 'drop within the window');
      expectUserSeat(user.address, cursor, workspace, 'a drag within the window');
      await js(`await inp.drag(${JSON.stringify(source)}, ${JSON.stringify(there)});`);
      await until(() => same(second().dropped, [payload]) || { second: second().dropped, user: userState().dropped }, 'drop into the other window');
      expectUserSeat(user.address, cursor, workspace, 'a drag between windows');
      // The same with Sky's drag_handle, step by step.
      await js(`{ const w = await e2eWindow(${JSON.stringify(INPUT)}); const handle = cua.computer.drag_handle();
        await handle.start({ window: w, x: ${source[0]}, y: ${source[1]} });
        try {
          for (const [x, y] of ${JSON.stringify([[source[0] + 40, source[1] + 30], [700, 300], there])}) await handle.move_to({ window: w, x, y });
        } finally { await handle.end(); } }`);
      await until(() => same(second().dropped, [payload, payload]) || { second: second().dropped, user: userState().dropped }, 'drag_handle drop');
      expectUserSeat(user.address, cursor, workspace, 'drag_handle');
      expect(same(userState().dropped, []) && same(agentState().dropped, []), `the user's app received a drop: ${JSON.stringify(userState().dropped)}`);
    });
  }, { needs: vmOnly() });

  test('input: the user types and moves the pointer in their window of the same app while the agent works in another — nothing crosses over', async () => {
    await withUserApp(async ({ user, agent, workspace }) => {
      // One step at a time: the user moves and types, then the agent acts; the
      // user's focus, cursor and workspace must survive every action.
      const actions = [
        `await uw.setValue(await e2eFind(uw, "Input entry", "text"), "");`,
        `await uw.click(await e2eFind(uw, "Input entry", "text"));`,
        `await uw.typeText("agent one ");`,
        `await uw.pressKey("ctrl+a");`,
        `await uw.typeText("Agent Two: @#$ äöü 😀");`,
        `await uw.click(${JSON.stringify(centre(agentState().geometry.pad))});`,
        `await uw.scroll(await e2eFind(uw, "Input document", "text"), "down", 1);`,
        `await uw.drag(${JSON.stringify(centre(agentState().geometry.slider))}, [${agentState().geometry.slider[0] + 30}, ${centre(agentState().geometry.slider)[1]}]);`,
        // The slider took the window's focus; back to the entry.
        `await uw.click(await e2eFind(uw, "Input entry", "text")); await uw.pressKey("End"); await uw.typeText(" end");`,
      ];
      // Pointer positions stay over the user's window: Hyprland's cursor warp
      // focuses the window under it, as the user's click would.
      const cursors = [[1200, 200], [1300, 300], [1700, 900], [1500, 500], [1100, 700], [1020, 60], [1860, 1000], [1400, 540], [1600, 400]];
      let typed = '';
      for (const [n, action] of actions.entries()) {
        cursorTo(...cursors[n]);
        const key = 'qwXY7!kZ?'[n];
        await userTypes(key).done;
        typed += key;
        await until(() => userState().text === typed || userState().text, `the user's key ${key} reached their window`);
        await js(`${action} await uw.getAXState({ emit: false });`);
        expectUserSeat(user.address, cursors[n], workspace, action);
      }
      await until(() => difference(agentState().text, 'Agent Two: @#$ äöü 😀 end'), 'the agent window text');
      expect(userState().text === typed, `the user's window: ${JSON.stringify(userState().text)} (typed ${JSON.stringify(typed)})`);

      // At the same time: the user types a sentence while the agent types a
      // long document and the pointer keeps moving.
      const sentence = 'The user keeps typing: Hello World 123, ABC xyz! (Shifted) MiXeD CaSe. '.repeat(2);
      const long = longText({ lines: 30 });
      await js(`const i = await e2eFind(uw, "Input document", "text"); await uw.setValue(i, ""); await uw.click(i);`);
      let moves = 0, last = null;
      const mover = setInterval(() => { last = [1010 + (moves * 97) % 860, 50 + (moves * 53) % 980]; moves++; try { cursorTo(...last); } catch {} }, 60);
      let typist;
      try {
        typist = userTypes(sentence, 12);
        for (let i = 0; i < long.length; i += 600) {
          await js(`await uw.typeText(${JSON.stringify(long.slice(i, i + 600))}); await uw.pressKey("ctrl+End");`, { timeout: 90000 });
        }
        await typist.done;
      } finally {
        clearInterval(mover);
        typist?.kill();
      }
      await until(() => difference(agentState().document, long), 'the agent document while the user typed', 15000);
      await until(() => difference(userState().text, typed + sentence), 'the user\'s text while the agent typed', 8000);
      const now = hypr('cursorpos');
      expect(moves > 5 && now.x === last[0] && now.y === last[1] && hypr('activewindow').address === user.address,
        `after concurrent work: cursor ${JSON.stringify(now)} (user ${last}), focus ${hypr('activewindow').address}`);
    });
  }, { needs: vmOnly(wtype ? null : 'wtype not installed') });

  test('input: held keys are released by user input and failed chords; the user\'s typing in the same app is never modified', async () => {
    await ensureX();
    await withUserApp(async ({ user }) => {
      let typed = '';
      const userTyping = async (text) => {
        await userTypes(text).done;
        typed += text;
        await until(() => userState().text === typed || userState().text, `the user's ${JSON.stringify(text)} arrived unmodified`);
      };
      const agentText = async (expected) => until(() => difference(agentState().text, expected), `agent text ${JSON.stringify(expected)}`);
      await js(`globalThis.uwWindow = await e2eWindow(${JSON.stringify(AGENT)});
        const i = await e2eFind(uw, "Input entry", "text"); await uw.setValue(i, ""); await uw.click(i);
        await cua.computer.key_down({ window: uwWindow, key: "shift" }); await uw.typeText("abc"); await uw.getAXState({ emit: false });`);
      await agentText('ABC');
      // The agent's shift belongs to its window: the user's keys are plain, and release it.
      await userTyping('xyz');
      await rejects('await uw.typeText("d");', /Physical input released the held keys/);
      await js('await uw.typeText("def"); await uw.getAXState({ emit: false });');
      await agentText('ABCdef');
      // A chord that fails leaves none of its keys down; the earlier hold stays.
      await js('await cua.computer.key_down({ window: uwWindow, key: "shift" });');
      await rejects('await cua.computer.key_down({ window: uwWindow, key: "ctrl+NoSuchKey" });', /Unknown|key/i);
      await js('await uw.typeText("ghi"); await cua.computer.key_up({ window: uwWindow, key: "shift" }); await uw.typeText("jkl"); await uw.getAXState({ emit: false });');
      await agentText('ABCdefGHIjkl');
      // A timed hold interrupted by the user: their keys stay plain, the agent's next text too.
      const keysBefore = agentState().keys.length;
      const holding = js('await cua.computer.press_key({ window: uwWindow, key: "shift", duration: 3000 });');
      try {
        await until(() => agentState().keys.slice(keysBefore).some(([k]) => k === 'Shift_L') || agentState().keys.slice(keysBefore), 'the timed hold began');
        await userTyping('mno');
      } finally {
        await holding;
      }
      await js('await uw.typeText("pqr"); await uw.getAXState({ emit: false });');
      await agentText('ABCdefGHIjklpqr');
      // XWayland holds live on a private X keyboard; user input releases them too.
      await js(`globalThis.xWindow = await e2eWindow(${JSON.stringify(XINPUT)});
        const i = await e2eFind(xinp, "Input entry", "text"); await xinp.setValue(i, ""); await xinp.click(i);
        await cua.computer.key_down({ window: xWindow, key: "shift" }); await xinp.typeText("abc"); await xinp.getAXState({ emit: false });`);
      await until(() => difference(xState().text, 'ABC'), 'XWayland held shift');
      await userTyping('stu');
      await rejects('await xinp.typeText("d");', /Physical input released the held keys/);
      await js('await xinp.typeText("def"); await xinp.getAXState({ emit: false });');
      await until(() => difference(xState().text, 'ABCdef'), 'XWayland keys after the release');
      await userTyping('vw');
      expect(userState().keys.every(([, mods]) => mods.length === 0), `the user's keys carried modifiers: ${JSON.stringify(userState().keys)}`);
      expect(hypr('activewindow').address === user.address, 'the user lost focus');
    });
  }, { needs: vmOnly(wtype ? null : 'wtype not installed') });
}
