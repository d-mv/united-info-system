/**
 * Jira app: pure logic (settings, URLs, response parsing, failure reasons, timing).
 *
 * The browser can't call https://<site>.atlassian.net/rest/api directly (CORS),
 * but the api.atlassian.com gateway allows it with a scoped API token
 * (read:jira-work) sent as Basic auth: /ex/jira/{cloudId}/rest/api/3/search/jql.
 */

export const DEFAULT_JQL = 'assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC';
export const DEFAULT_LABEL = 'Jira';
export const DEFAULT_MAX = 20;
export const MAX_RESULTS = 100;
export const REFRESH_MS = 5 * 60 * 1000;
const BACKOFF_CAP_MS = 60 * 60 * 1000;
const FIELDS = 'summary,status,assignee,priority,issuetype,updated';

const SITE_RE = /^[a-z0-9][a-z0-9-]*\.atlassian\.net$/;
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/;

/** "acme", "acme.atlassian.net" or a full URL -> "acme.atlassian.net"; anything else -> null. */
export function normalizeSite(input) {
  let s = String(input ?? '').trim().toLowerCase();
  if (!s) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(s)) {
    let url;
    try {
      url = new URL(s);
    } catch {
      return null;
    }
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.port) return null;
    s = url.hostname;
  } else {
    if (/[:@\s]/.test(s)) return null;
    s = s.split('/')[0];
  }
  if (NAME_RE.test(s)) s = `${s}.atlassian.net`;
  return SITE_RE.test(s) ? s : null;
}

export function isValidCloudId(value) {
  return UUID_RE.test(String(value ?? '').trim());
}

export function isValidIssueKey(key) {
  return KEY_RE.test(String(key ?? ''));
}

/** https://<site>/browse/<KEY>, only from a validated site and key; else null. */
export function issueUrl(site, key) {
  if (!SITE_RE.test(String(site ?? '')) || !isValidIssueKey(key)) return null;
  return `https://${site}/browse/${key}`;
}

export function clampMax(value) {
  const n = Math.floor(Number(value));
  if (value === '' || value == null || !Number.isFinite(n)) return DEFAULT_MAX;
  return Math.min(MAX_RESULTS, Math.max(1, n));
}

/** Stored settings (configManager secret `jira`) with every default applied. */
export function resolveJiraSettings(secrets = {}) {
  const site = normalizeSite(secrets.site);
  const email = String(secrets.email || '').trim();
  const token = String(secrets.token || '');
  const cloudId = isValidCloudId(secrets.cloudId) ? String(secrets.cloudId).trim().toLowerCase() : '';
  const jql = String(secrets.jql || '').trim() || DEFAULT_JQL;
  const label = String(secrets.label || '').trim() || DEFAULT_LABEL;
  const max = clampMax(secrets.max);
  const missing = [];
  if (!site) missing.push('site');
  if (!email) missing.push('email');
  if (!token) missing.push('token');
  if (!cloudId) missing.push('cloudId');
  return { site: site || '', email, token, cloudId, jql, label, max, missing, configured: missing.length === 0 };
}

export function searchUrl({ cloudId, jql, max }) {
  const params = new URLSearchParams({ jql, fields: FIELDS, maxResults: String(clampMax(max)) });
  return `https://api.atlassian.com/ex/jira/${encodeURIComponent(cloudId)}/rest/api/3/search/jql?${params}`;
}

export function tenantInfoUrl(site) {
  return `https://${site}/_edge/tenant_info`;
}

export function cloudIdFromTenantInfo(json) {
  const id = json && json.cloudId;
  return isValidCloudId(id) ? String(id).toLowerCase() : null;
}

/** "Basic base64(email:token)", UTF-8 encoded. */
export function authHeader(email, token) {
  const bytes = new TextEncoder().encode(`${email}:${token}`);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return `Basic ${btoa(binary)}`;
}

const text = (v) => (typeof v === 'string' ? v : '');

/** The search response as plain issues, or null if it isn't one. */
export function parseSearchResponse(json) {
  if (!json || !Array.isArray(json.issues)) return null;
  return json.issues
    .filter(issue => issue && isValidIssueKey(issue.key))
    .map(({ key, fields }) => {
      const f = fields || {};
      return {
        key,
        summary: text(f.summary),
        status: text(f.status && f.status.name),
        category: statusTone(f.status && f.status.statusCategory && f.status.statusCategory.key),
        assignee: text(f.assignee && f.assignee.displayName),
        priority: text(f.priority && f.priority.name),
        type: text(f.issuetype && f.issuetype.name),
        updated: text(f.updated),
      };
    });
}

