#!/usr/bin/env node
// End-to-end suite. Drives disposable apps through the official cua_repl MCP
// server exactly as Codex does, and checks results inside the apps themselves.
// Run from a logged-in Hyprland session after ./install:  ./test --host
// Output (results.json, provider.log) goes to $E2E_OUT, default a temporary directory.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { clients, helpers, js, ours, out, provider, seat, seatViolation } from './lib.mjs';
import basics from './cases/basics.mjs';
import gtk from './cases/gtk.mjs';
import windows from './cases/windows.mjs';
import lowlevel from './cases/lowlevel.mjs';
import toolkits from './cases/toolkits.mjs';
import isolation, { setup as isolationSetup, finish as isolationFinish } from './cases/isolation.mjs';

const only = process.env.E2E_ONLY ? new RegExp(process.env.E2E_ONLY, 'i') : null;
const tests = [];
const test = (name, run, options = {}) => tests.push({ name, run, ...options });
for (const register of [basics, isolationSetup, gtk, windows, lowlevel, isolation, toolkits, isolationFinish]) register(test);

const results = [];
let failed = 0;
try {
  await provider.start();
  // Test helpers exist in the REPL even when E2E_ONLY skips the test defining them.
  if (only) await js(helpers);
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
    try {
      await t.run();
      const violation = t.setup ? null : seatViolation(before);
      if (violation) throw new Error(violation);
      results.push({ name: t.name, status: 'passed', ms: Date.now() - started });
      console.log(`PASS ${t.name}`);
    } catch (error) {
      failed++;
      results.push({ name: t.name, status: 'failed', ms: Date.now() - started, error: error.message });
      console.log(`FAIL ${t.name}\n  ${error.message.split('\n').join('\n  ')}`);
    }
  }
} finally {
  provider.stop();
  for (const c of clients()) if (ours(c)) try { process.kill(c.pid, 'SIGTERM'); } catch {}
  writeFileSync(join(out, 'results.json'), JSON.stringify({ results, elicitations: provider.elicitations }, null, 2));
  writeFileSync(join(out, 'provider.log'), provider.stderr);
}
const count = (status) => results.filter((r) => r.status === status).length;
console.log(`${count('passed')} passed, ${failed} failed, ${count('skipped')} skipped. Results: ${out}`);
process.exit(failed ? 1 : 0);
