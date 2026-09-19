import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, environment } from './launch.mjs';

const { executable } = environment();
const config = `[mcp_servers.cua_repl]\ncommand = ${JSON.stringify(executable)}\nargs = [${JSON.stringify(join(root, 'scripts/launch.mjs'))}]\nstartup_timeout_sec = 120\n`;
if (process.argv.includes('--write')) {
  const path = join(root, '.codex/config.toml');
  if (existsSync(path)) throw new Error(`${path} already exists; merge the output of scripts/configure.mjs instead.`);
  mkdirSync(join(root, '.codex'), { recursive: true });
  writeFileSync(path, config, { flag: 'wx', mode: 0o600 });
  console.log(`Created ${path}. Open a new Codex session in this workspace.`);
} else {
  process.stdout.write(config);
}
