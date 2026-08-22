import assert from 'node:assert/strict';
import test from 'node:test';

const { accuracyTrend, averageAccuracy, weakLessons, weakestCards, lessonMasteryStatus } = await import('../src/stats.js');
const { localDateKey } = await import('../src/state.js');

const DAY_MS = 86400000;
const NOW = new Date(2026, 7, 17, 10, 0, 0).getTime(); // 2026-08-17 10:00 local

function keyFor(daysAgo) {
  return localDateKey(NOW - daysAgo * DAY_MS);
}

test('accuracyTrend: new-shape day computes pct from again, no-data day is null', () => {
  const logDays = {
    [keyFor(0)]: { reviewed: 4, again: 1, hard: 1, good: 2, easy: 0 },
  };
  const trend = accuracyTrend(logDays, 7, NOW);
  assert.equal(trend.length, 7);
  const today = trend.at(-1);
  assert.equal(today.key, keyFor(0));
  assert.equal(today.reviewed, 4);
  assert.equal(today.pct, 75); // (4-1)/4
  const yesterday = trend.at(-2);
  assert.equal(yesterday.reviewed, 0);
  assert.equal(yesterday.pct, null);
});

test('accuracyTrend: legacy bad-shape day is read as a failure too', () => {
  const logDays = {
    [keyFor(1)]: { reviewed: 5, bad: 2, ok: 1, good: 2 }, // pre-migration shape, no "again" key
  };
  const trend = accuracyTrend(logDays, 7, NOW);
  const day = trend.find(d => d.key === keyFor(1));
  assert.equal(day.pct, 60); // (5-2)/5
});

test('averageAccuracy ignores no-data days', () => {
  const trend = [
    { key: 'a', reviewed: 0, pct: null },
    { key: 'b', reviewed: 5, pct: 80 },
    { key: 'c', reviewed: 5, pct: 60 },
  ];
  assert.equal(averageAccuracy(trend), 70);
  assert.equal(averageAccuracy([{ key: 'x', reviewed: 0, pct: null }]), null);
});

function lesson(id, cards) {
  return { id, title: id, cards };
}

test('weakLessons filters by minSamples and sorts by bad rate, excludes lessons with no weak cards', () => {
  const cardA = { thai: 'a', zh: 'A' };
  const cardB = { thai: 'b', zh: 'B' };
  const cardC = { thai: 'c', zh: 'C' };
  const cardD = { thai: 'd', zh: 'D' };
  const lessons = [
    lesson('L1', [cardA, cardB, cardC, cardD]), // 2/4 weak = 50%
    lesson('L2', [cardA, cardB]),               // graded=1, below minSamples(2)... adjust below
    lesson('L3', [cardA, cardB, cardC]),        // all good, 0 weak -> excluded
  ];
  const progress = {
    'L1:a': { grade: 'again' },
    'L1:b': { grade: 'hard' },
    'L1:c': { grade: 'good' },
    'L1:d': { grade: 'good' },
    'L2:a': { grade: 'again' },
    'L3:a': { grade: 'good' },
    'L3:b': { grade: 'easy' },
  };
  const rows = weakLessons(progress, lessons, 2);
  assert.deepEqual(rows.map(r => r.lessonId), ['L1']);
  assert.equal(rows[0].graded, 4);
  assert.equal(rows[0].weak, 2);
  assert.ok(Math.abs(rows[0].badRate - 0.5) < 1e-9);
});

test('weakestCards ranks again before hard, then lower easeFactor first, respects limit', () => {
  const cards = [
    { thai: 'a', zh: 'A' },
    { thai: 'b', zh: 'B' },
    { thai: 'c', zh: 'C' },
    { thai: 'd', zh: 'D' },
  ];
  const lessons = [lesson('L1', cards)];
  const progress = {
    'L1:a': { grade: 'hard', easeFactor: 1.6 },
    'L1:b': { grade: 'again', easeFactor: 2.5 },
    'L1:c': { grade: 'hard', easeFactor: 1.3 },
    'L1:d': { grade: 'good', easeFactor: 2.5 }, // not weak, excluded
  };
  const rows = weakestCards(progress, lessons, 20);
  assert.deepEqual(rows.map(r => r.thai), ['b', 'c', 'a']);
  const limited = weakestCards(progress, lessons, 1);
  assert.equal(limited.length, 1);
  assert.equal(limited[0].thai, 'b');
});

test('lessonMasteryStatus buckets each lesson into new / due / progress / mastered', () => {
  const cardA = { thai: 'a', zh: 'A' };
  const cardB = { thai: 'b', zh: 'B' };
  const lessons = [
    lesson('NEW', [cardA, cardB]),
    lesson('DUE', [cardA, cardB]),
    lesson('PROGRESS', [cardA, cardB]),
    lesson('MASTERED', [cardA, cardB]),
  ];
  const future = NOW + 30 * DAY_MS;
  const past = NOW - DAY_MS;
  const progress = {
    // NEW: 完全沒評過分
    // DUE: 一張到期、一張還沒（有到期就整堂算 due，不管另一張多熟）
    'DUE:a': { grade: 'good', reps: 3, interval: 30, nextReviewAt: future },
    'DUE:b': { grade: 'good', reps: 1, interval: 1, nextReviewAt: past },
    // PROGRESS: 都評過分、都沒到期，但沒有全部 mature
    'PROGRESS:a': { grade: 'good', reps: 3, interval: 30, nextReviewAt: future },
    'PROGRESS:b': { grade: 'good', reps: 1, interval: 3, nextReviewAt: future },
    // MASTERED: 都沒到期，全部 interval>=21
    'MASTERED:a': { grade: 'good', reps: 3, interval: 30, nextReviewAt: future },
    'MASTERED:b': { grade: 'easy', reps: 4, interval: 40, nextReviewAt: future },
  };
  const rows = lessonMasteryStatus(progress, lessons, NOW);
  const byId = Object.fromEntries(rows.map(r => [r.lessonId, r]));
  assert.equal(byId.NEW.status, 'new');
  assert.equal(byId.DUE.status, 'due');
  assert.equal(byId.PROGRESS.status, 'progress');
  assert.equal(byId.MASTERED.status, 'mastered');
  assert.equal(byId.MASTERED.total, 2);
  assert.equal(byId.MASTERED.mature, 2);
});
