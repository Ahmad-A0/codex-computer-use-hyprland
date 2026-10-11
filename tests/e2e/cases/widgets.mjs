// Complex widgets and accessibility-tree fidelity across toolkits (GTK 3 on
// Wayland and XWayland, GTK 4, Qt 6, Chromium): long and virtualized lists,
// tree views, editable cells, combo boxes and drop-downs, numeric controls,
// notebooks and tabs, toggles and radio groups, disabled and hidden controls,
// web forms, ARIA widgets, iframes and long pages. Results are checked in the
// apps themselves (state files, the page's title), and the tree the agent sees
// is checked against them as a macOS accessibility tree would show them:
// current values and states, only what is on screen in the current tab, stable
// element IDs and exact diffs.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { clients, ensure, entry, expect, fixtures, js, out, python, root, state, statePath, until, which } from '../lib.mjs';

const G3 = 'codex-e2e-wgtk3';
const X3 = 'codex-e2e-wxgtk3';
const G4 = 'codex-e2e-wgtk4';
const QT = 'codex-e2e-wqt';
const WEB = 'codex-e2e-wweb';
const gtk3 = (id, name, backend) => entry(id, name, `/usr/bin/env GDK_BACKEND=${backend} python3 `
  + `${join(fixtures, 'widgets_gtk3.py')} ${statePath(id)} ${id} "${name}"`, `StartupWMClass=${id}\n`);
gtk3(G3, 'Codex E2E Widgets GTK3', 'wayland');
gtk3(X3, 'Codex E2E Widgets XWayland', 'x11');
const hasGtk4 = (() => {
  try { execFileSync('python3', ['-c', 'import gi; gi.require_version("Gtk", "4.0")'], { stdio: 'ignore' }); return true; } catch { return false; }
})();
entry(G4, 'Codex E2E Widgets GTK4', `/usr/bin/env GDK_BACKEND=wayland python3 ${join(fixtures, 'widgets_gtk4.py')} `
  + `${statePath(G4)} ${G4} "Codex E2E Widgets GTK4"`, `StartupWMClass=${G4}\n`);
const hasQt = python('PyQt6');
entry(QT, 'Codex E2E Widgets Qt', `/usr/bin/env QT_QPA_PLATFORM=wayland python3 ${join(fixtures, 'widgets_qt.py')} `
  + `${statePath(QT)} ${QT}`, `StartupWMClass=${QT}\n`);
const browser = which('chromium', 'google-chrome-stable');
if (browser) {
  entry(WEB, 'Codex E2E Widgets Web', `${browser} --user-data-dir=${join(out, 'browser')} --no-first-run `
    + `--no-default-browser-check --ozone-platform=wayland --app=file://${join(fixtures, 'widgets.html')}`);
}

// ---- Reading what the agent sees (macOS-format trees and diffs) ----------
const lines = (tree) => tree.split('\n').map((l) => l.replace(/^[~+]\t/, '').replace(/^\t+/, ''));
/** The ID of the first element with this name (and role), like e2eIndex; null if absent. */
function find(tree, name, role) {
  const line = lines(tree).find((l) => {
    if (!/^\d+ /.test(l)) return false;
    const rest = l.replace(/^\d+ /, '');
    if (role !== undefined && !(rest === role || rest.startsWith(`${role} `))) return false;
    const label = role === undefined ? rest : rest.slice(role.length).trim().replace(/^\([^)]*\) ?/, '');
    return role === undefined ? label.includes(name) : label === name || label.startsWith(`${name},`);
  });
  return line === undefined ? null : Number(line.match(/^(\d+)/)[1]);
}
/** The ID of the first element with this role (GTK 4 and Qt name combo boxes after their value). */
const withRole = (tree, role) => Number(lines(tree).find((l) => l.replace(/^\d+ /, '').startsWith(`${role} `))?.match(/^(\d+)/)[1] ?? NaN);
const lineOf = (tree, id) => lines(tree).find((l) => l.startsWith(`${id} `)) ?? null;
const STATE = '(?:focused|selected|expanded|indeterminate|checked|unchecked|settable|disabled)';
const stateList = new RegExp(`^\\d+ (?:[a-z][a-z ]*? )?\\((${STATE}(?:, ${STATE})*)\\)`);
const statesOf = (line) => line?.match(stateList)?.[1].split(', ') ?? [];
const has = (tree, id, s) => statesOf(lineOf(tree, id)).includes(s);
/** The value an element line shows ("Value: x"), or null. */
const valueOf = (line) => line?.match(/(?:^|, )Value: ([^,]*)/)?.[1] ?? null;
const isDiff = (text) => text.includes('The following is a diff from the previous accessibility tree');
function changes(diff) {
  return diff.split('\n').filter((l) => /^[~+]\t/.test(l))
    .map((l) => ({ kind: l[0], id: Number(l.slice(2).match(/^(\d+)/)?.[1]), body: l.slice(2) }));
}
function removed(diff) {
  const listed = diff.match(/Removed element IDs: ([^\n]*)/)?.[1];
  if (!listed) return [];
  return listed.split(', ').flatMap((part) => {
    const [a, b] = part.split('-').map(Number);
    return b === undefined ? [a] : Array.from({ length: b - a + 1 }, (_, i) => a + i);
  });
}
/** Every changed line other than these elements may differ only in focus. */
function onlyChanged(diff, before, ids, what) {
  for (const change of changes(diff)) {
    if (ids.includes(change.id)) continue;
    const normal = (line) => String(line).replace(/ \(([^)]*)\)/, (_, list) => {
      const kept = list.split(', ').filter((s) => s !== 'focused');
      return kept.length ? ` (${kept.join(', ')})` : '';
    });
    expect(change.kind === '~' && normal(change.body) === normal(lineOf(before, change.id)),
      `${what}: unrelated element changed: ${change.body}\n(was ${lineOf(before, change.id)})\n${diff}`);
  }
}
const numberIn = (line) => Number(valueOf(line)?.replace(/%$/, ''));

// ---- Driving the REPL ------------------------------------------------------
// Helpers defined inside the REPL; sent as source to avoid string escaping.
async function wTry(f) {
  try { await f(); return null; } catch (error) { return String((error && error.message) || error); }
}
async function wResult(value) { await nodeRepl.write(`E2EJSON${JSON.stringify(value)}`); }
async function defs() {
  const text = await js('await nodeRepl.write(String(typeof globalThis.wResult === "function"));');
  if (!text.trim().endsWith('true')) await js(`${wTry}; ${wResult}; globalThis.wTry = wTry; globalThis.wResult = wResult;`);
}
/** Run REPL code that ends with wResult(...) and return its value. */
async function run(code, options) {
  const text = await js(code, options);
  const at = text.lastIndexOf('E2EJSON');
  if (at < 0) throw new Error(`no result from the REPL:\n${text.slice(-1500)}`);
  return JSON.parse(text.slice(at + 7));
}
const full = (app) => `await ${app}.getAXState({ emit: false, disableDiffing: true })`;
const diff = (app) => `await ${app}.getAXState({ emit: false })`;
/** Bind a fixture app (once) and define the helpers. */
async function open(variable, id) {
  await ensure(variable, `${id}.desktop`, { timeout: 45000 });
  await defs();
}
/** Wait until a reading stops changing (scrolling can continue after input). */
async function settled(read, describe, quiet = 600, timeout = 8000) {
  let last = JSON.stringify(read());
  let since = Date.now();
  await until(() => {
    const now = JSON.stringify(read());
    if (now !== last) { last = now; since = Date.now(); }
    return Date.now() - since >= quiet;
  }, describe, timeout);
  return JSON.parse(last);
}
async function selectTab(app, name, done) {
  await js(`await ${app}.click(await e2eFind(${app}, ${JSON.stringify(name)}, "page tab")); await ${app}.getAXState({ emit: false });`);
  await until(done, `${name} tab is current`, 8000);
}

