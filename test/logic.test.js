import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseHours, formatHours, splitEvenly, matchRules, applyRules, setCell, fillRest, copyPrevious,
  splitDay, summarize, rowTotal, cellKey
} from '../public/logic.js';

const draft = () => ({
  id: 't', month: '2026-11', sheet: 'S', issues: [],
  days: [
    { day: 2, minutes: 480, description: 'Daily, payment migration' },
    { day: 3, minutes: 450, description: 'Sprint planning, review order history' },
    { day: 4, minutes: 240, description: 'bugfixing' }
  ],
  cells: {}
});
const issues = [{ key: 'A-1', summary: 'Meetings' }, { key: 'A-2', summary: 'Dev' }];

test('parseHours accepts decimal, colon and h/m notation', () => {
  assert.equal(parseHours('1.5'), 90);
  assert.equal(parseHours('1,25'), 75);
  assert.equal(parseHours('1:30'), 90);
  assert.equal(parseHours('1h 30m'), 90);
  assert.equal(parseHours('45m'), 45);
  assert.equal(parseHours(''), 0);
  assert.equal(parseHours('abc'), null);
  assert.equal(formatHours(90), '1.5');
  assert.equal(formatHours(0), '');
});

test('splitEvenly rounds to 5 minutes and gives the remainder to the last part', () => {
  assert.deepEqual(splitEvenly(480, 3), [160, 160, 160]);
  assert.deepEqual(splitEvenly(100, 3), [30, 30, 40]);
});

test('rules group description parts by issue and fill only empty days', () => {
  const rules = [{ pattern: 'daily|planning', issue: 'A-1', summary: 'Meetings' }, { pattern: 'migration', issue: 'A-2' }];
  const { groups, unmatched } = matchRules('Daily, payment migration, coffee', rules);
  assert.deepEqual(groups.map(g => [g.issue, g.parts]), [['A-1', ['Daily']], ['A-2', ['payment migration']]]);
  assert.deepEqual(unmatched, ['coffee']);

  const d = draft();
  assert.equal(applyRules(d, rules), 2);
  assert.deepEqual(d.cells[cellKey(2, 'A-1')], { minutes: 240, comment: 'Daily' });
  assert.equal(d.cells[cellKey(3, 'A-1')].minutes, 450);
  assert.deepEqual(d.issues.map(i => i.key), ['A-1', 'A-2']);
  assert.equal(applyRules(d, rules), 0, 'days with hours are not touched again');
});

test('setCell defaults the text to the JaTT description and never changes posted cells', () => {
  const d = { ...draft(), issues };
  setCell(d, 2, 'A-1', 60);
  assert.deepEqual(d.cells['2|A-1'], { minutes: 60, comment: 'Daily, payment migration' });
  d.cells['2|A-1'].worklogId = '9';
  setCell(d, 2, 'A-1', 120);
  assert.equal(d.cells['2|A-1'].minutes, 60);
});

test('fillRest, splitDay and copyPrevious keep rows matching the JaTT total', () => {
  const d = { ...draft(), issues };
  setCell(d, 2, 'A-1', 30);
  fillRest(d, 2, 'A-2');
  assert.equal(d.cells['2|A-2'].minutes, 450);
  assert.equal(rowTotal(d, 2), 480);

  assert.ok(copyPrevious(d, 3));
  assert.equal(rowTotal(d, 3), 450);
  assert.equal(d.cells['3|A-1'].minutes, 30);

  splitDay(d, 4, ['A-1', 'A-2']);
  assert.equal(d.cells['4|A-1'].minutes, 120);
  assert.equal(copyPrevious({ ...draft(), issues }, 2), false);
});

test('summarize lists unposted worklogs and days that do not match JaTT', () => {
  const d = { ...draft(), issues };
  setCell(d, 2, 'A-1', 480);
  setCell(d, 3, 'A-2', 400);
  d.cells['2|A-1'].worklogId = '1';
  const s = summarize(d);
  assert.deepEqual(s.toPost, [{ day: 3, key: 'A-2', date: '2026-11-03', minutes: 400, comment: 'Sprint planning, review order history' }]);
  assert.deepEqual(s.mismatches.map(m => m.day), [3, 4]);
  assert.equal(s.bookedTotal, 880);
  assert.equal(s.jattTotal, 1170);
});

