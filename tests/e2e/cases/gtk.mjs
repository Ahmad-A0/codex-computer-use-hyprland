// The public app API against a GTK app, on Wayland and XWayland.
import { readFileSync } from 'node:fs';
import { bind, client, clients, contextMenu, expect, gtk, js, provider, state, until } from '../lib.mjs';

gtk('codex-e2e-gtk', 'Codex E2E GTK');
gtk('codex-e2e-xgtk', 'Codex E2E XWayland', { backend: 'x11' });

export default function (test) {
  test('GTK: getApp launches silently, asks approval, enables accessibility', async () => {
    await bind('gtk', 'codex-e2e-gtk.desktop', { timeout: 30000 });
    const c = client('codex-e2e-gtk');
    expect(c.workspace.name === 'codex', `launched on workspace ${c.workspace.name}`);
    const environment = readFileSync(`/proc/${c.pid}/environ`, 'utf8').split('\0');
    for (const variable of ['ACCESSIBILITY_ENABLED=1', 'QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1', 'GNOME_ACCESSIBILITY=1']) {
      expect(environment.includes(variable), `missing ${variable}`);
    }
    expect(provider.elicitations.some((e) => e.message === 'Allow Computer Use to use "Codex E2E GTK"?'
      && e._meta?.connector_id === 'computer-use'), JSON.stringify(provider.elicitations));
  });

  test('GTK: setValue with Unicode', async () => {
    await js(`await gtk.setValue(await e2eFind(gtk, "E2E entry", "text"), "first café / second café");`);
    await until(() => state('codex-e2e-gtk').text === 'first café / second café', 'entry text');
  });

  test('GTK: selectText with prefix', async () => {
    await js(`await gtk.selectText(await e2eFind(gtk, "E2E entry", "text"), "café", { prefix: "second " });`);
    await until(() => JSON.stringify(state('codex-e2e-gtk').selection) === '[20,24]', 'selection');
  });

  test('GTK: click, cmd+a, paste', async () => {
    await js(`const i = await e2eFind(gtk, "E2E entry", "text"); await gtk.click(i); await gtk.pressKey("cmd+a");
      await gtk.paste("Pasted 世界 ✓", { format: "text" }); await gtk.getAXState({ emit: false });`);
    await until(() => state('codex-e2e-gtk').text === 'Pasted 世界 ✓', 'pasted text');
  });

  test('GTK: typeText', async () => {
    await js(`const i = await e2eFind(gtk, "E2E entry", "text"); await gtk.click(i); await gtk.pressKey("ctrl+a");
      await gtk.typeText("typed é"); await gtk.getAXState({ emit: false });`);
    await until(() => state('codex-e2e-gtk').text === 'typed é', 'typed text');
  });

  test('GTK: numeric setValue', async () => {
    await js(`await gtk.setValue(await e2eFind(gtk, "E2E slider"), "37");`);
    await until(() => state('codex-e2e-gtk').value === 37, 'slider value');
  });

  test('GTK: element click on a button', async () => {
    await js(`await gtk.click(await e2eFind(gtk, "E2E button", "button")); await gtk.getAXState({ emit: false });`);
    await until(() => state('codex-e2e-gtk').clicks === 1, 'button clicks');
  });

  test('GTK: element double-click selects a word', async () => {
    await js(`const i = await e2eFind(gtk, "E2E entry", "text"); await gtk.setValue(i, Array(30).fill("wordy").join(" "));
      await gtk.click(i, { clickCount: 2 }); await gtk.getAXState({ emit: false });`);
    await until(() => { const [a, b] = state('codex-e2e-gtk').selection; return b - a === 5; }, 'word selection');
  });

  test('GTK: right-click menu is observable and usable', async () => {
    // On macOS a context menu appears in the app's accessibility tree. The
    // window is on the hidden "codex" workspace, so this also checks that its
    // screenshot composes the menu.
    await js(`await gtk.setValue(await e2eFind(gtk, "E2E entry", "text"), "menu target");`);
    await contextMenu('gtk', 'E2E entry', 'text', 'Select All', { reopen: true });
    await until(() => JSON.stringify(state('codex-e2e-gtk').selection) === '[0,11]', 'select all from the menu');
  });

  test('GTK: scroll one page', async () => {
    await js(`await gtk.scroll(await e2eFind(gtk, "E2E viewport"), "down", 1); await gtk.getAXState({ emit: false });`);
    await until(() => state('codex-e2e-gtk').scroll > 0, 'scrolled');
  });

  test('GTK: macOS-format diffs and no-change notice', async () => {
    const text = await js(`await e2eFind(gtk, "E2E slider");
      await gtk.setValue(await e2eFind(gtk, "E2E entry", "text"), "diff check");
      await e2eFind(gtk, "E2E slider"); // a full-tree read resets the baseline
      await gtk.setValue(await e2eFind(gtk, "E2E entry", "text"), "diff check two");
      const changed = await gtk.getAXState({ emit: false }); const same = await gtk.getAXState({ emit: false });
      await nodeRepl.write(JSON.stringify({ changed, same }));`);
    const { changed, same } = JSON.parse(text.slice(text.indexOf('{"changed"')));
    expect(changed.includes('The following is a diff from the previous accessibility tree')
      && changed.split('\n').some((l) => l.startsWith('~\t')), changed);
    expect(same.includes('There has been no change in the accessibility tree'), same);
  });

  test('GTK: screenshots of a window on another workspace are current', async () => {
    const text = await js(`const before = await gtk.getScreenshot({ emit: false });
      await gtk.setValue(await e2eFind(gtk, "E2E entry", "text"), "W".repeat(40));
      const after = await gtk.getScreenshot({ emit: false });
      const both = await gtk.getAXStateAndScreenshot({ emit: false });
      await nodeRepl.write(JSON.stringify({ size: after.length, changed: Buffer.compare(Buffer.from(before), Buffer.from(after)) !== 0,
        combined: both.screenshot?.length > 1000 }));`);
    const result = JSON.parse(text.slice(text.lastIndexOf('{')));
    expect(result.size > 1000 && result.combined, text);
    expect(result.changed, 'screenshot did not change after the window changed (stale frame)');
  });

  test('GTK: getApp reuses the running app', async () => {
    const before = clients().length;
    await js(`await cua.getApp("Codex E2E GTK");`);
    expect(clients().length === before, 'a second window was opened');
  });

  test('XWayland: setValue, Unicode typing, click, paste', async () => {
    await bind('xgtk', 'codex-e2e-xgtk.desktop', { timeout: 30000 });
    expect(client('codex-e2e-xgtk').xwayland, 'fixture is not running under XWayland');
    await js(`await xgtk.setValue(await e2eFind(xgtk, "E2E entry", "text"), "x11 value");`);
    await until(() => state('codex-e2e-xgtk').text === 'x11 value', 'setValue');
    await js(`const i = await e2eFind(xgtk, "E2E entry", "text"); await xgtk.click(i); await xgtk.pressKey("ctrl+a");
      await xgtk.typeText("ünïcødé"); await xgtk.getAXState({ emit: false });`);
    await until(() => state('codex-e2e-xgtk').text === 'ünïcødé', 'typed text');
    await js(`await xgtk.click(await e2eFind(xgtk, "E2E button", "button")); await xgtk.getAXState({ emit: false });`);
    await until(() => state('codex-e2e-xgtk').clicks === 1, 'button click');
    await js(`const i = await e2eFind(xgtk, "E2E entry", "text"); await xgtk.click(i); await xgtk.pressKey("ctrl+a");
      await xgtk.paste("x11 paste", { format: "text" }); await xgtk.getAXState({ emit: false });`);
    await until(() => state('codex-e2e-xgtk').text === 'x11 paste', 'pasted text');
  });

  test('XWayland: right-click menu is observable and usable', async () => {
    await js(`await xgtk.setValue(await e2eFind(xgtk, "E2E entry", "text"), "menu target");`);
    await contextMenu('xgtk', 'E2E entry', 'text', 'Select All', { reopen: true });
    await until(() => JSON.stringify(state('codex-e2e-xgtk').selection) === '[0,11]', 'select all from the menu');
  });
}
