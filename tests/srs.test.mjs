import assert from 'node:assert/strict';
import test from 'node:test';

const stored = new Map();
globalThis.localStorage = {
  getItem(key) { return stored.get(key) ?? null; },
  setItem(key, value) { stored.set(key, value); },
  removeItem(key) { stored.delete(key); },
};
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { platform: 'test' },
});

const { nextReview, cardStatus, normalizeGrade, getDueCards } = await import('../src/srs.js');

const DAY_MS = 86400000;

test('again resets reps and always schedules for tomorrow', () => {
  const r = nextReview('again', { interval: 10, easeFactor: 2.8, reps: 5 });
  assert.equal(r.reps, 0);
  assert.equal(r.interval, 1);
  assert.equal(r.nextReviewAt - r.reviewedAt, DAY_MS);
});

test('first review of hard/good/easy all land on 1 day (rounding collapses the multiplier)', () => {
  for (const g of ['hard', 'good', 'easy']) {
    const r = nextReview(g, {});
    assert.equal(r.interval, 1, `${g} first interval`);
    assert.equal(r.reps, 1, `${g} first reps`);
  }
});

test('second review: hard discounts, good stays base, easy boosts the same base interval', () => {
  const prev = nextReview('good', {}); // interval 1, easeFactor 2.5, reps 1
  assert.equal(nextReview('hard', prev).interval, 2);
  assert.equal(nextReview('good', prev).interval, 3);
  assert.equal(nextReview('easy', prev).interval, 4);
});

test('easeFactor moves down on hard, flat on good, up on easy, floored at 1.3', () => {
  const prev = { interval: 5, easeFactor: 1.35, reps: 3 };
  assert.equal(nextReview('hard', prev).easeFactor, 1.3); // 1.35-0.14 would be 1.21, clamped
  assert.equal(nextReview('good', prev).easeFactor, 1.35);
  assert.ok(Math.abs(nextReview('easy', prev).easeFactor - 1.45) < 1e-9);
});

test('cardStatus derives new/learning/review/mature from reps+interval, no extra field', () => {
  assert.equal(cardStatus(undefined), 'new');
  assert.equal(cardStatus({ reps: 0, interval: 1 }), 'learning'); // just came back from "again"
  assert.equal(cardStatus({ reps: 1, interval: 1 }), 'review');
  assert.equal(cardStatus({ reps: 3, interval: 20 }), 'review');
  assert.equal(cardStatus({ reps: 3, interval: 21 }), 'mature');
  assert.equal(cardStatus({ reps: 5, interval: 60 }), 'mature');
});

test('getDueCards sorts by relative overdueness, not absolute nextReviewAt', () => {
  const now = Date.now();
  const cards = [
    { thai: 'long-interval', _lessonId: 'L' },   // interval 400d, 30d overdue → ratio 0.075
    { thai: 'short-interval', _lessonId: 'L' },  // interval 3d, 30d overdue → ratio 10
    { thai: 'not-due', _lessonId: 'L' },         // nextReviewAt in the future
  ];
  const progress = {
    'L:long-interval': { nextReviewAt: now - 30 * DAY_MS, interval: 400 },
    'L:short-interval': { nextReviewAt: now - 30 * DAY_MS, interval: 3 },
    'L:not-due': { nextReviewAt: now + DAY_MS, interval: 5 },
  };
  const due = getDueCards(cards, progress);
  assert.deepEqual(due.map(c => c.thai), ['short-interval', 'long-interval']);
});

test('getDueCards treats a never-scheduled interval as 1 day to avoid divide-by-zero', () => {
  const now = Date.now();
  const cards = [{ thai: 'migrated', _lessonId: 'L' }];
  const progress = { 'L:migrated': { nextReviewAt: 0, interval: 0 } };
  assert.doesNotThrow(() => getDueCards(cards, progress));
  assert.equal(getDueCards(cards, progress).length, 1);
});

test('normalizeGrade maps legacy 3-grade values onto the new 4-grade scheme', () => {
  assert.equal(normalizeGrade('bad'), 'again');
  assert.equal(normalizeGrade('ok'), 'hard');
  assert.equal(normalizeGrade('good'), 'good');
  assert.equal(normalizeGrade('again'), 'again');
  assert.equal(normalizeGrade('easy'), 'easy');
  assert.equal(normalizeGrade(undefined), undefined);
});