// ---- Evidence for failures -------------------------------------------------
const owner = (id) => () => clients().find((c) => c.class === id || c.initialClass === id);
const webWindow = () => clients().find((c) => c.title.startsWith('Codex E2E Widgets|'));
/** On failure keep the agent's tree and the raw AT-SPI tree (every state and action). */
function guarded(slug, variable, client, body) {
  return async () => {
    try {
      await body();
    } catch (error) {
      const files = [];
      try {
        const text = await js(`await nodeRepl.write(typeof globalThis.${variable} === "undefined" ? "unbound" : ${full(variable)});`);
        writeFileSync(join(out, `widgets-${slug}-tree.txt`), text);
        files.push(`widgets-${slug}-tree.txt`);
      } catch (treeError) {
        files.push(`(tree: ${treeError.message.slice(0, 200)})`);
      }
      try {
        const c = client();
        if (c) {
          execFileSync('python3', [join(root, 'tests/e2e/axdump.py'), String(c.pid), join(out, `widgets-${slug}-atspi.json`)],
            { timeout: 90000, stdio: 'ignore' });
          files.push(`widgets-${slug}-atspi.json`);
        }
      } catch (dumpError) {
        files.push(`(AT-SPI dump: ${dumpError.message.slice(0, 200)})`);
      }
      error.message += `\nevidence in the artifacts: ${files.join(', ')}`;
      throw error;
    }
  };
}

const web = () => { const t = webWindow().title; return JSON.parse(t.slice(t.indexOf('|') + 1)); };
async function openWeb() {
  await defs();
  const bound = await js('await nodeRepl.write(String(typeof globalThis.wweb !== "undefined"));');
  if (bound.trim().endsWith('true') && webWindow()) return;
  await js(`await cua.computer.launch_app({ app: "${WEB}.desktop" });`);
  await until(() => Boolean(webWindow()), 'widgets page window', 30000);
  await js(`globalThis.wweb = await cua.getApp({ windowId: ${parseInt(webWindow().address, 16)} });`);
  await until(() => webWindow().title.includes('"y":'), 'page state', 10000);
}

