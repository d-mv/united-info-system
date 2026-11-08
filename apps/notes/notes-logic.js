/**
 * Notes: pure helpers (no DOM), so they run and are tested in Node.
 *
 * The sanitizer is the security boundary for rich text. It never trusts the
 * input's structure: it scans tags itself, rebuilds only allowlisted tags from
 * their names (plus a checked href on <a>), and escapes all text. Nothing from
 * the input reaches the output except allowlisted tag names, a vetted URL and
 * re-escaped text, so its output is safe for innerHTML.
 */
import { escapeHtml } from '../../core/html.js';

// Tag name in the input -> tag name in the output.
const RENAME = {
  p: 'p', div: 'p', br: 'br',
  b: 'b', strong: 'strong', i: 'i', em: 'em', u: 'u', s: 's',
  h1: 'h2', h2: 'h2', h3: 'h3', h4: 'h3', h5: 'h3', h6: 'h3',
  ul: 'ul', ol: 'ol', li: 'li', a: 'a', blockquote: 'blockquote', code: 'code', pre: 'pre',
};
const VOID = new Set(['br']);
// Opening one of these closes an open p/h2/h3 (they can't hold blocks).
const BLOCKS = new Set(['p', 'h2', 'h3', 'ul', 'ol', 'blockquote', 'pre']);
const TEXT_BLOCKS = new Set(['p', 'h2', 'h3']);
const BOUNDARIES = new Set(['li', 'blockquote']);
// Elements dropped together with everything inside them.
// Raw-text ones: content is not markup, skip straight to the closing tag.
const RAW_TEXT = new Set(['script', 'style', 'iframe', 'textarea', 'title', 'xmp', 'noscript', 'noembed', 'noframes']);
// Others: skip their (nested) markup until the matching close.
const DROP_TREE = new Set(['svg', 'math', 'template', 'object', 'head', 'select', 'frameset']);

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  colon: ':', tab: '\t', newline: '\n', sol: '/', lpar: '(', rpar: ')', semi: ';',
  mdash: '—', ndash: '–', hellip: '…', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', bull: '•',
  middot: '·', copy: '©', reg: '®', trade: '™', times: '×', euro: '€',
};

/** Decode character references (named from a small table, and all numeric ones). */
export function decodeEntities(text) {
  return String(text).replace(/&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z][a-zA-Z0-9]*));?/g, (match, dec, hex, name) => {
    if (dec || hex) {
      const code = dec ? parseInt(dec, 10) : parseInt(hex, 16);
      if (!code || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '�';
      return String.fromCodePoint(code);
    }
    const value = NAMED[name.toLowerCase()];
    return value !== undefined && match.endsWith(';') ? value : match;
  });
}

const SCHEME_OK = /^(https?:|mailto:)/i;

/**
 * The URL a link may point to, or null. Decodes references and drops control
 * characters and surrounding spaces first (browsers ignore those too), so
 * "java&#9;script:" or " javascript:" can't slip past the scheme check, and
 * the string checked is exactly the string emitted.
 */
export function cleanLinkUrl(url) {
  const clean = decodeEntities(url == null ? '' : url).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return SCHEME_OK.test(clean) ? clean : null;
}

/** A URL typed into the link field: a bare host gets https://; other schemes are refused. */
export function linkFromInput(input) {
  const raw = String(input || '').trim();
  if (!raw) return { ok: false, error: 'Enter a URL' };
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^[^:/]+:\d/.test(raw);
  const url = cleanLinkUrl(hasScheme ? raw : `https://${raw}`);
  return url ? { ok: true, url } : { ok: false, error: 'Only http(s) and mailto links' };
}

// Index just past the `>` that ends a tag starting at `from`, honouring quotes; -1 if unterminated.
function tagEnd(html, from) {
  let quote = '';
  for (let i = from; i < html.length; i++) {
    const ch = html[i];
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i + 1;
    }
  }
  return -1;
}

// The href value from a tag's attribute text (null if absent).
function readHref(attrs) {
  const re = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m;
  while ((m = re.exec(attrs))) {
    if (m[1].toLowerCase() === 'href') return m[2] ?? m[3] ?? m[4] ?? '';
  }
  return null;
}

/**
 * One tag at `i` (html[i] === '<'), or null when `<` starts plain text.
 * { kind: 'comment'|'start'|'end', name, attrs, end }
 */
function readTag(html, i) {
  if (html.startsWith('<!--', i)) {
    const close = html.indexOf('-->', i + 4);
    return { kind: 'comment', end: close === -1 ? html.length : close + 3 };
  }
  const next = html[i + 1];
  if (next === '!' || next === '?') {
    const end = html.indexOf('>', i);
    return { kind: 'comment', end: end === -1 ? html.length : end + 1 };
  }
  const m = /^<(\/?)([a-zA-Z][^\s/>]*)/.exec(html.slice(i, i + 64));
  if (!m) return null;
  const end = tagEnd(html, i + m[0].length);
  // An unterminated tag swallows the rest of the input (as browsers do).
  if (end === -1) return { kind: 'comment', end: html.length };
  return {
    kind: m[1] ? 'end' : 'start',
    name: m[2].toLowerCase(),
    attrs: html.slice(i + m[0].length, end - 1),
    end,
  };
}

// Where a raw-text element's content ends: just past its closing tag (or the end).
function skipRawText(html, from, name) {
  const re = new RegExp(`</${name}[\\s/>]`, 'ig');
  re.lastIndex = from;
  const m = re.exec(html);
  if (!m) return html.length;
  const end = tagEnd(html, m.index + 2 + name.length);
  return end === -1 ? html.length : end;
}

