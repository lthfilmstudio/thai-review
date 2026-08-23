import assert from 'node:assert/strict';
import test from 'node:test';

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

const fallback = memoryStorage();
globalThis.localStorage = fallback;

const { state, loadState, saveState, STORAGE_KEY } = await import('../src/state.js');
const { DAILY_KEY, loadDailyLog, logReview } = await import('../src/today.js');
const { loadGradeHistory, recordGrade } = await import('../src/grade-history.js');
const { loadUnlocked, checkAndUnlock } = await import('../src/achievements.js');
const { loadResweepState, advanceResweepCursor } = await import('../src/resweep.js');

const HISTORY_KEY = 'thai-review-grade-history-v1';
const ACHIEVEMENTS_KEY = 'thai-review-achievements-v1';
const RESWEEP_KEY = 'thai-review-resweep-v1';

function resetRuntimeState() {
  state.progress = {};
  state.favorites = {};
  state.edits = {};
  state.collapsed = {};
}

function achievementCtx(streak) {
  return {
    streak,
    maxDailyReviewed: 0,
    totalReviewed: 0,
    totalCards: 0,
    gradedCards: 0,
    allLessonsLoaded: true,
    hasFullyMatureLesson: false,
    weeklyAccuracy: null,
  };
}

test('learning owners isolate explicit anonymous, A, and B storage ports', () => {
  fallback.values.clear();
  const anon = memoryStorage();
  const userA = memoryStorage();
  const userB = memoryStorage();
  const ports = [anon, userA, userB];

  ports.forEach((port, index) => {
    resetRuntimeState();
    state.progress = { [`card-${index}`]: { grade: 'good', reviewedAt: index + 1 } };
    saveState(port);
    logReview(index === 0 ? 'again' : 'good', 1_700_000_000_000 + index, port);
    recordGrade(`card-${index}`, 'good', 1_700_000_000_000 + index, port);
    checkAndUnlock(achievementCtx(index === 2 ? 7 : 0), port);
    advanceResweepCursor(index + 1, 10, port);
  });

  for (const key of [STORAGE_KEY, DAILY_KEY, HISTORY_KEY, ACHIEVEMENTS_KEY, RESWEEP_KEY]) {
    assert.equal(fallback.values.has(key), false, `${key} must not leak to fallback storage`);
  }

  ports.forEach((port, index) => {
    assert.deepEqual(Object.keys(JSON.parse(port.values.get(STORAGE_KEY)).progress), [`card-${index}`]);
    assert.equal(loadDailyLog(port).days['2023-11-15'].reviewed, 1);
    assert.deepEqual(Object.keys(loadGradeHistory(port).cards), [`card-${index}`]);
    assert.equal(!!loadUnlocked(port).streak7, index === 2);
    assert.equal(loadResweepState(port).position, index + 1);
  });
});

test('undefined storage preserves fallback behavior and corrupt injected payloads fail safe', () => {
  fallback.values.clear();
  resetRuntimeState();
  state.progress = { fallback: { grade: 'good' } };
  saveState(undefined);
  logReview('good', 1_700_000_000_000, undefined);
  recordGrade('fallback', 'hard', 1_700_000_000_000, undefined);
  checkAndUnlock(achievementCtx(7), undefined);
  advanceResweepCursor(2, 10, undefined);

  for (const key of [STORAGE_KEY, DAILY_KEY, HISTORY_KEY, ACHIEVEMENTS_KEY, RESWEEP_KEY]) {
    assert.equal(fallback.values.has(key), true, `${key} must retain default localStorage behavior`);
  }

  const corrupt = memoryStorage({
    [STORAGE_KEY]: '{bad json',
    [DAILY_KEY]: '{bad json',
    [HISTORY_KEY]: '{bad json',
    [ACHIEVEMENTS_KEY]: '{bad json',
    [RESWEEP_KEY]: '{bad json',
  });
  resetRuntimeState();
  assert.doesNotThrow(() => loadState(corrupt));
  assert.deepEqual(state.progress, {});
  assert.deepEqual(loadDailyLog(corrupt), { v: 1, backfilled: false, days: {} });
  assert.deepEqual(loadGradeHistory(corrupt), { v: 1, cards: {} });
  assert.deepEqual(loadUnlocked(corrupt), {});
  assert.deepEqual(loadResweepState(corrupt), { startedAt: null, position: 0 });

  const unavailable = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('blocked'); },
    removeItem() { throw new Error('blocked'); },
  };
  assert.doesNotThrow(() => loadState(unavailable));
  assert.deepEqual(loadDailyLog(unavailable), { v: 1, backfilled: false, days: {} });
  assert.deepEqual(loadGradeHistory(unavailable), { v: 1, cards: {} });
  assert.deepEqual(loadUnlocked(unavailable), {});
  assert.deepEqual(loadResweepState(unavailable), { startedAt: null, position: 0 });
  assert.throws(() => saveState(unavailable), /blocked/,
    'state save keeps its existing error behavior when an injected port is unavailable');
});
