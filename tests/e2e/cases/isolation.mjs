// The agent must only touch what it was given: never the user's own windows,
// nothing it was refused, and no desktop state such as the clipboard.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { bind, client, clients, entry, expect, js, launchDirect, out, provider, rejects, sharedProgram,
  sleep, state, statePath, strict, until, userWindows } from '../lib.mjs';

// A program shared by a custom entry and by the user's own window of it (like
// a custom kitty entry while the user has kitty open): the bug that once bound
// the user's focused kitty window and typed into it.
const shared = sharedProgram('codex-e2e-shared');
entry('codex-e2e-custom', 'Codex E2E Custom', `${shared} ${statePath('codex-e2e-custom')} codex-e2e-custom`,
  'StartupWMClass=codex-e2e-custom\n');
entry('codex-e2e-declined', 'Codex E2E Declined',
  `${shared} ${statePath('codex-e2e-declined')} codex-e2e-declined`, 'StartupWMClass=codex-e2e-declined\n');
// Authentication prompts are forbidden apps, like macOS's safety refusals.
entry('codex-e2e-forbidden', 'Codex E2E Forbidden',
  `${shared} ${statePath('gcr-prompter')} gcr-prompter`, 'StartupWMClass=gcr-prompter\n');
const sentinel = 'codex-e2e-clipboard-sentinel';

export function setup(test) {
  test('isolation: decoy user window of a shared program', async () => {
    // In the VM it is focused, as the user's active app is; on a live desktop it
    // stays out of the way on the codex workspace.
    launchDirect(`${shared} ${statePath('codex-e2e-shared')} codex-e2e-shared "Codex E2E Decoy"`, { silent: !strict });
    await until(() => Boolean(client('codex-e2e-shared')), 'decoy window', 15000);
    userWindows.add(client('codex-e2e-shared').address);
    if (strict) execFileSync('sh', ['-c', `printf %s ${sentinel} | wl-copy`]);
  }, { setup: true });
}

export default function (test) {
  test('isolation: a custom entry never binds the user\'s window of the same program', async () => {
    await bind('custom', 'codex-e2e-custom.desktop', { timeout: 30000 });
    await js(`await custom.setValue(await e2eFind(custom, "E2E entry", "text"), "custom app");`);
    await until(() => state('codex-e2e-custom').text === 'custom app', 'custom app text');
    const decoy = state('codex-e2e-shared');
    expect(decoy.text === '' && decoy.keys.length === 0, `decoy received input: ${JSON.stringify(decoy)}`);
  });

  test('isolation: a declined approval blocks the action', async () => {
    provider.decline.add('codex-e2e-declined.desktop');
    await rejects(`await cua.getApp("codex-e2e-declined.desktop");`, /not approved to use Codex E2E Declined/);
    await sleep(2000);
    expect(!client('codex-e2e-declined'), 'the declined app was launched anyway');
  });

  test('isolation: an authentication prompt is refused before launch', async () => {
    await rejects(`await cua.getApp("codex-e2e-forbidden.desktop");`, /not allowed to use the app .* for safety reasons/);
    await sleep(2000);
    expect(!client('gcr-prompter'), 'the forbidden app was launched');
  });
}

export function finish(test) {
  test('isolation: the user\'s window received no input during the run', async () => {
    const decoy = state('codex-e2e-shared');
    expect(decoy.text === '' && decoy.keys.length === 0 && decoy.clicks === 0, JSON.stringify(decoy));
  });

  test('isolation: the clipboard is unchanged', async () => {
    const now = execFileSync('wl-paste', ['--no-newline'], { encoding: 'utf8' });
    expect(now === sentinel, `clipboard changed to ${JSON.stringify(now.slice(0, 80))}`);
  }, { needs: strict ? null : 'VM only (reads the clipboard)' });

  test('approval was asked once per app', async () => {
    const asked = provider.elicitations.filter((e) => e._meta?.tool_params?.app !== 'codex-e2e-declined.desktop')
      .map((e) => e._meta?.tool_params?.app);
    expect(new Set(asked).size === asked.length, `repeated prompts: ${JSON.stringify(asked)}`);
  });
}
