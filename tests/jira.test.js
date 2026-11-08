import { test } from 'node:test';
import assert from 'node:assert';
import { installBrowserGlobals, makeStorage } from './helpers/fake-browser.js';
import { ConfigManager } from '../core/config.js';
import { collectCommands, clearCommands } from '../core/commands.js';

installBrowserGlobals();

const { JiraApp } = await import('../apps/jira/jira-app.js');
const { DEFAULT_JQL } = await import('../apps/jira/jira-logic.js');

const CLOUD = '1324a887-45db-1bf4-1e99-ef0ff456d421';
const SETTINGS = { site: 'acme', email: 'me@acme.io', token: 'sekret-token', cloudId: CLOUD };
const QUERY = { site: 'acme.atlassian.net', cloudId: CLOUD, jql: DEFAULT_JQL, max: 20 };

const ISSUE = (key, summary, category = 'indeterminate') => ({
  key,
  fields: {
    summary,
    status: { name: category === 'done' ? 'Done' : 'In Progress', statusCategory: { key: category } },
    assignee: { displayName: 'Ann <A>' },
    priority: { name: 'High' },
    issuetype: { name: 'Bug' },
    updated: new Date(Date.now() - 3 * 3600 * 1000).toISOString(),
  },
});

const response = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  json: async () => body,
});

function makeApp(settings = SETTINGS, seed = {}) {
  const app = new JiraApp();
  app.storage = makeStorage(seed);
  app.configManager = new ConfigManager({ storage: app.storage });
  if (settings) app.configManager.setSecret('jira', settings);
  app.classList = { contains: () => false };
  return app;
}

// Each test gets its own fetch stub; tests never reach the network.
function stubFetch(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init, calls.length);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test('unconfigured: explains what is missing and makes no request', async () => {
  const app = makeApp(null);
  const net = stubFetch(() => { throw new Error('must not fetch'); });
  try {
    app.connectedCallback();
    await app.refreshIfDue();
    assert.strictEqual(net.calls.length, 0);
    assert.match(app.innerHTML, /Not set up/);
    assert.match(app.innerHTML, /class="action-button state-setup-button"/);
  } finally {
    app.disconnectedCallback();
    net.restore();
  }
});

test('fetches the JQL through the gateway with Basic auth and renders safe links', async () => {
  const app = makeApp();
  const net = stubFetch(() => response(200, { issues: [ISSUE('ABC-1', 'Fix <b>login</b>'), ISSUE('ABC-2', 'Ship', 'done')], isLast: true }));
  try {
    await app.refresh();
    const [{ url, init }] = net.calls;
    const parsed = new URL(url);
    assert.strictEqual(parsed.origin + parsed.pathname, `https://api.atlassian.com/ex/jira/${CLOUD}/rest/api/3/search/jql`);
    assert.strictEqual(parsed.searchParams.get('jql'), DEFAULT_JQL);
    assert.strictEqual(init.headers.Authorization, `Basic ${Buffer.from('me@acme.io:sekret-token').toString('base64')}`);
    assert.strictEqual(init.headers.Accept, 'application/json');
    assert.strictEqual(init.credentials, 'omit');

    const cache = app.storage.get('app:jira:cache');
    assert.deepStrictEqual(cache.query, QUERY);
    assert.strictEqual(cache.issues.length, 2);
    assert.ok(cache.fetchedAt > 0);

    const html = app.innerHTML;
    assert.match(html, /href="https:\/\/acme\.atlassian\.net\/browse\/ABC-1"/);
    assert.match(html, /rel="noopener noreferrer"/);
    assert.ok(html.includes('Fix &lt;b&gt;login&lt;/b&gt;'), 'summary escaped');
    assert.ok(html.includes('Ann &lt;A&gt;'), 'assignee escaped');
    assert.ok(!html.includes('<b>login'), 'no raw markup');
    assert.match(html, /class="jira-status jira-status--indeterminate"/);
    assert.match(html, /class="jira-status jira-status--done"/);
    assert.match(html, />3h</);
    assert.ok(!html.includes('sekret-token'), 'token never rendered');
  } finally {
    net.restore();
  }
});

