import assert from 'node:assert/strict';
import test from 'node:test';

const stored = new Map();
globalThis.localStorage = {
  getItem(key) { return stored.get(key) ?? null; },
  setItem(key, value) { stored.set(key, value); },
  removeItem(key) { stored.delete(key); },
};

const { ACHIEVEMENT_DEFS, checkAndUnlock, loadUnlocked, achievementLabel } = await import('../src/achievements.js');

function baseCtx(overrides = {}) {
  return {
    streak: 0,
    maxDailyReviewed: 0,
    totalReviewed: 0,
    totalCards: 100,
    gradedCards: 0,
    ...overrides,
  };
}

test('streak7 unlocks once streak reaches 7, not before', () => {
  stored.clear();
  assert.equal(checkAndUnlock(baseCtx({ streak: 6 })).length, 0);
  const unlocked = checkAndUnlock(baseCtx({ streak: 7 }));
  assert.equal(unlocked.length, 1);
  assert.equal(unlocked[0].id, 'streak7');
});

test('already-unlocked achievements do not fire again', () => {
  stored.clear();
  checkAndUnlock(baseCtx({ streak: 30 })); // streak7 + streak30 both fire
  const secondPass = checkAndUnlock(baseCtx({ streak: 30 }));
  assert.equal(secondPass.length, 0);
  assert.equal(Object.keys(loadUnlocked()).length, 2);
});

test('allGraded requires every card graded, label reflects current total', () => {
  stored.clear();
  assert.equal(checkAndUnlock(baseCtx({ totalCards: 50, gradedCards: 49 })).length, 0);
  const unlocked = checkAndUnlock(baseCtx({ totalCards: 50, gradedCards: 50 }));
  const def = unlocked.find(d => d.id === 'allGraded');
  assert.ok(def);
  assert.equal(achievementLabel(def, { totalCards: 50 }), '50 張全上手');
});

test('cumulative1000 and daily50 are independent of streak/grading', () => {
  stored.clear();
  const unlocked = checkAndUnlock(baseCtx({ maxDailyReviewed: 50, totalReviewed: 1000 }));
  const ids = unlocked.map(d => d.id).sort();
  assert.deepEqual(ids, ['cumulative1000', 'daily50']);
});

test('ACHIEVEMENT_DEFS currently holds only the direction-2/3-independent set', () => {
  const ids = ACHIEVEMENT_DEFS.map(d => d.id).sort();
  assert.deepEqual(ids, ['allGraded', 'cumulative1000', 'daily50', 'streak30', 'streak7']);
});
