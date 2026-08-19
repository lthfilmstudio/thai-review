import assert from 'node:assert/strict';
import test from 'node:test';

const stored = new Map();
globalThis.localStorage = {
  getItem(key) { return stored.get(key) ?? null; },
  setItem(key, value) { stored.set(key, value); },
  removeItem(key) { stored.delete(key); },
};

const { DAILY_KEY, initDailyLog, loadDailyLog, logReview } = await import('../src/today.js');
const { localDateKey } = await import('../src/state.js');

test('localDateKey always uses Taipei date', () => {
  // 2026-08-18 23:30 UTC is 2026-08-19 07:30 in Taipei.
  assert.equal(localDateKey(Date.UTC(2026, 7, 18, 23, 30)), '2026-08-19');
});

test('new reviews extend a legacy-shaped day without dropping counters', () => {
  stored.clear();
  const key = '2026-08-19';
  stored.set(DAILY_KEY, JSON.stringify({
    v: 1,
    backfilled: true,
    days: { [key]: { reviewed: 2, bad: 1, ok: 1, good: 0 } },
  }));

  logReview('again', Date.UTC(2026, 7, 18, 23, 30));
  const day = loadDailyLog().days[key];
  assert.deepEqual(day, {
    reviewed: 3, bad: 1, ok: 1, good: 0, again: 1, hard: 0, easy: 0,
  });
});

test('daily backfill normalizes legacy grades', () => {
  stored.clear();
  initDailyLog({
    'L:bad': { grade: 'bad', reviewedAt: Date.UTC(2026, 7, 18, 23, 30) },
    'L:ok': { grade: 'ok', reviewedAt: Date.UTC(2026, 7, 18, 23, 35) },
  });
  const day = loadDailyLog().days['2026-08-19'];
  assert.equal(day.reviewed, 2);
  assert.equal(day.again, 1);
  assert.equal(day.hard, 1);
});