test('a matching cache is shown immediately; a cache for another query is not', async () => {
  const cached = { query: QUERY, issues: [{ key: 'OLD-7', summary: 'Cached', status: 'To Do', category: 'new', assignee: '', priority: '', type: '', updated: '' }], fetchedAt: Date.now() };
  const net = stubFetch(() => new Promise(() => {})); // never answers
  try {
    const app = makeApp(SETTINGS, { 'app:jira:cache': cached });
    app.connectedCallback();
    assert.ok(app.innerHTML.includes('OLD-7'));
    assert.strictEqual(net.calls.length, 0, 'fresh cache: no request yet');
    app.disconnectedCallback();

    const other = makeApp({ ...SETTINGS, jql: 'project = X' }, { 'app:jira:cache': cached });
    other.connectedCallback();
    assert.ok(!other.innerHTML.includes('OLD-7'));
    assert.match(other.innerHTML, /Loading/);
    assert.strictEqual(net.calls.length, 1);
    other.disconnectedCallback();
  } finally {
    net.restore();
  }
});

test('401 without a cache: "API token rejected" with setup; then no automatic retries', async () => {
  const app = makeApp();
  const net = stubFetch(() => response(401, { errorMessages: [] }));
  try {
    await app.refresh();
    assert.match(app.innerHTML, /API token rejected/);
    assert.match(app.innerHTML, /state-setup-button/);
    await app.refreshIfDue(Date.now() + 24 * 3600 * 1000);
    assert.strictEqual(net.calls.length, 1, 'waits for new settings');
  } finally {
    net.restore();
  }
});

test('a failed refresh keeps the stale list, marked "Update failed"', async () => {
  const cached = { query: QUERY, issues: [{ key: 'OLD-7', summary: 'Cached', status: 'To Do', category: 'new', assignee: '', priority: '', type: '', updated: '' }], fetchedAt: Date.now() - 3600 * 1000 };
  const app = makeApp(SETTINGS, { 'app:jira:cache': cached });
  const net = stubFetch(() => response(401, {}));
  try {
    await app.refresh();
    assert.ok(app.innerHTML.includes('OLD-7'));
    assert.match(app.innerHTML, /As of <span class="num">[^<]+<\/span> · <span class="warn">Update failed<\/span>/);
    assert.match(app.innerHTML, /API token rejected/);
  } finally {
    net.restore();
  }
});

test('400 shows Jira\'s own JQL error message', async () => {
  const app = makeApp({ ...SETTINGS, jql: 'projekt = X' });
  const net = stubFetch(() => response(400, { errorMessages: ["Field 'projekt' does not exist <x>."] }));
  try {
    await app.refresh();
    assert.match(app.innerHTML, /Query rejected/);
    assert.ok(app.innerHTML.includes("Field &#39;projekt&#39; does not exist &lt;x&gt;."));
  } finally {
    net.restore();
  }
});

test('403, 404, 429 and network failures are explained', async () => {
  const cases = [
    [() => response(403, {}), /Access denied/, /state-setup-button/],
    [() => response(404, {}), /Site not found/, /state-setup-button/],
    [() => response(429, {}, { 'retry-after': '120' }), /Rate limited/, /retry-button/],
    [() => { throw new TypeError('Failed to fetch'); }, /Can’t reach Jira/, /retry-button/],
    [() => response(502, null), /Jira unavailable/, /retry-button/],
  ];
  for (const [handler, label, action] of cases) {
    const app = makeApp();
    const net = stubFetch(handler);
    try {
      await app.refresh();
      assert.match(app.innerHTML, label);
      assert.match(app.innerHTML, action);
      assert.match(app.innerHTML, /role="status"/);
    } finally {
      net.restore();
    }
  }
});

