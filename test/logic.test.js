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
