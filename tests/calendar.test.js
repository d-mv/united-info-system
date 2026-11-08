import { test, beforeEach } from 'node:test';
import assert from 'node:assert';
import { installBrowserGlobals, makeStorage, writeFromOtherTab } from './helpers/fake-browser.js';

installBrowserGlobals();

const { CalendarApp } = await import('../apps/calendar/calendar-app.js');
const { collectCommands, clearCommands } = await import('../core/commands.js');

// Monday 9 November 2026, 09:00 local.
const NOW = new Date(2026, 10, 9, 9, 0).getTime();
const at = (h, m, day = 9) => new Date(2026, 10, day, h, m).getTime();

const ev = (over = {}) => ({ id: 'e1', title: 'Standup', date: '2026-11-09', start: '10:00', end: null, reminder: null, source: 'local', ...over });

function makeApp(seed = {}, { expanded = false } = {}) {
  const app = new CalendarApp();
  app.storage = makeStorage(seed);
  let now = NOW;
  app.now = () => now;
  app.setNow = (ms) => { now = ms; };
  app.classList = { contains: (c) => expanded && c === 'expanded', toggle() {} };
  return app;
}

class FakeNotification {
  static permission = 'granted';
  static created = [];
  static asked = 0;
  static async requestPermission() { FakeNotification.asked++; return FakeNotification.permission; }
  constructor(title, options) { this.title = title; this.options = options; FakeNotification.created.push(this); }
  close() { this.closed = true; }
}

beforeEach(() => {
  clearCommands();
  FakeNotification.permission = 'granted';
  FakeNotification.created = [];
  FakeNotification.asked = 0;
  globalThis.Notification = FakeNotification;
});

test('empty calendar: header actions and an empty agenda', () => {
  const app = makeApp();
  app.connectedCallback();
  assert.ok(app.innerHTML.includes('Calendar'));
  assert.ok(app.innerHTML.includes('data-action="new-event"'));
  assert.ok(app.innerHTML.includes('data-action="import"'));
  assert.ok(app.innerHTML.includes('class="cal-import-input"'));
  assert.ok(app.innerHTML.includes('zoom-button'));
  assert.ok(app.innerHTML.includes('No events in the next 7 days'));
  app.disconnectedCallback();
});

test('agenda: Today, Tomorrow, then dated days, with time or All day; titles are escaped', () => {
  const app = makeApp({
    'app:calendar': [
      ev(),
      ev({ id: 'e2', title: '<b>Trip</b>', date: '2026-11-10', start: null }),
      ev({ id: 'e3', title: 'Dentist', date: '2026-11-12', start: '15:30', end: '16:00' }),
      ev({ id: 'e4', title: 'Far away', date: '2026-11-30' }),
    ],
  });
  app.connectedCallback();
  const html = app.innerHTML;
  const compact = html.slice(html.indexOf('class="cal-agenda"'), html.indexOf('class="cal-expanded"'));
  assert.ok(compact.indexOf('Today') < compact.indexOf('Tomorrow'));
  assert.ok(compact.includes('Thu 12 Nov'));
  assert.ok(compact.includes('10:00') && compact.includes('Standup'));
  assert.ok(compact.includes('All day'));
  assert.ok(compact.includes('15:30–16:00'));
  assert.ok(!compact.includes('Far away'), 'only the next 7 days');
  assert.ok(html.includes('&lt;b&gt;Trip&lt;/b&gt;') && !html.includes('<b>Trip</b>'));
  app.disconnectedCallback();
});

test('saveEvent validates, creates, edits in place and deletes', () => {
  const app = makeApp();
  assert.deepStrictEqual(app.saveEvent({ title: '', date: '2026-11-09', start: '10:00' }), { ok: false, error: 'Add a title.' });
  const created = app.saveEvent({ title: 'Review', date: '2026-11-11', start: '14:00', end: '15:00', reminder: '15' });
  assert.ok(created.ok);
  let [stored] = app.getEvents();
  assert.strictEqual(stored.title, 'Review');
  assert.strictEqual(stored.reminder, 15);
  assert.strictEqual(stored.source, 'local');
  assert.ok(stored.id);
  app.saveEvent({ id: stored.id, title: 'Review v2', date: '2026-11-11', allDay: true, reminder: '' });
  const events = app.getEvents();
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].id, stored.id);
  assert.strictEqual(events[0].start, null);
  assert.strictEqual(events[0].reminder, null);
  app.deleteEvent(stored.id);
  assert.deepStrictEqual(app.getEvents(), []);
});

test('editing an imported event keeps its source, uid and rule', () => {
  const rrule = { freq: 'WEEKLY', interval: 1 };
  const app = makeApp({ 'app:calendar': [ev({ id: 'i1', uid: 'u1', source: 'work.ics', rrule, exdates: ['2026-11-16'] })] });
  app.saveEvent({ id: 'i1', title: 'Standup (moved)', date: '2026-11-09', start: '10:30', reminder: '5' });
  const [e] = app.getEvents();
  assert.strictEqual(e.source, 'work.ics');
  assert.strictEqual(e.uid, 'u1');
  assert.deepStrictEqual(e.rrule, rrule);
  assert.deepStrictEqual(e.exdates, ['2026-11-16']);
  assert.strictEqual(e.reminder, 5);
});

