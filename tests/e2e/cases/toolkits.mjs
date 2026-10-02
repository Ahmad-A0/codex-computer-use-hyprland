// Toolkits whose accessibility needs switches on Linux, and terminals.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bind, clients, contextMenu, entry, expect, fixtures, hypr, js, out, python, state, statePath, until, which } from '../lib.mjs';

if (python('PyQt6')) {
  entry('codex-e2e-qt', 'Codex E2E Qt',
    `/usr/bin/env QT_QPA_PLATFORM=wayland python3 ${join(fixtures, 'qt.py')} ${statePath('codex-e2e-qt')} codex-e2e-qt`,
    'StartupWMClass=codex-e2e-qt\n');
}
const browser = which('chromium', 'google-chrome-stable');
if (browser) {
  entry('codex-e2e-browser', 'Codex E2E Browser', `${browser} --user-data-dir=${join(out, 'browser')} --no-first-run `
    + `--no-default-browser-check --ozone-platform=wayland --app=file://${join(fixtures, 'page.html')}`);
}
const terminal = which('foot', 'kitty');
if (terminal) {
  const shell = 'bash --norc --noprofile';
  entry('codex-e2e-terminal', 'Codex E2E Terminal', terminal === 'foot'
    ? `foot --app-id=codex-e2e-terminal --title=Codex-E2E-Terminal ${shell}`
    : `kitty --class codex-e2e-terminal --title Codex-E2E-Terminal -o confirm_os_window_close=0 ${shell}`,
  'StartupWMClass=codex-e2e-terminal\nCategories=System;TerminalEmulator;\n');
}

const pageWindow = () => clients().find((c) => c.title.startsWith('Codex E2E Page'));
/** Open the test page in Chromium and bind it, unless an earlier test did. */
async function ensurePage() {
  const bound = await js('await nodeRepl.write(String(typeof globalThis.page !== "undefined"));');
  if (bound.trim().endsWith('true') && pageWindow()) return;
  await js(`await cua.computer.launch_app({ app: "codex-e2e-browser.desktop" });`);
  await until(() => Boolean(pageWindow()), 'browser window', 30000);
  await js(`globalThis.page = await cua.getApp({ windowId: ${parseInt(pageWindow().address, 16)} });`);
}

export default function (test) {
  test('Qt: accessibility tree, setValue, click', async () => {
    await bind('qt', 'codex-e2e-qt.desktop', { timeout: 30000 });
    await js(`await qt.setValue(await e2eFind(qt, "Qt entry", "text"), "qt value");`);
    await until(() => state('codex-e2e-qt').text === 'qt value', 'Qt entry text');
    await js(`await qt.click(await e2eFind(qt, "Qt button", "button")); await qt.getAXState({ emit: false });`);
    await until(() => state('codex-e2e-qt').clicks === 1, 'Qt button click');
  }, { needs: python('PyQt6') ? null : 'PyQt6 not installed' });

  test('Qt: context menu and button menu are observable and usable', async () => {
    // Qt lists no popup among its AT-SPI application children; the provider
    // finds open Qt menus through AT-SPI events, as a macOS AX tree shows them.
    if (!await js('await nodeRepl.write(String(globalThis.qt !== undefined));').then((t) => t.trim().endsWith('true'))) {
      await bind('qt', 'codex-e2e-qt.desktop', { timeout: 30000 });
    }
    await js(`await qt.setValue(await e2eFind(qt, "Qt entry", "text"), "menu target");`);
    // Reopened at the same point, as a user may right-click twice.
    await contextMenu('qt', 'Qt entry', 'text', 'Select All', { reopen: true });
    await until(() => JSON.stringify(state('codex-e2e-qt').selection) === '[0,11]', 'select all from the Qt menu');
    const text = await js(`const button = await e2eFind(qt, "Qt menu button", "push button menu");
      await qt.getAXState({ emit: false });
      await qt.click(button);
      const result = {};
      try {
        result.opened = await qt.getAXState({ emit: false });
        await qt.pressKey("Escape");
        result.escaped = await qt.getAXState({ emit: false });
        await qt.click(button);
        await qt.click(await e2eFind(qt, "Qt second choice"));
      } catch (error) {
        await qt.pressKey("Escape");
        throw error;
      }
      await nodeRepl.write(JSON.stringify(result));`);
    const { opened, escaped } = JSON.parse(text.slice(text.indexOf('{"opened"')));
    expect(opened.split('\n').some((l) => l.startsWith('+\t') && l.includes('Qt first choice')), `menu not added:\n${opened}`);
    expect(escaped.includes('Removed element IDs') && !escaped.includes('Qt first choice'), `menu not removed:\n${escaped}`);
    await until(() => state('codex-e2e-qt').menu === 'second', 'Qt menu choice');
  }, { needs: python('PyQt6') ? null : 'PyQt6 not installed' });

  test('Chromium: silent launch, accessibility tree, typing, click', async () => {
    // Chromium names --app windows after the page, so use the documented Linux
    // flow: launch_app, then bind the new window found by title. Chromium also
    // clears its environment, which once defeated Hyprland's launch rule.
    const window = () => clients().find((c) => c.title.startsWith('Codex E2E Page'));
    await js(`await cua.computer.launch_app({ app: "codex-e2e-browser.desktop" });`);
    await until(() => Boolean(window()), 'browser window', 30000);
    expect(window().workspace.name === 'codex', `browser opened on workspace ${window().workspace.name}`);
    expect(!hypr('activewindow').title?.startsWith('Codex E2E Page'), 'the browser took focus');
    await js(`globalThis.page = await cua.getApp({ windowId: ${parseInt(window().address, 16)} });`);
    await js(`const i = await e2eFind(page, "Page input", "entry"); await page.click(i); await page.typeText("from codex");
      await page.getAXState({ emit: false });`);
    await until(() => window().title.startsWith('Codex E2E Page|from codex|'), 'page input', 8000);
    await js(`await page.click(await e2eFind(page, "Page button", "button")); await page.getAXState({ emit: false });`);
    await until(() => window().title.endsWith('|1'), 'page button click', 8000);
  }, { needs: browser ? null : 'no Chromium-based browser' });

  test('Chromium: page context menu is observable and usable', async () => {
    // Chromium's context menu is a separate accessible frame of the app; it
    // belongs to the page window through the compositor's popup of that size.
    const window = pageWindow;
    await ensurePage();
    // Chromium's showContextMenu action leaves focus where it was, so focus the
    // input first; it needs text, or "Select all" is (rightly) disabled.
    await js(`await page.click(await e2eFind(page, "Page input", "entry")); await page.typeText("some text");`);
    await contextMenu('page', 'Page input', 'entry', 'Select all');
    // Typing replaces the selection that the menu made.
    await js(`await page.typeText("menu typed"); await page.getAXState({ emit: false });`);
    await until(() => window().title.startsWith('Codex E2E Page|menu typed|') || window().title,
      'typing replaced the menu selection', 8000);
  }, { needs: browser ? null : 'no Chromium-based browser' });

  test('Terminal: typing and the terminal paste shortcut', async () => {
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
}
