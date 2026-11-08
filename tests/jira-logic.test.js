import { test } from 'node:test';
import assert from 'node:assert';
import {
  normalizeSite, isValidCloudId, isValidIssueKey, issueUrl, clampMax, resolveJiraSettings,
  searchUrl, tenantInfoUrl, authHeader, parseSearchResponse, classifyHttpFailure, failureInfo,
  cacheMatches, relativeTime, statusTone, backoffMs, refreshDue, cloudIdFromTenantInfo,
  DEFAULT_JQL, REFRESH_MS,
} from '../apps/jira/jira-logic.js';

const CLOUD = '1324a887-45db-1bf4-1e99-ef0ff456d421';

test('normalizeSite accepts a name, a hostname or a URL', () => {
  assert.strictEqual(normalizeSite('acme'), 'acme.atlassian.net');
  assert.strictEqual(normalizeSite(' ACME.atlassian.net '), 'acme.atlassian.net');
  assert.strictEqual(normalizeSite('https://acme.atlassian.net/jira/software/projects/X'), 'acme.atlassian.net');
  assert.strictEqual(normalizeSite('acme.atlassian.net/browse/ABC-1'), 'acme.atlassian.net');
  assert.strictEqual(normalizeSite('my-team2'), 'my-team2.atlassian.net');
});

test('normalizeSite rejects anything that is not an Atlassian Cloud site', () => {
  for (const bad of ['', '   ', 'evil.com', 'https://evil.com/acme.atlassian.net', 'acme.atlassian.net.evil.com',
    'javascript:alert(1)', 'a b', '-acme', 'acme.atlassian.net:8080@evil.com', 'user@acme.atlassian.net', null, undefined]) {
    assert.strictEqual(normalizeSite(bad), null, String(bad));
  }
});

test('isValidCloudId accepts UUIDs only', () => {
  assert.ok(isValidCloudId(CLOUD));
  assert.ok(isValidCloudId(CLOUD.toUpperCase()));
  assert.ok(!isValidCloudId('1324a887'));
  assert.ok(!isValidCloudId(`${CLOUD}/../x`));
  assert.ok(!isValidCloudId(''));
});

test('isValidIssueKey / issueUrl build links only from a valid site and key', () => {
  assert.ok(isValidIssueKey('ABC-123'));
  assert.ok(isValidIssueKey('A1_B-1'));
  assert.ok(!isValidIssueKey('abc-1'));
  assert.ok(!isValidIssueKey('A-1'), 'project keys have at least two characters');
  assert.ok(!isValidIssueKey('ABC-1"><script>'));
  assert.strictEqual(issueUrl('acme.atlassian.net', 'ABC-12'), 'https://acme.atlassian.net/browse/ABC-12');
  assert.strictEqual(issueUrl('evil.com', 'ABC-12'), null);
  assert.strictEqual(issueUrl('acme.atlassian.net', 'ABC-12/../x'), null);
});

test('clampMax defaults to 20 and stays within 1..100', () => {
  assert.strictEqual(clampMax(undefined), 20);
  assert.strictEqual(clampMax(''), 20);
  assert.strictEqual(clampMax('abc'), 20);
  assert.strictEqual(clampMax(0), 1);
  assert.strictEqual(clampMax(500), 100);
  assert.strictEqual(clampMax('35'), 35);
  assert.strictEqual(clampMax(7.6), 7);
});

test('resolveJiraSettings applies defaults and reports what is missing', () => {
  const empty = resolveJiraSettings({});
  assert.strictEqual(empty.configured, false);
  assert.deepStrictEqual(empty.missing, ['site', 'email', 'token', 'cloudId']);
  assert.strictEqual(empty.jql, DEFAULT_JQL);
  assert.strictEqual(empty.label, 'Jira');
  assert.strictEqual(empty.max, 20);

  const full = resolveJiraSettings({ site: 'acme', email: 'me@x.io', token: 't', cloudId: CLOUD, jql: ' project = X ', label: ' Work ', max: 5 });
  assert.strictEqual(full.configured, true);
  assert.strictEqual(full.site, 'acme.atlassian.net');
  assert.strictEqual(full.jql, 'project = X');
  assert.strictEqual(full.label, 'Work');
  assert.strictEqual(full.max, 5);

  assert.strictEqual(resolveJiraSettings({ site: 'acme', email: 'e', token: 't', cloudId: 'nope' }).configured, false);
});

