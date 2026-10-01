// Sky's lower-level Linux commands, reached through cua.computer.
import { expect, js, state, until } from '../lib.mjs';

export default function (test) {
  test('low-level: held Shift extends a selection across key presses', async () => {
    await js(`const w = await e2eWindow("Codex E2E GTK"); const i = await e2eFind(gtk, "E2E entry", "text");
      await gtk.setValue(i, "abcdef"); await gtk.click(i);
      await cua.computer.press_key({ window: w, key: "End" });
      await cua.computer.key_down({ window: w, key: "shift" });
      try { for (let n = 0; n < 3; n++) await cua.computer.press_key({ window: w, key: "Left" }); }
      finally { await cua.computer.key_up({ window: w, key: "shift" }); }
      await gtk.getAXState({ emit: false });`);
    await until(() => JSON.stringify(state('codex-e2e-gtk').selection) === '[3,6]', 'shift selection');
  });

  test('low-level: modifier held for one click (ctrl+click)', async () => {
    await js(`const w = await e2eWindow("Codex E2E GTK");
      await cua.computer.click({ window: w, element_id: String(await e2eFind(gtk, "E2E button", "button")), key: "ctrl" });
      await gtk.getAXState({ emit: false });`);
    await until(() => state('codex-e2e-gtk').clicks >= 2, 'ctrl+click reached the button');
  });

  test('low-level: type_text into a specific element', async () => {
    await js(`const w = await e2eWindow("Codex E2E GTK"); const i = await e2eFind(gtk, "E2E entry", "text");
      await gtk.setValue(i, "start");
      await cua.computer.type_text({ window: w, element_id: String(i), text: "+typed" });
      await gtk.getAXState({ emit: false });`);
    await until(() => state('codex-e2e-gtk').text.includes('+typed'), 'element typing');
  });

  test('low-level: clipboard snapshot round trip', async () => {
    await js(`const w = await e2eWindow("Codex E2E GTK"); const i = await e2eFind(gtk, "E2E entry", "text");
      await gtk.setValue(i, "snapshot ✓"); await gtk.click(i); await gtk.pressKey("ctrl+a");
      const handle = await cua.computer.clipboard_read({ window: w });
      try {
        await gtk.setValue(i, ""); await gtk.click(i);
        await cua.computer.clipboard_write({ window: w, handle });
        await cua.computer.clipboard_write({ window: w, handle }); // handles are reusable
      } finally { await cua.computer.clipboard_release({ handle }); }
      await gtk.getAXState({ emit: false });`);
    await until(() => state('codex-e2e-gtk').text === 'snapshot ✓snapshot ✓', 'clipboard snapshot pasted twice');
  });

  test('low-level: press_key with a hold duration', async () => {
    const started = Date.now();
    await js(`const w = await e2eWindow("Codex E2E GTK"); const i = await e2eFind(gtk, "E2E entry", "text");
      await gtk.setValue(i, ""); await gtk.click(i);
      await cua.computer.press_key({ window: w, key: "z", duration: 400 }); await gtk.getAXState({ emit: false });`);
    expect(Date.now() - started >= 400, 'duration was not held');
    await until(() => state('codex-e2e-gtk').text.startsWith('z'), 'held key typed');
  });
}
