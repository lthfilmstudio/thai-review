import assert from 'node:assert/strict';
import test from 'node:test';

const stored = new Map();
globalThis.localStorage = {
  getItem(key) { return stored.get(key) ?? null; },
  setItem(key, value) { stored.set(key, value); },
  removeItem(key) { stored.delete(key); },
};

const { buildComboReview } = await import('../src/game-combo.js');

function card(lessonId, thai, zh, extra = {}) {
  return { _lessonId: lessonId, thai, zh, karaoke: `${thai}-k`, ...extra };
}

test('due cards are prioritized over weak/unseen cards', () => {
  const now = Date.now();
  const allCards = [
    card('newest', 'due1', 'zh-due1'),
    card('newest', 'weak1', 'zh-weak1'),
    card('newest', 'new1', 'zh-new1'),
  ];
  const progress = {
    'newest:due1': { nextReviewAt: now - 1000, grade: 'good' },
    'newest:weak1': { nextReviewAt: now + 999999, grade: 'again', easeFactor: 1.5 },
    // new1 has no progress entry at all
  };
  const q = buildComboReview(allCards, progress, 'newest', { count: 1 });
  assert.equal(q.length, 1);
  assert.equal(q[0].card.thai, 'due1');
});

test('newest lesson is weighted first within the same category (due)', () => {
  const now = Date.now();
  const allCards = [
    card('old', 'oldDue', 'zh-oldDue'),
    card('newest', 'newestDue', 'zh-newestDue'),
  ];
  const progress = {
    'old:oldDue': { nextReviewAt: now - 5000 },
    'newest:newestDue': { nextReviewAt: now - 1000 }, // less overdue, but newest lesson
  };
  const q = buildComboReview(allCards, progress, 'newest', { count: 2 });
  assert.equal(q[0].card.thai, 'newestDue'); // newest lesson wins despite being less overdue
  assert.equal(q[1].card.thai, 'oldDue');
});

test('falls back to weak cards when due pool is smaller than count', () => {
  const now = Date.now();
  const allCards = [
    card('L', 'due1', 'zh-due1'),
    card('L', 'weak1', 'zh-weak1'),
    card('L', 'weak2', 'zh-weak2'),
  ];
  const progress = {
    'L:due1': { nextReviewAt: now - 1000 },
    'L:weak1': { grade: 'again', nextReviewAt: now + 999999, easeFactor: 1.3 },
    'L:weak2': { grade: 'hard', nextReviewAt: now + 999999, easeFactor: 2.0 },
  };
  const q = buildComboReview(allCards, progress, 'L', { count: 3 });
  const thais = q.map(x => x.card.thai);
  assert.deepEqual(thais.sort(), ['due1', 'weak1', 'weak2']);
});

test('weak cards rank again before hard, lower easeFactor first within same grade', () => {
  const now = Date.now();
  const allCards = [
    card('L', 'a', 'zh-a'),
    card('L', 'b', 'zh-b'),
    card('L', 'c', 'zh-c'),
  ];
  const progress = {
    'L:a': { grade: 'hard', nextReviewAt: now + 999999, easeFactor: 2.0 },
    'L:b': { grade: 'again', nextReviewAt: now + 999999, easeFactor: 1.3 },
    'L:c': { grade: 'again', nextReviewAt: now + 999999, easeFactor: 1.8 },
  };
  const q = buildComboReview(allCards, progress, 'L', { count: 3 });
  assert.deepEqual(q.map(x => x.card.thai), ['b', 'c', 'a']);
});

test('falls back to newest-lesson unseen cards only when due+weak cannot fill count', () => {
  const allCards = [
    card('newest', 'unseen1', 'zh-u1'),
    card('newest', 'unseen2', 'zh-u2'),
    card('other', 'unseen3', 'zh-u3'), // not newest lesson, must not be picked as fallback
  ];
  const q = buildComboReview(allCards, {}, 'newest', { count: 2 });
  assert.equal(q.length, 2);
  for (const item of q) assert.equal(item.card._lessonId, 'newest');
});

test('cross-lesson coverage: older lessons contribute due cards when newest lesson has none', () => {
  const now = Date.now();
  const allCards = [
    card('newest', 'freshCard', 'zh-fresh'), // no progress, not due
    card('old1', 'due1', 'zh-old1'),
    card('old2', 'due2', 'zh-old2'),
  ];
  const progress = {
    'old1:due1': { nextReviewAt: now - 1000 },
    'old2:due2': { nextReviewAt: now - 2000 },
  };
  const q = buildComboReview(allCards, progress, 'newest', { count: 2 });
  const lessonIds = q.map(x => x.card._lessonId).sort();
  assert.deepEqual(lessonIds, ['old1', 'old2']); // not stuck on newest lesson alone
});

test('never returns duplicate cards even if a card would qualify for multiple categories', () => {
  const now = Date.now();
  const allCards = [card('L', 'x', 'zh-x')];
  // due AND weak at the same time (overdue + again grade)
  const progress = { 'L:x': { grade: 'again', nextReviewAt: now - 1000, easeFactor: 1.3 } };
  const q = buildComboReview(allCards, progress, 'L', { count: 6 });
  assert.equal(q.length, 1);
});

test('entry snapshot carries the existing progress entry for "next review" display, unmodified', () => {
  const now = Date.now();
  const allCards = [card('L', 'x', 'zh-x')];
  const entry = { nextReviewAt: now - 1000, grade: 'good', easeFactor: 2.5 };
  const progress = { 'L:x': entry };
  const q = buildComboReview(allCards, progress, 'L', { count: 1 });
  assert.equal(q[0].entry, entry);
});

test('does not crash with fewer than count candidates total', () => {
  const allCards = [card('L', 'only', 'zh-only')];
  const q = buildComboReview(allCards, {}, 'L', { count: 6 });
  assert.equal(q.length, 1);
});

test('cards missing thai or zh are excluded from candidates', () => {
  const allCards = [
    card('L', 'a', ''),
    card('L', '', 'zh-b'),
    card('L', 'c', 'zh-c'),
  ];
  const q = buildComboReview(allCards, {}, 'L', { count: 6 });
  assert.equal(q.length, 1);
  assert.equal(q[0].card.thai, 'c');
});
