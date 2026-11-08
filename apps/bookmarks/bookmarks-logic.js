/**
 * Pure bookmark rules (no DOM, no storage) so they can be tested directly.
 */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(text) {
  return String(text).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

const stripTags = (html) => decodeEntities(String(html).replace(/<[^>]*>/g, '')).trim();

// Root folders browsers add on export; links in them count as ungrouped.
const ROOT_FOLDER = /PERSONAL_TOOLBAR_FOLDER|UNFILED_BOOKMARKS_FOLDER/i;

/**
 * Read a Netscape bookmark file (what Chrome, Firefox and Safari export).
 * Returns [{ title, url, group }] with the innermost folder as the group.
 * Links that aren't http(s) (bookmarklets, place: URIs) are skipped.
 */
export function parseBookmarkHtml(html) {
  const text = String(html || '');
  const token = /<h3([^>]*)>([\s\S]*?)<\/h3>|<a\s([^>]*)>([\s\S]*?)<\/a>|<dl[^>]*>|<\/dl>/gi;
  const folders = []; // stack of folder names ('' for root folders)
  let pending = null; // an <H3> opens a folder at the next <DL>
  const items = [];
  let m;
  while ((m = token.exec(text))) {
    const tag = m[0].slice(0, 3).toLowerCase();
    if (m[2] !== undefined) {
      pending = ROOT_FOLDER.test(m[1]) ? '' : stripTags(m[2]);
    } else if (m[3] !== undefined) {
      const href = /href\s*=\s*"([^"]*)"/i.exec(m[3]) || /href\s*=\s*'([^']*)'/i.exec(m[3]);
      const url = href ? decodeEntities(href[1]).trim() : '';
      if (!/^https?:\/\//i.test(url)) continue;
      const group = [...folders].reverse().find(f => f) || '';
      items.push({ title: stripTags(m[4]) || url, url, group });
    } else if (tag === '</d') {
      folders.pop();
    } else {
      folders.push(pending ?? '');
      pending = null;
    }
  }
  return items;
}

/** Comparable form of a URL: lower-case host, no trailing slash. */
function urlKey(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '')}${u.search}${u.hash}`;
  } catch {
    return String(url).trim().replace(/\/+$/, '');
  }
}

/**
 * Append imported links that aren't saved yet. `makeId()` gives each new
 * bookmark its id. Returns { list, added, skipped }.
 */
export function mergeImported(existing, imported, makeId) {
  const seen = new Set(existing.map(b => urlKey(b.url)));
  const fresh = [];
  let skipped = 0;
  for (const item of imported) {
    const key = urlKey(item.url);
    if (seen.has(key)) { skipped++; continue; }
    seen.add(key);
    const bookmark = { id: makeId(), title: item.title, url: item.url };
    if (item.group) bookmark.group = item.group;
    fresh.push(bookmark);
  }
  return { list: [...existing, ...fresh], added: fresh.length, skipped };
}

/** [{ name, items }]: ungrouped ('') first, then groups in the order they first appear. */
export function groupBookmarks(list) {
  const groups = new Map([['', []]]);
  for (const item of list) {
    const name = String(item.group || '').trim();
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(item);
  }
  return [...groups].filter(([, items]) => items.length).map(([name, items]) => ({ name, items }));
}

/** The site's /favicon.ico, or null for anything that isn't an http(s) URL. */
export function faviconUrl(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? `${u.origin}/favicon.ico` : null;
  } catch {
    return null;
  }
}

/** Index 0-8 for a plain 1-9 key press, otherwise -1 (modifiers belong to the browser). */
export function shortcutKey(event) {
  if (event.metaKey || event.ctrlKey || event.altKey) return -1;
  return /^[1-9]$/.test(event.key) ? Number(event.key) - 1 : -1;
}
