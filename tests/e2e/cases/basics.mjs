// The provider is what Codex runs, and it exposes the official tools.
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { expect, helpers, js, provider, root, which } from '../lib.mjs';

export default function (test) {
  test('Codex resolves cua_repl to this provider', async () => {
    const output = execFileSync('codex', ['mcp', 'get', 'cua_repl'], { encoding: 'utf8' });
    // E2E_LAUNCHER: the installed Codex plugin's command, run from its directory.
    const launcher = process.env.E2E_LAUNCHER;
    expect(launcher ? output.includes('args: ./bin/start') && output.includes(`cwd: ${dirname(dirname(launcher))}`)
      : output.includes(join(root, 'scripts/launch.mjs')), output);
  }, { needs: which('codex') ? null : 'codex CLI not installed' });

  test('official MCP tools and native instructions', async () => {
    const tools = await provider.tools();
    const tool = tools.find((t) => t.name === 'js');
    expect(tool?.description.includes('cua.getApp("Example App")'), JSON.stringify(tools.map((t) => t.name)));
    await js(helpers);
  });

  test('native inventory', async () => {
    const text = await js(`const s = await cua.getState({ emit: false });
      if (s.errors?.length) throw new Error(JSON.stringify(s.errors));
      const w = await cua.listWindows({ emit: false });
      await nodeRepl.write(JSON.stringify({ apps: s.apps.length, windows: w.length, target: cua.computer.target }));`);
    expect(text.includes('"target":"linux"'), text);
  });
}
