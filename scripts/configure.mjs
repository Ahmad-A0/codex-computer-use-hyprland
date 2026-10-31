import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { root, environment } from './launch.mjs';

const { executable } = environment();
const browser = process.argv.includes('--browser');
const runtime = dirname(dirname(executable));
let config = `[mcp_servers.cua_repl]\ncommand = ${JSON.stringify(executable)}\nargs = [${JSON.stringify(join(root, 'scripts/launch.mjs'))}]\nstartup_timeout_sec = 120\nenabled = true\n# Codex passes MCP servers only a few variables by default; these name the session to drive.\nenv_vars = ["HYPRLAND_INSTANCE_SIGNATURE", "WAYLAND_DISPLAY"]\n# Same tool exposure as the bundled unified-computer-use plugin's cua_repl.\nenabled_tools = ["js", "js_reset", "turn_ended"]\nomit_tools_from = ["code_mode", "deferred"]\n\n[mcp_servers.cua_repl.tools.js]\noutput_token_limit = 25000\n\n[mcp_servers.cua_repl.env]\nCODEX_CUA_RUNTIME = ${JSON.stringify(runtime)}\nCUA_REPL_ENABLED_SURFACES = ${JSON.stringify(browser ? 'browser,computer' : 'computer')}\n`;
if (process.argv.includes('--write')) {
  const path = join(root, '.codex/config.toml');
  if (existsSync(path)) throw new Error(`${path} already exists; merge the output of scripts/configure.mjs instead.`);
  mkdirSync(join(root, '.codex'), { recursive: true });
  writeFileSync(path, config, { flag: 'wx', mode: 0o600 });
  console.log(`Created ${path}. Open a new Codex session in this workspace.`);
} else {
  process.stdout.write(config);
}
