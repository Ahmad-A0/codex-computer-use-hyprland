// Computer use in Codex sessions with a sandbox. Codex sends its sandbox state
// with each call; node_repl then runs the model's JavaScript kernel and the
// trusted Sky worker under `codex sandbox` (bwrap + seccomp: no Unix-socket
// connects, read-only home). The backend needs the desktop's sockets, so it must
// run outside, reached through node_repl's native pipe, while the model's own
// code stays confined.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Provider } from '../mcp.mjs';
import { client, expect, gtk, helpers, out, providerOptions, runtime, state, until } from '../lib.mjs';

gtk('codex-e2e-sandboxed', 'Codex E2E Sandboxed');
gtk('codex-e2e-full-access', 'Codex E2E Full Access');

// node_repl sandboxes only when it knows the Codex CLI (scripts/launch.mjs).
const cli = process.env.CODEX_CLI_PATH ?? join(runtime, '..', 'codex');

// The `codex/sandbox-state-meta` Codex 0.166 sends for `-s workspace-write` and
// `-s danger-full-access` (recorded from `codex exec`), with the e2e output
// directory as the workspace.
function sandboxState(mode) {
  const permissionProfile = mode === 'danger-full-access' ? { type: 'disabled' } : {
    type: 'managed',
    file_system: { type: 'restricted', entries: [
      { path: { type: 'special', value: { kind: 'root' } }, access: 'read' },
      { path: { type: 'path', path: out }, access: 'write' },
      { path: { type: 'special', value: { kind: 'slash_tmp' } }, access: 'write' },
      { path: { type: 'special', value: { kind: 'tmpdir' } }, access: 'write' },
    ] },
    network: 'restricted',
  };
  return { permissionProfile, sandboxCwd: `file://${out}`, useLegacyLandlock: false, useMxc: false };
}

// The provider's node_repl processes that run JavaScript (not their sandbox wrappers).
function nodeProcesses(root) {
  const parents = new Map();
  for (const pid of readdirSync('/proc').filter((name) => /^\d+$/.test(name))) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      parents.set(pid, stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    } catch {}
  }
  const found = {};
  for (const pid of parents.keys()) {
    let ancestor = pid;
    while (ancestor && ancestor !== '0' && ancestor !== String(root)) ancestor = parents.get(ancestor);
    if (ancestor !== String(root)) continue;
    try {
      const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
      const script = argv.find((arg) => /\/(kernel|trusted-worker)\.js$/.test(arg));
      if (!argv[0].endsWith('/node') || !script) continue;
      const seccomp = readFileSync(`/proc/${pid}/status`, 'utf8').match(/^Seccomp:\s*(\d)/m)?.[1];
      found[script.endsWith('kernel.js') ? 'kernel' : 'worker'] = seccomp === '2';
    } catch {}
  }
  return found;
}

// What the model's own code can reach from the kernel.
const probe = `const fs = await import("node:fs"), net = await import("node:net");
  const result = {};
  try { fs.writeFileSync(nodeRepl.homeDir + "/.codex-e2e-sandbox-probe", ""); fs.rmSync(nodeRepl.homeDir + "/.codex-e2e-sandbox-probe"); result.home = "written"; }
  catch (error) { result.home = error.code; }
  result.hyprland = await new Promise((done) => {
    const socket = net.connect(${JSON.stringify(join(process.env.XDG_RUNTIME_DIR ?? '', 'hypr', process.env.HYPRLAND_INSTANCE_SIGNATURE ?? '', '.socket.sock'))});
    socket.on("connect", () => { socket.destroy(); done("connected"); });
    socket.on("error", (error) => done(error.code));
  });
  await nodeRepl.write("E2E-PROBE" + JSON.stringify(result));`;

async function drive(mode, id, name) {
  const provider = new Provider({ ...providerOptions, meta: { 'codex/sandbox-state-meta': sandboxState(mode) } });
  try {
    const started = await provider.start();
    expect(started.capabilities?.experimental?.['codex/sandbox-state-meta'], `node_repl does not accept Codex sandbox state: ${JSON.stringify(started.capabilities)}`);
    await provider.js(helpers);
    expect(!client(id), `${id} is already running`);
    // getApp shows the app's state; act in a separate call so that errors stay readable.
    await provider.js(`globalThis.app = await cua.getApp(${JSON.stringify(`${id}.desktop`)});`, { timeout: 60000 });
    await provider.js(`await app.setValue(await e2eFind(app, "E2E entry", "text"), ${JSON.stringify(`${mode} ✓`)});
      await app.click(await e2eFind(app, "E2E button", "button"));
      await app.getAXState({ emit: false });`);
    await until(() => state(id).text === `${mode} ✓` && state(id).clicks === 1, `${name} received the agent's input`, 10000);
    const text = await provider.js(probe);
    return { processes: nodeProcesses(provider.process.pid), probe: JSON.parse(text.slice(text.indexOf('E2E-PROBE') + 9)) };
  } finally {
    provider.stop();
  }
}

export default function (test) {
  const needs = existsSync(cli) ? null : `no Codex CLI at ${cli} for node_repl's sandbox`;

  test('sandbox: computer use works in a workspace-write session, whose code stays confined', async () => {
    const { processes, probe } = await drive('workspace-write', 'codex-e2e-sandboxed', 'Codex E2E Sandboxed');
    expect(processes.kernel === true && processes.worker === true, `node_repl did not sandbox its processes: ${JSON.stringify(processes)}`);
    expect(probe.home !== 'written' && probe.hyprland === 'EPERM', `the model's code escaped the sandbox: ${JSON.stringify(probe)}`);
  }, { needs });

  test('sandbox: computer use works in a danger-full-access session', async () => {
    const { processes, probe } = await drive('danger-full-access', 'codex-e2e-full-access', 'Codex E2E Full Access');
    expect(processes.kernel === false && processes.worker === false, `node_repl sandboxed a full-access session: ${JSON.stringify(processes)}`);
    expect(probe.hyprland === 'connected', `full access is restricted: ${JSON.stringify(probe)}`);
  }, { needs });
}
