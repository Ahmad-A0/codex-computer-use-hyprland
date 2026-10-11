// More real applications doing multi-step tasks, each judged by its real
// outcome as an agent's work would be: files on disk, saved settings, data a
// page received. They cover what is hard for a computer-use backend: in-window
// GTK 4 dialogs and popovers, menu bars, toolbars, toolkit file dialogs and
// their follow-up dialogs, a browser form's native controls, Qt dialogs, and an
// office suite under XWayland.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bind, clients, entry, existingWindows, expect, fixtures, js, launchedClasses, out, strict, until, which,
  windowId } from '../lib.mjs';

// Throwaway settings, state, caches and documents; never the user's.
const base = join(out, 'realapps2');
rmSync(base, { recursive: true, force: true });
const home = join(base, 'home');
for (const dir of ['config', 'state', 'cache']) mkdirSync(join(home, dir), { recursive: true });
const keyfile = join(home, 'config/glib-2.0/settings/keyfile');
// GSettings go to a key file in that home (not the user's dconf), so settings
// an app saves can be read back.
const isolated = `env XDG_CONFIG_HOME=${home}/config XDG_STATE_HOME=${home}/state XDG_CACHE_HOME=${home}/cache `
  + 'GSETTINGS_BACKEND=keyfile GDK_DEBUG=no-portals GTK_USE_PORTAL=0';
const docs = join(base, 'docs');
mkdirSync(docs, { recursive: true });

const busy = (name) => {
  try { return execFileSync('busctl', ['--user', 'status', name], { stdio: 'pipe' }).length > 0; } catch { return false; }
};
/** Why a real app can't run here, or null. Single-instance apps the user
 *  already runs would receive our windows, so they are never shared. */
function blocked(program, { id, bus } = {}) {
  if (!which(program)) return `${program} not installed`;
  if (!strict && ((id && existingWindows(`${id}.desktop`).length) || (bus && busy(bus)))) return `${program} is already running`;
  return null;
}

// LibreOffice: a private profile per app, without first-start tips, in US
// English so the CSV's numbers are formatted predictably.
function office(name) {
  const profile = join(base, `lo-${name}`);
  mkdirSync(join(profile, 'user'), { recursive: true });
  const item = (path, prop, value) => `<item oor:path="${path}"><prop oor:name="${prop}" oor:op="fuse"><value>${value}</value></prop></item>`;
  writeFileSync(join(profile, 'user/registrymodifications.xcu'), `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
${item('/org.openoffice.Office.Common/Misc', 'ShowTipOfTheDay', 'false')}
${item('/org.openoffice.Office.Common/Misc', 'FirstRun', 'false')}
${item('/org.openoffice.Office.Common/Misc', 'UseSystemFileDialog', 'true')}
${item('/org.openoffice.Setup/L10N', 'ooSetupSystemLocale', 'en-US')}
${item('/org.openoffice.Setup/L10N', 'ooLocale', 'en-US')}
${item('/org.openoffice.Setup/Product', 'ooSetupLastVersion', '99.0')}
</oor:items>
`);
  return `-env:UserInstallation=file://${profile} --norestore --nologo`;
}

// Firefox: a private profile without first-run pages, in US English (the date
// field's order), opening the form.
const firefoxProfile = join(base, 'firefox');
mkdirSync(firefoxProfile, { recursive: true });
writeFileSync(join(firefoxProfile, 'user.js'), Object.entries({
  'browser.shell.checkDefaultBrowser': false, 'browser.aboutwelcome.enabled': false,
  'datareporting.policy.dataSubmissionEnabled': false, 'datareporting.policy.dataSubmissionPolicyBypassNotification': true,
  'datareporting.policy.firstRunURL': '', 'toolkit.telemetry.reportingpolicy.firstRun': false,
  'browser.startup.homepage_override.mstone': 'ignore', 'startup.homepage_welcome_url': '',
  'startup.homepage_welcome_url.additional': '', 'browser.startup.firstrunSkipsHomepage': true,
  'trailhead.firstrun.didSeeAboutWelcome': true, 'app.normandy.enabled': false, 'browser.translations.enable': false,
  'browser.sessionstore.resume_from_crash': false, 'browser.tabs.warnOnClose': false,
  'browser.newtab.preload': false, 'intl.locale.requested': 'en-US', 'intl.regional_prefs.use_os_locales': false, 'intl.accept_languages': 'en-US, en',
}).map(([key, value]) => `user_pref(${JSON.stringify(key)}, ${JSON.stringify(value)});\n`).join(''));

