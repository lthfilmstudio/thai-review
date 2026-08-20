import assert from 'node:assert/strict';
import test from 'node:test';

const stored = new Map();
globalThis.localStorage = {
  getItem(key) { return stored.get(key) ?? null; },
  setItem(key, value) { stored.set(key, value); },
  removeItem(key) { stored.delete(key); },
};

const { recordGrade, loadGradeHistory } = await import('../src/grade-history.js');

test('records a grade and keeps timestamp in seconds', () => {
  stored.clear();
  recordGrade('L1:a', 'good', 1_700_000_000_000);
  const h = loadGradeHistory();
  assert.deepEqual(h.cards['L1:a'], [[2, 1_700_000_000]]);
});

test('each card keeps only the most recent 5 entries', () => {
  stored.clear();
  const grades = ['again', 'hard', 'good', 'easy', 'again', 'hard', 'good'];
  grades.forEach((g, i) => recordGrade('L1:a', g, i * 1000));
  const h = loadGradeHistory();
  assert.equal(h.cards['L1:a'].length, 5);
  // 最舊的兩筆（again@0, hard@1000）被丟掉，留下 good/easy/again/hard/good
  assert.deepEqual(h.cards['L1:a'].map(e => e[0]), [2, 3, 0, 1, 2]);
});

test('all four grades round-trip through the code table', () => {
  stored.clear();
  ['again', 'hard', 'good', 'easy'].forEach((g, i) => recordGrade(`L1:${g}`, g, i));
  const h = loadGradeHistory();
  assert.equal(h.cards['L1:again'][0][0], 0);
  assert.equal(h.cards['L1:hard'][0][0], 1);
  assert.equal(h.cards['L1:good'][0][0], 2);
  assert.equal(h.cards['L1:easy'][0][0], 3);
});

test('unknown grade string or missing cardKey is ignored, not recorded', () => {
  stored.clear();
  recordGrade('L1:a', undefined);
  recordGrade('', 'good');
  const h = loadGradeHistory();
  assert.deepEqual(h.cards, {});
});

test('different cards are tracked independently', () => {
  stored.clear();
  recordGrade('L1:a', 'good', 1);
  recordGrade('L1:b', 'again', 2);
  const h = loadGradeHistory();
  assert.equal(h.cards['L1:a'].length, 1);
  assert.equal(h.cards['L1:b'].length, 1);
});

test('corrupted localStorage falls back to an empty history without throwing', () => {
  stored.clear();
  stored.set('thai-review-grade-history-v1', '{not json');
  assert.doesNotThrow(() => recordGrade('L1:a', 'good', 1));
  const h = loadGradeHistory();
  assert.equal(h.cards['L1:a'].length, 1);
});