test('searchUrl goes through the api.atlassian.com gateway with the cloudId', () => {
  const url = new URL(searchUrl({ cloudId: CLOUD, jql: 'project = "A&B"', max: 7 }));
  assert.strictEqual(url.origin, 'https://api.atlassian.com');
  assert.strictEqual(url.pathname, `/ex/jira/${CLOUD}/rest/api/3/search/jql`);
  assert.strictEqual(url.searchParams.get('jql'), 'project = "A&B"');
  assert.strictEqual(url.searchParams.get('maxResults'), '7');
  assert.strictEqual(url.searchParams.get('fields'), 'summary,status,assignee,priority,issuetype,updated');
  assert.strictEqual(tenantInfoUrl('acme.atlassian.net'), 'https://acme.atlassian.net/_edge/tenant_info');
});

test('authHeader is Basic base64(email:token), UTF-8 safe', () => {
  assert.strictEqual(authHeader('me@x.io', 'tok'), `Basic ${Buffer.from('me@x.io:tok').toString('base64')}`);
  assert.strictEqual(authHeader('jö@x.io', 'tök'), `Basic ${Buffer.from('jö@x.io:tök', 'utf8').toString('base64')}`);
});

test('parseSearchResponse maps issues and drops entries with invalid keys', () => {
  const issues = parseSearchResponse({
    issues: [
      { key: 'ABC-1', fields: { summary: 'Fix it', status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } }, assignee: { displayName: 'Ann' }, priority: { name: 'High' }, issuetype: { name: 'Bug' }, updated: '2026-11-08T09:00:00.000+0000' } },
      { key: 'bad key', fields: { summary: 'x' } },
      { key: 'ABC-2', fields: { summary: null, status: null, assignee: null } },
    ],
  });
  assert.deepStrictEqual(issues, [
    { key: 'ABC-1', summary: 'Fix it', status: 'In Progress', category: 'indeterminate', assignee: 'Ann', priority: 'High', type: 'Bug', updated: '2026-11-08T09:00:00.000+0000' },
    { key: 'ABC-2', summary: '', status: '', category: 'new', assignee: '', priority: '', type: '', updated: '' },
  ]);
  assert.strictEqual(parseSearchResponse(null), null);
  assert.strictEqual(parseSearchResponse({ nope: 1 }), null);
});

test('classifyHttpFailure maps statuses to reasons, with Jira\'s JQL message', () => {
  assert.deepStrictEqual(classifyHttpFailure(401), { reason: 'bad-token' });
  assert.deepStrictEqual(classifyHttpFailure(403), { reason: 'forbidden' });
  assert.deepStrictEqual(classifyHttpFailure(404), { reason: 'not-found' });
  assert.deepStrictEqual(classifyHttpFailure(429), { reason: 'rate-limited' });
  assert.deepStrictEqual(classifyHttpFailure(400, { errorMessages: ["Field 'x' does not exist."] }), { reason: 'bad-jql', message: "Field 'x' does not exist." });
  assert.deepStrictEqual(classifyHttpFailure(400, { errors: { jql: 'Bad' } }), { reason: 'bad-jql', message: 'Bad' });
  assert.deepStrictEqual(classifyHttpFailure(400, null), { reason: 'bad-jql' });
  assert.deepStrictEqual(classifyHttpFailure(503), { reason: 'http', status: 503 });
});

test('failureInfo gives a label, a detail and the action that fixes it', () => {
  for (const reason of ['unconfigured', 'bad-token', 'forbidden', 'bad-jql', 'rate-limited', 'not-found', 'network', 'http']) {
    const info = failureInfo({ reason });
    assert.ok(info.label && info.detail, reason);
    assert.ok(['setup', 'retry'].includes(info.action), reason);
  }
  assert.strictEqual(failureInfo({ reason: 'bad-token' }).action, 'setup');
  assert.strictEqual(failureInfo({ reason: 'network' }).action, 'retry');
  assert.strictEqual(failureInfo({ reason: 'bad-jql', message: 'Oops' }).detail, 'Oops');
  assert.strictEqual(failureInfo({ reason: 'whatever' }).label, failureInfo({ reason: 'network' }).label);
});

