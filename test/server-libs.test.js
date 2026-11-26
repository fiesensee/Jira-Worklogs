import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readTimesheet } from '../lib/timesheet.js';
import { formatStarted, createJira } from '../lib/jira.js';

test('reads a real JaTT export (duration falls back to arrival/departure minus break)', () => {
  const [sheet] = readTimesheet(readFileSync(new URL('./fixtures/jatt-export.xlsx', import.meta.url)));
  assert.equal(sheet.name, 'Customer Shop Dev');
  assert.equal(sheet.month, '2026-11');
  assert.deepEqual(sheet.days, [
    { day: 2, minutes: 480, description: 'Daily, payment migration' },
    { day: 3, minutes: 480, description: 'Sprint planning, review order history' },
    { day: 4, minutes: 240, description: 'bugfixing' }
  ]);
});

test('formatStarted produces the Jira timestamp format with a local offset', () => {
  assert.match(formatStarted('2026-11-14'), /^2026-11-14T09:00:00\.000[+-]\d{4}$/);
});

test('mock Jira finds issues and records worklogs', async () => {
  const jira = createJira({ mock: true });
  assert.equal((await jira.find('demo-101'))[0].key, 'DEMO-101');
  assert.ok((await jira.find('pipeline')).some(i => i.key === 'OPS-7'));
  await jira.addWorklog('DEMO-110', { started: 'x', minutes: 30, comment: 'Daily' });
  assert.equal(jira.posted.length, 1);
  await assert.rejects(jira.addWorklog('NOPE-1', { minutes: 1 }), /404/);
});

test('real Jira client sends Bearer auth and maps worklog payloads', async () => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ id: '77' }), { status: 201 });
  };
  try {
    const jira = createJira({ url: 'https://jira.example.com/', pat: 'secret' });
    assert.deepEqual(await jira.addWorklog('ABC-1', { started: 's', minutes: 90, comment: 'c' }), { id: '77' });
    assert.equal(calls[0].url, 'https://jira.example.com/rest/api/2/issue/ABC-1/worklog');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer secret');
    assert.deepEqual(JSON.parse(calls[0].init.body), { started: 's', timeSpentSeconds: 5400, comment: 'c' });
  } finally {
    globalThis.fetch = original;
  }
});
