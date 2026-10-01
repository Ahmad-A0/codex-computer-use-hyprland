// Multi-step tasks in real applications, checked by their real outcomes (a
// file on disk, a displayed result), as an agent's work would be judged.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensure, entry, existingWindows, expect, js, out, strict, until, which } from '../lib.mjs';

// Real apps get throwaway settings, state and caches, never the user's.
const home = join(out, 'home');
for (const dir of ['config', 'state', 'cache']) mkdirSync(join(home, dir), { recursive: true });
const isolated = `env XDG_CONFIG_HOME=${home}/config XDG_STATE_HOME=${home}/state XDG_CACHE_HOME=${home}/cache `
  + 'GDK_DEBUG=no-portals GTK_USE_PORTAL=0';
const busy = (name) => {
  try { return execFileSync('busctl', ['--user', 'status', name], { stdio: 'pipe' }).length > 0; } catch { return false; }
};
/** Why a real app can't run here, or null. A running single-instance app would
 *  receive our windows, so it is never shared with the user. */
function blocked(program, id, bus, dialogs = false) {
  if (!which(program)) return `${program} not installed`;
  if (!strict && (existingWindows(`${id}.desktop`).length || (bus && busy(bus)))) return `${program} is already running`;
  // Save dialogs are separate windows; until they follow their app's workspace,
  // don't open them on a live desktop.
  if (!strict && dialogs && process.env.E2E_DIALOGS !== '1') return 'VM only until app dialogs follow their app';
  return null;
}

const apps = [
  ['codex-e2e-texteditor', 'GNOME Text Editor', 'gnome-text-editor', `${isolated} gnome-text-editor --standalone`, 'org.gnome.TextEditor'],
  ['codex-e2e-mousepad', 'Mousepad', 'mousepad', `${isolated} mousepad --disable-server`, 'mousepad', null],
  ['codex-e2e-calculator', 'GNOME Calculator', 'gnome-calculator', `${isolated} gnome-calculator --mode=basic`, 'org.gnome.Calculator'],
];
for (const [id, name, , exec, wmclass] of apps) entry(id, name, exec, `StartupWMClass=${wmclass}\n`);
const reason = (id, program, bus, dialogs) => blocked(program, id, bus, dialogs);

/** Type a document, save it through the app's own Save dialog, check the file. */
function saveScenario(test, label, id, program, bus) {
  const file = join(out, `${id}-saved.txt`);
  const wmclass = apps.find((a) => a[0] === id)[4];
  test(`${label}: write a document and save it through the Save dialog`, async () => {
    await ensure('editor', `${id}.desktop`, { timeout: 45000 });
    await js(`await editor.typeText("Written by Codex\\nSecond line ✓"); await editor.pressKey("ctrl+s");`);
    // The dialog is a separate window of the same app; the agent finds it as a user would.
    await js(`let dialog;
      for (let n = 0; n < 50 && !dialog; n++) {
        dialog = (await cua.listWindows({ emit: false })).find((w) => /save/i.test(w.title ?? "") && w.app === ${JSON.stringify(wmclass)});
        if (!dialog) await new Promise((r) => setTimeout(r, 200));
      }
      if (!dialog) throw new Error("No Save dialog: " + JSON.stringify(await cua.listWindows({ emit: false })));
      globalThis.save = await cua.getApp({ windowId: dialog.id });
      const tree = await save.getAXState({ emit: false, disableDiffing: true });
      await save.setValue(e2eIndex(tree, "Name", "text"), ${JSON.stringify(file)});
      await save.pressKey("Return");`, { timeout: 30000 });
    await until(() => existsSync(file) && readFileSync(file, 'utf8').startsWith('Written by Codex\nSecond line ✓'),
      'saved file contents', 10000);
    await js(`delete globalThis.editor;`);
  }, { needs: reason(id, program, bus, true) });
}

export default function (test) {
  saveScenario(test, 'GNOME Text Editor (GTK 4)', 'codex-e2e-texteditor', 'gnome-text-editor', 'org.gnome.TextEditor');
  saveScenario(test, 'Mousepad (GTK 3)', 'codex-e2e-mousepad', 'mousepad', null);

  test('GNOME Calculator: compute with the real buttons', async () => {
    await ensure('calc', 'codex-e2e-calculator.desktop', { timeout: 45000 });
    const text = await js(`for (const name of ["1", "2", "×", "3", "4", "="]) {
        const tree = await calc.getAXState({ emit: false, disableDiffing: true });
        await calc.click(e2eIndex(tree, name, "button"));
      }
      await nodeRepl.write(await calc.getAXState({ emit: false, disableDiffing: true }));`, { timeout: 30000 });
    expect(/\b408\b/.test(text), `result 408 not shown:\n${text.slice(-2000)}`);
  }, { needs: reason('codex-e2e-calculator', 'gnome-calculator', 'org.gnome.Calculator') });
}
