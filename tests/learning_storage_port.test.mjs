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

const {
  state, loadState, saveState, STORAGE_KEY, DEVICE_STATE_KEY,
} = await import('../src/state.js');
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
  state.currentLessonId = null;
  state.mode = 'card';
  state.lastOpenDate = null;
  state.cardIndex = 0;
  state.listFilter = 'all';
  state.listLessonId = null;
  state.listOrder = 'thai';
  Object.assign(state.settings, {
    sheetInput: '', rate: 1, repeat: 3, gap: 'auto', theme: 'dark',
    voiceProvider: 'elevenlabs', voice: 'th-TH-Neural2-C', dialogSource: 'lesson',
  });
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

test('state keeps device UI global while explicit learning ports stay isolated', () => {
  fallback.values.clear();
  const userA = memoryStorage();
  const userB = memoryStorage();
  const legacyBlob = JSON.stringify({
    settingsVersion: 2,
    settings: { theme: 'light', rate: 0.8 },
    progress: { legacy: { grade: 'again' } },
    favorites: { legacy: { v: 1, ts: 1 } },
    edits: { legacy: { thai: 'legacy' } },
    collapsed: { beginner: true },
    currentLessonId: 'legacy-lesson',
    mode: 'list',
    lastOpenDate: '2026-08-23',
    cardIndex: 4,
    listFilter: 'hard',
    listLessonId: 'legacy-list',
    listOrder: 'zh',
  });
  fallback.setItem(STORAGE_KEY, legacyBlob);

  resetRuntimeState();
  state.progress = { a: { grade: 'good' } };
  state.favorites = { 'เอ': { v: 1, ts: 2 } };
  state.edits = { a: { thai: 'เอ', updatedAt: 2 } };
  state.currentLessonId = 'lesson-a';
  state.mode = 'reverse';
  state.lastOpenDate = '2026-08-24';
  state.cardIndex = 7;
  state.collapsed = { intermediate: true };
  state.listFilter = 'fav';
  state.listLessonId = 'list-a';
  state.listOrder = 'thai';
  Object.assign(state.settings, { theme: 'dark', rate: 1.2 });
  saveState(userA);

  assert.equal(fallback.getItem(STORAGE_KEY), legacyBlob,
    'explicit save must not overwrite unclaimed legacy learning facts');
  assert.deepEqual(JSON.parse(userA.getItem(STORAGE_KEY)), {
    progress: state.progress,
    favorites: state.favorites,
    edits: state.edits,
  });
  const globalDevice = JSON.parse(fallback.getItem(DEVICE_STATE_KEY));
  assert.equal(globalDevice.currentLessonId, 'lesson-a');
  assert.equal(globalDevice.mode, 'reverse');
  assert.equal(globalDevice.cardIndex, 7);
  assert.deepEqual(globalDevice.collapsed, { intermediate: true });
  assert.equal(globalDevice.listFilter, 'fav');
  assert.equal(globalDevice.listLessonId, 'list-a');
  assert.equal(globalDevice.listOrder, 'thai');
  assert.equal(globalDevice.settings.theme, 'dark');

  state.progress = { b: { grade: 'hard' } };
  state.favorites = { 'บี': { v: 1, ts: 3 } };
  state.edits = { b: { thai: 'บี', updatedAt: 3 } };
  saveState(userB);

  resetRuntimeState();
  loadState(userA);
  assert.deepEqual(Object.keys(state.progress), ['a']);
  assert.deepEqual(Object.keys(state.favorites), ['เอ']);
  assert.deepEqual(Object.keys(state.edits), ['a']);
  assert.equal(state.currentLessonId, 'lesson-a');
  assert.equal(state.mode, 'reverse');
  assert.equal(state.cardIndex, 7);
  assert.deepEqual(state.collapsed, { intermediate: true });

  resetRuntimeState();
  loadState(userB);
  assert.deepEqual(Object.keys(state.progress), ['b']);
  assert.deepEqual(Object.keys(state.favorites), ['บี']);
  assert.deepEqual(Object.keys(state.edits), ['b']);
  assert.equal(state.currentLessonId, 'lesson-a', 'device UI remains shared across workspaces');
});

