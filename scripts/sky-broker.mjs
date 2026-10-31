// Runs the Sky Linux backend outside Codex's sandbox for the sandboxed node_repl
// trusted worker, as macOS Sky reaches its out-of-sandbox Computer Use service.
//
// In sandboxed sessions node_repl starts its trusted worker under `codex sandbox`
// (bwrap + seccomp), where connect() on any Unix socket fails: no Hyprland IPC,
// D-Bus or AT-SPI for a backend spawned there. node_repl itself is not sandboxed
// and relays nodeRepl.nativePipe connections to Unix sockets for the worker.
// scripts/launch.mjs (the MCP server process, unsandboxed) starts this broker;
// scripts/runtime/sky_linux.js connects to it through the native pipe.
//
// Protocol per connection: one JSON line { token, args, cwd } from the client,
// then the backend's stdin/stdout line protocol relayed unchanged. When the
// backend exits the broker sends { exit: "<status>: <stderr tail>" } and closes.
// Closing the connection ends the backend.
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { name } from './paths.mjs';

const MAX_HELLO = 64 * 1024;

// A private 0700 directory per broker; leftovers of dead brokers are removed.
function socketDirectory(env) {
  const base = join(isAbsolute(env.XDG_RUNTIME_DIR ?? '') ? env.XDG_RUNTIME_DIR : tmpdir(), name);
  mkdirSync(base, { recursive: true, mode: 0o700 });
  for (const entry of readdirSync(base)) {
    const pid = Number(entry.match(/^sky-(\d+)-/)?.[1]);
    if (!pid) continue;
    try { process.kill(pid, 0); } catch (error) {
      if (error.code === 'ESRCH') rmSync(join(base, entry), { recursive: true, force: true });
    }
  }
  return mkdtempSync(join(base, `sky-${process.pid}-`));
}

function validArgs(args) {
  return Array.isArray(args) && (args.length === 0
    || (args.length === 2 && args[0] === '--mouse-size-px' && /^\d{1,4}$/.test(args[1])));
}

/** Start the broker for `backend`; returns the socket path, its token, and close(). */
export function startBroker(backend, env) {
  const directory = socketDirectory(env);
  const socket = join(directory, 'sky.sock');
  const token = randomBytes(32).toString('hex');
  const expected = Buffer.from(token);
  const children = new Set();

  const server = createServer((connection) => {
    let hello = Buffer.alloc(0);
    let child = null;
    const refuse = (message) => {
      connection.end(JSON.stringify({ exit: message }) + '\n');
    };
    const onHello = (data) => {
      hello = Buffer.concat([hello, data]);
      const newline = hello.indexOf(10);
      if (newline === -1) {
        if (hello.length > MAX_HELLO) { connection.off('data', onHello); refuse('invalid broker handshake'); }
        return;
      }
      connection.off('data', onHello);
      let request;
      try { request = JSON.parse(hello.subarray(0, newline).toString('utf8')); } catch { request = null; }
      const offered = Buffer.from(String(request?.token ?? ''));
      if (offered.length !== expected.length || !timingSafeEqual(offered, expected)) return refuse('broker authentication failed');
      if (!validArgs(request.args)) return refuse('unsupported backend arguments');
      let cwd = typeof request.cwd === 'string' && isAbsolute(request.cwd) ? request.cwd : undefined;
      try { if (cwd && !statSync(cwd).isDirectory()) cwd = undefined; } catch { cwd = undefined; }
      run(connection, request.args, cwd, hello.subarray(newline + 1));
    };
    const run = (connection, args, cwd, rest) => {
      child = spawn(backend, [...args, 'server'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
      children.add(child);
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (text) => { stderr = (stderr + text).slice(-8192); });
      child.stdout.pipe(connection, { end: false });
      connection.pipe(child.stdin);
      child.stdin.on('error', () => {});
      let finished = false;
      const finish = (status) => {
        if (finished) return;
        finished = true;
        children.delete(child);
        const tail = stderr.trim();
        if (!connection.destroyed) connection.end(JSON.stringify({ exit: tail ? `${status}: ${tail}` : status }) + '\n');
      };
      // 'close' waits for stdout to drain, so every response precedes the exit line.
      child.on('close', (code, signal) => finish(signal ? `signal=${signal}` : `exit=${code ?? 'unknown'}`));
      child.on('error', (error) => finish(error.message));
      if (rest.length) child.stdin.write(rest);
    };
    connection.on('data', onHello);
    connection.on('error', () => {});
    // The backend serves until its stdin ends; make sure it does not outlive the client.
    connection.on('close', () => {
      if (!child || child.exitCode !== null || child.signalCode !== null) return;
      child.stdin.end();
      const timer = setTimeout(() => child.kill('SIGTERM'), 5000);
      timer.unref();
      child.once('exit', () => clearTimeout(timer));
    });
  });
  server.listen(socket);
  server.unref();

  const close = () => {
    server.close();
    for (const child of children) child.kill('SIGTERM');
    if (existsSync(directory)) rmSync(directory, { recursive: true, force: true });
  };
  return { socket, token, close };
}
