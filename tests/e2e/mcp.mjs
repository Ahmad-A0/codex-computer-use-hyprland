// A minimal MCP client that drives the provider the way Codex does: the
// official cua_repl server over stdio, `js` tool calls carrying Codex turn
// metadata, and approval elicitations answered like a user choosing "session".
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

export class Provider {
  constructor({ node, launcher, env, timeout = 60000 }) {
    this.timeout = timeout;
    this.serial = 0;
    this.pending = new Map();
    this.elicitations = [];
    this.decline = new Set(); // app IDs whose approval prompts are declined
    this.stderr = '';
    this.session = randomUUID();
    this.process = spawn(node, [launcher], { env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    this.process.stderr.on('data', (data) => { this.stderr = (this.stderr + data).slice(-20000); });
    this.process.on('exit', (code) => {
      for (const item of this.pending.values()) item.reject(new Error(`Provider exited ${code}: ${this.stderr.slice(-1500)}`));
      this.pending.clear();
    });
    createInterface({ input: this.process.stdout }).on('line', (line) => this.receive(line));
  }

  receive(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.method === undefined) {
      const item = this.pending.get(message.id);
      if (!item) return;
      this.pending.delete(message.id);
      clearTimeout(item.timer);
      if (message.error) item.reject(new Error(JSON.stringify(message.error)));
      else item.resolve(message.result);
    } else if (message.id !== undefined) {
      // Server requests share the id space with ours; only answer what we support.
      if (message.method === 'elicitation/create') {
        this.elicitations.push(message.params);
        const declined = this.decline.has(message.params?._meta?.tool_params?.app);
        this.send({ jsonrpc: '2.0', id: message.id, result: declined ? { action: 'decline' }
          : { action: 'accept', content: {}, _meta: { persist: 'session' } } });
      } else {
        this.send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Unsupported client request ${message.method}` } });
      }
    }
  }

  send(message) { this.process.stdin.write(JSON.stringify(message) + '\n'); }

  rpc(method, params, timeout = this.timeout) {
    return new Promise((resolve, reject) => {
      const id = ++this.serial;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out: ${method}\n${this.stderr.slice(-1500)}`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  async start() {
    const result = await this.rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: { elicitation: {} },
      clientInfo: { name: 'codex-hyprland-e2e', version: '1' },
    }, 120000);
    this.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return result;
  }

  tools() { return this.rpc('tools/list', {}).then((result) => result.tools); }

  /** Run code in the cua_repl `js` tool; returns its text output, throwing on errors. */
  async js(code, { timeout = 60000 } = {}) {
    const result = await this.rpc('tools/call', {
      _meta: { 'x-codex-turn-metadata': { session_id: this.session, turn_id: randomUUID(), call_id: `call_${this.serial + 1}` } },
      name: 'js',
      arguments: { code, timeout_ms: timeout },
    }, timeout + 30000);
    const text = (result.content ?? []).filter((item) => item.type === 'text').map((item) => item.text).join('\n');
    if (result.isError || /(?:^|\n)(?:Error|RuntimeError|TypeError|ReferenceError|SyntaxError):/.test(text)) {
      throw new Error(text.slice(-3000));
    }
    return text;
  }

  stop() {
    this.process.stdin.end();
    try { process.kill(-this.process.pid, 'SIGTERM'); } catch {}
    for (const item of this.pending.values()) clearTimeout(item.timer);
  }
}