/** Status category -> tone: 'new' | 'indeterminate' | 'done'. */
export function statusTone(category) {
  return category === 'indeterminate' || category === 'done' ? category : 'new';
}

/** Failure reason for a non-2xx search response (`body` = parsed JSON, if any). */
export function classifyHttpFailure(status, body = null) {
  if (status === 401) return { reason: 'bad-token' };
  if (status === 403) return { reason: 'forbidden' };
  if (status === 404) return { reason: 'not-found' };
  if (status === 429) return { reason: 'rate-limited' };
  if (status === 400) {
    const messages = body && Array.isArray(body.errorMessages) ? body.errorMessages : [];
    const fieldErrors = body && body.errors && typeof body.errors === 'object' ? Object.values(body.errors) : [];
    const message = [...messages, ...fieldErrors].find(m => typeof m === 'string' && m.trim());
    return message ? { reason: 'bad-jql', message: message.trim() } : { reason: 'bad-jql' };
  }
  return { reason: 'http', status };
}

// What the app shows for each failure, and which action fixes it.
const FAILURES = {
  'unconfigured': { label: 'Not set up', detail: 'Add your Jira site, email and API token.', action: 'setup' },
  'bad-token': { label: 'API token rejected', detail: 'Check the email and token. Scoped tokens expire; create a new one with read:jira-work.', action: 'setup' },
  'forbidden': { label: 'Access denied', detail: 'The token is missing the read:jira-work scope or access to this site.', action: 'setup' },
  'bad-jql': { label: 'Query rejected', detail: 'Jira could not run this JQL.', action: 'setup' },
  'rate-limited': { label: 'Rate limited', detail: 'Jira asked to slow down. It will try again later.', action: 'retry' },
  'not-found': { label: 'Site not found', detail: 'Check the Cloud ID for this site.', action: 'setup' },
  'network': { label: 'Can’t reach Jira', detail: 'Offline, blocked or timed out.', action: 'retry' },
  'http': { label: 'Jira unavailable', detail: 'Jira returned an error. Try again later.', action: 'retry' },
};

export function failureInfo(error = {}) {
  const base = FAILURES[error.reason] || FAILURES.network;
  return error.message ? { ...base, detail: error.message } : base;
}

/** Failures that need new settings, not another try. */
export function needsSetup(reason) {
  return failureInfo({ reason }).action === 'setup';
}

/** The cache `{ query: {site, cloudId, jql, max}, issues, fetchedAt }` answers `query`. */
export function cacheMatches(entry, query) {
  if (!entry || !entry.query || !Array.isArray(entry.issues)) return false;
  const q = entry.query;
  return q.site === query.site && q.cloudId === query.cloudId && q.jql === query.jql && q.max === query.max;
}

/** "now", "5m", "3h", "2d", "3w", then a date. */
export function relativeTime(iso, now = Date.now()) {
  const at = Date.parse(String(iso || '').replace(/([+-]\d\d)(\d\d)$/, '$1:$2'));
  if (Number.isNaN(at)) return '';
  const s = Math.max(0, (now - at) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`;
  if (s < 5 * 7 * 86400) return `${Math.floor(s / (7 * 86400))}w`;
  const date = new Date(at);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString([], { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
}

/** Wait before the next try after `failures` failures in a row. */
export function backoffMs(failures) {
  if (failures <= 1) return REFRESH_MS;
  return Math.min(BACKOFF_CAP_MS, REFRESH_MS * 2 ** (failures - 1));
}

/**
 * Is a refresh due? Every REFRESH_MS after the last reading or attempt; after
 * failures, backed off (and at least Retry-After); never while blocked on setup.
 */
export function refreshDue({ fetchedAt = 0, lastAttemptAt = 0, failures = 0, blocked = false, retryAfterMs = 0 }, now = Date.now()) {
  if (blocked) return false;
  if (failures > 0) return now - lastAttemptAt >= Math.max(backoffMs(failures), retryAfterMs || 0);
  return now - Math.max(fetchedAt, lastAttemptAt) >= REFRESH_MS;
}