test('resetDraft starts over but keeps posted worklogs and their issues', async () => {
  const { resetDraft } = await import('../public/logic.js');
  const d = { ...draft(), issues: [...issues, { key: 'A-3', summary: 'Other' }] };
  setCell(d, 2, 'A-1', 480);
  setCell(d, 3, 'A-3', 450);
  d.cells['2|A-1'].worklogId = '5';
  const rules = [{ pattern: 'bugfix', issue: 'A-9', summary: 'Bugs' }];
  const { draft: fresh, kept, filled } = resetDraft(d, { pinned: [{ key: 'A-2', summary: 'Dev' }], rules });
  assert.equal(kept, 1);
  assert.equal(filled, 1, 'only day 4 (bugfixing) matches a rule');
  assert.deepEqual(fresh.issues.map(i => i.key), ['A-1', 'A-2', 'A-9'], 'posted issue, pinned issue, rule issue');
  assert.deepEqual(Object.keys(fresh.cells).sort(), ['2|A-1', '4|A-9']);
  assert.equal(fresh.cells['2|A-1'].worklogId, '5');
  assert.equal(d.cells['3|A-3'].minutes, 450, 'the original draft is not modified');
});

test('recurring bookings land on matching weekdays with JaTT hours and never overbook', async () => {
  const { applyRecurring, weekdayOf } = await import('../public/logic.js');
  assert.equal(weekdayOf('2026-11', 2), 1, '2 Nov 2026 is a Monday');
  const d = { ...draft(), issues };
  d.days.push({ day: 5, minutes: 10, description: 'short day' });
  setCell(d, 3, 'A-1', 30); // other hours on the day don't block the booking
  d.cells['5|M-1'] = { minutes: 0, comment: '', worklogId: '1' }; // posted cells are never touched
  const daily = { issue: 'M-1', summary: 'Meetings', minutes: 15, comment: 'Daily standup', weekdays: [1, 2, 4] };
  assert.equal(applyRecurring(d, [daily]), 2);
  assert.deepEqual(d.cells['2|M-1'], { minutes: 15, comment: 'Daily standup', recurring: true });
  assert.equal(d.cells['3|M-1'].minutes, 15);
  assert.equal(d.cells['4|M-1'], undefined, 'Wednesday is not a selected weekday');
  assert.equal(d.cells['5|M-1'].worklogId, '1');
  const tiny = { ...draft(), issues, days: [{ day: 2, minutes: 10, description: '' }] };
  applyRecurring(tiny, [daily]);
  assert.equal(tiny.cells['2|M-1'].minutes, 10, 'capped to the free time of the day');
  assert.equal(applyRecurring(d, [daily]), 0, 'applying twice books nothing new');
  assert.equal(applyRecurring(d, [{ ...daily, minutes: 0 }, { ...daily, issue: '' }]), 0);
});

test('prefill books recurring first and lets rules split only the remaining time', async () => {
  const { prefill } = await import('../public/logic.js');
  const d = draft();
  const result = prefill(d, {
    pinned: [{ key: 'P-1', summary: 'Pinned' }],
    recurring: [{ issue: 'M-1', summary: 'Meetings', minutes: 15, comment: 'Daily standup', weekdays: [1, 2, 3, 4, 5] }],
    rules: [{ pattern: 'daily|planning', issue: 'M-1' }, { pattern: 'migration|review', issue: 'D-1' }, { pattern: 'bugfix', issue: 'B-1' }]
  });
  assert.deepEqual(result, { recurringCells: 3, filled: 3 });
  assert.deepEqual(d.issues.map(i => i.key), ['P-1', 'M-1', 'D-1', 'B-1']);
  // Mon: "Daily" is covered by the recurring booking, so the migration issue gets the remaining 465 minutes.
  assert.equal(d.cells['2|M-1'].minutes, 15);
  assert.deepEqual(d.cells['2|D-1'], { minutes: 465, comment: 'payment migration' });
  assert.equal(rowTotal(d, 2), 480);
  assert.equal(rowTotal(d, 3), 450);
  assert.equal(d.cells['4|B-1'].minutes, 225);
});

