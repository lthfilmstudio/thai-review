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
  runStreakSettlement, settleStreakOnOpen, getProtectionCount, getMakeupPending,
  PROTECTION_MAX,
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
  logGame('listen', NOON_TAIPEI(2026, 8, 20));
  logGame('listen', NOON_TAIPEI(2026, 8, 20));
  const day = loadDailyLog().days['2026-08-20'];
  assert.equal(day.games, 2);
  assert.equal(day.reviewed, 0);
});

test('logGame records which game ids ran today, for per-task "done" state', () => {
  stored.clear();
  logGame('listen', NOON_TAIPEI(2026, 8, 20));
  logGame('combo', NOON_TAIPEI(2026, 8, 20));
  const day = loadDailyLog().days['2026-08-20'];
  assert.deepEqual(day.gameIds, ['listen', 'combo']);
  assert.equal(day.games, 2);
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
  logGame('listen', NOON_TAIPEI(2026, 8, 20));
  logGame('listen', NOON_TAIPEI(2026, 8, 20));
  logGame('listen', NOON_TAIPEI(2026, 8, 20));
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

/* ===== streak 結算：安神保護／補救／回補（設計書 6.1 節） ===== */

const TODAY = NOON_TAIPEI(2026, 8, 20);

test('D=0（昨天有來）：什麼都不做，protection 不變', () => {
  const log = { days: { '2026-08-19': { reviewed: 1, games: 0 } }, protection: 2 };
  const { log: out, event } = runStreakSettlement(log, TODAY);
  assert.deepEqual(event, { type: 'none' });
  assert.equal(out.protection, 2);
  assert.equal(out.makeupPending, null);
});

test('D=1，保護夠：自動消耗 1 個保護、蓋章昨天，streak 連得回去', () => {
  const log = {
    days: {
      '2026-08-17': { reviewed: 1, games: 0 },
      // 08-18 有來，08-19 斷一天（D=1），今天 08-20
    },
    protection: 2,
  };
  const daysWithHistory = { ...log.days, '2026-08-18': { reviewed: 1, games: 0 } };
  const { log: out, event } = runStreakSettlement({ ...log, days: daysWithHistory }, TODAY);
  assert.deepEqual(event, { type: 'protected', spent: 1 });
  assert.equal(out.protection, 1);
  assert.equal(out.days['2026-08-19'].bridged, true);
  assert.equal(out.makeupPending, null);
});

test('D=1，保護=0：進補救判定，streak 顯示為斷（不歸零舊資料）', () => {
  const log = {
    days: { '2026-08-18': { reviewed: 1, games: 0 } }, // 08-19 斷一天
    protection: 0,
  };
  const { log: out, event } = runStreakSettlement(log, TODAY);
  assert.deepEqual(event, { type: 'makeup-offered', missedDate: '2026-08-19' });
  assert.equal(out.makeupPending.missedDate, '2026-08-19');
  assert.equal(out.days['2026-08-19']?.bridged, undefined); // 還沒蓋章
  assert.equal(streakDays(out.days, TODAY), 0); // 顯示為斷
  assert.equal(out.protection, 0); // 沒有保護可扣，數量不變
});

test('D=2，保護剛好夠：連續 2 天都蓋章，不進補救', () => {
  const log = {
    days: { '2026-08-17': { reviewed: 1, games: 0 } }, // 08-18、08-19 都斷
    protection: 2,
  };
  const { log: out, event } = runStreakSettlement(log, TODAY);
  assert.deepEqual(event, { type: 'protected', spent: 2 });
  assert.equal(out.protection, 0);
  assert.equal(out.days['2026-08-18'].bridged, true);
  assert.equal(out.days['2026-08-19'].bridged, true);
});

test('D=2，保護=0：R>=2，streak 歸零，不提供補救', () => {
  const log = {
    days: { '2026-08-15': { reviewed: 1, games: 0 } }, // 08-18、08-19 斷 2 天
    protection: 0,
  };
  const { log: out, event } = runStreakSettlement(log, TODAY);
  assert.deepEqual(event, { type: 'reset' });
  assert.equal(out.makeupPending, null);
  assert.equal(streakDays(out.days, TODAY), 0);
});

test('D=3，保護=2：先扣光保護蓋最舊 2 天，剩下 1 天（=昨天）進補救——不重複計費', () => {
  const log = {
    days: { '2026-08-16': { reviewed: 1, games: 0 } }, // 08-17/08-18/08-19 斷 3 天
    protection: 2,
  };
  const { log: out, event } = runStreakSettlement(log, TODAY);
  assert.equal(out.protection, 0);
  assert.deepEqual(event, { type: 'makeup-offered', missedDate: '2026-08-19' });
  assert.equal(out.days['2026-08-17'].bridged, true);
  assert.equal(out.days['2026-08-18'].bridged, true);
  assert.equal(out.days['2026-08-19']?.bridged, undefined);
  // 已經用保護補掉的那兩天不會又被要求補做——makeupPending 只指向剩下那 1 天
  assert.equal(out.makeupPending.missedDate, '2026-08-19');
});

test('結算對同一天冪等：蓋過章的日子第二次結算不會再扣一次保護', () => {
  const log = {
    days: { '2026-08-18': { reviewed: 1, games: 0 } },
    protection: 2,
  };
  const first = runStreakSettlement(log, TODAY);
  assert.deepEqual(first.event, { type: 'protected', spent: 1 });
  assert.equal(first.log.protection, 1);

  const second = runStreakSettlement(first.log, TODAY);
  assert.deepEqual(second.event, { type: 'none' });
  assert.equal(second.log.protection, 1); // 沒有被再扣一次
});

test('安神保護回補：連續 7 天回補 1 個，上限 2', () => {
  const days = {};
  for (let i = 1; i <= 7; i++) {
    const d = new Date(TODAY);
    d.setDate(d.getDate() - i);
    days[localDateKey(d.getTime())] = { reviewed: 1, games: 0 };
  }
  const log = { days, protection: 0, protectionRefillCheckpoint: 0 };
  const { log: out } = runStreakSettlement(log, TODAY);
  assert.equal(streakDays(out.days, TODAY), 7);
  assert.equal(out.protection, 1);
  assert.equal(out.protectionRefillCheckpoint, 7);
});

test('安神保護回補上限 2，不會超補', () => {
  const days = {};
  for (let i = 1; i <= 21; i++) {
    const d = new Date(TODAY);
    d.setDate(d.getDate() - i);
    days[localDateKey(d.getTime())] = { reviewed: 1, games: 0 };
  }
  const log = { days, protection: 0, protectionRefillCheckpoint: 0 };
  const { log: out } = runStreakSettlement(log, TODAY);
  assert.equal(out.protection, PROTECTION_MAX);
});

test('streak 歸零後回補 checkpoint 也跟著歸零，不會卡住', () => {
  const log = {
    days: { '2026-08-15': { reviewed: 1, games: 0 } }, // D>=2，歸零
    protection: 0,
    protectionRefillCheckpoint: 14,
  };
  const { log: out } = runStreakSettlement(log, TODAY);
  assert.equal(out.protectionRefillCheckpoint, 0);
});

test('settleStreakOnOpen 會實際寫回 localStorage', () => {
  stored.clear();
  stored.set(DAILY_KEY, JSON.stringify({
    v: 1, backfilled: true,
    days: { '2026-08-18': { reviewed: 1, games: 0 } },
    protection: 2,
  }));
  const event = settleStreakOnOpen(TODAY);
  assert.equal(event.type, 'protected');
  assert.equal(getProtectionCount(), 1);
});

test('logGame 累積滿 2 局會自動完成補救：蓋章昨天、清掉 makeupPending', () => {
  stored.clear();
  stored.set(DAILY_KEY, JSON.stringify({
    v: 1, backfilled: true,
    days: { '2026-08-18': { reviewed: 1, games: 0 } }, // 08-19 斷一天
    protection: 0,
  }));
  settleStreakOnOpen(TODAY); // 產生 makeupPending: { missedDate: '2026-08-19' }
  assert.ok(getMakeupPending());

  logGame('listen', TODAY); // 第 1 局，還沒補完
  assert.ok(getMakeupPending());
  // 今天自己這 1 局照樣算「今天有來」(+1)，只是還沒連回 08-19 之前的舊 streak
  assert.equal(streakDays(loadDailyLog().days, TODAY), 1);

  logGame('combo', TODAY); // 第 2 局，補完
  assert.equal(getMakeupPending(), null);
  const log = loadDailyLog();
  assert.equal(log.days['2026-08-19'].bridged, true);
  // 補完後連回 08-18 之前的連續紀錄 + 今天，共 3 天
  assert.equal(streakDays(log.days, TODAY), 3);
});