test('network failures back off; success resets the count', async () => {
  const app = makeApp();
  let fail = true;
  const net = stubFetch(() => { if (fail) throw new TypeError('offline'); return response(200, { issues: [] }); });
  try {
    const t0 = Date.now();
    await app.refresh(t0);
    await app.refresh(t0);
    assert.strictEqual(app.failures, 2);
    await app.refreshIfDue(t0 + 6 * 60 * 1000);
    assert.strictEqual(net.calls.length, 2, 'second failure waits 10 minutes');
    fail = false;
    await app.refreshIfDue(t0 + 11 * 60 * 1000);
    assert.strictEqual(net.calls.length, 3);
    assert.strictEqual(app.failures, 0);
  } finally {
    net.restore();
  }
});

test('empty result: says no issues match', async () => {
  const app = makeApp();
  const net = stubFetch(() => response(200, { issues: [] }));
  try {
    await app.refresh();
    assert.match(app.innerHTML, /No issues match/);
  } finally {
    net.restore();
  }
});

test('only the latest request writes the cache and status', async () => {
  const app = makeApp();
  let release;
  const net = stubFetch((url, init, n) => (n === 1
    ? new Promise(resolve => { release = () => resolve(response(200, { issues: [ISSUE('SLOW-1', 'slow')] })); })
    : response(200, { issues: [ISSUE('FAST-1', 'fast')] })));
  try {
    const first = app.refresh();
    await app.refresh();
    release();
    await first;
    assert.strictEqual(app.storage.get('app:jira:cache').issues[0].key, 'FAST-1');
    assert.ok(!app.innerHTML.includes('SLOW-1'));
  } finally {
    net.restore();
  }
});

test('setup dialog: token is a password field, never echoed, stored-in-browser note', () => {
  const app = makeApp();
  app.openSetup();
  const html = app.innerHTML;
  assert.match(html, /<dialog class="dialog jira-dialog"/);
  assert.match(html, /type="password"[^>]*id="jira-token"|id="jira-token"[^>]*type="password"/);
  assert.ok(!html.includes('sekret-token'));
  assert.match(html, /stored in this browser/i);
  assert.match(html, /backups/i);
  assert.match(html, /read:jira-work/);
});

test('saveSettings normalizes the site and looks up the cloudId', async () => {
  const app = makeApp(null);
  const net = stubFetch((url) => {
    if (url === 'https://acme.atlassian.net/_edge/tenant_info') return response(200, { cloudId: CLOUD });
    return response(200, { issues: [] });
  });
  try {
    const result = await app.saveSettings({ site: 'https://acme.atlassian.net/jira', email: ' me@acme.io ', token: 'tok', cloudId: '', jql: '', label: '', max: '150' });
    assert.strictEqual(result._tag, 'Ok');
    const saved = app.configManager.getSecret('jira');
    assert.deepStrictEqual(saved, { site: 'acme.atlassian.net', email: 'me@acme.io', token: 'tok', cloudId: CLOUD, jql: DEFAULT_JQL, label: '', max: 100 });
    assert.strictEqual(net.calls[0].init.credentials, 'omit');
    assert.ok(!net.calls[0].init.headers || !net.calls[0].init.headers.Authorization, 'no credentials to tenant_info');
  } finally {
    net.restore();
  }
});

test('saveSettings: failed cloudId lookup asks for it with the tenant_info link', async () => {
  const app = makeApp(null);
  const net = stubFetch(() => { throw new TypeError('CORS'); });
  try {
    const result = await app.saveSettings({ site: 'acme', email: 'me@acme.io', token: 'tok', cloudId: '' });
    assert.strictEqual(result._tag, 'Err');
    assert.strictEqual(result.error.field, 'cloudId');
    assert.match(result.error.message, /https:\/\/acme\.atlassian\.net\/_edge\/tenant_info/);
    assert.deepStrictEqual(app.configManager.getSecret('jira'), {}, 'nothing saved');
  } finally {
    net.restore();
  }
});