entry('codex-e2e-nautilus', 'Codex E2E Files', `${isolated} nautilus --new-window ${join(base, 'files')}`,
  'StartupWMClass=org.gnome.Nautilus\n');
entry('codex-e2e-writer', 'Codex E2E Writer', `${isolated} SAL_USE_VCLPLUGIN=gtk3 soffice ${office('writer')} --writer`,
  'StartupWMClass=libreoffice-writer\n');
entry('codex-e2e-calc-x11', 'Codex E2E Calc', `${isolated} SAL_USE_VCLPLUGIN=gtk3 GDK_BACKEND=x11 soffice ${office('calc')} --calc`,
  'StartupWMClass=libreoffice-calc\n');
entry('codex-e2e-firefox', 'Codex E2E Firefox', `${isolated} MOZ_ENABLE_WAYLAND=1 firefox --no-remote --new-instance `
  + `--profile ${firefoxProfile} file://${join(fixtures, 'form.html')}`);
entry('codex-e2e-mousepad-prefs', 'Codex E2E Mousepad Preferences', `${isolated} mousepad --disable-server`,
  'StartupWMClass=org.xfce.mousepad\n');
entry('codex-e2e-gte-replace', 'Codex E2E Text Editor Replace',
  `${isolated} gnome-text-editor --standalone ${join(docs, 'letter.txt')}`, 'StartupWMClass=org.gnome.TextEditor\n');
entry('codex-e2e-featherpad', 'Codex E2E FeatherPad', `${isolated} QT_QPA_PLATFORM=wayland featherpad --standalone`,
  'StartupWMClass=featherpad\n');
// Dialog windows of these apps may report other classes; include them in the report and cleanup.
for (const name of ['soffice', 'libreoffice-startcenter', 'FeatherPad']) launchedClasses.add(name);

// REPL helper: the ID of the n-th element whose tree line (after its ID)
// matches a pattern; negative n counts from the end, where open menus are.
// Lines are "<role> (<states>) <name>, <details>"; menu items have no role.
// Waits up to timeout ms for it, as an agent observes again after an action.
async function r2Find(app, source, flags, options) {
  const { timeout = 0, nth = 0, enabled = false } = options ?? {};
  const pattern = new RegExp(source, flags);
  const deadline = Date.now() + timeout;
  for (;;) {
    const tree = await app.getAXState({ emit: false, disableDiffing: true });
    const hits = [];
    for (const raw of tree.split(String.fromCharCode(10))) {
      const match = raw.trim().match(/^(\d+) (.*)$/);
      if (!match || !pattern.test(match[2])) continue;
      if (enabled && /^[^(]*\([^)]*\bdisabled\b/.test(match[2])) continue;
      hits.push(Number(match[1]));
    }
    const hit = hits.at(nth);
    if (hit !== undefined) return hit;
    // The pattern goes last: tool errors keep only their end.
    if (Date.now() >= deadline) throw new Error(`${tree.slice(0, 6000)}\nNo element matching /${source}/ in the tree above`);
    await new Promise((done) => setTimeout(done, 300));
  }
}
const helpers = `${r2Find}; globalThis.r2Find = r2Find;`;
/** REPL expression for an element ID, see r2Find. */
const find = (app, pattern, options = {}) =>
  `(await r2Find(${app}, ${JSON.stringify(pattern.source)}, ${JSON.stringify(pattern.flags)}, ${JSON.stringify(options)}))`;
/** A line for a role (regex source; '' for menu items, which have none) and an exact name (regex source). */
const el = (role, name) => new RegExp(`^${role ? `(?:${role}) ` : ''}(?:\\([^)]*\\) )?(?:${name})(?:,|$)`);
/** A menu item (plain ones are printed without a role). */
const item = (name) => new RegExp(`^(?:(?:radio |check )?menu item )?(?:\\([^)]*\\) )?(?:${name})(?:,|$)`);
const button = (name) => el('push button|button|toggle button', name);
const settable = (name) => new RegExp(`^(?:text|entry|spin button) \\([^)]*settable[^)]*\\)${name === undefined ? '' : ` (?:${name})(?:,|$)`}`);
/** An editable field by its current value (a lone value is printed without its "Value: " title). */
const holding = (value) => new RegExp(`^(?:text|entry) \\([^)]*settable[^)]*\\) (?:.*Value: )?${value}`);

// REPL variables this file binds, for failure diagnostics; processes it
// launched, closed when the next of its tests starts.
const bound = new Set();
const launched = [];
async function retire() {
  const pids = launched.splice(0).filter(Boolean);
  for (const pid of pids) try { process.kill(pid, 'SIGKILL'); } catch {}
  await until(() => !clients().some((c) => pids.includes(c.pid)), 'earlier apps closed', 10000);
}
// Hyprland reuses a closed window's address, so a window is its address and owner.
const key = (c) => `${c.address}/${c.pid}`;
const addresses = () => new Set(clients().map(key));
async function bindWindow(variable, c) {
  await js(`globalThis.${variable} = await cua.getApp({ windowId: ${windowId(c)} });`, { timeout: 60000 });
  bound.add(variable);
}
/** launch_app, then bind the new window, as for apps whose window class differs from their entry. */
async function launch(variable, id, match, timeout = 90000) {
  const before = addresses();
  await js(`await cua.computer.launch_app({ app: ${JSON.stringify(`${id}.desktop`)} });`);
  let found;
  await until(() => Boolean(found = clients().find((c) => !before.has(key(c)) && match(c))), `${id} window`, timeout);
  launched.push(found.pid);
  await bindWindow(variable, found);
  return found;
}
/** A window the app opened itself (a dialog), found as a user sees it appear. */
async function opened(variable, pid, known, title = /./, timeout = 20000) {
  let found;
  await until(() => Boolean(found = clients().find((c) => c.pid === pid && !known.has(key(c)) && title.test(c.title))),
    `new window ${title} of ${pid} (have: ${JSON.stringify(clients().map((c) => [c.pid, c.class, c.title]))})`, timeout);
  await bindWindow(variable, found);
  return found;
}
const read = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null);

