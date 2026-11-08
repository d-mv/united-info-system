/**
 * Module placement rules for the layout editor. Pure functions, no DOM.
 * A module: { id, enabled, col, row, cols, rows } (1-based grid lines).
 */

const rectOf = (m) => ({ col: m.col ?? 1, row: m.row ?? 1, cols: m.cols ?? 1, rows: m.rows ?? 1 });

function overlaps(a, b) {
  const r1 = rectOf(a);
  const r2 = rectOf(b);
  return r1.col < r2.col + r2.cols && r2.col < r1.col + r1.cols
    && r1.row < r2.row + r2.rows && r2.row < r1.row + r1.rows;
}

/** Does `candidate` (with its id) overlap any other enabled module? */
export function collides(modules, candidate) {
  return modules.some(m => m.id !== candidate.id && m.enabled !== false && overlaps(m, candidate));
}

/** Inside the grid: col >= 1, row >= 1, sizes >= 1, right edge within `gridCols`. */
export function fits(candidate, gridCols) {
  const r = rectOf(candidate);
  return r.col >= 1 && r.row >= 1 && r.cols >= 1 && r.rows >= 1 && r.col + r.cols - 1 <= gridCols;
}

/**
 * Apply a placement change to module `id`. Returns the new list, or null when
 * the result would leave the grid or overlap another module.
 */
export function place(modules, id, change, gridCols) {
  const current = modules.find(m => m.id === id);
  if (!current) return null;
  const next = { ...current, ...change };
  if (!fits(next, gridCols) || collides(modules, next)) return null;
  return modules.map(m => (m.id === id ? next : m));
}

/** First row below every enabled module (where a newly shown module can go). */
export function nextFreeRow(modules) {
  return modules
    .filter(m => m.enabled !== false)
    .reduce((max, m) => Math.max(max, rectOf(m).row + rectOf(m).rows), 1);
}

/**
 * First free spot for `mod`'s size, scanning rows top to bottom and columns
 * left to right. Returns { col, row, cols } (cols clamped to the grid width).
 */
export function firstFit(modules, mod, gridCols) {
  const cols = Math.min(mod.cols ?? 1, gridCols);
  const rows = mod.rows ?? 1;
  const limit = nextFreeRow(modules);
  for (let row = 1; row <= limit; row++) {
    for (let col = 1; col + cols - 1 <= gridCols; col++) {
      if (!collides(modules, { id: mod.id, col, row, cols, rows })) return { col, row, cols };
    }
  }
  return { col: 1, row: limit, cols };
}

/**
 * Turn a module on or off. A module turned on goes to the first free spot
 * that fits its size (top-left first), so modules fill the page instead of
 * keeping a default position that may be far from the rest.
 */
export function setEnabled(modules, id, enabled, gridCols = 12) {
  const target = modules.find(m => m.id === id);
  if (!target) return modules;
  let next = { ...target, enabled };
  if (enabled && target.enabled === false) next = { ...next, ...firstFit(modules, target, gridCols) };
  return modules.map(m => (m.id === id ? next : m));
}

/**
 * Keep saved modules (and the user's placement); drop ids the registry no
 * longer knows; append default modules that are missing, below everything.
 */
export function normalizeModules(saved, defaults, knownIds) {
  const known = new Set(knownIds);
  const kept = (Array.isArray(saved) ? saved : []).filter(m => m && known.has(m.id));
  const have = new Set(kept.map(m => m.id));
  let result = kept;
  for (const def of defaults) {
    if (have.has(def.id)) continue;
    const candidate = { ...def };
    if (collides(result, candidate)) Object.assign(candidate, { col: 1, row: nextFreeRow(result) });
    result = [...result, candidate];
  }
  return result;
}

/**
 * Where modules are drawn: each shown module grows into empty neighbouring
 * cells (right, down, then left, up) so the page has no gaps. The saved
 * placement is untouched; this is recomputed on every layout change.
 * Returns { id: { col, row, cols, rows } } for enabled modules.
 */
export function fillGaps(modules, gridCols) {
  const shown = modules
    .filter(m => m.enabled !== false)
    .map(m => ({ id: m.id, ...rectOf(m) }))
    .sort((a, b) => a.row - b.row || a.col - b.col);
  const maxRow = shown.reduce((max, r) => Math.max(max, r.row + r.rows - 1), 0);
  const taken = new Set();
  const key = (c, r) => `${c},${r}`;
  const mark = (rect) => {
    for (let c = rect.col; c < rect.col + rect.cols; c++) for (let r = rect.row; r < rect.row + rect.rows; r++) taken.add(key(c, r));
  };
  shown.forEach(mark);
  const free = (c1, c2, r1, r2) => {
    if (c1 < 1 || c2 > gridCols || r1 < 1 || r2 > maxRow) return false;
    for (let c = c1; c <= c2; c++) for (let r = r1; r <= r2; r++) if (taken.has(key(c, r))) return false;
    return true;
  };
  // One direction at a time for every module (right, down, left, up), so a
  // module beside a gap fills it before one above grows down into it.
  const grown = shown.map(m => ({ ...m }));
  const steps = [
    { test: g => free(g.col + g.cols, g.col + g.cols, g.row, g.row + g.rows - 1), apply: g => { g.cols++; return { col: g.col + g.cols - 1, row: g.row, cols: 1, rows: g.rows }; } },
    { test: g => free(g.col, g.col + g.cols - 1, g.row + g.rows, g.row + g.rows), apply: g => { g.rows++; return { col: g.col, row: g.row + g.rows - 1, cols: g.cols, rows: 1 }; } },
    { test: g => free(g.col - 1, g.col - 1, g.row, g.row + g.rows - 1), apply: g => { g.col--; g.cols++; return { col: g.col, row: g.row, cols: 1, rows: g.rows }; } },
    { test: g => free(g.col, g.col + g.cols - 1, g.row - 1, g.row - 1), apply: g => { g.row--; g.rows++; return { col: g.col, row: g.row, cols: g.cols, rows: 1 }; } },
  ];
  for (const step of steps) {
    for (const g of grown) while (step.test(g)) mark(step.apply(g));
  }
  const out = {};
  for (const g of grown) out[g.id] = { col: g.col, row: g.row, cols: g.cols, rows: g.rows };
  return out;
}

/**
 * Move module `id` to `target` ({ col, row }) and make room: modules it lands
 * on move down until they fit, then every other module moves up as far as it
 * can (closing the hole the moved one left). The moved module stays exactly
 * where it was dropped. Returns the new list, or null if it doesn't fit the grid.
 */
export function moveWithPush(modules, id, target, gridCols) {
  const current = modules.find(m => m.id === id);
  if (!current) return null;
  const moved = { ...current, ...target };
  if (!fits(moved, gridCols)) return null;

  const others = modules
    .filter(m => m.id !== id && m.enabled !== false)
    .map(m => ({ ...m }))
    .sort((a, b) => (a.row - b.row) || (a.col - b.col));

  // Push down, top to bottom, against everything already settled.
  const settled = [moved];
  for (const m of others) {
    while (collides(settled, m)) m.row++;
    settled.push(m);
  }
  // Close up: each module (not the moved one) rises while the cell above is free.
  for (const m of others) {
    while (m.row > 1 && !collides(settled, { ...m, row: m.row - 1 })) m.row--;
  }

  const byId = new Map(settled.map(m => [m.id, m]));
  return modules.map(m => byId.get(m.id) || m);
}
