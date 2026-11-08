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
 * Turn a module on or off. A module turned on where it would overlap others
 * moves to the first free row, at column 1.
 */
export function setEnabled(modules, id, enabled) {
  const target = modules.find(m => m.id === id);
  if (!target) return modules;
  let next = { ...target, enabled };
  if (enabled && collides(modules, next)) next = { ...next, col: 1, row: nextFreeRow(modules) };
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
