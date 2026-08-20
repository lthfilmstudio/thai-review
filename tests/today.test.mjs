import assert from 'node:assert/strict';
import test from 'node:test';

const stored = new Map();
globalThis.localStorage = {
  getItem(key) { return stored.get(key) ?? null; },
  setItem(key, value) { stored.set(key, value); },
  removeItem(key) { stored.delete(key); },
};

const {
  DAILY_KEY, initDailyLog, loadDailyLog, logReview,
  logGame, addActiveSeconds, streakDays, weekSummary, buildAchievementCtx,
} = await import('../src/today.js');
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

// 12:00 台北時間，落在同一個 localDateKey 內，方便測試不用擔心時區邊界
const NOON_TAIPEI = (y, m, d) => Date.UTC(y, m - 1, d, 4, 0);

test('logGame only bumps games, never reviewed', () => {
  stored.clear();
  logGame(NOON_TAIPEI(2026, 8, 20));
  logGame(NOON_TAIPEI(2026, 8, 20));
  const day = loadDailyLog().days['2026-08-20'];
  assert.equal(day.games, 2);
  assert.equal(day.reviewed, 0);
});

test('addActiveSeconds accumulates seconds on the same day', () => {
  stored.clear();
  addActiveSeconds(15, NOON_TAIPEI(2026, 8, 20));
  addActiveSeconds(15, NOON_TAIPEI(2026, 8, 20));
  addActiveSeconds(0, NOON_TAIPEI(2026, 8, 20)); // 0 秒不寫
  const day = loadDailyLog().days['2026-08-20'];
  assert.equal(day.seconds, 30);
});

test('streakDays counts a games-only day as "came" (no SRS grading needed)', () => {
  const days = {
    '2026-08-18': { reviewed: 3, games: 0 },
    '2026-08-19': { reviewed: 0, games: 1 }, // 只玩遊戲，沒評分
    '2026-08-20': { reviewed: 0, games: 1 },
  };
  assert.equal(streakDays(days, NOON_TAIPEI(2026, 8, 20)), 3);
});

test('streakDays still breaks on a day with neither reviewed nor games', () => {
  const days = {
    '2026-08-18': { reviewed: 2, games: 0 },
    // 2026-08-19 完全空白
    '2026-08-20': { reviewed: 1, games: 0 },
  };
  assert.equal(streakDays(days, NOON_TAIPEI(2026, 8, 20)), 1);
});

test('a games-only day does not affect maxDailyReviewed / totalReviewed achievement counters', () => {
  stored.clear();
  logGame(NOON_TAIPEI(2026, 8, 20));
  logGame(NOON_TAIPEI(2026, 8, 20));
  logGame(NOON_TAIPEI(2026, 8, 20));
  const ctx = buildAchievementCtx(loadDailyLog());
  assert.equal(ctx.maxDailyReviewed, 0);
  assert.equal(ctx.totalReviewed, 0);
  assert.equal(ctx.streak, 1); // 遊戲日仍然算「有來」
});

test('weekSummary: exactly one entry marks today, daysCame/reviewedTotal match injected log', () => {
  const now = NOON_TAIPEI(2026, 8, 20);
  const todayKey = localDateKey(now);

  // 先用空日誌取得這一週真正的 7 個日期 key，不用自己猜今天是週幾
  const empty = weekSummary({}, now);
  assert.equal(empty.days.length, 7);
  const todayEntries = empty.days.filter(d => d.key === todayKey);
  assert.equal(todayEntries.length, 1);

  const mondayKey = empty.days[0].key;
  const days = {
    [mondayKey]: { reviewed: 3, games: 0 },
    [todayKey]: { reviewed: 0, games: 1 },
  };
  const week = weekSummary(days, now);
  assert.equal(week.daysCame, mondayKey === todayKey ? 1 : 2);
  assert.equal(week.reviewedTotal, 3);
  const todayDay = week.days.find(d => d.key === todayKey);
  assert.equal(todayDay.came, true);
  assert.equal(todayDay.reviewed, mondayKey === todayKey ? 3 : 0);
});
