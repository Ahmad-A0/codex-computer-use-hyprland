// A self-contained HTML report: each test's result, the screenshots taken after
// it, and on failure the accessibility trees the agent would have seen.
const escape = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export function report(results) {
  const rows = results.map((r) => {
    const shots = (r.shots ?? []).map((s) => (s.file
      ? `<figure><a href="${escape(s.file)}"><img src="${escape(s.file)}" loading="lazy"></a><figcaption>${escape(s.window)}</figcaption></figure>`
      : `<p class="note">${escape(s.error ?? '')}</p>`)).join('');
    const trees = Object.entries(r.trees ?? {}).map(([name, tree]) =>
      `<details><summary>Accessibility tree: ${escape(name)}</summary><pre>${escape(tree)}</pre></details>`).join('');
    return `<section class="${r.status}"><h2>${escape(r.status.toUpperCase())} ${escape(r.name)}`
      + `${r.ms ? ` <small>${(r.ms / 1000).toFixed(1)} s</small>` : ''}</h2>`
      + (r.error ? `<pre class="error">${escape(r.error)}</pre>` : '') + (r.reason ? `<p class="note">${escape(r.reason)}</p>` : '')
      + (shots ? `<div class="shots">${shots}</div>` : '') + trees + '</section>';
  }).join('\n');
  const count = (status) => results.filter((r) => r.status === status).length;
  return `<!doctype html><meta charset="utf-8"><title>Codex Hyprland e2e</title>
<style>
body{font:14px system-ui,sans-serif;margin:24px;background:#fafafa;color:#222}
section{background:#fff;border-left:6px solid #999;margin:12px 0;padding:8px 16px;border-radius:4px}
.passed{border-color:#2a7}.failed{border-color:#c33}.skipped{border-color:#bbb}
h2{font-size:15px;margin:6px 0}small{color:#777;font-weight:normal}
pre{white-space:pre-wrap;font-size:12px;background:#f3f3f3;padding:8px;max-height:400px;overflow:auto}
.error{background:#fdecec}.note{color:#777}
.shots{display:flex;flex-wrap:wrap;gap:8px}figure{margin:0}img{max-width:320px;border:1px solid #ddd}
figcaption{font-size:11px;color:#666}
</style>
<h1>Codex Hyprland end-to-end: ${count('passed')} passed, ${count('failed')} failed, ${count('skipped')} skipped</h1>
${rows}`;
}