/** A test that saves the full trees of its windows when it fails. */
function scenario(test, name, needs, run) {
  test(name, async () => {
    try {
      await js(helpers);
      await run();
    } catch (error) {
      try {
        const text = await js(`const result = {};
          for (const name of ${JSON.stringify([...bound])}) {
            if (globalThis[name] === undefined) continue;
            try { result[name] = await globalThis[name].getAXState({ emit: false, disableDiffing: true }); }
            catch (error) { result[name] = String(error); }
          }
          await nodeRepl.write("R2TREES" + JSON.stringify(result));`);
        const slug = name.replace(/[^A-Za-z0-9]+/g, '-').slice(0, 60);
        writeFileSync(join(out, `realapps2-${slug}.json`), JSON.stringify({
          trees: JSON.parse(text.slice(text.indexOf('R2TREES') + 7)),
          clients: clients().map((c) => ({ class: c.class, title: c.title, pid: c.pid, xwayland: c.xwayland })),
        }, null, 2));
      } catch {}
      throw error;
    }
  }, { needs });
}

export default function (test) {
  scenario(test, 'Nautilus (GTK 4): new folder dialog, rename from the context menu and with F2',
    blocked('nautilus', { id: 'codex-e2e-nautilus', bus: 'org.gnome.Nautilus' }), async () => {
      await retire();
      const dir = join(base, 'files');
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'draft-report.txt'), 'quarterly numbers\n');
      writeFileSync(join(dir, 'notes.md'), '# notes\n');
      const before = addresses();
      await bind('files', 'codex-e2e-nautilus.desktop', { timeout: 60000 });
      bound.add('files');
      launched.push(clients().find((c) => c.class === 'org.gnome.Nautilus' && !before.has(key(c)))?.pid);
      await js(`${find('files', /draft-report\.txt/, { timeout: 30000 })};`);
      // A new folder through the app's in-window dialog.
      await js(`await files.pressKey("ctrl+shift+n");
        ${find('files', button('Create'), { timeout: 10000 })};
        // The dialog's name field (the window has no other editable field).
        await files.setValue(${find('files', settable(), { nth: -1 })}, "Archive 2026");
        await files.click(${find('files', button('Create'), { timeout: 5000, enabled: true })});`, { timeout: 30000 });
      await until(() => existsSync(join(dir, 'Archive 2026')) && statSync(join(dir, 'Archive 2026')).isDirectory(),
        'new folder on disk', 10000);
      // Rename through the file's context menu and the rename popover.
      await js(`await files.click(${find('files', /draft-report\.txt/)}, { mouseButton: "right" });
        await files.click(${find('files', item('Rename…|Rename\\.\\.\\.|Rename'), { timeout: 5000, nth: -1 })});
        await files.setValue(${find('files', holding('draft-report\\.txt'), { timeout: 5000 })}, "final-report.txt");
        await files.click(${find('files', button('Rename'), { timeout: 5000, enabled: true })});`, { timeout: 30000 });
      await until(() => read(join(dir, 'final-report.txt')) === 'quarterly numbers\n' && !existsSync(join(dir, 'draft-report.txt')),
        'renamed file on disk', 10000);
      // Rename with the keyboard: select, F2, type over the preselected base name.
      await js(`await files.click(${find('files', /^(?!.*settable).*\bnotes\.md\b/, { timeout: 5000 })});
        await files.pressKey("F2");
        ${find('files', holding('notes\\.md'), { timeout: 5000 })};
        await files.typeText("meeting-notes"); await files.pressKey("Return");`, { timeout: 30000 });
      await until(() => read(join(dir, 'meeting-notes.md')) === '# notes\n' && !existsSync(join(dir, 'notes.md')),
        'F2-renamed file on disk', 10000);
    });

  scenario(test, 'LibreOffice Writer: heading from the menu bar, bold from the toolbar, Save As .odt',
    blocked('soffice'), async () => {
      await retire();
      const file = join(docs, 'report.odt');
      rmSync(file, { force: true });
      const main = await launch('writer', 'codex-e2e-writer', (c) => /LibreOffice Writer|Writer$/.test(c.title));
      await js(`${find('writer', /^paragraph\b/, { timeout: 60000 })};
        await writer.typeText("Quarterly report\\nRevenue grew strongly this year.");
        ${find('writer', /Revenue grew strongly this year\./, { timeout: 10000 })}; // typed
        // The heading: caret into the first paragraph, then Styles > Heading 1.
        await writer.pressKey("ctrl+Home");
        await writer.click(${find('writer', el('menu', 'Styles'), { timeout: 5000 })});
        await writer.click(${find('writer', item('Heading 1'), { timeout: 5000, nth: -1 })});
        // Bold: select a word by its text, then the toolbar's Bold button.
        await writer.selectText(${find('writer', /Revenue grew strongly this year\./)}, "strongly");
        await writer.click(${find('writer', button('Bold'), { timeout: 5000 })});`, { timeout: 120000 });
      const known = addresses();
      await js(`await writer.pressKey("ctrl+shift+s");`);
      await opened('saveas', main.pid, known, /Save/i);
      await js(`await saveas.setValue(${find('saveas', settable('Name:?'), { timeout: 10000 })}, ${JSON.stringify(file)});
        await saveas.click(${find('saveas', button('Save'), { enabled: true })});`, { timeout: 30000 });
      await until(() => existsSync(file) && statSync(file).size > 0, 'saved document', 20000);
      let content = '';
      await until(() => {
        content = execFileSync('python3', ['-c', 'import sys, zipfile; print(zipfile.ZipFile(sys.argv[1]).read("content.xml").decode())', file],
          { encoding: 'utf8' });
        return true;
      }, 'readable OpenDocument', 10000);
      const plain = content.replace(/<[^>]+>/g, '');
      expect(plain.includes('Quarterly report') && plain.includes('Revenue grew strongly this year.'), `text missing:\n${content}`);
      expect(/<text:h\b[^>]*text:outline-level="1"[^>]*>Quarterly report<\/text:h>/.test(content), `no level-1 heading:\n${content}`);
      const span = content.match(/<text:span text:style-name="([^"]+)">strongly<\/text:span>/);
      expect(span, `"strongly" has no character style:\n${content}`);
      const style = content.match(new RegExp(`<style:style style:name="${span[1]}"[^>]*>(.*?)</style:style>`))?.[1] ?? '';
      expect(/fo:font-weight="bold"/.test(style), `"strongly" is not bold (${span[1]}: ${style})`);
      expect(!/<text:span[^>]*>Revenue/.test(content), `more than the word was formatted:\n${content}`);
    });

  scenario(test, 'LibreOffice Calc (XWayland): cells and formulas, Save As CSV with the file type and format dialogs',
    blocked('soffice'), async () => {
      await retire();
      const file = join(docs, 'budget.csv');
      rmSync(file, { force: true });
      const main = await launch('calc', 'codex-e2e-calc-x11', (c) => /LibreOffice Calc|Calc$/.test(c.title));
      expect(main.xwayland, 'Calc is not running under XWayland');
      // Tab enters a cell and moves right; Return goes to the next row's first
      // column. The Name Box shows the current cell and moves to one typed into
      // it. (Moving over empty cells with Tab while typing ahead races in Calc:
      // typed text can land in the cell being left.)
      const cell = (name) => new RegExp(`^text \\([^)]*settable[^)]*\\) (?:Value: )?${name}(?:,|$)`);
      await js(`${find('calc', /\b(?:table|Sheet1)\b/, { timeout: 60000 })};
        await calc.typeText("Item\\tQty\\tPrice\\tTotal\\nApples\\t3\\t0.5\\t=B2*C2\\nBread\\t2\\t1.25\\t=B3*C3\\nSum\\n");
        await calc.click(${find('calc', cell('A5'), { timeout: 10000 })});
        await calc.pressKey("ctrl+a"); await calc.typeText("D4\\n");
        ${find('calc', cell('D4'), { timeout: 10000 })};
        await calc.typeText("=SUM(D2:D3)\\n");
        ${find('calc', cell('D5'), { timeout: 10000 })};`,
      { timeout: 90000 });
      const known = addresses();
      await js(`await calc.pressKey("ctrl+shift+s");`);
      await opened('saveas', main.pid, known, /Save/i);
      // The file type decides the format, not the name: choose it in the
      // file type list (a closed list shows no items), then name the file.
      await js(`await saveas.click(${find('saveas', /^combo box\b.*\(\.ods\)/, { timeout: 10000 })});
        await saveas.click(${find('saveas', item('Text CSV \\(\\.csv\\)'), { timeout: 5000, nth: -1 })});
        // The dialog's own name field ("Name:"), not its hidden rename popover's "Name".
        await saveas.setValue(${find('saveas', settable('Name:'))}, ${JSON.stringify(file)});
        ${find('saveas', holding(file.replace(/[.]/g, '\\.')), { timeout: 3000 })};
        await saveas.click(${find('saveas', button('Save'), { enabled: true })});`, { timeout: 30000 });
      // LibreOffice asks whether to keep the non-ODF format. (The new dialog
      // may take the closed Save dialog's address: find it by its title.)
      await opened('keep', main.pid, new Set([key(main)]), /^(?!.*Save)/);
      await js(`await keep.click(${find('keep', button('Use Text CSV Format!?'), { timeout: 10000 })});`);
      // Depending on settings, the CSV export options follow; accept them.
      let options;
      await until(() => existsSync(file) || Boolean(options = clients().find((c) => c.pid === main.pid
        && /Export Text File|Text Export/i.test(c.title))), 'CSV written or export options', 20000);
      if (!existsSync(file)) {
        await bindWindow('csvopts', options);
        await js(`await csvopts.click(${find('csvopts', button('OK'), { timeout: 10000 })});`);
      }
      await until(() => /Sum,,,4\s*$/.test(read(file) ?? ''), 'CSV with the computed sum', 20000);
      const rows = read(file).replace(/"/g, '').trim().split(/\r?\n/);
      expect(JSON.stringify(rows) === JSON.stringify(['Item,Qty,Price,Total', 'Apples,3,0.5,1.5', 'Bread,2,1.25,2.5', 'Sum,,,4']),
        `unexpected CSV: ${JSON.stringify(rows)}`);
    });

  scenario(test, 'Firefox: fill a form (select, radio, checkboxes, date, number, range, textarea) and submit',
    blocked('firefox'), async () => {
      await retire();
      const title = () => clients().find((c) => c.title.startsWith('Codex E2E Form'))?.title ?? '';
      await launch('form', 'codex-e2e-firefox', (c) => c.title.startsWith('Codex E2E Form'));
      // Each step's failure is collected, so one run shows the whole form's state.
      const text = await js(`const failed = [];
        const attempt = async (label, run) => { try { await run(); } catch (error) { failed.push(label + ": " + error.message); } };
        await attempt("setValue name", async () => form.setValue(${find('form', settable('Full name'), { timeout: 45000 })}, "Ada Lovelace"));
        await attempt("type email", async () => { await form.click(${find('form', settable('Email'))}); await form.typeText("ada@example.org"); });
        // A native select, by keyboard: focused, it selects the option typed.
        // (Its dropdown list does not open in a background window; see the next test.)
        await attempt("country", async () => {
          await form.click(${find('form', el('combo box', 'Country|Choose…'))});
          ${find('form', el('combo box \\([^)]*focused[^)]*\\)', 'Country'), { timeout: 5000 })};
          await form.typeText("Japan");
        });
        await attempt("radio", async () => form.click(${find('form', el('radio button', 'Pro'))}));
        await attempt("checkbox", async () => form.click(${find('form', el('check box', 'Subscribe to newsletter'))}));
        await attempt("setValue seats", async () => form.setValue(${find('form', el('spin button|entry', 'Seats'))}, "3"));
        await attempt("setValue priority", async () => form.setValue(${find('form', el('slider', 'Priority'))}, "7"));
        await attempt("textarea", async () => {
          await form.click(${find('form', settable('Delivery notes'))});
          await form.typeText("Ring the bell twice.\\nDanke ✓");
        });
        // The date's month field, then its digits as a user types them.
        await attempt("date", async () => {
          await form.click(${find('form', el('spin button', '[Mm]onth.*'))});
          await form.typeText("10112026");
          await form.pressKey("Escape");
        });
        await nodeRepl.write("R2FAILED" + JSON.stringify(failed));`, { timeout: 90000 });
      const failed = JSON.parse(text.slice(text.indexOf('R2FAILED') + 8));
      try {
        // Terms are required: the browser refuses the submission first.
        await js(`await form.click(${find('form', button('Place order'))});`);
        await until(() => title().startsWith('Codex E2E Form|invalid:terms'), 'submission refused without terms', 10000);
        // Dismiss the browser's message, as a user does, then accept the terms.
        await js(`await form.pressKey("Escape");
          await form.click(${find('form', el('check box', 'Accept terms'))});
          ${find('form', /^check box \([^)]*\bchecked\b[^)]*\) Accept terms/, { timeout: 5000 })};
          await form.click(${find('form', button('Place order'))});`);
        await until(() => title().startsWith('Codex E2E Form|submitted|'), 'form submitted', 10000);
      } catch (error) {
        throw new Error(`${failed.join('\n')}\n${error.message}`);
      }
      const json = title().slice('Codex E2E Form|submitted|'.length).replace(/ [—-] Mozilla Firefox$/, '');
      const data = JSON.parse(json);
      const expected = { name: 'Ada Lovelace', email: 'ada@example.org', country: 'JP', plan: 'pro', news: 'yes', terms: 'yes',
        start: '2026-10-11', seats: '3', priority: '7', notes: 'Ring the bell twice.\nDanke ✓', submits: 1 };
      expect(!failed.length && JSON.stringify(data) === JSON.stringify(expected),
        `${failed.join('\n')}\nsubmitted ${JSON.stringify(data)}\nexpected  ${JSON.stringify(expected)}`);
    });

  // Known gap, kept as the check for its fix: in a background window Firefox
  // does not open a <select>'s dropdown list, neither for a click (which
  // focuses the select) nor for its AT-SPI "open" action, and Hyprland's log
  // shows it never creates the popup. Its form validation popups do appear.
  scenario(test, 'Firefox: a select\'s dropdown list opens on a click and its option is chosen from it',
    blocked('firefox') ?? 'known gap: Firefox does not open a <select> dropdown in a background window', async () => {
      await retire();
      const title = () => clients().find((c) => c.title.startsWith('Codex E2E Form'))?.title ?? '';
      await launch('form', 'codex-e2e-firefox', (c) => c.title.startsWith('Codex E2E Form'));
      await js(`await form.click(${find('form', el('combo box', 'Country|Choose…'), { timeout: 45000 })});
        await form.click(${find('form', item('Japan'), { timeout: 5000, nth: -1 })});
        await form.click(${find('form', el('check box', 'Accept terms'))});
        await form.setValue(${find('form', settable('Email'))}, "ada@example.org");
        await form.click(${find('form', button('Place order'))});`, { timeout: 90000 });
      await until(() => title().includes('"country":"JP"'), 'Japan submitted', 10000);
    });

  scenario(test, 'Mousepad: Preferences from the menu bar, settings saved in its config',
    blocked('mousepad'), async () => {
      await retire();
      rmSync(keyfile, { force: true });
      const main = await launch('pad', 'codex-e2e-mousepad-prefs', (c) => c.class === 'org.xfce.mousepad');
      const known = addresses();
      await js(`await pad.click(${find('pad', el('menu', 'Edit'), { timeout: 20000 })});
        await pad.click(${find('pad', item('Preferences.*'), { timeout: 5000, nth: -1 })});`);
      await opened('prefs', main.pid, known, /Preferences/i);
      await js(`await prefs.click(${find('prefs', el('check box', '.*[Ll]ine numbers.*'), { timeout: 10000 })});
        await prefs.click(${find('prefs', el('page tab', 'Editor'))});
        await prefs.setValue(${find('prefs', /^spin button \([^)]*settable[^)]*\) Value: 8(?:,|$)/, { timeout: 5000 })}, "3");
        await prefs.pressKey("Escape");`, { timeout: 30000 });
      await until(() => !clients().some((c) => c.pid === main.pid && /Preferences/i.test(c.title)), 'preferences closed', 10000);
      await until(() => /show-line-numbers=true/.test(read(keyfile) ?? '') && /tab-width=(?:uint32 )?3\b/.test(read(keyfile)),
        'settings in the key file', 10000);
    });

  scenario(test, 'GNOME Text Editor (GTK 4): find and replace all in an existing file, then save',
    blocked('gnome-text-editor', { bus: 'org.gnome.TextEditor' }), async () => {
      await retire();
      const file = join(docs, 'letter.txt');
      const original = 'Dear team,\nThe colour of the logo and the colour of the banner should match.\nKeep the colourful header.\n';
      writeFileSync(file, original);
      await launch('letter', 'codex-e2e-gte-replace', (c) => c.class === 'org.gnome.TextEditor' && /letter/.test(c.title));
      await js(`${find('letter', /Dear team,/, { timeout: 30000 })};
        await letter.pressKey("ctrl+h");
        // Type once the search field has taken focus, as a user waits for it.
        ${find('letter', /^text \([^)]*focused[^)]*settable[^)]*\) Search\b/, { timeout: 5000 })};
        await letter.typeText("colour");
        await letter.setValue(${find('letter', settable('.*[Rr]eplace.*'), { timeout: 5000 })}, "color");
        await letter.click(${find('letter', button('Replace All|Replace all'), { timeout: 10000, enabled: true })});
        ${find('letter', /Dear team,\\nThe color of the logo/, { timeout: 5000 })};
        await letter.pressKey("ctrl+s");`, { timeout: 60000 });
      await until(() => read(file) === original.replaceAll('colour', 'color'), 'replaced text saved', 10000);
    });

  scenario(test, 'FeatherPad (Qt 6): Save As through the Qt file dialog, then save again',
    blocked('featherpad'), async () => {
      await retire();
      const file = join(docs, 'qt-notes.txt');
      rmSync(file, { force: true });
      const main = await launch('feather', 'codex-e2e-featherpad', (c) => /featherpad/i.test(`${c.class} ${c.title}`));
      await js(`${find('feather', /^text\b.*settable/, { timeout: 30000 })};
        await feather.typeText("Grüße aus Qt\\nZeile zwei ✓");`, { timeout: 30000 });
      const known = addresses();
      await js(`await feather.pressKey("ctrl+shift+s");`);
      await opened('qtsave', main.pid, known, /Save/i);
      await js(`await qtsave.setValue(${find('qtsave', settable('File name:?'), { timeout: 10000 })}, ${JSON.stringify(file)});
        await qtsave.click(${find('qtsave', button('Save'), { enabled: true })});`, { timeout: 30000 });
      await until(() => (read(file) ?? '').replace(/\n$/, '') === 'Grüße aus Qt\nZeile zwei ✓', 'file saved through the dialog', 10000);
      // The document now has a name: a plain save writes it, no dialog.
      // (FeatherPad ends a saved document with a newline.)
      await js(`await feather.pressKey("ctrl+End"); await feather.typeText("Dritte"); await feather.pressKey("ctrl+s");`);
      await until(() => read(file) === 'Grüße aus Qt\nZeile zwei ✓\nDritte\n', 'file saved again', 10000);
    });
}