test('notification permission is asked when saving with a reminder, and only then', () => {
  FakeNotification.permission = 'default';
  const app = makeApp();
  app.connectedCallback();
  app.saveEvent({ title: 'No reminder', date: '2026-11-11', start: '14:00', reminder: '' });
  assert.strictEqual(FakeNotification.asked, 0);
  app._tick();
  assert.strictEqual(FakeNotification.asked, 0, 'never on a tick');
  app.saveEvent({ title: 'With reminder', date: '2026-11-11', start: '14:00', reminder: '10' });
  assert.strictEqual(FakeNotification.asked, 1);
  app.disconnectedCallback();
});

test('a due reminder rings once: fired set, banner, notification', () => {
  const app = makeApp({ 'app:calendar': [ev({ reminder: 15 })] });
  app.connectedCallback();
  app.setNow(at(9, 44));
  app._tick();
  assert.deepStrictEqual(app.storage.get('app:calendar:fired', {}), {}, 'not yet');

  app.setNow(at(9, 46));
  app._tick();
  const fired = app.storage.get('app:calendar:fired');
  assert.ok(fired['e1@2026-11-09'], 'marked fired');
  assert.strictEqual(fired['e1@2026-11-09'].dismissed, false);
  assert.ok(app.innerHTML.includes('class="cal-ring"'), 'banner shown');
  assert.ok(app.innerHTML.includes('Standup') && app.innerHTML.includes('data-action="dismiss"'));
  assert.strictEqual(FakeNotification.created.length, 1);
  assert.strictEqual(FakeNotification.created[0].title, 'Standup');
  assert.ok(/10:00/.test(FakeNotification.created[0].options.body));

  app._tick();
  assert.strictEqual(FakeNotification.created.length, 1, 'does not ring twice');

  app.dismiss('e1@2026-11-09');
  assert.strictEqual(app.storage.get('app:calendar:fired')['e1@2026-11-09'].dismissed, true);
  assert.ok(!app.innerHTML.includes('class="cal-ring"'), 'banner gone');
  app.disconnectedCallback();
});

test('a reminder another tab already fired does not ring here, but its banner shows', () => {
  const app = makeApp({
    'app:calendar': [ev({ reminder: 15 })],
    'app:calendar:fired': { 'e1@2026-11-09': { at: at(9, 45), title: 'Standup', when: 'Today · 10:00', dismissed: false } },
  });
  app.setNow(at(9, 46));
  app.connectedCallback();
  app._tick();
  assert.strictEqual(FakeNotification.created.length, 0);
  assert.ok(app.innerHTML.includes('class="cal-ring"'));
  writeFromOtherTab('app:calendar:fired', { 'e1@2026-11-09': { at: at(9, 45), title: 'Standup', when: 'Today · 10:00', dismissed: true } });
  assert.ok(!app.innerHTML.includes('class="cal-ring"'), 'dismissed in the other tab');
  app.disconnectedCallback();
});

test('old fired entries are pruned when a new reminder fires', () => {
  const app = makeApp({
    'app:calendar': [ev({ reminder: 0 })],
    'app:calendar:fired': { 'old@2026-11-01': { at: at(9, 0, 1), title: 'Old', when: '', dismissed: true } },
  });
  app.setNow(at(10, 1));
  app._tick();
  assert.deepStrictEqual(Object.keys(app.storage.get('app:calendar:fired')), ['e1@2026-11-09']);
  app.disconnectedCallback();
});