test('explicit load uses legacy blob only as a device UI fallback', () => {
  fallback.values.clear();
  fallback.setItem(STORAGE_KEY, JSON.stringify({
    settingsVersion: 2,
    settings: { theme: 'light' },
    progress: { legacy: { grade: 'again' } },
    favorites: { legacy: { v: 1, ts: 1 } },
    edits: { legacy: { thai: 'legacy' } },
    collapsed: { legacy: true },
    currentLessonId: 'legacy-lesson',
    mode: 'list',
    cardIndex: 9,
    listFilter: 'again',
    listLessonId: 'legacy-list',
    listOrder: 'zh',
  }));
  const userA = memoryStorage({
    [STORAGE_KEY]: JSON.stringify({
      progress: { a: { grade: 'good' } },
      favorites: { a: { v: 1, ts: 2 } },
      edits: { a: { thai: 'เอ' } },
    }),
  });

  resetRuntimeState();
  loadState(userA);
  assert.deepEqual(Object.keys(state.progress), ['a']);
  assert.deepEqual(Object.keys(state.favorites), ['a']);
  assert.deepEqual(Object.keys(state.edits), ['a']);
  assert.equal(state.currentLessonId, 'legacy-lesson');
  assert.equal(state.mode, 'list');
  assert.equal(state.cardIndex, 9);
  assert.deepEqual(state.collapsed, { legacy: true });
  assert.equal(state.listFilter, 'again');
  assert.equal(state.listLessonId, 'legacy-list');
  assert.equal(state.listOrder, 'zh');
  assert.equal(state.settings.theme, 'light');
});

test('default state path preserves the combined thai-review-v1 blob contract', () => {
  fallback.values.clear();
  resetRuntimeState();
  state.progress = { legacy: { grade: 'good' } };
  state.favorites = { 'เก่า': { v: 1, ts: 4 } };
  state.edits = { legacy: { thai: 'เก่า', updatedAt: 4 } };
  state.collapsed = { advanced: true };
  state.currentLessonId = 'lesson-legacy';
  state.mode = 'list';
  state.lastOpenDate = '2026-08-24';
  state.cardIndex = 6;
  state.listFilter = 'easy';
  state.listLessonId = 'list-legacy';
  state.listOrder = 'zh';
  Object.assign(state.settings, { theme: 'light', repeat: 5 });
  saveState();

  const saved = JSON.parse(fallback.getItem(STORAGE_KEY));
  assert.deepEqual(saved.progress, state.progress);
  assert.deepEqual(saved.favorites, state.favorites);
  assert.deepEqual(saved.edits, state.edits);
  assert.deepEqual(saved.collapsed, { advanced: true });
  assert.equal(saved.currentLessonId, 'lesson-legacy');
  assert.equal(saved.mode, 'list');
  assert.equal(saved.lastOpenDate, '2026-08-24');
  assert.equal(saved.cardIndex, 6);
  assert.equal(saved.listFilter, 'easy');
  assert.equal(saved.listLessonId, 'list-legacy');
  assert.equal(saved.listOrder, 'zh');
  assert.equal(saved.settings.theme, 'light');
  assert.equal(fallback.getItem(DEVICE_STATE_KEY), null);

  resetRuntimeState();
  loadState();
  assert.deepEqual(Object.keys(state.progress), ['legacy']);
  assert.equal(state.currentLessonId, 'lesson-legacy');
  assert.equal(state.mode, 'list');
  assert.equal(state.cardIndex, 6);
  assert.equal(state.settings.theme, 'light');
});

test('missing default legacy state is a valid first-run load', () => {
  fallback.values.clear();
  resetRuntimeState();
  state.currentLessonId = 'unchanged-default';

  assert.equal(loadState(), true);
  assert.equal(state.currentLessonId, 'unchanged-default');
  assert.equal(fallback.getItem(STORAGE_KEY), null);
  assert.equal(fallback.getItem(DEVICE_STATE_KEY), null);
});

test('corrupt or unavailable state reads fail closed without mutating runtime or raw bytes', () => {
  fallback.values.clear();
  const corrupt = memoryStorage({ [STORAGE_KEY]: '{bad json' });
  resetRuntimeState();
  state.progress = { sentinel: { grade: 'easy' } };
  state.favorites = { sentinel: { v: 1, ts: 9 } };
  state.edits = { sentinel: { thai: 'เดิม' } };
  state.currentLessonId = 'sentinel-lesson';
  const before = JSON.stringify({
    progress: state.progress,
    favorites: state.favorites,
    edits: state.edits,
    currentLessonId: state.currentLessonId,
  });

  assert.equal(loadState(corrupt), false);
  assert.equal(corrupt.getItem(STORAGE_KEY), '{bad json');
  assert.equal(JSON.stringify({
    progress: state.progress,
    favorites: state.favorites,
    edits: state.edits,
    currentLessonId: state.currentLessonId,
  }), before);

  const unavailable = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('blocked'); },
  };
  assert.equal(loadState(unavailable), false);
  assert.equal(JSON.stringify({
    progress: state.progress,
    favorites: state.favorites,
    edits: state.edits,
    currentLessonId: state.currentLessonId,
  }), before);

  fallback.setItem(STORAGE_KEY, '{legacy corrupt');
  assert.equal(loadState(), false, 'default legacy corruption keeps its fail-safe behavior');
  assert.equal(fallback.getItem(STORAGE_KEY), '{legacy corrupt');
  assert.equal(JSON.stringify({
    progress: state.progress,
    favorites: state.favorites,
    edits: state.edits,
    currentLessonId: state.currentLessonId,
  }), before);

  fallback.values.clear();
  assert.equal(loadState(memoryStorage()), true, 'a missing explicit workspace is a valid empty state');
  assert.deepEqual(state.progress, {});
  assert.deepEqual(state.favorites, {});
  assert.deepEqual(state.edits, {});
  assert.equal(state.currentLessonId, 'sentinel-lesson');
});