test('defaultComment gives a cell the description parts that belong to its issue', async () => {
  const { defaultComment } = await import('../public/logic.js');
  const d = { ...draft(), days: [{ day: 2, minutes: 480, description: 'Format anpassungen, Betrieb, Vault Migration' }] };
  const rules = [{ pattern: 'betrieb', issue: 'OPS-1' }, { pattern: 'vault', issue: 'SEC-2' }];
  assert.equal(defaultComment(d, 2, 'OPS-1', rules), 'Betrieb');
  assert.equal(defaultComment(d, 2, 'NEW-9', rules), 'Format anpassungen', 'unmapped parts go to an unmapped issue');
  assert.equal(defaultComment(d, 2, 'NEW-9', []), 'Format anpassungen, Betrieb, Vault Migration');
  setCell(d, 2, 'SEC-2', 60, rules);
  assert.equal(d.cells['2|SEC-2'].comment, 'Vault Migration');
});

test('dayRows offers one row per description part, pre-mapped by rules and pre-split', async () => {
  const { dayRows } = await import('../public/logic.js');
  const d = { ...draft(), days: [{ day: 2, minutes: 480, description: 'Format anpassungen, Betrieb, Vault Migration, Betriebsmeeting' }] };
  const rules = [{ pattern: 'betrieb', issue: 'OPS-1', summary: 'Ops' }];
  const rows = dayRows(d, 2, rules);
  assert.deepEqual(rows.map(r => [r.issue, r.comment, r.minutes, r.matched]), [
    ['', 'Format anpassungen', 160, false],
    ['OPS-1', 'Betrieb, Betriebsmeeting', 160, true],
    ['', 'Vault Migration', 160, false]
  ]);
});

test('dayRows keeps existing cells and only adds parts their texts do not cover', async () => {
  const { dayRows } = await import('../public/logic.js');
  const d = { ...draft(), issues: [{ key: 'M-1', summary: '' }, { key: 'OPS-1', summary: '' }],
    days: [{ day: 2, minutes: 480, description: 'Daily, Betrieb, Vault Migration' }] };
  d.cells['2|M-1'] = { minutes: 15, comment: 'Daily standup', recurring: true };
  d.cells['2|OPS-1'] = { minutes: 200, comment: 'Betrieb', worklogId: '3' };
  const rows = dayRows(d, 2, []);
  assert.deepEqual(rows.map(r => [r.issue, r.comment, r.minutes, r.posted]), [
    ['M-1', 'Daily standup', 15, false],
    ['OPS-1', 'Betrieb', 200, true],
    ['', 'Vault Migration', 265, false]
  ]);
  d.reviewed = { 2: true };
  assert.equal(dayRows(d, 2, []).length, 2, 'reviewed days show only what was saved');
});

test('saveDayRows merges rows per issue, drops removed issues and marks the day reviewed', async () => {
  const { saveDayRows } = await import('../public/logic.js');
  const d = { ...draft(), issues: [{ key: 'A-1', summary: '' }, { key: 'A-2', summary: '' }, { key: 'P-1', summary: '' }] };
  d.cells['2|A-2'] = { minutes: 480, comment: 'old' };
  d.cells['2|P-1'] = { minutes: 30, comment: 'posted', worklogId: '8' };
  assert.match(saveDayRows(d, 2, [{ issue: '', minutes: 60, comment: 'x' }]), /Pick an issue/);
  assert.match(saveDayRows(d, 2, [{ issue: 'P-1', minutes: 60, comment: 'x' }]), /already posted/);
  assert.equal(d.cells['2|A-2'].minutes, 480, 'a refused save changes nothing');
  assert.equal(saveDayRows(d, 2, [
    { issue: 'P-1', minutes: 30, comment: 'posted', posted: true },
    { issue: 'A-1', minutes: 200, comment: 'Format anpassungen' },
    { issue: 'A-1', minutes: 250, comment: 'Review ' },
    { issue: '', minutes: 0, comment: 'ignored' }
  ]), null);
  assert.deepEqual(d.cells['2|A-1'], { minutes: 450, comment: 'Format anpassungen\nReview' });
  assert.equal(d.cells['2|A-2'], undefined);
  assert.equal(d.cells['2|P-1'].worklogId, '8');
  assert.deepEqual(d.reviewed, { 2: true });
});
