/**
 * Escape a value for safe use inside HTML text or a quoted attribute.
 * Modules build markup with template strings, so every user- or API-supplied
 * value must go through this before it reaches innerHTML.
 */
const ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}

/** Return the URL only if it is http(s); anything else becomes '#'. */
export function safeHref(url) {
  return /^https?:\/\//i.test(String(url || '')) ? escapeHtml(url) : '#';
}
