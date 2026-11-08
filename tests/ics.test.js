import { test } from 'node:test';
import assert from 'node:assert';
import { parseIcs, unfoldLines, unescapeText } from '../apps/calendar/ics.js';

// Results are converted into `zone`, so these tests don't depend on the machine's zone.
const cal = (...events) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...events.flat(), 'END:VCALENDAR'].join('\r\n');
const vevent = (...lines) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT'];

test('unfolds continuation lines and unescapes text', () => {
  assert.deepStrictEqual(unfoldLines('A:one\r\n two\r\n\tthree\nB:x'), ['A:onetwothree', 'B:x']);
  assert.strictEqual(unescapeText('a\\nb\\, c\\; d\\\\e\\Nf'), 'a\nb, c; d\\e\nf');
});

test('all-day, floating and UTC events', () => {
  const { events, simplified } = parseIcs(cal(
    vevent('UID:a', 'SUMMARY:Holiday', 'DTSTART;VALUE=DATE:20261225', 'DTEND;VALUE=DATE:20261226'),
    vevent('UID:b', 'SUMMARY:Floating', 'DTSTART:20261110T090000', 'DTEND:20261110T093000'),
    vevent('UID:c', 'SUMMARY:Call', 'DTSTART:20260105T143000Z', 'DTEND:20260105T153000Z'),
    vevent('UID:d', 'SUMMARY:Late call', 'DTSTART:20260105T153000Z'),
  ), { zone: 'Asia/Tokyo' });
  assert.strictEqual(simplified, 0);
  const byUid = Object.fromEntries(events.map(e => [e.uid, e]));
  assert.deepStrictEqual(byUid.a, { uid: 'a', title: 'Holiday', date: '2026-12-25', start: null, end: null });
  assert.deepStrictEqual(byUid.b, { uid: 'b', title: 'Floating', date: '2026-11-10', start: '09:00', end: '09:30' });
  assert.deepStrictEqual(byUid.c, { uid: 'c', title: 'Call', date: '2026-01-05', start: '23:30', end: null }, 'end on the next day is dropped');
  assert.strictEqual(byUid.d.date, '2026-01-06', 'UTC crosses midnight into Tokyo');
  assert.strictEqual(byUid.d.start, '00:30');
});

test('TZID times convert to the target zone, including DST', () => {
  const { events } = parseIcs(cal(
    vevent('UID:s', 'SUMMARY:Summer', 'DTSTART;TZID=America/New_York:20260701T090000', 'DTEND;TZID="America/New_York":20260701T100000'),
    vevent('UID:w', 'SUMMARY:Winter', 'DTSTART;TZID=America/New_York:20260115T090000'),
    vevent('UID:x', 'SUMMARY:Unknown zone', 'DTSTART;TZID=Pacific Standard Time:20260115T090000'),
  ), { zone: 'Europe/Lisbon' });
  const byUid = Object.fromEntries(events.map(e => [e.uid, e]));
  assert.strictEqual(byUid.s.start, '14:00', 'EDT -4 -> WEST +1');
  assert.strictEqual(byUid.s.end, '15:00');
  assert.strictEqual(byUid.w.start, '14:00', 'EST -5 -> WET 0');
  assert.strictEqual(byUid.x.start, '09:00', 'an unknown TZID is taken as local time');
});

test('description, escaped summary, folded lines and quoted parameters', () => {
  const { events } = parseIcs(cal(vevent(
    'UID:n',
    'SUMMARY;LANGUAGE=en:Lunch\\, then a walk',
    'DESCRIPTION:Line one\\nLine two that is long and',
    '  folded',
    'ORGANIZER;CN="Doe: Jane":mailto:jane@example.com',
    'DTSTART:20261110T120000',
  )), { zone: 'UTC' });
  assert.strictEqual(events[0].title, 'Lunch, then a walk');
  assert.strictEqual(events[0].notes, 'Line one\nLine two that is long and folded');
});

test('recurring rules are kept, with EXDATE in the target zone', () => {
  const { events, simplified } = parseIcs(cal(vevent(
    'UID:r',
    'SUMMARY:Standup',
    'DTSTART;TZID=Europe/Berlin:20261102T100000',
    'RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE,FR;UNTIL=20261231T225959Z',
    'EXDATE;TZID=Europe/Berlin:20261104T100000,20261106T100000',
    'EXDATE;TZID=Europe/Berlin:20261109T100000',
  )), { zone: 'Europe/Berlin' });
  assert.strictEqual(simplified, 0);
  assert.deepStrictEqual(events[0].rrule, { freq: 'WEEKLY', interval: 1, byday: [1, 3, 5], until: '2026-12-31' });
  assert.deepStrictEqual(events[0].exdates, ['2026-11-04', '2026-11-06', '2026-11-09']);
});

test('UNTIL earlier in the day than the start time ends the day before', () => {
  const { events } = parseIcs(cal(vevent('UID:u', 'SUMMARY:x', 'DTSTART:20261102T100000Z', 'RRULE:FREQ=DAILY;UNTIL=20261110T090000Z')), { zone: 'UTC' });
  assert.strictEqual(events[0].rrule.until, '2026-11-09');
});

