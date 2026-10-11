#!/usr/bin/env node
// End-to-end suite. Drives disposable apps through the official cua_repl MCP
// server exactly as Codex does, and checks results inside the apps themselves.
// Run from a logged-in Hyprland session after ./install:  ./test --host
// Output (results.json, provider.log) goes to $E2E_OUT, default a temporary directory.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { clients, helpers, js, ours, out, provider, seat, seatViolation, snap, trees } from './lib.mjs';
import { report } from './report.mjs';
import basics from './cases/basics.mjs';
import gtk from './cases/gtk.mjs';
import windows from './cases/windows.mjs';
import lowlevel from './cases/lowlevel.mjs';
import toolkits from './cases/toolkits.mjs';
import widgets from './cases/widgets.mjs';
import realApps from './cases/apps.mjs';
import isolation, { setup as isolationSetup, finish as isolationFinish } from './cases/isolation.mjs';

const only = process.env.E2E_ONLY ? new RegExp(process.env.E2E_ONLY, 'i') : null;
const tests = [];
const test = (name, run, options = {}) => tests.push({ name, run, ...options });
for (const register of [basics, isolationSetup, gtk, windows, lowlevel, isolation, toolkits, widgets, realApps, isolationFinish]) register(test);

const results = [];
let failed = 0;
try {
  await provider.start();
  await js(helpers);
  for (const t of tests) {
    // Setup always runs; the rest can be filtered with E2E_ONLY.
    if (only && !t.setup && !only.test(t.name)) continue;
    const started = Date.now();
    if (t.needs) {
      results.push({ name: t.name, status: 'skipped', reason: t.needs });
      console.log(`SKIP ${t.name} (${t.needs})`);
      continue;
    }
    const before = seat();
    const label = `${String(results.length + 1).padStart(2, '0')}-${t.name}`;
    try {
      await t.run();
      const violation = t.setup ? null : seatViolation(before);
      if (violation) throw new Error(violation);
      results.push({ name: t.name, status: 'passed', ms: Date.now() - started, shots: snap(label) });
      console.log(`PASS ${t.name}`);
    } catch (error) {
      failed++;
      // What the apps actually showed is usually the fastest way to the cause.
      results.push({ name: t.name, status: 'failed', ms: Date.now() - started, error: error.message,
        shots: snap(label), trees: await trees() });
      console.log(`FAIL ${t.name}\n  ${error.message.split('\n').join('\n  ')}`);
    }
  }
} finally {
  provider.stop();
  // Apps with unsaved work may ignore SIGTERM; our disposable ones must not linger.
  for (const c of clients()) if (ours(c)) try { process.kill(c.pid, 'SIGTERM'); } catch {}
  await new Promise((done) => setTimeout(done, 1500));
  for (const c of clients()) if (ours(c)) try { process.kill(c.pid, 'SIGKILL'); } catch {}
  writeFileSync(join(out, 'results.json'), JSON.stringify({ results, elicitations: provider.elicitations }, null, 2));
  writeFileSync(join(out, 'provider.log'), provider.stderr);
  writeFileSync(join(out, 'report.html'), report(results));
}
const count = (status) => results.filter((r) => r.status === status).length;
console.log(`${count('passed')} passed, ${failed} failed, ${count('skipped')} skipped. Report: ${join(out, 'report.html')}`);
process.exit(failed ? 1 : 0);