test('valid JSON with non-object learning containers fails closed atomically', () => {
  fallback.values.clear();
  resetRuntimeState();
  state.progress = { sentinel: { grade: 'easy' } };
  state.favorites = { sentinel: { v: 1, ts: 9 } };
  state.edits = { sentinel: { thai: 'เดิม' } };
  state.currentLessonId = 'sentinel-lesson';

  for (const [field, invalid] of [
    ['progress', []],
    ['favorites', 'not-an-object'],
    ['edits', 7],
  ]) {
    const raw = JSON.stringify({ progress: {}, favorites: {}, edits: {}, [field]: invalid });
    const learning = memoryStorage({ [STORAGE_KEY]: raw });
    const before = structuredClone(state);
    assert.equal(loadState(learning), false, `${field} must reject a non-plain object`);
    assert.deepEqual(state, before, `${field} failure must not partially mutate runtime`);
    assert.equal(learning.getItem(STORAGE_KEY), raw, `${field} failure must not rewrite raw bytes`);
  }
});

test('valid JSON with non-object device containers fails closed atomically', () => {
  resetRuntimeState();
  state.progress = { sentinel: { grade: 'easy' } };
  state.currentLessonId = 'sentinel-lesson';

  for (const [field, invalid] of [
    ['settings', []],
    ['collapsed', 'not-an-object'],
  ]) {
    fallback.values.clear();
    const deviceRaw = JSON.stringify({ settings: {}, collapsed: {}, [field]: invalid });
    fallback.setItem(DEVICE_STATE_KEY, deviceRaw);
    const learningRaw = JSON.stringify({ progress: { a: { grade: 'good' } }, favorites: {}, edits: {} });
    const learning = memoryStorage({ [STORAGE_KEY]: learningRaw });
    const before = structuredClone(state);
    assert.equal(loadState(learning), false, `${field} must reject a non-plain object`);
    assert.deepEqual(state, before, `${field} failure must not partially mutate runtime`);
    assert.equal(learning.getItem(STORAGE_KEY), learningRaw);
    assert.equal(fallback.getItem(DEVICE_STATE_KEY), deviceRaw);
  }
});

test('migration persistence failure leaves runtime and source payload untouched', () => {
  fallback.values.clear();
  const raw = JSON.stringify({ progress: { legacy: 'good' }, favorites: {}, edits: {} });
  const values = new Map([[STORAGE_KEY, raw]]);
  const blockedMigration = {
    getItem: key => values.get(key) ?? null,
    setItem() { throw new Error('migration write blocked'); },
  };
  resetRuntimeState();
  state.progress = { sentinel: { grade: 'easy' } };
  state.currentLessonId = 'sentinel-lesson';
  const before = structuredClone(state);

  assert.equal(loadState(blockedMigration), false);
  assert.deepEqual(state, before);
  assert.equal(values.get(STORAGE_KEY), raw);
});

test('explicit save reports device failure without throwing after learning committed', () => {
  fallback.values.clear();
  const learning = memoryStorage();
  const originalLocalStorage = globalThis.localStorage;
  const warnings = [];
  const originalWarn = console.warn;
  globalThis.localStorage = {
    getItem: key => fallback.getItem(key),
    setItem(key, value) {
      if (key === DEVICE_STATE_KEY) throw new Error('device blocked');
      fallback.setItem(key, value);
    },
    removeItem: key => fallback.removeItem(key),
  };
  console.warn = (...args) => warnings.push(args);

  try {
    resetRuntimeState();
    state.progress = { committed: { grade: 'good' } };
    const result = saveState(learning);
    assert.deepEqual(result, { learningSaved: true, deviceSaved: false });
    assert.deepEqual(Object.keys(JSON.parse(learning.getItem(STORAGE_KEY)).progress), ['committed']);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0].join(' '), /device state save failed.*device blocked/);
  } finally {
    console.warn = originalWarn;
    globalThis.localStorage = originalLocalStorage;
  }
});

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