test('saveSettings validates fields and keeps the stored token when left blank', async () => {
  const app = makeApp();
  const net = stubFetch(() => response(200, { issues: [] }));
  try {
    assert.deepStrictEqual((await app.saveSettings({ ...SETTINGS, site: 'evil.com' })).error.field, 'site');
    assert.deepStrictEqual((await app.saveSettings({ ...SETTINGS, email: '' })).error.field, 'email');
    assert.deepStrictEqual((await app.saveSettings({ ...SETTINGS, cloudId: 'not-a-uuid' })).error.field, 'cloudId');
    assert.strictEqual(net.calls.length, 0);

    const ok = await app.saveSettings({ ...SETTINGS, token: '', jql: 'project = X', label: 'Work' });
    assert.strictEqual(ok._tag, 'Ok');
    const saved = app.configManager.getSecret('jira');
    assert.strictEqual(saved.token, 'sekret-token');
    assert.strictEqual(saved.label, 'Work');

    const noToken = makeApp(null);
    assert.strictEqual((await noToken.saveSettings({ ...SETTINGS, token: '' })).error.field, 'token');
  } finally {
    net.restore();
  }
});

test('a new site with the old cloudId looks the cloudId up again', async () => {
  const OTHER = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const app = makeApp({ ...SETTINGS, site: 'acme.atlassian.net' });
  const net = stubFetch((url) => (url.includes('_edge') ? response(200, { cloudId: OTHER }) : response(200, { issues: [] })));
  try {
    const result = await app.saveSettings({ ...SETTINGS, site: 'beta', token: '' });
    assert.strictEqual(result._tag, 'Ok');
    assert.strictEqual(app.configManager.getSecret('jira').cloudId, OTHER);
    assert.strictEqual(net.calls[0].url, 'https://beta.atlassian.net/_edge/tenant_info');
  } finally {
    net.restore();
  }
});

test('settings change refetches with the new query', async () => {
  const app = makeApp();
  const net = stubFetch(() => response(200, { issues: [] }));
  try {
    app.connectedCallback();
    await new Promise(r => setTimeout(r, 0));
    const before = net.calls.length;
    app.configManager.setSecret('jira', { jql: 'project = NEW' });
    await new Promise(r => setTimeout(r, 0));
    assert.strictEqual(net.calls.length, before + 1);
    assert.strictEqual(new URL(net.calls.at(-1).url).searchParams.get('jql'), 'project = NEW');
  } finally {
    app.disconnectedCallback();
    net.restore();
  }
});

test('header uses the label and offers Setup, Refresh and expand', () => {
  const app = makeApp({ ...SETTINGS, label: 'Work <tickets>' });
  app.render();
  assert.ok(app.innerHTML.includes('<p class="block-header__label">Work &lt;tickets&gt;</p>'));
  assert.match(app.innerHTML, /id="jira-setup-button"/);
  assert.match(app.innerHTML, /id="jira-refresh-button"/);
  assert.match(app.innerHTML, /data-expand/);
});

test('palette: Refresh Jira, Jira setup and Open <KEY>: <summary>', async () => {
  clearCommands();
  const app = makeApp();
  const opened = [];
  globalThis.window.open = (...args) => opened.push(args);
  const net = stubFetch(() => response(200, { issues: [ISSUE('ABC-1', 'Fix login')] }));
  try {
    app.connectedCallback();
    await new Promise(r => setTimeout(r, 0));
    const titles = collectCommands('', 20).map(c => c.title);
    assert.ok(titles.includes('Refresh Jira'));
    assert.ok(titles.includes('Jira setup'));
    const open = collectCommands('fix login', 20).find(c => c.title === 'Open ABC-1: Fix login');
    assert.ok(open);
    open.run();
    assert.deepStrictEqual(opened[0], ['https://acme.atlassian.net/browse/ABC-1', '_blank', 'noopener']);
    app.disconnectedCallback();
    assert.ok(!collectCommands('', 20).some(c => c.title === 'Refresh Jira'), 'unregistered');
  } finally {
    delete globalThis.window.open;
    net.restore();
  }
});
