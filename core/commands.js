/**
 * Command registry for the palette. Modules register a provider while they are
 * mounted; the palette asks every provider for commands as you type.
 *
 * Provider: (query: string) => Command[]
 * Command: { title, hint?, keywords?, dynamic?, run() }
 *   `dynamic` commands are built from the query itself (e.g. "Add task: …") and
 *   are always shown; others are filtered and ranked against the query.
 */
const providers = new Map();

export function registerCommands(name, provider) {
  providers.set(name, provider);
  return () => {
    if (providers.get(name) === provider) providers.delete(name);
  };
}

/**
 * Score how well `query` matches `text`: -1 for no match, higher is better.
 * Every query character must appear in order; starts of words and runs score more.
 */
export function scoreMatch(query, text) {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const t = String(text).toLowerCase();
  if (t.startsWith(q)) return 1000 - t.length;
  const word = t.indexOf(' ' + q);
  if (word !== -1) return 800 - word;
  const inside = t.indexOf(q);
  if (inside !== -1) return 600 - inside;
  let score = 0;
  let at = -1;
  for (const ch of q) {
    const next = t.indexOf(ch, at + 1);
    if (next === -1) return -1;
    score += next === at + 1 ? 5 : (t[next - 1] === ' ' ? 3 : 1);
    at = next;
  }
  return score;
}

/** Commands for `query`: ranked matches first, then the query-built ones. */
export function collectCommands(query, limit = 8) {
  const ranked = [];
  const dynamic = [];
  for (const [name, provider] of providers) {
    let list = [];
    try {
      list = provider(query) || [];
    } catch (err) {
      console.error(`[commands] provider "${name}" failed:`, err);
    }
    for (const cmd of list) {
      if (cmd.dynamic) {
        if (query.trim()) dynamic.push(cmd);
        continue;
      }
      const score = Math.max(scoreMatch(query, cmd.title), cmd.keywords ? scoreMatch(query, cmd.keywords) - 1 : -1);
      if (score >= 0) ranked.push({ cmd, score });
    }
  }
  ranked.sort((a, b) => b.score - a.score);
  const room = Math.max(0, limit - dynamic.length);
  return [...ranked.slice(0, room).map(r => r.cmd), ...dynamic];
}

/** For tests: drop every provider. */
export function clearCommands() {
  providers.clear();
}
