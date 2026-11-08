#!/usr/bin/env node
/**
 * Real-browser smoke checks — catches what the node mock DOM can't
 * (CSS custom properties, inert, focus, layout, real fetch/route behaviour).
 *
 * Not part of `node --test`. Run manually:
 *   node tests/browser/smoke.mjs
 *
 * playwright-core lives outside the repo (no package.json here). One-time setup:
 *   npm install --prefix ~/.cache/uis-playwright playwright-core@1.64.1
 *   npx --prefix ~/.cache/uis-playwright playwright-core install chromium
 * Env: UIS_PLAYWRIGHT_DIR (install dir), UIS_CHROME (browser executable), UIS_SMOKE_PORT.
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PW_DIR = process.env.UIS_PLAYWRIGHT_DIR || path.join(homedir(), '.cache', 'uis-playwright');
const PORT = Number(process.env.UIS_SMOKE_PORT || 8790);
const BASE = `http://127.0.0.1:${PORT}`;

async function loadPlaywright() {
  try {
    const resolved = createRequire(path.join(PW_DIR, 'package.json')).resolve('playwright-core');
    const mod = await import(pathToFileURL(resolved).href);
    return mod.chromium ? mod : mod.default; // CommonJS package
  } catch {
    console.error(`playwright-core not found in ${PW_DIR}. Setup:
  npm install --prefix ${PW_DIR} playwright-core@1.64.1
  npx --prefix ${PW_DIR} playwright-core install chromium`);
    process.exit(2);
  }
}

// Playwright's own browser first; otherwise the newest cached Chromium (macOS layout).
async function launch(chromium) {
  if (process.env.UIS_CHROME) return chromium.launch({ executablePath: process.env.UIS_CHROME });
  try {
    return await chromium.launch();
  } catch (err) {
    const cache = path.join(homedir(), 'Library', 'Caches', 'ms-playwright');
    const dirs = existsSync(cache) ? readdirSync(cache).filter(d => /^chromium-\d+$/.test(d)).sort() : [];
    const app = dirs.length && path.join(cache, dirs.pop(), 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
    if (app && existsSync(app)) return chromium.launch({ executablePath: app });
    throw err;
  }
}

function startServer() {
  return new Promise((resolve, reject) => {
    const proc = spawn(path.join(REPO, 'start.sh'), [String(PORT), REPO], { stdio: ['ignore', 'pipe', 'inherit'] });
    const timer = setTimeout(() => reject(new Error('start.sh did not start within 5s')), 5000);
    proc.stdout.on('data', (chunk) => {
      if (String(chunk).includes(`localhost:${PORT}`)) { clearTimeout(timer); resolve(proc); }
    });
    proc.on('error', reject);
  });
}

// ---------- tiny runner ----------
const results = [];
function assert(cond, message) {
  if (!cond) throw new Error(message);
}

async function freshPage(browser, width = 1440) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  // No real network: any non-local request (opened links, favicons) gets an empty page.
  await context.route(/^https?:\/\/(?!127\.0\.0\.1[:/]|localhost[:/])/, r => r.fulfill({ status: 200, contentType: 'text/html', body: '' }));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  // Weather APIs are never hit; failures are expected and handled by the widget.
  await page.route(/open-meteo\.com|openweathermap\.org/, r => r.fulfill({ status: 503, body: '' }));
  await page.goto(`${BASE}/`);
  await page.waitForSelector('app-todo');
  await page.waitForTimeout(150);
  return { page, errors, close: () => context.close() };
}

const checks = {
  async 'boots all modules without page errors'(browser) {
    const { page, errors, close } = await freshPage(browser);
    const mounted = await page.evaluate(() => [...document.querySelectorAll('#shell > .module')].map(m => m.tagName.toLowerCase()));
    await close();
    assert(mounted.join() === 'app-clock,widget-weather,app-bookmarks,app-todo,app-notes', `mounted: ${mounted}`);
    assert(errors.length === 0, `page errors: ${errors}`);
  },

  async 'applies grid settings (CSS custom properties)'(browser) {
    const { page, close } = await freshPage(browser);
    const r = await page.evaluate(() => ({
      tracks: getComputedStyle(document.getElementById('shell')).gridTemplateColumns.split(' ').length,
      padding: getComputedStyle(document.querySelector('.module')).paddingTop,
    }));
    await close();
    assert(r.tracks === 12 && r.padding === '16px', JSON.stringify(r));
  },

  async 'saving weather settings keeps other modules mounted'(browser) {
    const { page, close } = await freshPage(browser);
    await page.evaluate(() => { document.querySelector('app-bookmarks').__marker = true; });
    await page.click('#setup-button', { force: true });
    await page.fill('#weather-city', 'Oslo');
    await page.click('#save-secrets');
    await page.waitForTimeout(200);
    const kept = await page.evaluate(() => document.querySelector('app-bookmarks').__marker === true);
    await close();
    assert(kept, 'bookmarks element was remounted');
  },

  async 'expand: one module, rest inert, focus kept and restored'(browser) {
    const { page, close } = await freshPage(browser);
    await page.click('app-bookmarks [data-expand]', { force: true });
    await page.waitForTimeout(400);
    const open = await page.evaluate(() => ({
      others: document.querySelectorAll('.module').length - 1,
      expanded: [...document.querySelectorAll('.module.expanded')].map(m => m.dataset.module),
      inert: [...document.querySelectorAll('.module')].filter(m => m.inert).length,
      aria: document.querySelector('app-bookmarks [data-expand]').getAttribute('aria-expanded'),
    }));
    assert(open.expanded.join() === 'bookmarks' && open.inert === open.others && open.aria === 'true', JSON.stringify(open));
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press('Tab');
      const where = await page.evaluate(() => document.activeElement.closest('.module')?.dataset.module ?? null);
      assert(where === null || where === 'bookmarks', `Tab reached ${where}`);
    }
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    const closed = await page.evaluate(() => ({
      expanded: document.querySelectorAll('.module.expanded').length,
      inert: [...document.querySelectorAll('.module')].filter(m => m.inert).length,
      modal: document.body.classList.contains('modal-open'),
      focus: document.activeElement.matches('app-bookmarks [data-expand]'),
    }));
    await close();
    assert(!closed.expanded && !closed.inert && !closed.modal && closed.focus, JSON.stringify(closed));
  },

  async 'dialog Close button does not toggle expansion'(browser) {
    const { page, close } = await freshPage(browser);
    await page.click('app-bookmarks #add', { force: true });
    await page.click('app-bookmarks #close-button');
    await page.waitForTimeout(300);
    const expanded = await page.evaluate(() => document.querySelectorAll('.module.expanded').length);
    await close();
    assert(expanded === 0, 'a module expanded');
  },

  async 'responsive: no horizontal scroll; stacks below 900px'(browser) {
    for (const width of [1440, 950, 375]) {
      const { page, close } = await freshPage(browser, width);
      const r = await page.evaluate(() => {
        const boxes = [...document.querySelectorAll('#shell > .module')].map(m => m.getBoundingClientRect());
        const clock = document.querySelector('.clock-text');
        return {
          hScroll: document.documentElement.scrollWidth > window.innerWidth,
          stacked: new Set(boxes.map(b => Math.round(b.left))).size === 1,
          clockFits: clock.scrollWidth <= clock.closest('.module').clientWidth,
        };
      });
      await close();
      assert(!r.hScroll, `${width}px: horizontal scroll`);
      assert(r.clockFits, `${width}px: clock time clipped`);
      assert(r.stacked === (width < 900), `${width}px: stacked=${r.stacked}`);
    }
  },

  async 'todo: edit, keyboard reorder, drag reorder, delete'(browser) {
    const { page, errors, close } = await freshPage(browser);
    const order = () => page.evaluate(() => [...document.querySelectorAll('app-todo .todo-text')].map(l => l.textContent));
    const first = (await order())[0];

    await page.click('app-todo [data-action="edit"]', { force: true });
    await page.fill('app-todo .todo-edit-text', 'Edited task');
    await page.fill('app-todo .todo-edit-date', '2000-01-01');
    await page.click('app-todo .todo-edit-form button[type="submit"]');
    let names = await order();
    assert(names[0] === 'Edited task', `after edit: ${names}`);
    assert(await page.isVisible('app-todo .todo-due--overdue'), 'overdue badge shown');
    assert(await page.evaluate(() => document.activeElement.matches('app-todo [data-action="edit"]')), 'focus back on Edit');

    await page.focus('app-todo [data-action="reorder"]');
    await page.keyboard.press('ArrowDown');
    names = await order();
    assert(names[1] === 'Edited task', `after ArrowDown: ${names}`);
    assert(await page.evaluate(() => document.activeElement.matches('app-todo [data-action="reorder"]')), 'focus stays on grip');

    const rows = page.locator('app-todo .todo-item');
    await rows.nth(2).dragTo(rows.nth(0));
    names = await order();
    assert(names[0] !== first || names.length < 3, `drag did nothing: ${names}`);

    const before = names.length;
    await page.click('app-todo [data-action="edit"]', { force: true });
    await page.click('app-todo .todo-edit-form [data-action="delete"]');
    names = await order();
    await close();
    assert(names.length === before - 1, `after delete: ${names}`);
    assert(errors.length === 0, `page errors: ${errors}`);
  },

  async 'bookmarks: import file, groups, 1-9 shortcut opens a tab'(browser) {
    const { page, errors, close } = await freshPage(browser);
    await page.route(/favicon\.ico$/, r => r.fulfill({ status: 404, body: '' }));
    await page.setInputFiles('app-bookmarks .import-input', {
      name: 'bookmarks.html', mimeType: 'text/html',
      buffer: Buffer.from('<DL><p><DT><H3>Imported</H3><DL><p><DT><A HREF="https://imported.example">Imported one</A></DL><p></DL>'),
    });
    await page.waitForSelector('app-bookmarks .bookmark-group__name');
    const notice = await page.textContent('app-bookmarks .bookmark-notice');
    assert(/Imported 1/.test(notice), `notice: ${notice}`);

    await page.click('body', { position: { x: 5, y: 890 } });
    const popup = page.context().waitForEvent('page', { timeout: 2000 });
    await page.keyboard.press('1');
    const opened = await popup;
    const url = opened.url();
    await opened.close();
    assert(/refactoringui\.com/.test(url), `1 opened ${url}`);

    await page.click('app-todo .add-todo-input');
    await page.keyboard.press('2');
    const typed = await page.inputValue('app-todo .add-todo-input');
    await close();
    assert(typed === '2', 'digit typed into an input must not open a bookmark');
    assert(errors.length === 0, `page errors: ${errors}`);
  },

  async 'clock: weekday alarms, second zone, pomodoro'(browser) {
    const { page, errors, close } = await freshPage(browser);
    await page.click('app-clock [data-action="open-alarm"]');
    await page.fill('app-clock dialog input[name="time"]', '06:30');
    await page.click('app-clock dialog .day:has(input[value="1"])');
    await page.click('app-clock dialog .day:has(input[value="3"])');
    await page.click('app-clock dialog button[type="submit"]');
    const listed = await page.textContent('app-clock dialog .alarm-list');
    assert(/06:30/.test(listed) && /Mon Wed/.test(listed), `alarm list: ${listed}`);
    assert(await page.evaluate(() => document.activeElement.matches('app-clock dialog input[name="time"]')), 'focus back on time');
    await page.click('app-clock dialog .alarm-item label');
    const off = await page.evaluate(() => JSON.parse(localStorage.getItem('dashboard:clock')).alarms[0].enabled);
    assert(off === false, 'label click switches the alarm off');
    await page.click('app-clock dialog [data-action="close-dialog"] >> nth=-1');

    await page.click('app-clock [data-action="open-zone"]');
    await page.fill('app-clock dialog input[name="zone"]', 'Nowhere/Land');
    await page.click('app-clock dialog button[type="submit"]');
    assert(await page.isVisible('app-clock dialog .error'), 'bad zone explained');
    await page.fill('app-clock dialog input[name="zone"]', 'Asia/Tokyo');
    await page.click('app-clock dialog button[type="submit"]');
    const zone = await page.textContent('app-clock .clock-zone');
    assert(/Tokyo\s+\d\d:\d\d/.test(zone), `zone: ${zone}`);

    await page.click('app-clock [data-action="open-timer"]');
    await page.click('app-clock dialog [data-action="pomodoro-start"]');
    const label = await page.textContent('app-clock [data-action="open-timer"] .label');
    await close();
    assert(label === 'Focus 1/4', `timer row: ${label}`);
    assert(errors.length === 0, `page errors: ${errors}`);
  },

  async 'settings: export a backup and import it back'(browser) {
    const { page, errors, close } = await freshPage(browser);
    await page.click('shell-bar [data-action="open-settings"]');
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('shell-bar [data-action="export"]')]);
    const { readFile } = await import('node:fs/promises');
    const backup = JSON.parse(await readFile(await download.path(), 'utf-8'));
    assert(backup.app === 'uis' && backup.data.config, 'backup has the config');
    backup.data['app:todo'] = [{ id: 'r1', text: 'Restored task', done: false }];

    await page.setInputFiles('shell-bar .backup-input', { name: 'b.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
    await page.waitForSelector('shell-bar [data-action="import-confirm"]');
    await Promise.all([page.waitForEvent('load'), page.click('shell-bar [data-action="import-confirm"]')]);
    await page.waitForSelector('app-todo .todo-text');
    const texts = await page.$$eval('app-todo .todo-text', els => els.map(e => e.textContent));
    await close();
    assert(texts.join() === 'Restored task', `after import: ${texts}`);
    assert(errors.length === 0, `page errors: ${errors}`);
  },

  async 'palette: Ctrl+K and "/" open it; commands run; focus returns'(browser) {
    const { page, errors, close } = await freshPage(browser);
    await page.click('body', { position: { x: 5, y: 890 } });
    await page.keyboard.press('Control+k');
    await page.waitForSelector('command-palette dialog[open]');
    await page.keyboard.type('pick up parcel');
    const last = await page.$$eval('command-palette .palette-option__title', els => els.map(e => e.textContent));
    assert(last.includes('Add task: pick up parcel') && last.includes('Search the web: pick up parcel'), `options: ${last}`);
    await page.click('command-palette .palette-option:has-text("Add task")');
    await page.waitForSelector('command-palette dialog', { state: 'detached' });
    const first = await page.textContent('app-todo .todo-text');
    assert(first === 'pick up parcel', `todo: ${first}`);

    await page.keyboard.press('/');
    await page.keyboard.type('refac');
    const popup = page.context().waitForEvent('page', { timeout: 2000 });
    await page.keyboard.press('Enter');
    const opened = await popup;
    const url = opened.url();
    await opened.close();
    assert(/refactoringui/.test(url), `opened ${url}`);

    await page.focus('shell-bar [data-action="open-settings"]');
    await page.keyboard.press('Control+k');
    await page.keyboard.press('Escape');
    const back = await page.evaluate(() => document.activeElement.matches('shell-bar [data-action="open-settings"]'));
    await close();
    assert(back, 'focus returns after Escape');
    assert(errors.length === 0, `page errors: ${errors}`);
  },

  async 'layout editor: drag, keys, refused overlap, hide, no remount'(browser) {
    const { page, errors, close } = await freshPage(browser);
    const placement = (id) => page.evaluate((id) => {
      const c = JSON.parse(localStorage.getItem('dashboard:config'));
      const m = c.pages.find(p => p.id === c.activePage).modules.find(x => x.id === id);
      return [m.col, m.row, m.cols, m.rows, m.enabled];
    }, id);
    await page.evaluate(() => { document.querySelector('app-todo').__marker = 1; });
    await page.click('shell-bar [data-action="toggle-layout"]');
    await page.waitForSelector('.layout-overlay');
    assert(await page.evaluate(() => document.querySelector('app-todo').inert), 'modules are inert while editing');
    // Notes sits below weather (col 1, row 5); hide it so weather has room to move down.
    await page.click('.layout-overlay[data-overlay-for="notes"] [data-layout="hide"]');
    // Hiding remounts the grid; mark todo again once it has.
    await page.waitForFunction(() => document.querySelector('app-todo') && !document.querySelector('app-notes'));
    await page.evaluate(() => { document.querySelector('app-todo').__marker = 1; });

    // Weather (2x2 at 1,3): drag one row down -> row 4.
    const weather = page.locator('.layout-overlay[data-overlay-for="weather"]');
    const box = await weather.boundingBox();
    await page.mouse.move(box.x + 40, box.y + 40);
    await page.mouse.down();
    await page.mouse.move(box.x + 40, box.y + 40 + 112, { steps: 5 });
    await page.mouse.up();
    let p = await placement('weather');
    assert(p[1] === 4, `after drag: ${p}`);

    // Keys: Shift+Right grows to 3 wide, but Right then would overlap bookmarks (col 3) -> refused.
    await weather.focus();
    await page.keyboard.press('Shift+ArrowRight');
    p = await placement('weather');
    assert(p[2] === 2, `growing into bookmarks must be refused: ${p}`);
    await page.keyboard.press('ArrowDown');
    p = await placement('weather');
    assert(p[1] === 5, `ArrowDown: ${p}`);
    assert(await page.evaluate(() => document.activeElement.dataset.overlayFor === 'weather'), 'focus stays on the overlay');

    assert(await page.evaluate(() => document.querySelector('app-todo').__marker === 1), 'moving a module must not remount the others');

    await page.click('.layout-overlay[data-overlay-for="weather"] [data-layout="hide"]');
    p = await placement('weather');
    assert(p[4] === false, 'hidden');

    await page.click('shell-bar [data-action="toggle-layout"]');
    const after = await page.evaluate(() => ({
      overlays: document.querySelectorAll('.layout-overlay').length,
      inert: document.querySelector('app-todo').inert,
    }));
    await close();
    assert(after.overlays === 0 && !after.inert, JSON.stringify(after));
    assert(errors.length === 0, `page errors: ${errors}`);
  },

  async 'appearance: dark theme and accent apply live and before paint on reload'(browser) {
    const { page, errors, close } = await freshPage(browser); // OS scheme: light
    const look = () => page.evaluate(() => ({
      bg: getComputedStyle(document.body).backgroundColor,
      accent: getComputedStyle(document.querySelector('.todo-now.is-active .todo-now__dot') || document.body).backgroundColor,
      theme: document.documentElement.dataset.theme || 'auto',
    }));
    const before = await look();
    await page.click('shell-bar [data-action="open-settings"]');
    await page.click('shell-bar .segment:has(input[value="dark"])');
    await page.click('shell-bar .swatch:has(input[value="green"])');
    await page.waitForTimeout(300); // colour transitions
    const live = await look();
    assert(live.theme === 'dark' && live.bg !== before.bg, `live: ${JSON.stringify(live)}`);
    assert(live.accent === 'rgb(76, 175, 114)', `green accent in dark: ${live.accent}`);

    // With every script file blocked, only the inline head script can set the theme.
    await page.route(/\.js$/, r => r.abort());
    await page.reload();
    const early = await page.evaluate(() => document.documentElement.dataset.theme);
    await close();
    assert(early === 'dark', `early theme: ${early}`);
  },

  async 'pages: add a page, it starts empty, tabs switch, reload keeps the page'(browser) {
    const { page, errors, close } = await freshPage(browser);
    await page.click('shell-bar [data-action="open-settings"]');
    await page.fill('shell-bar .page-new-name', 'Work');
    await page.click('shell-bar [data-action="add-page"]');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#shell .shell-empty');
    const tabs = await page.$$eval('shell-bar .shell-tab', els => els.map(e => e.textContent + (e.classList.contains('is-current') ? '*' : '')));
    assert(tabs.join() === 'Home,Work*', `tabs: ${tabs}`);
    assert(/#page=p_/.test(page.url()), `url: ${page.url()}`);

    await page.reload();
    await page.waitForSelector('#shell .shell-empty');
    await page.click('shell-bar .shell-tab:has-text("Home")');
    await page.waitForSelector('app-todo');
    assert(/#page=home$/.test(page.url()), `url: ${page.url()}`);
    await close();
    assert(errors.length === 0, `page errors: ${errors}`);
  },

  async 'notes: rich text, autosave, sanitized paste, links, cross-tab keeps the editor'(browser) {
    const { page, errors, close } = await freshPage(browser);
    const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('dashboard:app:notes') || '[]'));
    await page.click('app-notes [data-action="new"]', { force: true });
    assert(await page.evaluate(() => document.activeElement.matches('app-notes .notes-editor')), 'editor focused');
    await page.keyboard.type('Shopping list');
    await page.click('app-notes .notes-tool--heading');
    assert(await page.getAttribute('app-notes .notes-tool--heading', 'aria-pressed') === 'true', 'heading pressed');
    await page.keyboard.press('Enter');
    await page.click('app-notes .notes-tool--bold');
    await page.keyboard.type('milk');
    await page.waitForTimeout(600);
    let notes = await stored();
    assert(notes.length === 1 && /<h2>Shopping list<\/h2>/.test(notes[0].html) && /<b>milk<\/b>/.test(notes[0].html), `saved: ${JSON.stringify(notes)}`);
    assert(/Saved \d\d:\d\d/.test(await page.textContent('app-notes .notes-status')), 'saved indicator');

    // Paste: only sanitized markup gets in.
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.setData('text/html', '<img src=x onerror="window.__xss=1"> pasted<script>window.__xss=2</script><a href="javascript:window.__xss=3">bad</a>');
      document.querySelector('app-notes .notes-editor').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(600);
    const editorHtml = await page.innerHTML('app-notes .notes-editor');
    assert(!/<img|<script|javascript:/i.test(editorHtml) && /pasted/.test(editorHtml), `after paste: ${editorHtml}`);
    assert(await page.evaluate(() => window.__xss === undefined), 'pasted script ran');

    // Link: unsafe refused inline, a bare host becomes https; Cmd/Ctrl+click opens it.
    await page.click('app-notes .notes-tool--link');
    await page.fill('app-notes .notes-link-input', 'javascript:alert(1)');
    await page.keyboard.press('Enter');
    assert(/http/.test(await page.textContent('app-notes .notes-link-error')), 'unsafe link explained');
    await page.fill('app-notes .notes-link-input', 'example.com');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(600);
    notes = await stored();
    assert(/<a href="https:\/\/example\.com" rel="noopener noreferrer" target="_blank">/.test(notes[0].html), `link: ${notes[0].html}`);
    const popup = page.context().waitForEvent('page', { timeout: 2000 });
    await page.click('app-notes .notes-editor a', { modifiers: ['ControlOrMeta'] });
    const opened = await popup;
    assert(/example\.com/.test(opened.url()), `opened ${opened.url()}`);
    await opened.close();

    // Another tab adds a note: the list updates, the editor keeps focus, caret and content.
    await page.evaluate(() => {
      const editor = document.querySelector('app-notes .notes-editor');
      editor.focus();
      getSelection().selectAllChildren(editor);
      getSelection().collapseToEnd();
    });
    await page.keyboard.type(' end');
    const other = await page.context().newPage();
    await other.goto(`${BASE}/`);
    await other.evaluate(() => {
      const list = JSON.parse(localStorage.getItem('dashboard:app:notes'));
      localStorage.setItem('dashboard:app:notes', JSON.stringify([...list, { id: 'other', html: '<p>From the other tab</p>', updatedAt: Date.now() }]));
    });
    await page.waitForFunction(() => /From the other tab/.test(document.querySelector('app-notes .notes-list-pane').textContent));
    await page.keyboard.type('!');
    const kept = await page.evaluate(() => ({
      focus: document.activeElement.matches('app-notes .notes-editor'),
      text: document.querySelector('app-notes .notes-editor').textContent,
    }));
    assert(kept.focus && /end!$/.test(kept.text), `editor after cross-tab write: ${JSON.stringify(kept)}`);

    // Expanded: list and editor side by side.
    await page.click('app-notes [data-expand]');
    await page.waitForTimeout(400);
    const panes = await page.evaluate(() => ['.notes-list-pane', '.notes-editor-pane'].map(s => getComputedStyle(document.querySelector(`app-notes ${s}`)).display));
    assert(panes.join() === 'flex,flex', `expanded panes: ${panes}`);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(600);

    // The open note is deleted in the other tab: the editor closes.
    const openId = (await stored()).find(n => n.id !== 'other').id;
    await other.evaluate((id) => {
      const list = JSON.parse(localStorage.getItem('dashboard:app:notes'));
      localStorage.setItem('dashboard:app:notes', JSON.stringify(list.filter(n => n.id !== id)));
    }, openId);
    await page.waitForSelector('app-notes .notes-editor', { state: 'detached' });
    await other.close();

    // Inline delete confirm.
    await page.click('app-notes .note-item');
    await page.click('app-notes [data-action="delete"]');
    await page.click('app-notes [data-action="confirm-delete"]');
    notes = await stored();
    await close();
    assert(notes.length === 0, `after delete: ${JSON.stringify(notes)}`);
    assert(errors.length === 0, `page errors: ${errors}`);
  },

  async 'server refuses dotfiles and foreign Host headers'() {
    const git = await fetch(`${BASE}/.git/HEAD`);
    assert(git.status === 404, `.git/HEAD -> ${git.status}`);
    const { request } = await import('node:http');
    const status = await new Promise((resolve, reject) => {
      request({ host: '127.0.0.1', port: PORT, path: '/', headers: { Host: 'evil.example' } }, res => resolve(res.statusCode))
        .on('error', reject).end();
    });
    assert(status === 403, `foreign Host -> ${status}`);
  },
};

// ---------- main ----------
const { chromium } = await loadPlaywright();
const server = await startServer();
let browser;
try {
  browser = await launch(chromium);
  for (const [name, fn] of Object.entries(checks)) {
    try {
      await fn(browser);
      results.push([true, name]);
    } catch (err) {
      results.push([false, name, err.message]);
    }
  }
} finally {
  if (browser) await browser.close();
  server.kill('SIGTERM');
}

for (const [ok, name, message] of results) console.log(`${ok ? '✔' : '✖'} ${name}${ok ? '' : `\n    ${message}`}`);
const failed = results.filter(([ok]) => !ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
