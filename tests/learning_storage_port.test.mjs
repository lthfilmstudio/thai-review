import assert from 'node:assert/strict';
import test from 'node:test';

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
    clear() { values.clear(); },
  };
}

const fallback = memoryStorage();
globalThis.localStorage = fallback;

const {
  state, loadDeviceStateResult, loadState, loadStateResult, saveState, STORAGE_KEY, DEVICE_STATE_KEY,
  setGrade, toggleFavorite, saveCardEdit,
  projectHydratedWorkspaceState, projectWorkspaceAuxiliaryState, mergeWorkspaceHydration,
} = await import('../src/state.js');
const {
  DAILY_KEY, loadDailyLog, logReview, logGame, addActiveSeconds, buildDailyQueue,
} = await import('../src/today.js');
const { loadGradeHistory, recordGrade } = await import('../src/grade-history.js');
const { loadUnlocked, checkAndUnlock } = await import('../src/achievements.js');
const { loadResweepState, advanceResweepCursor } = await import('../src/resweep.js');
const {
  LEARNING_STORE_KEYS, createWorkspaceBoot, createWorkspaceStorage, runWorkspaceBoot,
} = await import('../src/storage-scope.js');
const { clearSyncState, lastSyncedAt } = await import('../src/cloud-sync.js');

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

function readyWorkspacePort(backing, workspaceId) {
  const boot = createWorkspaceBoot();
  boot.moveTo('loading-catalog', { workspaceId });
  boot.moveTo('opening-storage');
  boot.moveTo('ready');
  return { boot, port: createWorkspaceStorage(backing, { workspaceId, boot }) };
}

test('workspace hydration 保留 local-only 評分，IndexedDB 同卡資料優先', () => {
  const localOnly = '550e8400-e29b-41d4-a716-446655440010';
  const shared = '550e8400-e29b-41d4-a716-446655440011';
  const result = mergeWorkspaceHydration(
    { progress: { [shared]: { grade: 'easy' } }, projections: {} },
    {
      progress: {
        [localOnly]: { grade: 'good' },
        [shared]: { grade: 'again' },
      },
      favorites: { favorite: { v: 1, ts: 9 } },
      edits: { edit: { thai: 'เดิม', updatedAt: 9 } },
    },
  );

  assert.deepEqual(result.progress, {
    [localOnly]: { grade: 'good' },
    [shared]: { grade: 'easy' },
  });
  assert.deepEqual(result.favorites, { favorite: { v: 1, ts: 9 } });
  assert.deepEqual(result.edits, { edit: { thai: 'เดิม', updatedAt: 9 } });
});

/* P0：呼叫端（app.js 的 runtimeProgressFromHydration）已經把 hydration 的 card_id 翻回
   lessonId:thai，所以兩邊是同一組鍵。IDB 是權威來源不代表它比較新——使用者在單堂課或
   別台裝置評過的那筆只寫得進 localStorage 鏡射。 */
const srsAt = (interval, updatedAt) => ({
  grade: 'good', interval, reps: 5, easeFactor: 2.6,
  reviewedAt: updatedAt, nextReviewAt: updatedAt, updatedAt,
});

test('開機合併：帳本比本機舊就不准蓋掉，排程不回捲', () => {
  const key = 'gid-1:สวัสดี';
  const result = mergeWorkspaceHydration(
    { progress: { [key]: srsAt(3, 1_780_000_000_000) }, projections: {} },
    { progress: { [key]: srsAt(64, 1_790_000_000_000) }, favorites: {}, edits: {} },
  );
  assert.equal(result.progress[key].interval, 64, '本機那筆才是最新的，不能被帳本蓋掉');
});

test('開機合併：帳本比本機新就採用', () => {
  const key = 'gid-1:สวัสดี';
  const result = mergeWorkspaceHydration(
    { progress: { [key]: srsAt(64, 1_790_000_000_000) }, projections: {} },
    { progress: { [key]: srsAt(3, 1_780_000_000_000) }, favorites: {}, edits: {} },
  );
  assert.equal(result.progress[key].interval, 64);
});

test('開機合併：時間戳平手時由權威那份贏', () => {
  const key = 'gid-1:สวัสดี';
  const stamp = 1_780_000_000_000;
  const result = mergeWorkspaceHydration(
    { progress: { [key]: srsAt(64, stamp) }, projections: {} },
    { progress: { [key]: srsAt(3, stamp) }, favorites: {}, edits: {} },
  );
  assert.equal(result.progress[key].interval, 64);
});

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

  assert.deepEqual(loadStateResult(), { status: 'ok', source: 'missing' });
  assert.equal(loadState(), true);
  assert.equal(state.currentLessonId, 'unchanged-default');
  assert.equal(fallback.getItem(STORAGE_KEY), null);
  assert.equal(fallback.getItem(DEVICE_STATE_KEY), null);
});