test('COUNT, INTERVAL, DAILY+BYDAY weekdays and redundant BYMONTHDAY are supported', () => {
  const { events, simplified } = parseIcs(cal(
    vevent('UID:1', 'SUMMARY:a', 'DTSTART;VALUE=DATE:20261101', 'RRULE:FREQ=MONTHLY;INTERVAL=2;COUNT=4;BYMONTHDAY=1'),
    vevent('UID:2', 'SUMMARY:b', 'DTSTART:20261102T080000', 'RRULE:FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR'),
    vevent('UID:3', 'SUMMARY:c', 'DTSTART;VALUE=DATE:19900315', 'RRULE:FREQ=YEARLY;BYMONTH=3'),
  ), { zone: 'UTC' });
  assert.strictEqual(simplified, 0);
  const byUid = Object.fromEntries(events.map(e => [e.uid, e]));
  assert.deepStrictEqual(byUid['1'].rrule, { freq: 'MONTHLY', interval: 2, count: 4 });
  assert.deepStrictEqual(byUid['2'].rrule, { freq: 'WEEKLY', interval: 1, byday: [1, 2, 3, 4, 5] });
  assert.deepStrictEqual(byUid['3'].rrule, { freq: 'YEARLY', interval: 1 });
});

test('unsupported rules import the first occurrence only and are counted', () => {
  const { events, simplified } = parseIcs(cal(
    vevent('UID:1', 'SUMMARY:2nd Tuesday', 'DTSTART:20261110T180000', 'RRULE:FREQ=MONTHLY;BYDAY=2TU'),
    vevent('UID:2', 'SUMMARY:Hourly', 'DTSTART:20261110T180000', 'RRULE:FREQ=HOURLY'),
    vevent('UID:3', 'SUMMARY:Last day', 'DTSTART:20261130T180000', 'RRULE:FREQ=MONTHLY;BYMONTHDAY=-1'),
  ), { zone: 'UTC' });
  assert.strictEqual(simplified, 3);
  assert.strictEqual(events.length, 3);
  assert.ok(events.every(e => !e.rrule));
});

test('multi-day all-day events repeat daily over their span; DURATION sets the end', () => {
  const { events } = parseIcs(cal(
    vevent('UID:t', 'SUMMARY:Trip', 'DTSTART;VALUE=DATE:20261120', 'DTEND;VALUE=DATE:20261123'),
    vevent('UID:d', 'SUMMARY:Talk', 'DTSTART:20261110T090000', 'DURATION:PT1H30M'),
  ), { zone: 'UTC' });
  const byUid = Object.fromEntries(events.map(e => [e.uid, e]));
  assert.deepStrictEqual(byUid.t.rrule, { freq: 'DAILY', interval: 1, count: 3 });
  assert.strictEqual(byUid.d.end, '10:30');
});

test('a moved occurrence (RECURRENCE-ID) excludes the date from the series; cancelled ones vanish', () => {
  const { events } = parseIcs(cal(
    vevent('UID:s', 'SUMMARY:Weekly', 'DTSTART:20261102T100000', 'RRULE:FREQ=WEEKLY'),
    vevent('UID:s', 'RECURRENCE-ID:20261109T100000', 'SUMMARY:Weekly (moved)', 'DTSTART:20261110T110000'),
    vevent('UID:s', 'RECURRENCE-ID:20261116T100000', 'STATUS:CANCELLED', 'DTSTART:20261116T100000'),
    vevent('UID:gone', 'SUMMARY:Cancelled', 'STATUS:CANCELLED', 'DTSTART:20261116T100000'),
  ), { zone: 'UTC' });
  assert.strictEqual(events.length, 2);
  const master = events.find(e => e.uid === 's');
  assert.deepStrictEqual(master.exdates, ['2026-11-09', '2026-11-16']);
  const moved = events.find(e => e.uid !== 's');
  assert.strictEqual(moved.uid, 's#2026-11-09');
  assert.strictEqual(moved.date, '2026-11-10');
});

test('alarms inside an event are ignored; missing UID and title get stable fallbacks', () => {
  const text = cal(vevent('DTSTART:20261110T090000', 'BEGIN:VALARM', 'SUMMARY:Alarm text', 'TRIGGER:-PT15M', 'END:VALARM'));
  const a = parseIcs(text, { zone: 'UTC' }).events[0];
  const b = parseIcs(text, { zone: 'UTC' }).events[0];
  assert.strictEqual(a.title, '(No title)');
  assert.ok(a.uid && a.uid === b.uid, 'same file, same uid');
});

test('files without events, or not calendars at all, give no events', () => {
  assert.deepStrictEqual(parseIcs(cal(), { zone: 'UTC' }).events, []);
  assert.deepStrictEqual(parseIcs('<html>not a calendar</html>', { zone: 'UTC' }).events, []);
  assert.deepStrictEqual(parseIcs(cal(vevent('SUMMARY:No start')), { zone: 'UTC' }).events, [], 'an event without DTSTART is skipped');
});