// Skip a dropped subtree that started before `from`; returns the index after its close.
function skipTree(html, from, name) {
  let depth = 1;
  let i = from;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) return html.length;
    const tag = readTag(html, lt);
    if (!tag) { i = lt + 1; continue; }
    i = tag.end;
    if (tag.kind === 'start' && RAW_TEXT.has(tag.name)) i = skipRawText(html, i, tag.name);
    else if (tag.kind === 'start' && tag.name === name && !/\/\s*$/.test(tag.attrs)) depth++;
    else if (tag.kind === 'end' && tag.name === name && --depth === 0) return i;
  }
  return html.length;
}

/** Allowlist sanitizer for note HTML. See the module comment. */
export function sanitizeHtml(input) {
  const html = input == null ? '' : String(input);
  const out = [];
  // Open output elements: { name, at } where `at` is the index of its opening tag in `out`.
  const stack = [];

  const close = (index) => {
    while (stack.length > index) {
      const el = stack.pop();
      // Drop a paragraph that ended up empty (e.g. from nested divs).
      if (el.name === 'p' && el.at === out.length - 1) out.pop();
      else out.push(`</${el.name}>`);
    }
  };
  const findOpen = (names, stopAt) => {
    for (let k = stack.length - 1; k >= 0; k--) {
      if (names.has(stack[k].name)) return k;
      if (stopAt && stopAt.has(stack[k].name)) return -1;
    }
    return -1;
  };

  const open = (name, attrs) => {
    if (BLOCKS.has(name)) {
      const k = findOpen(TEXT_BLOCKS, BOUNDARIES);
      if (k !== -1) close(k);
    }
    if (name === 'li') {
      const k = findOpen(new Set(['li']), new Set(['ul', 'ol']));
      if (k !== -1) close(k);
    }
    let tag = `<${name}>`;
    if (name === 'a') {
      const href = cleanLinkUrl(readHref(attrs));
      if (!href) return; // keep the text, lose the link
      const k = findOpen(new Set(['a']));
      if (k !== -1) close(k);
      tag = `<a href="${escapeHtml(href)}" rel="noopener noreferrer" target="_blank">`;
    }
    out.push(tag);
    if (!VOID.has(name)) stack.push({ name, at: out.length - 1 });
  };

  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    const textEnd = lt === -1 ? html.length : lt;
    if (textEnd > i) out.push(escapeHtml(decodeEntities(html.slice(i, textEnd))));
    if (lt === -1) break;

    const tag = readTag(html, lt);
    if (!tag) {
      out.push('&lt;');
      i = lt + 1;
      continue;
    }
    i = tag.end;
    if (tag.kind === 'comment') continue;

    if (tag.kind === 'start') {
      if (RAW_TEXT.has(tag.name)) { i = skipRawText(html, i, tag.name); continue; }
      if (DROP_TREE.has(tag.name)) {
        if (!/\/\s*$/.test(tag.attrs)) i = skipTree(html, i, tag.name);
        continue;
      }
      const name = RENAME[tag.name];
      if (name) open(name, tag.attrs);
      continue;
    }

    // End tag: close the nearest open element of that (output) name, if any.
    const name = RENAME[tag.name];
    if (!name || VOID.has(name)) continue;
    for (let k = stack.length - 1; k >= 0; k--) {
      if (stack[k].name === name) { close(k); break; }
    }
  }
  close(0);
  return out.join('');
}

/** Plain text of note HTML: one entry per non-empty line, whitespace collapsed. */
export function noteText(html) {
  const marked = sanitizeHtml(html)
    .replace(/<br>|<\/?(?:p|h2|h3|ul|ol|li|blockquote|pre)>/g, '\n')
    .replace(/<[^>]*>/g, '');
  return decodeEntities(marked)
    .split('\n')
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

const TITLE_MAX = 80;

/** First line of a note's text, or "Untitled". */
export function noteTitle(html) {
  const first = noteText(html).split('\n')[0] || '';
  if (!first) return 'Untitled';
  return first.length > TITLE_MAX ? first.slice(0, TITLE_MAX - 1) + '…' : first;
}

/** Pasted plain text as note HTML: escaped, one paragraph per line (a single line stays inline). */
export function plainTextToHtml(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  if (lines.length === 1) return escapeHtml(lines[0]);
  return lines.map(line => `<p>${line ? escapeHtml(line) : '<br>'}</p>`).join('');
}

/** Most recently updated first (a new array). */
export function sortNotes(notes) {
  return [...notes].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };

/** "Just now", "5m ago", "3h ago", "Yesterday", "Wed", "Mar 4", "Mar 4, 2024". */
export function relativeTime(ts, now = Date.now()) {
  const diff = now - ts;
  if (diff < 45e3) return 'Just now';
  if (diff < 3600e3) return `${Math.max(1, Math.round(diff / 60e3))}m ago`;
  const days = Math.round((startOfDay(now) - startOfDay(ts)) / 86400e3);
  if (days === 0) return `${Math.floor(diff / 3600e3)}h ago`;
  if (days === 1) return 'Yesterday';
  const d = new Date(ts);
  if (days < 7) return DAYS[d.getDay()];
  const md = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return d.getFullYear() === new Date(now).getFullYear() ? md : `${md}, ${d.getFullYear()}`;
}

/** HH:MM in local time. */
export function clockTime(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export const newNoteId = () => 'n_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