const ICS = [
  'BEGIN:VCALENDAR', 'VERSION:2.0',
  'BEGIN:VEVENT', 'UID:a', 'SUMMARY:Planning', 'DTSTART:20261110T090000', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:b', 'SUMMARY:Weekly sync', 'DTSTART:20261109T110000', 'RRULE:FREQ=WEEKLY;BYDAY=MO', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:c', 'SUMMARY:Odd rule', 'DTSTART:20261111T110000', 'RRULE:FREQ=MONTHLY;BYDAY=2WE', 'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

test('import: result line, re-import updates by UID, sources listed and removable', () => {
  const app = makeApp({ 'app:calendar': [ev()] }, { expanded: true });
  app.connectedCallback();
  const first = app.importText(ICS, 'work.ics', { zone: 'UTC' });
  assert.deepStrictEqual(first, { ok: true, added: 3, updated: 0, simplified: 1 });
  assert.ok(app.innerHTML.includes('Imported 3 events · 1 recurring rule simplified'));
  assert.strictEqual(app.getEvents().length, 4);
  assert.ok(app.innerHTML.includes('Imported calendars'));
  assert.ok(app.innerHTML.includes('work.ics'));

  const again = app.importText(ICS.replace('Planning', 'Planning v2'), 'work.ics', { zone: 'UTC' });
  assert.strictEqual(again.added, 0);
  assert.strictEqual(again.updated, 3);
  assert.strictEqual(app.getEvents().length, 4, 'no duplicates');
  assert.ok(app.getEvents().some(e => e.title === 'Planning v2'));

  app.removeSource('work.ics');
  assert.deepStrictEqual(app.getEvents().map(e => e.id), ['e1']);
  assert.ok(app.innerHTML.includes('Removed work.ics'));
  app.disconnectedCallback();
});

test('import of a file without events shows an error and keeps the data', () => {
  const app = makeApp({ 'app:calendar': [ev()] });
  app.connectedCallback();
  const result = app.importText('just some text', 'notes.txt');
  assert.strictEqual(result.ok, false);
  assert.ok(app.innerHTML.includes('No events found in that file'));
  assert.ok(app.innerHTML.includes('role="alert"'));
  assert.strictEqual(app.getEvents().length, 1);
  app.disconnectedCallback();
});

test('expanded view: Monday-first month grid, today and event days marked, navigation', () => {
  const app = makeApp({ 'app:calendar': [ev({ date: '2026-11-12' })] }, { expanded: true });
  app.connectedCallback();
  let html = app.innerHTML;
  assert.ok(html.includes('November 2026'));
  assert.ok(/<th[^>]*>Mon<\/th>/.test(html.replace(/<abbr[^>]*>|<\/abbr>/g, '')) || html.includes('>Mon<'));
  assert.ok(/data-date="2026-11-09"[^>]*aria-current="date"/.test(html), 'today marked');
  assert.ok(/class="cal-cell[^"]*has-events[^"]*"[^>]*data-date="2026-11-12"/.test(html), 'event day marked');
  assert.ok(html.includes('data-date="2026-10-26"'), 'grid starts on the Monday before the 1st');

  app.shiftView(1);
  assert.ok(app.innerHTML.includes('December 2026'));
  app.goToday();
  assert.ok(app.innerHTML.includes('November 2026'));

  app.selectDay('2026-11-12');
  html = app.innerHTML;
  const side = html.slice(html.indexOf('class="cal-side"'));
  assert.ok(side.includes('Thu 12 Nov') && side.includes('Standup'), 'selected day agenda');
  app.disconnectedCallback();
});

test('other tabs re-render the calendar, but never over an open dialog', () => {
  const app = makeApp();
  app.connectedCallback();
  writeFromOtherTab('app:calendar', [ev({ title: 'From elsewhere' })]);
  assert.ok(app.innerHTML.includes('From elsewhere'));

  app.openEditor(null);
  assert.ok(app.innerHTML.includes('class="dialog cal-dialog"'));
  const before = app.innerHTML;
  writeFromOtherTab('app:calendar', [ev({ title: 'Changed again' })]);
  assert.strictEqual(app.innerHTML, before, 'dialog left alone');
  app.closeEditor();
  assert.ok(app.innerHTML.includes('Changed again'), 'closing catches up');
  assert.ok(!app.innerHTML.includes('class="dialog cal-dialog"'));
  app.disconnectedCallback();
});

test('dialog: edit form is prefilled, errors keep what was typed', () => {
  const app = makeApp({ 'app:calendar': [ev({ title: 'Say "hi"', reminder: 30, notes: 'Room 4' })] });
  app.connectedCallback();
  app.openEditor('e1', '2026-11-09');
  let html = app.innerHTML;
  assert.ok(html.includes('Edit event'));
  assert.ok(html.includes('value="Say &quot;hi&quot;"'));
  assert.ok(/<option value="30" selected>/.test(html));
  assert.ok(html.includes('Room 4'));
  assert.ok(html.includes('data-action="delete-event"'));

  const result = app.submitEditor({ title: 'Say hi', date: '2026-11-09', start: '10:00', end: '09:00', reminder: '30', notes: '' });
  assert.strictEqual(result.ok, false);
  html = app.innerHTML;
  assert.ok(html.includes('End must be after start.'));
  assert.ok(html.includes('value="09:00"'), 'typed end kept');
  assert.ok(html.includes('class="dialog cal-dialog"'), 'still open');
  app.disconnectedCallback();
});

test('palette: New event, Import calendar and upcoming events', () => {
  const app = makeApp({ 'app:calendar': [ev(), ev({ id: 'past', title: 'Breakfast', start: '07:00' })] });
  app.connectedCallback();
  const titles = collectCommands('', 50).map(c => c.title);
  assert.ok(titles.includes('New event'));
  assert.ok(titles.includes('Import calendar'));
  assert.ok(titles.includes('Event: Standup · Today 10:00'));
  assert.ok(!titles.some(t => t.includes('Breakfast')), 'events that are over are left out');
  collectCommands('standup')[0].run();
  assert.ok(app.innerHTML.includes('Edit event'));
  app.disconnectedCallback();
  assert.strictEqual(collectCommands('New event').filter(c => c.title === 'New event').length, 0, 'unregistered');
});