test('device-only boot loader 不讀 legacy learning blob，只採用獨立 UI settings', () => {
  fallback.values.clear();
  fallback.setItem(STORAGE_KEY, JSON.stringify({
    progress: { leaked: { grade: 'easy' } }, settings: { theme: 'light' },
  }));
  fallback.setItem(DEVICE_STATE_KEY, JSON.stringify({
    settingsVersion: 2, settings: { theme: 'light', rate: 0.8 }, mode: 'lists',
  }));
  resetRuntimeState();

  assert.deepEqual(loadDeviceStateResult(), { status: 'ok', source: 'stored' });
  assert.deepEqual(state.progress, {});
  assert.equal(state.settings.theme, 'light');
  assert.equal(state.settings.rate, 0.8);
  assert.equal(state.mode, 'lists');

  fallback.setItem(DEVICE_STATE_KEY, '{bad json');
  assert.deepEqual(loadDeviceStateResult(), { status: 'corrupt', reason: 'json' });
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

  assert.deepEqual(loadStateResult(corrupt), { status: 'corrupt', reason: 'json' });
  assert.equal(loadState(corrupt), false, 'boolean compatibility wrapper remains fail closed');
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
  assert.deepEqual(loadStateResult(unavailable), { status: 'unavailable', phase: 'read' });
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
    assert.deepEqual(loadStateResult(learning), { status: 'corrupt', reason: 'schema' },
      `${field} must reject a non-plain object`);
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
    assert.deepEqual(loadStateResult(learning), { status: 'corrupt', reason: 'schema' },
      `${field} must reject a non-plain object`);
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

  assert.deepEqual(loadStateResult(blockedMigration), {
    status: 'unavailable', phase: 'migration-write',
  });
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

test('production learning paths keep actual A, anonymous, and B workspace ports isolated on one backing store', () => {
  fallback.values.clear();
  const legacyBefore = new Map();
  for (const [name, key] of Object.entries(LEARNING_STORE_KEYS)) {
    const raw = JSON.stringify({ legacy: name });
    fallback.setItem(key, raw);
    legacyBefore.set(key, raw);
  }

  const workspaces = ['user:A', 'anon:device-1', 'user:B'];
  const handles = workspaces.map(id => readyWorkspacePort(fallback, id));
  const ts = Date.UTC(2026, 7, 20, 4, 0);

  handles.forEach(({ port }, index) => {
    const lessonId = `L${index}`;
    const card = {
      _lessonId: lessonId,
      _cardKey: `${lessonId}:thai-${index}`,
      thai: `thai-${index}`,
      karaoke: `karaoke-${index}`,
      zh: `zh-${index}`,
    };
    resetRuntimeState();
    state.lessons = [{ id: lessonId, title: lessonId, _loaded: true, cards: [card] }];
    state.currentLessonId = lessonId;
    state.settings.theme = ['light', 'dark', 'auto'][index];

    setGrade(card, 'good', port);
    toggleFavorite(card, port);
    saveCardEdit(card, { thai: `edited-${index}`, zh: card.zh }, port);
    recordGrade(card._cardKey, 'good', ts + index, port);
    logReview('good', ts + index, port);
    logGame(['listen', 'combo', 'dialog'][index], ts + index, port);
    addActiveSeconds(15 + index, ts + index, port);
    assert.equal(buildDailyQueue([card], state.progress, state.lessons, 0, port).cards.length, 1);
    checkAndUnlock(achievementCtx(index === 2 ? 7 : 0), port);
    advanceResweepCursor(index + 1, 10, port);

    port.setItem(LEARNING_STORE_KEYS.cursors, JSON.stringify({ at: 100 + index }));
    assert.equal(lastSyncedAt(port), 100 + index);
    clearSyncState(port);
    assert.equal(lastSyncedAt(port), 0);
  });

  handles.forEach(({ port }, index) => {
    const lessonId = `L${index}`;
    const key = `${lessonId}:thai-${index}`;
    const savedState = JSON.parse(port.getItem(STORAGE_KEY));
    const daily = loadDailyLog(port).days['2026-08-20'];
    assert.deepEqual(Object.keys(savedState.progress), [key]);
    assert.deepEqual(Object.keys(savedState.favorites), [`thai-${index}`]);
    assert.deepEqual(Object.keys(savedState.edits), [key]);
    assert.equal(daily.reviewed, 1);
    assert.equal(daily.games, 1);
    assert.equal(daily.seconds, 15 + index);
    assert.deepEqual(Object.keys(loadGradeHistory(port).cards), [key]);
    assert.equal(!!loadUnlocked(port).streak7, index === 2);
    assert.equal(loadResweepState(port).position, index + 1);
    assert.deepEqual(JSON.parse(port.getItem(LEARNING_STORE_KEYS.remoteDays)), {});
  });

  for (const [key, raw] of legacyBefore) {
    assert.equal(fallback.getItem(key), raw, `${key} legacy bytes must remain unchanged`);
  }
  const deviceState = JSON.parse(fallback.getItem(DEVICE_STATE_KEY));
  assert.equal(deviceState.settings.theme, 'auto', 'device settings remain one shared device store');
});

test('fresh reload hydrates scoped favorites and edits while IndexedDB remains progress authority', async () => {
  fallback.values.clear();
  const legacyRaw = JSON.stringify({
    progress: { legacy: { grade: 'again' } },
    favorites: { legacy: { v: 1, ts: 1 } },
    edits: { legacy: { thai: 'legacy' } },
  });
  fallback.setItem(STORAGE_KEY, legacyRaw);

  const workspaces = ['user:A', 'anon:device-1', 'user:B'];
  const cards = [
    '550e8400-e29b-41d4-a716-446655440000',
    '550e8400-e29b-41d4-a716-446655440001',
    '550e8400-e29b-41d4-a716-446655440002',
  ];
  workspaces.forEach((workspaceId, index) => {
    const { port } = readyWorkspacePort(fallback, workspaceId);
    port.setItem(STORAGE_KEY, JSON.stringify({
      progress: { [`local-${index}`]: { grade: 'again' } },
      favorites: { [`thai-${index}`]: index === 1 ? 1 : { v: 1, ts: index + 1 } },
      edits: { [`L${index}:thai-${index}`]: { thai: `edited-${index}`, updatedAt: index + 1 } },
    }));
  });

  for (let index = 0; index < workspaces.length; index += 1) {
    const workspaceId = workspaces[index];
    const session = workspaceId.startsWith('user:')
      ? { user: { id: workspaceId.slice(5) } }
      : null;
    resetRuntimeState();
    const result = await runWorkspaceBoot({
      resolveSession: async () => session
        ? { status: 'authenticated', session }
        : { status: 'anonymous', session: null },
      resolveDeviceId: () => 'device-1',
      loadCatalog: async () => ({ revision: 'catalog-1' }),
      openStorage: ({ workspaceId: id, boot }) => createWorkspaceStorage(fallback, {
        workspaceId: id, boot,
      }),
      hydrate: async ({ workspaceId: id, hydrationStorage }) => {
        const auxiliary = projectWorkspaceAuxiliaryState(
          hydrationStorage.getItem(STORAGE_KEY),
        );
        const projected = projectHydratedWorkspaceState({
          kind: 'practice-workspace-hydration-v1', schemaVersion: 1, workspaceId: id,
          srs: [{
            workspaceId: id, cardId: cards[index], version: index,
            state: { grade: ['again', 'good', 'easy'][index] }, sourceEventId: null,
          }],
          projections: [],
        });
        Object.assign(state, mergeWorkspaceHydration(projected, auxiliary));
        return { projected, auxiliary };
      },
    });

    assert.equal(result.status, 'ready');
    assert.deepEqual(Object.keys(state.progress).sort(), [`local-${index}`, cards[index]].sort());
    assert.deepEqual(Object.keys(state.favorites), [`thai-${index}`]);
    assert.deepEqual(Object.keys(state.edits), [`L${index}:thai-${index}`]);
    assert.deepEqual(state.favorites[`thai-${index}`], { v: 1, ts: index === 1 ? 0 : index + 1 });
    saveState(result.storage);
    const saved = JSON.parse(result.storage.getItem(STORAGE_KEY));
    assert.deepEqual(saved.favorites, state.favorites, 'first ready save must retain favorites');
    assert.deepEqual(saved.edits, state.edits, 'first ready save must retain edits');
    assert.deepEqual(
      Object.keys(saved.progress).sort(),
      [`local-${index}`, cards[index]].sort(),
      'scoped local progress survives until the IndexedDB write path owns every grade',
    );
  }

  assert.equal(fallback.getItem(STORAGE_KEY), legacyRaw, 'global legacy bytes remain untouched');
});

test('invalid scoped auxiliary state fails boot closed without partially applying hydration', async () => {
  fallback.values.clear();
  const seed = readyWorkspacePort(fallback, 'user:A').port;
  seed.setItem(STORAGE_KEY, JSON.stringify({
    progress: { ignored: { grade: 'good' } },
    favorites: { bad: { v: 2, ts: 1 } },
    edits: {},
  }));
  resetRuntimeState();
  state.progress = { sentinel: { grade: 'easy' } };
  state.favorites = { sentinel: { v: 1, ts: 9 } };
  state.edits = { sentinel: { thai: 'เดิม' } };

  const events = [];
  const result = await runWorkspaceBoot({
    resolveSession: async () => ({
      status: 'authenticated', session: { user: { id: 'A' } },
    }),
    resolveDeviceId: () => 'device-1',
    loadCatalog: async () => ({ revision: 'catalog-1' }),
    openStorage: ({ workspaceId, boot }) => createWorkspaceStorage(fallback, {
      workspaceId, boot,
    }),
    hydrate: async ({ workspaceId, hydrationStorage }) => {
      const auxiliary = projectWorkspaceAuxiliaryState(hydrationStorage.getItem(STORAGE_KEY));
      const projected = projectHydratedWorkspaceState({
        kind: 'practice-workspace-hydration-v1', schemaVersion: 1, workspaceId,
        srs: [], projections: [],
      });
      Object.assign(state, { progress: projected.progress, ...auxiliary });
    },
    onState: snapshot => events.push(snapshot.state),
  });

  assert.equal(result.status, 'recoverable-failure');
  assert.equal(events.includes('ready'), false);
  assert.deepEqual(state.progress, { sentinel: { grade: 'easy' } });
  assert.deepEqual(state.favorites, { sentinel: { v: 1, ts: 9 } });
  assert.deepEqual(state.edits, { sentinel: { thai: 'เดิม' } });
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

test('hydration 純轉換只投影 stable-card SRS 與版本化 projections，不改 global state', () => {
  const cardId = '550e8400-e29b-41d4-a716-446655440000';
  const hydration = {
    kind: 'practice-workspace-hydration-v1',
    schemaVersion: 1,
    workspaceId: 'user:A',
    srs: [{
      workspaceId: 'user:A', cardId, version: 0,
      state: { grade: 'good', nextReviewAt: 20 }, sourceEventId: null,
    }],
    projections: [{
      workspaceId: 'user:A', name: 'daily', schemaVersion: 1,
      projectorVersion: 'legacy-workspace-facts-v1',
      facts: [{ sourceStore: 'daily', sourceKey: '2026-08-24', value: { reviewed: 1 } }],
    }],
    quarantine: [{ cardId: 'must-not-leak' }],
    audit: [{ cardId: 'must-not-leak' }],
  };
  const before = structuredClone(hydration);
  state.progress = { sentinel: { grade: 'easy' } };

  const projected = projectHydratedWorkspaceState(hydration);

  assert.deepEqual(projected.progress, {
    [cardId]: { grade: 'good', nextReviewAt: 20 },
  });
  assert.deepEqual(Object.keys(projected.projections), ['daily']);
  assert.equal(projected.quarantine, undefined);
  assert.equal(projected.audit, undefined);
  assert.deepEqual(state.progress, { sentinel: { grade: 'easy' } });
  projected.progress[cardId].grade = 'again';
  assert.deepEqual(hydration, before);
});

test('hydration 拒絕 ownership SRS keys、非整數 reps 與 prototype projection names', () => {
  const cardId = '550e8400-e29b-41d4-a716-446655440000';
  const base = {
    kind: 'practice-workspace-hydration-v1', schemaVersion: 1, workspaceId: 'user:A',
    srs: [{
      workspaceId: 'user:A', cardId, version: 0,
      state: { grade: 'good' }, sourceEventId: null,
    }],
    projections: [],
  };
  assert.throws(() => projectHydratedWorkspaceState({
    ...base,
    srs: [{ ...base.srs[0], state: { grade: 'good', workspaceId: 'user:A' } }],
  }), /invalid hydrated SRS row/);
  assert.throws(() => projectHydratedWorkspaceState({
    ...base,
    srs: [{ ...base.srs[0], state: { grade: 'good', reps: 1.5 } }],
  }), /invalid hydrated SRS row/);
  assert.throws(() => projectHydratedWorkspaceState({
    ...base,
    srs: [{ ...base.srs[0], version: Number.MAX_SAFE_INTEGER + 1 }],
  }), /invalid hydrated SRS row/);
  for (const name of ['__proto__', 'prototype', 'constructor']) {
    assert.throws(() => projectHydratedWorkspaceState({
      ...base,
      projections: [{
        workspaceId: 'user:A', name, schemaVersion: 1,
        projectorVersion: 'legacy-workspace-facts-v1', facts: [],
      }],
    }), /invalid hydrated projection row/);
  }
});
