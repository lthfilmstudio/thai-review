import assert from 'node:assert/strict';
import test from 'node:test';

const stored = new Map();
globalThis.localStorage = {
  getItem(key) { return stored.get(key) ?? null; },
  setItem(key, value) { stored.set(key, value); },
  removeItem(key) { stored.delete(key); },
};

const {
  ACHIEVEMENT_DEFS, checkAndUnlock, loadUnlocked, achievementLabel, achievementIconSvg,
} = await import('../src/achievements.js');

function baseCtx(overrides = {}) {
  return {
    streak: 0,
    maxDailyReviewed: 0,
    totalReviewed: 0,
    totalCards: 100,
    gradedCards: 0,
    allLessonsLoaded: true,
    hasFullyMatureLesson: false,
    weeklyAccuracy: null,
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

test('allGraded does not unlock while the deck is only partially loaded', () => {
  stored.clear();
  assert.equal(checkAndUnlock(baseCtx({ gradedCards: 100, allLessonsLoaded: false })).length, 0);
});

test('cumulative1000 and daily50 are independent of streak/grading', () => {
  stored.clear();
  const unlocked = checkAndUnlock(baseCtx({ maxDailyReviewed: 50, totalReviewed: 1000 }));
  const ids = unlocked.map(d => d.id).sort();
  assert.deepEqual(ids, ['cumulative1000', 'daily50']);
});

test('lessonMastered fires only when hasFullyMatureLesson is true', () => {
  stored.clear();
  assert.equal(checkAndUnlock(baseCtx({ hasFullyMatureLesson: false })).length, 0);
  const unlocked = checkAndUnlock(baseCtx({ hasFullyMatureLesson: true }));
  assert.equal(unlocked.length, 1);
  assert.equal(unlocked[0].id, 'lessonMastered');
});

test('weeklyAccuracy90 requires actual data (not null) at or above 90', () => {
  stored.clear();
  assert.equal(checkAndUnlock(baseCtx({ weeklyAccuracy: null })).length, 0);
  assert.equal(checkAndUnlock(baseCtx({ weeklyAccuracy: 89 })).length, 0);
  const unlocked = checkAndUnlock(baseCtx({ weeklyAccuracy: 90 }));
  assert.equal(unlocked.length, 1);
  assert.equal(unlocked[0].id, 'weeklyAccuracy90');
});

test('ACHIEVEMENT_DEFS now holds all 8 badges (Phase 2 adds streak100)', () => {
  const ids = ACHIEVEMENT_DEFS.map(d => d.id).sort();
  assert.deepEqual(ids, [
    'allGraded', 'cumulative1000', 'daily50', 'lessonMastered',
    'streak100', 'streak30', 'streak7', 'weeklyAccuracy90',
  ]);
});

test('streak100 unlocks once streak reaches 100, independent of streak7/30', () => {
  stored.clear();
  const unlocked = checkAndUnlock(baseCtx({ streak: 100 }));
  const ids = unlocked.map(d => d.id).sort();
  // 一次跨過 7/30/100 三個門檻，三個都該一起解鎖
  assert.deepEqual(ids, ['streak100', 'streak30', 'streak7']);
});

test('every achievement renders an SVG line icon without emoji glyphs', () => {
  const emojiGlyphs = /[🔥📅🎓📚🌟🎯]/u;
  for (const def of ACHIEVEMENT_DEFS) {
    const svg = achievementIconSvg(def);
    assert.match(svg, /^<svg\b/);
    assert.match(svg, /stroke="currentColor"/);
    assert.equal(emojiGlyphs.test(svg), false);
  }
});