export default function (test) {
  // A row's AT-SPI bounds stay valid after it scrolls out of its list; a click
  // at its centre would land on whatever the window shows there instead.
  test('widgets GTK3: a list row scrolled out of view is never clicked through; it is scrolled to, selected and activated',
    guarded('gtk3-list', 'wg3', owner(G3), async () => {
      await open('wg3', G3);
      await selectTab('wg3', 'List', () => state(G3).page === 0);
      await until(() => state(G3).overTrap?.length > 0, 'list geometry', 10000);
      const start = state(G3);
      expect(start.scroll === 0, `the list must start at the top: ${JSON.stringify(start)}`);
      // The first row whose centre lies below the viewport, over the Trap button.
      const hiddenRow = start.overTrap[0];
      const first = await run(`const tree = ${full('wg3')};
        const error = await wTry(async () => wg3.click(e2eIndex(tree, ${JSON.stringify(hiddenRow)}, "table cell")));
        await wg3.getAXState({ emit: false });
        await wResult({ error });`);
      if (first.error === null) await until(() => state(G3).selected === hiddenRow, `${hiddenRow} selected`);
      else expect(/view|visible|scroll/i.test(first.error), `clicking ${hiddenRow} failed without saying it is out of view: ${first.error}`);
      expect(state(G3).trap === 0, `the click on ${hiddenRow} (out of view) went through to the Trap button below the list: ${JSON.stringify(state(G3))}`);

      // One page of scrolling shows the next page: it moves, and skips nothing.
      for (let n = 0; n < 3; n++) {
        const before = await settled(() => state(G3).scroll, 'list at rest');
        await js(`await wg3.scroll(await e2eFind(wg3, "Inventory"), "down", 1); await wg3.getAXState({ emit: false });`);
        await until(() => state(G3).scroll !== before, 'the list scrolled');
        const after = await settled(() => state(G3).scroll, 'list scrolling settled');
        const { pageSize, rowHeight } = state(G3);
        expect(after - before >= pageSize / 2 && after - before <= pageSize + rowHeight,
          `a one-page scroll moved the list by ${after - before} px; its page is ${pageSize} px (rows ${rowHeight} px)`);
      }

      // An agent's way to a far row: click it, and scroll a page while it is out of view.
      const far = 'Row 150';
      const flow = await run(`const attempts = [];
        for (let n = 0; n < 40; n++) {
          const tree = ${full('wg3')};
          const error = await wTry(async () => wg3.click(e2eIndex(tree, ${JSON.stringify(far)}, "table cell")));
          attempts.push(error);
          if (error === null) break;
          await wg3.scroll(e2eIndex(tree, "Inventory"), "down", 1);
        }
        await wg3.getAXState({ emit: false });
        await wResult({ attempts });`, { timeout: 180000 });
      expect(flow.attempts.at(-1) === null, `never clicked ${far}: ${JSON.stringify(flow.attempts)}`);
      await until(() => state(G3).selected === far, `${far} selected`);
      await js(`await wg3.click(await e2eFind(wg3, ${JSON.stringify(far)}, "table cell"), { clickCount: 2 }); await wg3.getAXState({ emit: false });`);
      await until(() => state(G3).activated === far, `${far} activated by a double-click`);
      const tree = await js(`await nodeRepl.write(${full('wg3')});`);
      expect(has(tree, find(tree, far, 'table cell'), 'selected'), `the tree does not show ${far} selected:\n${lineOf(tree, find(tree, far, 'table cell'))}`);

      // A row scrolled out at the top lies over the notebook's tabs: clicking it
      // must not switch the page.
      const s = state(G3);
      const above = Array.from({ length: 200 }, (_, i) => i)
        .filter((i) => s.listTop + (i + 0.5) * s.rowHeight - s.scroll < s.listTop).at(-1);
      const aboveRow = `Row ${String(above).padStart(3, '0')}`;
      const top = await run(`const error = await wTry(async () => wg3.click(e2eIndex(${full('wg3')}, ${JSON.stringify(aboveRow)}, "table cell")));
        await wg3.getAXState({ emit: false }); await wResult({ error });`);
      if (top.error === null) await until(() => state(G3).selected === aboveRow, `${aboveRow} selected`);
      else expect(/view|visible|scroll|outside/i.test(top.error), `clicking ${aboveRow} failed without saying it is out of view: ${top.error}`);
      expect(state(G3).page === 0 && state(G3).trap === 0 && state(G3).listAction === 0,
        `a click on a row above the viewport hit another control: ${JSON.stringify(state(G3))}`);
    }));

  test('widgets GTK3: tree view nodes expand and collapse with exact diffs and stable IDs; a leaf is activated',
    guarded('gtk3-tree', 'wg3', owner(G3), async () => {
      await open('wg3', G3);
      await selectTab('wg3', 'Tree', () => state(G3).page === 1);
      const step1 = await run(`const t0 = ${full('wg3')};
        const fruits = e2eIndex(t0, "Fruits", "table cell");
        const line = t0.split(String.fromCharCode(10)).map((l) => l.trim()).find((l) => l.startsWith(fruits + " "));
        const action = (line.match(/Secondary Actions: (.*)$/)?.[1] ?? "").split(", ").find((a) => /expand/i.test(a));
        await wg3.performSecondaryAction(fruits, action);
        const d1 = ${diff('wg3')};
        const t1 = ${full('wg3')};
        await wResult({ t0, fruits, action, d1, t1 });`);
      const { t0, fruits, d1, t1 } = step1;
      expect(step1.action, `Fruits shows no expand action: ${lineOf(t0, fruits)}`);
      expect(find(t0, 'Citrus') === null && find(t0, 'Apple') === null, `collapsed children are listed:\n${t0}`);
      const vegetables = find(t0, 'Vegetables', 'table cell');
      await until(() => state(G3).expanded.includes('Fruits'), 'Fruits expanded in the app');
      expect(isDiff(d1), `not a diff:\n${d1}`);
      const c1 = changes(d1);
      expect(c1.some((c) => c.kind === '~' && c.id === fruits && statesOf(c.body).includes('expanded')), `Fruits not shown expanded:\n${d1}`);
      for (const child of ['Citrus', 'Apple']) {
        expect(c1.some((c) => c.kind === '+' && c.body.includes(child)), `${child} was not added:\n${d1}`);
      }
      expect(!d1.includes('Lemon') && removed(d1).length === 0, `unexpected diff:\n${d1}`);
      expect(find(t1, 'Vegetables', 'table cell') === vegetables && find(t1, 'Fruits', 'table cell') === fruits,
        `IDs changed when rows were inserted above them:\n${t0}\n---\n${t1}`);

      // Keyboard, as a user expands the selected node.
      const step2 = await run(`await wg3.click(e2eIndex(${full('wg3')}, "Citrus", "table cell"));
        await wg3.pressKey("plus");
        const d2 = ${diff('wg3')};
        await wResult({ d2, t2: ${full('wg3')} });`);
      await until(() => state(G3).treeSelected === 'Fruits/Citrus' && state(G3).expanded.includes('Citrus'), 'Citrus selected and expanded');
      const citrus = find(t1, 'Citrus', 'table cell');
      for (const leaf of ['Lemon', 'Lime', 'Orange']) {
        expect(changes(step2.d2).some((c) => c.kind === '+' && c.body.includes(leaf)), `${leaf} was not added:\n${step2.d2}`);
      }
      expect(has(step2.t2, citrus, 'expanded') && has(step2.t2, citrus, 'selected'), `Citrus line: ${lineOf(step2.t2, citrus)}`);

      const step3 = await run(`await wg3.click(e2eIndex(${full('wg3')}, "Lemon", "table cell"), { clickCount: 2 });
        await wg3.getAXState({ emit: false });
        await wResult({ t3: ${full('wg3')} });`);
      await until(() => state(G3).treeActivated === 'Fruits/Citrus/Lemon', 'Lemon activated');
      const lemon = find(step3.t3, 'Lemon', 'table cell');
      expect(has(step3.t3, lemon, 'selected') && !has(step3.t3, citrus, 'selected'), `selection in the tree:\n${step3.t3}`);

      const step4 = await run(`await wg3.performSecondaryAction(${fruits}, ${JSON.stringify(step1.action)});
        const d4 = ${diff('wg3')};
        await wResult({ d4, t4: ${full('wg3')} });`);
      await until(() => !state(G3).expanded.includes('Fruits'), 'Fruits collapsed in the app');
      const gone = removed(step4.d4);
      for (const name of ['Citrus', 'Apple', 'Lemon', 'Lime', 'Orange']) {
        const id = find(step3.t3, name, 'table cell');
        expect(gone.includes(id), `${name} (${id}) was not removed:\n${step4.d4}`);
        expect(find(step4.t4, name) === null, `${name} is still listed after collapsing:\n${step4.t4}`);
      }
      expect(!has(step4.t4, fruits, 'expanded') && find(step4.t4, 'Vegetables', 'table cell') === vegetables,
        `after collapsing:\n${step4.t4}`);
    }));

  test('widgets GTK3: an editable table cell is edited in place and the change appears on the same element',
    guarded('gtk3-cell', 'wg3', owner(G3), async () => {
      await open('wg3', G3);
      await selectTab('wg3', 'List', () => state(G3).page === 0);
      const s = await settled(() => state(G3).scroll, 'list at rest').then(() => state(G3));
      const row = `Row ${String(Math.ceil(s.scroll / s.rowHeight) + 2).padStart(3, '0')}`;
      // GTK 3's "edit" cell action only moves the cursor (its signal name is
      // wrong in GTK), so edit as a user does: click the cell, Return edits it.
      const result = await run(`const t = ${full('wg3')};
        const nameId = e2eIndex(t, ${JSON.stringify(row)}, "table cell");
        const rows = t.split(String.fromCharCode(10)).map((l) => l.trim());
        const at = rows.findIndex((l) => l.startsWith(nameId + " "));
        const qty = rows.slice(at + 1).find((l) => /^\\d+ table cell/.test(l));
        const qtyId = Number(qty.split(" ")[0]);
        await wg3.click(qtyId);
        const selected = ${diff('wg3')};
        await wg3.pressKey("Return"); await wg3.pressKey("ctrl+a"); await wg3.typeText("77"); await wg3.pressKey("Return");
        const after = ${diff('wg3')};
        await wResult({ qty, qtyId, selected, after, t: ${full('wg3')} });`);
      await until(() => state(G3).qty[row] === 77, `${row} quantity edited in the model`);
      expect(state(G3).selected === row && state(G3).activated !== row, `editing did not stay on ${row}: ${JSON.stringify(state(G3))}`);
      const line = lineOf(result.t, result.qtyId);
      expect(/(^|\s)77(,|$)/.test(line.replace(/^\d+ table cell( \([^)]*\))?/, '')), `the edited cell shows ${line} (was ${result.qty})`);
      expect(changes(result.after).some((c) => c.kind === '~' && c.id === result.qtyId && c.body.includes('77')),
        `the edit is not a change of the same cell:\n${result.after}`);
    }));

  test('widgets GTK3: notebook pages, toggles, radio group, switch, disabled and hidden controls: states, exact diffs, stable IDs',
    guarded('gtk3-controls', 'wg3', owner(G3), async () => {
      await open('wg3', G3);
      await selectTab('wg3', 'List', () => state(G3).page === 0);
      const r0 = await run(`const t0 = ${full('wg3')};
        await wg3.click(e2eIndex(t0, "Controls", "page tab"));
        const d = ${diff('wg3')};
        await wResult({ t0, d, t1: ${full('wg3')} });`);
      await until(() => state(G3).page === 2, 'Controls page is current');
      const listAction = find(r0.t0, 'List page action', 'button');
      // As on macOS, only the current page's controls are in the tree.
      expect(find(r0.t1, 'List page action') === null && find(r0.t1, 'Inventory') === null && find(r0.t1, 'Catalog') === null,
        `controls of other notebook pages are listed:\n${r0.t1}`);
      expect(find(r0.t0, 'Subscribe') === null, `the Controls page is listed while the List page is current:\n${r0.t0}`);
      expect(removed(r0.d).includes(listAction) && changes(r0.d).some((c) => c.kind === '+' && c.body.includes('Subscribe')),
        `switching pages is not a diff of the two pages:\n${r0.d}`);
      expect(has(r0.t1, find(r0.t1, 'Controls', 'page tab'), 'selected') && !has(r0.t1, find(r0.t1, 'List', 'page tab'), 'selected'),
        `tab selection:\n${r0.t1}`);
      const stale = await run(`await wResult({ error: await wTry(async () => wg3.click(${listAction})) });`);
      expect(stale.error !== null && state(G3).listAction === 0, `a control of a hidden page was pressed: ${JSON.stringify(stale)}`);

      const t1 = r0.t1;
      const ids = Object.fromEntries([['subscribe', 'Subscribe', 'check box'], ['small', 'Small', 'radio button'],
        ['medium', 'Medium', 'radio button'], ['large', 'Large', 'radio button'], ['bold', 'Bold', 'toggle button'],
        ['airplane', 'Airplane mode'], ['disabled', 'Disabled action', 'button'], ['reveal', 'Reveal', 'button']]
        .map(([key, name, role]) => [key, find(t1, name, role)]));
      expect(Object.values(ids).every((id) => id !== null), `controls missing: ${JSON.stringify(ids)}\n${t1}`);
      expect(find(t1, 'Hidden action') === null, `a hidden button is listed:\n${t1}`);
      expect(statesOf(lineOf(t1, ids.disabled)).includes('disabled'), `not shown disabled: ${lineOf(t1, ids.disabled)}`);
      expect(has(t1, ids.small, 'checked') && !has(t1, ids.large, 'checked') && !has(t1, ids.subscribe, 'checked'),
        `initial states:\n${t1}`);

      // Each change is exactly one diff of the elements it changed.
      const steps = [['subscribe', [ids.subscribe], (s) => s.subscribe === true],
        ['large', [ids.large, ids.small], (s) => s.size === 'Large'],
        ['bold', [ids.bold], (s) => s.bold === true],
        ['airplane', [ids.airplane], (s) => s.airplane === true]];
      for (const [key, changed, done] of steps) {
        const r = await run(`const before = ${full('wg3')}; await wg3.click(${ids[key]});
          const d = ${diff('wg3')}; await wResult({ before, d, after: ${full('wg3')} });`);
        await until(() => done(state(G3)), `${key} changed in the app`);
        expect(isDiff(r.d) && removed(r.d).length === 0 && !changes(r.d).some((c) => c.kind === '+'), `${key}: ${r.d}`);
        expect(changes(r.d).some((c) => c.id === ids[key] && statesOf(c.body).includes('checked')), `${key} not shown checked:\n${r.d}`);
        if (key === 'large') {
          expect(changes(r.d).some((c) => c.id === ids.small && !statesOf(c.body).includes('checked')), `Small not unchecked in the same diff:\n${r.d}`);
        }
        onlyChanged(r.d, r.before, changed, key);
      }

      const r2 = await run(`const error = await wTry(async () => wg3.click(${ids.disabled}));
        await wg3.getAXState({ emit: false }); await wResult({ error });`);
      expect(state(G3).disabledClicks === 0, `a disabled button was activated: ${JSON.stringify(r2)}`);

      const r3 = await run(`const before = ${full('wg3')}; await wg3.click(${ids.reveal});
        const d = ${diff('wg3')}; await wResult({ before, d, after: ${full('wg3')} });`);
      await until(() => state(G3).revealed && !state(G3).subscribeEnabled, 'revealed in the app');
      const shown = find(r3.after, 'Hidden action', 'button');
      expect(shown !== null && changes(r3.d).some((c) => c.kind === '+' && c.id === shown), `the revealed button was not added:\n${r3.d}`);
      expect(!Object.values(ids).includes(shown), `the revealed button reuses an ID: ${shown}`);
      expect(changes(r3.d).some((c) => c.kind === '~' && c.id === ids.subscribe && statesOf(c.body).includes('disabled')),
        `Subscribe not shown disabled in the diff:\n${r3.d}`);
      const r4 = await run(`await wg3.click(${shown}); const error = await wTry(async () => wg3.click(${ids.subscribe}));
        await wg3.getAXState({ emit: false }); await wResult({ error, t: ${full('wg3')} });`);
      await until(() => state(G3).hiddenClicks === 1, 'the revealed button works');
      expect(state(G3).subscribe === true, `a disabled check box was toggled: ${JSON.stringify(r4.error)}`);
      for (const [key, id] of Object.entries(ids)) {
        expect(lineOf(r4.t, id) !== null, `${key} lost its ID ${id}:\n${r4.t}`);
      }
    }));

  test('widgets GTK3: combo box popup choice, spin button and slider values are set and read back; progress is readable',
    guarded('gtk3-values', 'wg3', owner(G3), async () => {
      await open('wg3', G3);
      await selectTab('wg3', 'Controls', () => state(G3).page === 2);
      const t0 = await js(`await nodeRepl.write(${full('wg3')});`);
      const combo = find(t0, 'Size preset', 'combo box');
      const spin = find(t0, 'Quantity', 'spin button');
      const volume = find(t0, 'Volume', 'slider');
      const upload = find(t0, 'Upload', 'progress bar');
      expect([combo, spin, volume, upload].every((id) => id !== null), `controls missing:\n${t0}`);
      // As a macOS popup button, slider or progress indicator, each shows its value.
      expect(valueOf(lineOf(t0, combo)) === 'Alpha', `the combo box does not show its value: ${lineOf(t0, combo)}`);
      expect(numberIn(lineOf(t0, volume)) === 20, `the slider does not show its value: ${lineOf(t0, volume)}`);
      expect([0.6, 60].includes(numberIn(lineOf(t0, upload))), `the progress bar does not show its value: ${lineOf(t0, upload)}`);
      expect(find(t0, 'Gamma') === null, `a closed combo box lists its menu:\n${t0}`);

      const r1 = await run(`await wg3.click(${combo}); const opened = ${diff('wg3')};
        const error = await wTry(async () => wg3.click(e2eIndex(${full('wg3')}, "Gamma")));
        const chosen = ${diff('wg3')};
        await wResult({ opened, error, chosen, t: ${full('wg3')} });`);
      if (r1.error) await js('await wg3.pressKey("Escape");');
      expect(r1.error === null, `choosing from the open combo box failed: ${r1.error}\n${r1.opened}`);
      expect(changes(r1.opened).some((c) => c.kind === '+' && c.body.includes('Gamma')), `the open menu was not added:\n${r1.opened}`);
      await until(() => state(G3).combo === 'Gamma', 'Gamma chosen in the app');
      expect(find(r1.t, 'Delta') === null, `the menu is still listed after choosing:\n${r1.t}`);
      expect(valueOf(lineOf(r1.t, combo)) === 'Gamma', `the combo box shows ${lineOf(r1.t, combo)}`);

      await js(`await wg3.setValue(${spin}, "42"); await wg3.getAXState({ emit: false });`);
      await until(() => state(G3).spin === 42, 'the spin button value is committed in the app');
      await js(`await wg3.click(${spin}); await wg3.pressKey("Up"); await wg3.getAXState({ emit: false });`);
      await until(() => state(G3).spin === 43, 'the Up key steps the spin button');
      await js(`await wg3.setValue(${volume}, "65"); await wg3.getAXState({ emit: false });`);
      await until(() => state(G3).volume === 65, 'slider value set');
      const t2 = await js(`await nodeRepl.write(${full('wg3')});`);
      expect(numberIn(lineOf(t2, spin)) === 43 && numberIn(lineOf(t2, volume)) === 65,
        `values in the tree: ${lineOf(t2, spin)} / ${lineOf(t2, volume)}`);
      // Keyboard on the slider, as a user adjusts it after clicking it.
      await js(`await wg3.click(${volume}); await wg3.pressKey("End"); await wg3.getAXState({ emit: false });`);
      await until(() => state(G3).volume === 100, 'End moves the slider to its maximum');
      const t3 = await js(`await wg3.pressKey("Left"); await nodeRepl.write(${diff('wg3')});`);
      await until(() => state(G3).volume === 99, 'Left lowers the slider by a step');
      expect(changes(t3).some((c) => c.id === volume && numberIn(c.body) === 99), `the slider change is not in the diff:\n${t3}`);
    }));

  test('widgets XWayland: list row, tree expansion, combo box and spin button in a GTK3 X11 window',
    guarded('xwayland', 'wx3', owner(X3), async () => {
      await open('wx3', X3);
      expect(clients().find((c) => c.class === X3)?.xwayland, 'fixture is not running under XWayland');
      await until(() => state(X3).overTrap?.length > 0, 'list geometry', 10000);
      const hiddenRow = state(X3).overTrap[0];
      const first = await run(`const error = await wTry(async () => wx3.click(e2eIndex(${full('wx3')}, ${JSON.stringify(hiddenRow)}, "table cell")));
        await wx3.getAXState({ emit: false }); await wResult({ error });`);
      if (first.error === null) await until(() => state(X3).selected === hiddenRow, `${hiddenRow} selected`);
      expect(state(X3).trap === 0, `the click on ${hiddenRow} (out of view) went through to the Trap button: ${JSON.stringify(first)}`);
      await js(`await wx3.click(await e2eFind(wx3, "Row 003", "table cell"), { clickCount: 2 }); await wx3.getAXState({ emit: false });`);
      await until(() => state(X3).activated === 'Row 003' && state(X3).selected === 'Row 003', 'Row 003 activated');

      await selectTab('wx3', 'Tree', () => state(X3).page === 1);
      const tree = await run(`const t = ${full('wx3')}; const vegetables = e2eIndex(t, "Vegetables", "table cell");
        const line = t.split(String.fromCharCode(10)).map((l) => l.trim()).find((l) => l.startsWith(vegetables + " "));
        const action = (line.match(/Secondary Actions: (.*)$/)?.[1] ?? "").split(", ").find((a) => /expand/i.test(a));
        await wx3.performSecondaryAction(vegetables, action);
        const d = ${diff('wx3')};
        await wx3.click(e2eIndex(${full('wx3')}, "Leek", "table cell"), { clickCount: 2 });
        await wx3.getAXState({ emit: false });
        await wResult({ d });`);
      await until(() => state(X3).treeActivated === 'Vegetables/Leek', 'Leek activated');
      expect(changes(tree.d).some((c) => c.kind === '+' && c.body.includes('Carrot')), `expansion not in the diff:\n${tree.d}`);

      await selectTab('wx3', 'Controls', () => state(X3).page === 2);
      const combo = await run(`await wx3.click(await e2eFind(wx3, "Size preset", "combo box")); const opened = ${diff('wx3')};
        const error = await wTry(async () => wx3.click(e2eIndex(${full('wx3')}, "Delta")));
        if (error) await wx3.pressKey("Escape");
        await wx3.getAXState({ emit: false }); await wResult({ opened, error });`);
      expect(combo.error === null, `choosing from the open combo box failed: ${combo.error}\n${combo.opened}`);
      await until(() => state(X3).combo === 'Delta', 'Delta chosen');
      await js(`await wx3.setValue(await e2eFind(wx3, "Quantity", "spin button"), "17"); await wx3.getAXState({ emit: false });`);
      await until(() => state(X3).spin === 17, 'spin button value committed');
    }));

  test('widgets GTK4: virtualized list scrolled page by page to an unrealized row; drop-down, switch, numeric values, hidden and disabled, notebook',
    guarded('gtk4', 'wg4', owner(G4), async () => {
      await open('wg4', G4);
      await until(() => state(G4).realizedRows?.length > 0, 'list rows realized', 10000);
      const t0 = await js(`await nodeRepl.write(${full('wg4')});`);
      const far = 'Item 150';
      expect(find(t0, far) === null, `an unrealized row is listed:\n${t0.slice(0, 3000)}`);
      // A realized row below the viewport, over the Trap button.
      const hiddenRow = state(G4).overTrap[0];
      if (hiddenRow !== undefined) {
        const r = await run(`const error = await wTry(async () => wg4.click(e2eIndex(${full('wg4')}, ${JSON.stringify(hiddenRow)})));
          await wg4.getAXState({ emit: false }); await wResult({ error });`);
        if (r.error === null) await until(() => state(G4).selected === hiddenRow, `${hiddenRow} selected`);
        expect(state(G4).trap === 0, `the click on ${hiddenRow} (out of view) went through to the Trap button: ${JSON.stringify(r)}`);
      }
      // Page by page: every row is on screen in some page, until the target is listed.
      let seen = (await settled(() => state(G4).visibleRows, 'list at rest')).slice();
      let found = null;
      for (let n = 0; n < 40 && found === null; n++) {
        const before = await settled(() => state(G4).visibleRows, 'list at rest');
        const r = await run(`await wg4.scroll(await e2eFind(wg4, "Stock"), "down", 1); await wResult({ t: ${diff('wg4')} });`);
        await until(() => JSON.stringify(state(G4).visibleRows) !== JSON.stringify(before), 'the list scrolled');
        const after = await settled(() => state(G4).visibleRows, 'list scrolling settled');
        const index = (name) => Number(name.slice(5));
        expect(index(after[0]) <= index(before.at(-1)) + 1 && index(after[0]) > index(before[0]),
          `a one-page scroll skipped rows: ${before[0]}..${before.at(-1)} -> ${after[0]}..${after.at(-1)}`);
        seen = seen.concat(after);
        const tree = await js(`await nodeRepl.write(${full('wg4')});`);
        if (after.includes(far)) {
          found = find(tree, far);
          expect(found !== null, `${far} is on screen but not in the tree:\n${tree.slice(0, 3000)}`);
        }
      }
      expect(found !== null, `${far} never appeared: ${JSON.stringify(seen.slice(-10))}`);
      await js(`await wg4.click(await e2eFind(wg4, ${JSON.stringify(far)})); await wg4.getAXState({ emit: false });`);
      await until(() => state(G4).selected === far, `${far} selected`);
      await js(`await wg4.click(await e2eFind(wg4, ${JSON.stringify(far)}), { clickCount: 2 }); await wg4.getAXState({ emit: false });`);
      await until(() => state(G4).activated === far, `${far} activated`);
      expect(state(G4).trap === 0, 'the Trap button was clicked');

      const t1 = await js(`await nodeRepl.write(${full('wg4')});`);
      const flavor = withRole(t1, 'combo box');
      const ids = { wifi: find(t1, 'Wi-Fi'), notify: find(t1, 'Notify', 'check box'), copies: find(t1, 'Copies', 'spin button'),
        brightness: find(t1, 'Brightness', 'slider'), sync: find(t1, 'Sync', 'progress bar'), disabled: find(t1, 'Disabled action', 'button') };
      expect(!Number.isNaN(flavor) && Object.values(ids).every((id) => id !== null), `controls missing: ${JSON.stringify(ids)}\n${t1}`);
      expect(lineOf(t1, flavor).includes('Vanilla'), `the drop-down does not show its value: ${lineOf(t1, flavor)}`);
      expect(find(t1, 'Hidden action') === null, `a hidden button is listed:\n${t1}`);
      expect(statesOf(lineOf(t1, ids.disabled)).includes('disabled'), `not shown disabled: ${lineOf(t1, ids.disabled)}`);
      expect([0.25, 25].includes(numberIn(lineOf(t1, ids.sync))), `the progress bar does not show its value: ${lineOf(t1, ids.sync)}`);
      expect(numberIn(lineOf(t1, ids.brightness)) === 50, `the slider does not show its value: ${lineOf(t1, ids.brightness)}`);
      expect(find(t1, 'Advanced action') === null, `a hidden notebook page is listed:\n${t1}`);

      const drop = await run(`await wg4.click(${flavor}); const opened = ${diff('wg4')};
        const error = await wTry(async () => wg4.click(e2eIndex(${full('wg4')}, "Strawberry")));
        if (error) await wg4.pressKey("Escape");
        const closed = ${diff('wg4')};
        await wResult({ opened, error, closed, t: ${full('wg4')} });`);
      expect(drop.error === null, `choosing from the drop-down failed: ${drop.error}\n${drop.opened}`);
      expect(changes(drop.opened).some((c) => c.kind === '+' && c.body.includes('Strawberry')), `the open list was not added:\n${drop.opened}`);
      await until(() => state(G4).flavor === 'Strawberry', 'Strawberry chosen');
      expect(find(drop.t, 'Chocolate') === null && lineOf(drop.t, flavor).includes('Strawberry'), `after choosing:\n${drop.t}`);

      const r = await run(`await wg4.click(${ids.wifi}); await wg4.click(${ids.notify});
        await wg4.setValue(${ids.copies}, "7"); await wg4.setValue(${ids.brightness}, "80");
        const error = await wTry(async () => wg4.click(${ids.disabled}));
        await wg4.getAXState({ emit: false }); await wResult({ error, t: ${full('wg4')} });`);
      await until(() => { const s = state(G4); return s.wifi && s.notify && s.copies === 7 && s.brightness === 80; }, 'controls changed in the app');
      expect(state(G4).disabledClicks === 0, `a disabled button was activated: ${r.error}`);
      expect(has(r.t, ids.wifi, 'checked') && has(r.t, ids.notify, 'checked'), `toggle states:\n${r.t}`);
      expect(numberIn(lineOf(r.t, ids.copies)) === 7 && numberIn(lineOf(r.t, ids.brightness)) === 80,
        `values in the tree: ${lineOf(r.t, ids.copies)} / ${lineOf(r.t, ids.brightness)}`);

      const general = find(r.t, 'General action', 'button');
      await selectTab('wg4', 'Advanced', () => state(G4).tab === 1);
      const nb = await run(`const t = ${full('wg4')}; const error = await wTry(async () => wg4.click(${general}));
        await wg4.click(e2eIndex(t, "Advanced action", "button")); await wg4.getAXState({ emit: false });
        await wResult({ t, error });`);
      await until(() => state(G4).advancedClicks === 1, 'the Advanced page button works');
      expect(find(nb.t, 'General action') === null && state(G4).generalClicks === 0,
        `the hidden General page is listed or pressed (${nb.error}):\n${nb.t}`);
    }), { needs: hasGtk4 ? null : 'GTK 4 bindings not installed' });

  test('widgets Qt: tree widget expansion and activation, table cell scrolled to and edited, combo popup, values, hidden and disabled',
    guarded('qt', 'wqt', owner(QT), async () => {
      await open('wqt', QT);
      await selectTab('wqt', 'Items', () => state(QT).tab === 0);
      const r1 = await run(`const t0 = ${full('wqt')};
        await wqt.click(e2eIndex(t0, "Engineering")); await wqt.pressKey("Right");
        const d1 = ${diff('wqt')}; const t1 = ${full('wqt')};
        await wqt.click(e2eIndex(t1, "Backend")); await wqt.pressKey("Right");
        const d2 = ${diff('wqt')};
        await wqt.click(e2eIndex(${full('wqt')}, "Bob"), { clickCount: 2 });
        await wqt.getAXState({ emit: false });
        await wResult({ t0, d1, t1, d2, t3: ${full('wqt')} });`);
      expect(find(r1.t0, 'Backend') === null, `collapsed children are listed:\n${r1.t0}`);
      await until(() => state(QT).treeActivated === 'Engineering/Backend/Bob', 'Bob activated');
      expect(['Engineering', 'Backend'].every((n) => state(QT).expanded.includes(n)), JSON.stringify(state(QT)));
      expect(changes(r1.d1).some((c) => c.kind === '+' && c.body.includes('Backend')), `expansion not in the diff:\n${r1.d1}`);
      expect(changes(r1.d2).some((c) => c.kind === '+' && c.body.includes('Alice')), `expansion not in the diff:\n${r1.d2}`);
      // Qt recreates every cell object of a tree view when it changes, so tree
      // item IDs cannot survive it; the table beside it must keep its IDs.
      expect(has(r1.t1, find(r1.t1, 'Engineering'), 'expanded'), `Engineering not shown expanded:\n${r1.t1}`);
      expect(has(r1.t3, find(r1.t3, 'Bob'), 'selected'), `Bob not shown selected:\n${r1.t3}`);
      expect(find(r1.t3, 'Product 00') === find(r1.t0, 'Product 00') && find(r1.t3, 'Prices') === find(r1.t0, 'Prices'),
        'IDs of the unchanged table changed');

      // A table row partly below the viewport lies over the Trap button.
      const overTrap = state(QT).overTrap.find((name) => find(r1.t3, name) !== null);
      if (overTrap !== undefined) {
        const r = await run(`const error = await wTry(async () => wqt.click(e2eIndex(${full('wqt')}, ${JSON.stringify(overTrap)})));
          await wqt.getAXState({ emit: false }); await wResult({ error });`);
        if (r.error === null) await until(() => state(QT).cell[0] === Number(overTrap.slice(8)), `${overTrap} is the current cell`);
        expect(state(QT).trap === 0, `the click on ${overTrap} (out of view) went through to the Trap button: ${JSON.stringify(r)}`);
      }
      // Rows below the viewport are not on screen; scroll page by page until the target is.
      const target = 'Product 30';
      let listed = null;
      for (let n = 0; n < 20 && listed === null; n++) {
        const tree = await js(`await nodeRepl.write(${full('wqt')});`);
        listed = find(tree, target);
        if (listed !== null) break;
        const [first, last] = await settled(() => state(QT).tableRows, 'table at rest');
        await js(`await wqt.scroll(await e2eFind(wqt, "Prices"), "down", 1); await wqt.getAXState({ emit: false });`);
        await until(() => state(QT).tableRows[0] !== first, 'the table scrolled');
        const [after] = await settled(() => state(QT).tableRows, 'table scrolling settled');
        expect(after > first && after <= last + 1, `a one-page scroll skipped rows: ${first}..${last} -> ${JSON.stringify(state(QT).tableRows)}`);
      }
      expect(listed !== null, `${target} never appeared: ${JSON.stringify(state(QT))}`);
      await js(`await wqt.click(${listed}); await wqt.getAXState({ emit: false });`);
      await until(() => JSON.stringify(state(QT).cell) === '[30,0]', `${target} is the current cell`);
      expect(state(QT).tab === 0 && state(QT).treeActivated === 'Engineering/Backend/Bob' && state(QT).trap === 0,
        `a click in the table hit something else: ${JSON.stringify(state(QT))}`);

      const row = state(QT).tableRows[0] + 1;
      const product = `Product ${String(row).padStart(2, '0')}`;
      const edit = await run(`const t = ${full('wqt')};
        const rows = t.split(String.fromCharCode(10)).map((l) => l.trim());
        const at = rows.findIndex((l) => l.startsWith(e2eIndex(t, ${JSON.stringify(product)}) + " "));
        const price = Number(rows.slice(at + 1).find((l) => /^\\d+ table cell(?: \\([^)]*\\))? ${row * 10}(,|$)/.test(l)).split(" ")[0]);
        await wqt.click(price); await wqt.pressKey("F2"); await wqt.pressKey("ctrl+a"); await wqt.typeText("123"); await wqt.pressKey("Return");
        const d = ${diff('wqt')}; await wResult({ price, d, t: ${full('wqt')} });`);
      await until(() => state(QT).prices[product] === '123', `${product} price edited`);
      expect(lineOf(edit.t, edit.price)?.includes('123'), `the edited cell shows ${lineOf(edit.t, edit.price)}`);

      await selectTab('wqt', 'Settings', () => state(QT).tab === 1);
      const t2 = await js(`await nodeRepl.write(${full('wqt')});`);
      expect(find(t2, 'Departments') === null && find(t2, 'Prices') === null, `the hidden Items tab is listed:\n${t2}`);
      const ids = { theme: withRole(t2, 'combo box'), autosave: find(t2, 'Autosave', 'check box'), daily: find(t2, 'Daily', 'radio button'),
        weekly: find(t2, 'Weekly', 'radio button'), retries: find(t2, 'Retries', 'spin button'), zoom: find(t2, 'Zoom', 'slider'),
        indexing: find(t2, 'Indexing', 'progress bar'), disabled: find(t2, 'Disabled action', 'button'), reveal: find(t2, 'Reveal', 'button') };
      expect(Object.values(ids).every((id) => id !== null), `controls missing: ${JSON.stringify(ids)}\n${t2}`);
      expect(find(t2, 'Hidden action') === null, `a hidden button is listed:\n${t2}`);
      expect(lineOf(t2, ids.theme).includes('Light'), `the combo box does not show its value: ${lineOf(t2, ids.theme)}`);
      expect(numberIn(lineOf(t2, ids.indexing)) === 40, `the progress bar does not show its value: ${lineOf(t2, ids.indexing)}`);
      expect(numberIn(lineOf(t2, ids.zoom)) === 100, `the slider does not show its value: ${lineOf(t2, ids.zoom)}`);
      expect(statesOf(lineOf(t2, ids.disabled)).includes('disabled'), `not shown disabled: ${lineOf(t2, ids.disabled)}`);

      const combo = await run(`await wqt.click(${ids.theme}); const opened = ${diff('wqt')};
        const error = await wTry(async () => wqt.click(e2eIndex(${full('wqt')}, "Solarized")));
        if (error) await wqt.pressKey("Escape");
        await wqt.getAXState({ emit: false }); await wResult({ opened, error, t: ${full('wqt')} });`);
      expect(combo.error === null, `choosing from the combo popup failed: ${combo.error}\n${combo.opened}`);
      await until(() => state(QT).theme === 'Solarized', 'Solarized chosen');
      expect(lineOf(combo.t, ids.theme).includes('Solarized'), `the combo box shows ${lineOf(combo.t, ids.theme)}`);

      const r2 = await run(`await wqt.click(${ids.autosave}); await wqt.click(${ids.weekly});
        await wqt.setValue(${ids.retries}, "7"); await wqt.setValue(${ids.zoom}, "150");
        const error = await wTry(async () => wqt.click(${ids.disabled}));
        await wqt.getAXState({ emit: false }); await wResult({ error, t: ${full('wqt')} });`);
      await until(() => { const s = state(QT); return s.autosave && s.schedule === 'Weekly' && s.retries === 7 && s.zoom === 150; },
        'settings changed in the app');
      expect(state(QT).disabledClicks === 0, `a disabled button was activated: ${r2.error}`);
      expect(has(r2.t, ids.autosave, 'checked') && has(r2.t, ids.weekly, 'checked') && !has(r2.t, ids.daily, 'checked'), `states:\n${r2.t}`);
      expect(numberIn(lineOf(r2.t, ids.retries)) === 7 && numberIn(lineOf(r2.t, ids.zoom)) === 150,
        `values in the tree: ${lineOf(r2.t, ids.retries)} / ${lineOf(r2.t, ids.zoom)}`);

      const r3 = await run(`await wqt.click(${ids.reveal}); const d = ${diff('wqt')}; await wResult({ d, t: ${full('wqt')} });`);
      await until(() => state(QT).revealed, 'revealed in the app');
      const shown = find(r3.t, 'Hidden action', 'button');
      expect(shown !== null && changes(r3.d).some((c) => c.kind === '+' && c.id === shown), `the revealed button was not added:\n${r3.d}`);
      expect(has(r3.t, ids.autosave, 'disabled'), `Autosave not shown disabled: ${lineOf(r3.t, ids.autosave)}`);
    }), { needs: hasQt ? null : 'PyQt6 not installed' });

  test('widgets Chromium: labelled form controls, ARIA switch and tabs, disabled and hidden buttons, contenteditable and an iframe form',
    guarded('web-forms', 'wweb', webWindow, async () => {
      await openWeb();
      const t0 = await js(`await nodeRepl.write(${full('wweb')});`);
      const ids = { email: find(t0, 'Email address', 'entry'), terms: find(t0, 'Accept terms', 'check box'), free: find(t0, 'Free', 'radio button'),
        pro: find(t0, 'Pro', 'radio button'), dark: find(t0, 'Dark mode'), disabled: find(t0, 'Disabled submit', 'button'),
        overview: find(t0, 'Overview action', 'button'), details: find(t0, 'Details', 'page tab'), notes: find(t0, 'Notes'),
        frameField: find(t0, 'Frame field', 'entry'), frameButton: find(t0, 'Frame button', 'button') };
      expect(Object.values(ids).every((id) => id !== null), `controls missing: ${JSON.stringify(ids)}\n${t0}`);
      expect(find(t0, 'Hidden submit') === null && find(t0, 'Invisible submit') === null && find(t0, 'Details action') === null,
        `hidden controls are listed:\n${t0}`);
      expect(statesOf(lineOf(t0, ids.disabled)).includes('disabled'), `not shown disabled: ${lineOf(t0, ids.disabled)}`);
      expect(has(t0, ids.free, 'checked') && !has(t0, ids.pro, 'checked') && !has(t0, ids.dark, 'checked'), `initial states:\n${t0}`);

      await js(`await wweb.setValue(${ids.email}, "ada@example.com"); await wweb.getAXState({ emit: false });`);
      await until(() => web().email === 'ada@example.com', 'email typed into the page');
      const r1 = await run(`await wweb.click(${ids.terms}); await wweb.click(${ids.dark}); const before = ${full('wweb')};
        await wweb.click(${ids.pro}); const d = ${diff('wweb')};
        await wResult({ before, d, t: ${full('wweb')} });`);
      await until(() => { const s = web(); return s.terms && s.dark && s.plan === 'pro'; }, 'check box, switch and radio changed in the page');
      expect(has(r1.t, ids.terms, 'checked') && has(r1.t, ids.dark, 'checked') && has(r1.t, ids.pro, 'checked') && !has(r1.t, ids.free, 'checked'),
        `states in the tree:\n${r1.t}`);
      expect(changes(r1.d).some((c) => c.id === ids.free) && changes(r1.d).some((c) => c.id === ids.pro), `the radio change is not one diff:\n${r1.d}`);
      onlyChanged(r1.d, r1.before, [ids.free, ids.pro], 'radio');
      const r2 = await run(`const error = await wTry(async () => wweb.click(${ids.disabled})); await wweb.getAXState({ emit: false });
        await wResult({ error });`);
      expect(web().disabled === 0, `a disabled button was activated: ${r2.error}`);

      // ARIA tabs: the hidden panel's controls leave and enter the tree.
      const r3 = await run(`await wweb.click(${ids.details}); const d = ${diff('wweb')}; const t = ${full('wweb')};
        const stale = await wTry(async () => wweb.click(${ids.overview}));
        await wweb.click(e2eIndex(t, "Details action", "button")); await wweb.getAXState({ emit: false });
        await wResult({ d, t, stale });`);
      await until(() => web().tab === 'b' && web().details === 1, 'Details tab and its button');
      expect(web().overview === 0, `a control of the hidden panel was pressed: ${r3.stale}`);
      expect(removed(r3.d).includes(ids.overview) && changes(r3.d).some((c) => c.kind === '+' && c.body.includes('Details action')),
        `the panel switch is not in the diff:\n${r3.d}`);
      expect(has(r3.t, ids.details, 'selected') && !has(r3.t, find(r3.t, 'Overview', 'page tab'), 'selected'), `tab selection:\n${r3.t}`);

      await js(`await wweb.setValue(${ids.notes}, "Meeting at noon"); await wweb.getAXState({ emit: false });`);
      await until(() => web().notes === 'Meeting at noon', 'contenteditable value set');
      await js(`await wweb.selectText(${ids.notes}, "noon"); await wweb.typeText("lunch"); await wweb.getAXState({ emit: false });`);
      await until(() => web().notes === 'Meeting at lunch', 'contenteditable selection replaced by typing');
      await js(`await wweb.setValue(${ids.frameField}, "inside frame"); await wweb.click(${ids.frameButton}); await wweb.getAXState({ emit: false });`);
      await until(() => web().frame === 'inside frame' && web().frameClicks === 1, 'the iframe form was used');
      const t = await js(`await nodeRepl.write(${full('wweb')});`);
      expect(find(t, 'Email address', 'entry') === ids.email && find(t, 'Frame field', 'entry') === ids.frameField
        && lineOf(t, ids.email).includes('ada@example.com'), `IDs or values changed:\n${t}`);
    }), { needs: browser ? null : 'no Chromium-based browser' });

  test('widgets Chromium: select dropdown, range value, page scrolling, and controls far below the fold',
    guarded('web-scroll', 'wweb', webWindow, async () => {
      await openWeb();
      const t0 = await js(`await nodeRepl.write(${full('wweb')});`);
      const country = find(t0, 'Country', 'combo box');
      const volume = find(t0, 'Volume', 'slider');
      expect(country !== null && volume !== null, `controls missing:\n${t0}`);
      expect(lineOf(t0, country).includes('Norway'), `the select does not show its value: ${lineOf(t0, country)}`);
      expect(numberIn(lineOf(t0, volume)) === 10, `the range does not show its value: ${lineOf(t0, volume)}`);
      expect(find(t0, 'Kenya') === null, `a closed select lists its options:\n${t0}`);
      const r1 = await run(`await wweb.click(${country}); const opened = ${diff('wweb')};
        const error = await wTry(async () => wweb.click(e2eIndex(${full('wweb')}, "Kenya")));
        if (error) await wweb.pressKey("Escape");
        await wweb.getAXState({ emit: false }); await wResult({ opened, error, t: ${full('wweb')} });`);
      expect(r1.error === null, `choosing from the open select failed: ${r1.error}\n${r1.opened}`);
      await until(() => web().country === 'Kenya', 'Kenya chosen in the page');
      expect(changes(r1.opened).some((c) => c.kind === '+' && c.body.includes('Kenya')), `the open list was not added:\n${r1.opened}`);
      expect(lineOf(r1.t, country).includes('Kenya') && find(r1.t, 'Peru') === null, `after choosing:\n${r1.t}`);

      await js(`await wweb.setValue(${volume}, "70"); await wweb.getAXState({ emit: false });`);
      await until(() => web().volume === 70, 'range value set in the page');
      expect(numberIn(lineOf(await js(`await nodeRepl.write(${full('wweb')});`), volume)) === 70, 'the range does not show its new value');

      // One page down from the top moves by at most the viewport.
      const top = await settled(() => web().y, 'page at rest');
      const viewport = clients().find((c) => c.title.startsWith('Codex E2E Widgets|')).size[1];
      await js(`await wweb.scroll(await e2eFind(wweb, "Codex E2E Widgets", "heading"), "down", 1); await wweb.getAXState({ emit: false });`);
      await until(() => web().y !== top, 'the page scrolled');
      const moved = (await settled(() => web().y, 'page scrolling settled')) - top;
      expect(moved > 0 && moved <= viewport, `one page moved the page by ${moved} px; the window is ${viewport} px tall`);

      const r2 = await run(`const t = ${full('wweb')};
        const checkbox = e2eIndex(t, "Far checkbox", "check box"); const button = e2eIndex(t, "Far button", "button");
        const errors = [await wTry(async () => wweb.click(checkbox)), await wTry(async () => wweb.click(button))];
        await wweb.getAXState({ emit: false }); await wResult({ errors, t: ${full('wweb')}, checkbox });`);
      expect(r2.errors.every((e) => e === null), `controls far below the fold could not be used: ${JSON.stringify(r2.errors)}`);
      await until(() => web().far && web().farClicks === 1, 'far checkbox and button used');
      expect(has(r2.t, r2.checkbox, 'checked'), `far checkbox not shown checked: ${lineOf(r2.t, r2.checkbox)}`);
    }), { needs: browser ? null : 'no Chromium-based browser' });
  // TEMPORARY probe: how each toolkit moves content for one scroll event of each kind.
  test('widgets probe: scroll sources', async () => {
    await open('wg4', G4); await open('wqt', QT); await openWeb();
    await selectTab('wqt', 'Items', () => state(QT).tab === 0);
    const apps = [
      ['wg4', () => clients().find((c) => c.class === G4), () => state(G4).scroll, [280, 120],
        [['finger 20', {}, 20], ['finger 60', {}, 60]]],
      ['wweb', webWindow, () => web().y, null, [['finger 20', {}, 20], ['finger 60', {}, 60]]],
      ['wqt', () => clients().find((c) => c.class === QT), () => [state(QT).tableScroll, ...state(QT).tableRows, state(QT).wheels ?? [], state(QT).popup], [260, 448],
        [['finger', {}, 100], ['finger no leave', { leave: false }, 100], ['wheel', { source: 'wheel', value120: 120 }, 15],
          ['wheel no leave', { source: 'wheel', value120: 120, leave: false }, 15]]],
    ];
    const results = {};
    for (const [name, window, read, point, variants] of apps) {
      const c = window();
      const at = point ?? [c.size[0] / 2, c.size[1] / 2];
      results[name] = { point: at };
      for (const [label, options, amount] of variants) {
        for (const direction of [1, -1]) {
          const before = await settled(read, 'at rest');
          const reply = execFileSync('hyprctl', ['codex-background', JSON.stringify({ op: 'scroll', address: c.address, x: at[0], y: at[1], dx: 0, dy: direction * amount, ...options })], { encoding: 'utf8' });
          let last = JSON.stringify(read()); let since = Date.now();
          const deadline = Date.now() + 4000;
          while (Date.now() < deadline && Date.now() - since < 800) {
            await js(`await ${name}.getAXState({ emit: false });`);
            const now = JSON.stringify(read());
            if (now !== last) { last = now; since = Date.now(); }
          }
          results[name][`${label}${direction > 0 ? ' down' : ' up'}`] = [before, JSON.parse(last), reply.includes('"ok":true') ? '' : reply];
        }
      }
    }
    // The provider's own scroll of the Qt table.
    await js(`await wqt.scroll(await e2eFind(wqt, "Prices"), "down", 1); await wqt.getAXState({ emit: false });`);
    results.providerQt = await settled(() => [state(QT).tableScroll, state(QT).wheels ?? []], 'qt');
    writeFileSync(join(out, 'widgets-probe.json'), JSON.stringify(results, null, 1));
    throw new Error(`probe:\n${JSON.stringify(results)}`);
  });
}