test('cacheMatches compares site, cloudId, jql and max', () => {
  const query = { site: 'acme.atlassian.net', cloudId: CLOUD, jql: 'x', max: 20 };
  const entry = { query: { ...query }, issues: [], fetchedAt: 1 };
  assert.ok(cacheMatches(entry, query));
  assert.ok(!cacheMatches({ ...entry, query: { ...query, jql: 'y' } }, query));
  assert.ok(!cacheMatches({ ...entry, query: { ...query, max: 5 } }, query));
  assert.ok(!cacheMatches({ query, fetchedAt: 1 }, query), 'needs issues');
  assert.ok(!cacheMatches(null, query));
});

test('relativeTime is short and tabular', () => {
  const now = Date.parse('2026-11-08T12:00:00Z');
  assert.strictEqual(relativeTime('2026-11-08T11:59:40Z', now), 'now');
  assert.strictEqual(relativeTime('2026-11-08T11:55:00Z', now), '5m');
  assert.strictEqual(relativeTime('2026-11-08T09:00:00.000+0000', now), '3h');
  assert.strictEqual(relativeTime('2026-11-06T12:00:00Z', now), '2d');
  assert.strictEqual(relativeTime('2026-10-18T12:00:00Z', now), '3w');
  assert.match(relativeTime('2025-01-01T12:00:00Z', now), /2025/);
  assert.strictEqual(relativeTime('', now), '');
  assert.strictEqual(relativeTime('garbage', now), '');
});

test('statusTone follows the status category', () => {
  assert.strictEqual(statusTone('new'), 'new');
  assert.strictEqual(statusTone('indeterminate'), 'indeterminate');
  assert.strictEqual(statusTone('done'), 'done');
  assert.strictEqual(statusTone('undefined'), 'new');
});

test('backoff doubles after each failure, capped at an hour', () => {
  assert.strictEqual(backoffMs(0), REFRESH_MS);
  assert.strictEqual(backoffMs(1), REFRESH_MS);
  assert.strictEqual(backoffMs(2), 2 * REFRESH_MS);
  assert.strictEqual(backoffMs(3), 4 * REFRESH_MS);
  assert.strictEqual(backoffMs(10), 60 * 60 * 1000);
});

test('refreshDue: every 5 minutes, later after failures, never for setup problems', () => {
  const t = 10_000_000;
  assert.ok(refreshDue({ fetchedAt: 0, lastAttemptAt: 0, failures: 0 }, t));
  assert.ok(!refreshDue({ fetchedAt: t - 60_000, lastAttemptAt: 0, failures: 0 }, t));
  assert.ok(refreshDue({ fetchedAt: t - REFRESH_MS, lastAttemptAt: 0, failures: 0 }, t));
  assert.ok(!refreshDue({ fetchedAt: 0, lastAttemptAt: t - REFRESH_MS, failures: 2 }, t), 'backed off');
  assert.ok(refreshDue({ fetchedAt: 0, lastAttemptAt: t - 2 * REFRESH_MS, failures: 2 }, t));
  assert.ok(!refreshDue({ fetchedAt: 0, lastAttemptAt: 0, failures: 1, blocked: true }, t), 'bad token: wait for setup');
  assert.ok(!refreshDue({ fetchedAt: 0, lastAttemptAt: t - 2 * REFRESH_MS, failures: 1, retryAfterMs: 3 * REFRESH_MS }, t), 'Retry-After honoured');
});

test('cloudIdFromTenantInfo returns a valid cloudId or null', () => {
  assert.strictEqual(cloudIdFromTenantInfo({ cloudId: CLOUD }), CLOUD);
  assert.strictEqual(cloudIdFromTenantInfo({ cloudId: 'x' }), null);
  assert.strictEqual(cloudIdFromTenantInfo(null), null);
});
