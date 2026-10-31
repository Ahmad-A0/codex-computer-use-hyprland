// Windows an app opens itself, and windows that look identical.
import { client, clients, ensure, entry, expect, gtkFixture, hypr, js, launchDirect, out, rejects, state, statePath, stateOf, until }
  from '../lib.mjs';
import { join } from 'node:path';

entry('codex-e2e-twin', 'Codex E2E Twin',
  `/usr/bin/env GDK_BACKEND=wayland python3 ${gtkFixture} ${join(out, 'twin-{pid}.json')} codex-e2e-twin "Codex E2E Twin"`,
  'StartupWMClass=codex-e2e-twin\n');
const dialog = () => clients().find((c) => c.title === 'Codex E2E Dialog');

export default function (test) {
  test('dialog: an app-opened dialog stays out of the user\'s way', async () => {
    await ensure('gtk', 'codex-e2e-gtk.desktop', { timeout: 30000 });
    await js(`await gtk.click(await e2eFind(gtk, "Open dialog", "button"));`);
    await until(() => Boolean(dialog()), 'dialog window', 10000);
    // Like the app's main window it must not take focus or land on the user's workspace.
    expect(hypr('activewindow').title !== 'Codex E2E Dialog', 'the dialog took focus');
    expect(dialog().workspace.name === 'codex', `the dialog opened on workspace ${dialog().workspace.name}`);
  });

  test('dialog: the agent finds and drives it', async () => {
    await ensure('gtk', 'codex-e2e-gtk.desktop', { timeout: 30000 });
    if (!dialog()) await js(`await gtk.click(await e2eFind(gtk, "Open dialog", "button"));`);
    await until(() => Boolean(dialog()), 'dialog window', 10000);
    await js(`globalThis.dlg = await cua.getApp({ windowId: (await e2eWindow("Codex E2E Dialog")).id });
      await dlg.setValue(await e2eFind(dlg, "Dialog entry", "text"), "from the dialog");
      globalThis.dialogOk = await e2eFind(dlg, "Dialog OK", "button");
      await dlg.click(dialogOk);`);
    await until(() => state('codex-e2e-gtk').dialog === 'from the dialog', 'dialog result reached the app');
    await until(() => !dialog(), 'dialog closed');
  });

  test('dialog: a closed window gives a clear error, not a misdirected action', async () => {
    await rejects(`await dlg.click(dialogOk);`, /unavailable|getAXState|refresh/i);
  });

  // macOS delivers input to a window that another window covers. Hyprland
  // marks a window below a fullscreen one as refusing focus; the agent's
  // input goes to the app directly and must still arrive.
  test('covered: input reaches a window below a fullscreen window on its workspace', async () => {
    await ensure('gtk', 'codex-e2e-gtk.desktop', { timeout: 30000 });
    const target = client('codex-e2e-gtk');
    launchDirect(`/usr/bin/env GDK_BACKEND=wayland python3 ${gtkFixture} ${statePath('codex-e2e-cover')} codex-e2e-cover "Codex E2E Cover"`,
      { rules: 'fullscreen on' });
    const cover = () => clients().find((c) => c.title === 'Codex E2E Cover');
    try {
      await until(() => cover()?.fullscreen > 0 && cover().workspace.name === target.workspace.name,
        'a fullscreen window over the target', 20000);
      // The precondition the test is about (hyprctl reports it on releases).
      await until(() => client('codex-e2e-gtk').acceptsInput !== true, 'the target blocked by the fullscreen window');
      const clicks = state('codex-e2e-gtk').clicks;
      await js(`const i = await e2eFind(gtk, "E2E entry", "text");
        await gtk.setValue(i, ""); await gtk.click(i);
        await gtk.typeText("covered"); await gtk.paste(" ✓", { format: "text" });
        await gtk.click(await e2eFind(gtk, "E2E button", "button"));
        const shot = await gtk.getScreenshot({ emit: false });
        if (!(shot && shot.length > 1000)) throw new Error("no screenshot of the covered window");`);
      await until(() => state('codex-e2e-gtk').text === 'covered ✓', 'typing and paste reached the covered window');
      await until(() => state('codex-e2e-gtk').clicks === clicks + 1, 'the click reached the covered window');
      expect(cover()?.fullscreen > 0, 'the cover left fullscreen');
    } finally {
      if (cover()) process.kill(cover().pid, 'SIGTERM');
      await until(() => !cover(), 'cover closed', 10000);
    }
  });

  test('twins: identical windows are each driven exactly', async () => {
    await js(`await cua.computer.launch_app({ app: "codex-e2e-twin.desktop" });
      await cua.computer.launch_app({ app: "codex-e2e-twin.desktop" });`);
    const twins = () => clients().filter((c) => c.title === 'Codex E2E Twin');
    await until(() => twins().length === 2, 'two twin windows', 20000);
    const [a, b] = twins();
    await js(`const ws = (await cua.listWindows({ emit: false })).filter((w) => w.title === "Codex E2E Twin");
      for (const [n, w] of ws.entries()) {
        const app = await cua.getApp({ windowId: w.id });
        await app.setValue(await e2eFind(app, "E2E entry", "text"), "twin " + w.id);
      }`);
    for (const twin of [a, b]) {
      await until(() => stateOf(twin.pid).text === `twin ${parseInt(twin.address, 16)}`, `twin ${twin.address} text`);
    }
  });
}
