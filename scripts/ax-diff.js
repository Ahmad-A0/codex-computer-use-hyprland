// Prepended to the private copy of @oai/cua's bind_linux_app.js. Reproduces the
// macOS get_app_state text: diffs against the previous observation of the same
// window unless disableDiffing is set. Element IDs come from Sky's ElementIds,
// which keep an element's number while its native accessibility ID survives.
const axBaselines = new Map();

function axLines(text) {
  return text.split("\n").filter(Boolean).map((line) => {
    const body = line.replace(/^\t+/, "");
    const space = body.indexOf(" ");
    return { id: space < 0 ? body : body.slice(0, space), body };
  });
}

function axRanges(ids) {
  const numbers = ids.filter((id) => /^\d+$/.test(id)).map(Number).sort((a, b) => a - b);
  const ranges = [];
  for (const n of numbers) {
    const last = ranges.at(-1);
    if (last && n === last[1] + 1) last[1] = n;
    else ranges.push([n, n]);
  }
  return [...ranges.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)),
    ...ids.filter((id) => !/^\d+$/.test(id))].join(", ");
}

function axState(state, options) {
  const full = state.ax_tree.to_string();
  const prefix = `Accessibility source: ${state.ax_tree_source}\n`;
  const lines = axLines(full);
  const previous = axBaselines.get(state.window.id);
  // Every observation refreshes the baseline, including full-tree requests.
  axBaselines.set(state.window.id, lines);
  if (options?.disableDiffing === true || previous === undefined) return prefix + full;

  const window = `Window: ${JSON.stringify(state.window.title ?? "")}`;
  const focused = lines.find((line) => /^\S+ [^()]*\((?:[^()]*, )?focused[,)]/.test(line.body));
  const focus = focused ? [`The focused UI element is ${focused.body}`] : [];
  const before = new Map(previous.map((line) => [line.id, line.body]));
  const changes = [];
  for (const line of lines) {
    const old = before.get(line.id);
    if (old === undefined) changes.push(`+\t${line.body}`);
    else if (old !== line.body) changes.push(`~\t${line.body}`);
  }
  const present = new Set(lines.map((line) => line.id));
  const removed = previous.map((line) => line.id).filter((id) => !present.has(id));
  if (changes.length === 0 && removed.length === 0) {
    return prefix + [`There has been no change in the accessibility tree for ${window}.`, ...focus].join("\n");
  }
  if (removed.length) changes.push(`Removed element IDs: ${axRanges(removed)}`);
  // As on macOS, a diff longer than the tree itself is replaced by the tree.
  if (changes.length > lines.length) return prefix + full;
  return prefix + [
    `The following is a diff from the previous accessibility tree for ${window} with ~ and + representing changed and added elements, respectively. Removed elements are summarized by ID range.`,
    ...changes, ...focus,
  ].join("\n");
}
