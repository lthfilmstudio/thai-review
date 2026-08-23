import assert from 'node:assert/strict';
import test from 'node:test';

const stored = new Map();
globalThis.localStorage = {
  getItem(key) { return stored.get(key) ?? null; },
  setItem(key, value) { stored.set(key, value); },
  removeItem(key) { stored.delete(key); },
};

const toastElements = new Map();
globalThis.document = {
  getElementById(id) { return toastElements.get(id); },
  createElement() {
    return {
      classList: { add() {}, remove() {} },
      id: '', className: '', textContent: '',
    };
  },
  body: {
    appendChild(el) { toastElements.set(el.id, el); },
  },
};

const {
  DAILY_KEY, initDailyLog, loadDailyLog, logReview,
  logGame, addActiveSeconds, streakDays, weekSummary, buildAchievementCtx,
  runStreakSettlement, settleStreakOnOpen, getProtectionCount, getMakeupPending,
  PROTECTION_MAX, notifyAchievements, renderAchievementsHtml, buildDailyQueue,
  saveRemoteDays, dailyDays,
} = await import('../src/today.js');
const { localDateKey } = await import('../src/state.js');
const { loadResweepState, advanceResweepCursor } = await import('../src/resweep.js');

function queueCard(lessonId, thai, zh = thai) {
  return { thai, zh, _lessonId: lessonId, _cardKey: `${lessonId}:${thai}` };
}

test('localDateKey always uses Taipei date', () => {
  // 2026-08-18 23:30 UTC is 2026-08-19 07:30 in Taipei.
  assert.equal(localDateKey(Date.UTC(2026, 7, 18, 23, 30)), '2026-08-19');
});

test('notifyAchievements handles extra messages, combined messages, and no-op', () => {
  const ctx = { allLessonsLoaded: true, totalCards: 12 };

  toastElements.clear();
  notifyAchievements([], ctx, '這句你上次不會，現在會了。');
  assert.equal(toastElements.get('achvToast').textContent, '這句你上次不會，現在會了。');

  notifyAchievements([{ label: '連續 7 天' }], ctx, '這句你上次不會，現在會了。');
  assert.equal(toastElements.get('achvToast').textContent, '解鎖成就：連續 7 天\n這句你上次不會，現在會了。');

  toastElements.clear();
  notifyAchievements([], ctx);
  assert.equal(toastElements.has('achvToast'), false);
});

test('renderAchievementsHtml renders all badges with unlock state, count, and escaped titles', () => {
  stored.clear();
  stored.set('thai-review-achievements-v1', JSON.stringify({ streak7: 1 }));
  const html = renderAchievementsHtml({ allLessonsLoaded: true, totalCards: '<3&"' });
  assert.equal((html.match(/class="achv-badge/g) || []).length, 8);
  assert.equal((html.match(/<svg\b/g) || []).length, 8);
  assert.match(html, /class="achv-badge on"/);
  assert.match(html, /已解鎖 1\/8/);
  assert.match(html, /title="&lt;3&amp;&quot; 張全上手"/);
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
  // streak/週正確率跟「今天」有關，帶固定 now（跟上面寫死的日期同一天）
  // 才不會隨系統真實日期往前走而變動。
  const ctx = buildAchievementCtx(loadDailyLog(), NOON_TAIPEI(2026, 8, 20));
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

test('weekSummary counts completed dialogue games separately', () => {
  const now = NOON_TAIPEI(2026, 8, 20);
  const week = weekSummary({
    '2026-08-18': { reviewed: 0, games: 2, gameIds: ['dialog', 'dialog'] },
    '2026-08-20': { reviewed: 0, games: 1, gameIds: ['listen'] },
  }, now);
  assert.equal(week.dialoguesCompleted, 2);
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

/* ===== buildDailyQueue（設計書 docs/mastery-sprint-plan-2026-08.md） ===== */

test('buildDailyQueue pulls resweep cards for never-graded material even though they are not due', () => {
  stored.clear();
  const cards = [queueCard('L1', 'untouched1'), queueCard('L1', 'untouched2')];
  const progress = {}; // 都沒評過分，到期複習隊列是空的
  const lessons = [{ id: 'L1', cards: [] }];
  const { cards: queue, resweepKeys } = buildDailyQueue(cards, progress, lessons, 0);
  assert.equal(queue.length, 2);
  assert.equal(resweepKeys.size, 2);
});

test('buildDailyQueue does not duplicate a card that is both due and next in resweep order', () => {
  stored.clear();
  const now = Date.now();
  const cards = [queueCard('L1', 'dup'), queueCard('L1', 'fresh')];
  const progress = { 'L1:dup': { nextReviewAt: now - 1000, interval: 1 } }; // due；fresh 從沒評過
  const lessons = [{ id: 'L1', cards: [] }];
  const { cards: queue, resweepKeys } = buildDailyQueue(cards, progress, lessons, 0);
  const keys = queue.map(c => c._cardKey);
  assert.equal(keys.filter(k => k === 'L1:dup').length, 1);
  assert.ok(resweepKeys.has('L1:dup')); // Due 同時完成 Sweep，仍只顯示一次
});

test('buildDailyQueue shows a Due cursor card once and marks it as confirmed resweep evidence', () => {
  stored.clear();
  const cards = [
    queueCard('L1', 'earlier'),
    queueCard('L1', 'later'),
  ];
  const lessons = [{ id: 'L1', cards: [] }];
  const dueProgress = {
    'L1:earlier': { nextReviewAt: Date.now() - 1000, interval: 1 },
  };

  const dueRound = buildDailyQueue(cards, dueProgress, lessons, 0);
  assert.deepEqual([...dueRound.resweepKeys], ['L1:earlier']);
  assert.equal(dueRound.cards.filter(c => c._cardKey === 'L1:earlier').length, 1);
  assert.equal(loadResweepState().position, 0);

  // The existing app advances only after confirming a key in resweepKeys.
  // That one confirmation moves to the later card; it is not repeated.
  advanceResweepCursor(1, cards.length);
  const nextRound = buildDailyQueue(cards, {}, lessons, 0);
  assert.equal(nextRound.cards[0]._cardKey, 'L1:later');
  assert.deepEqual([...nextRound.resweepKeys], ['L1:later']);
});

test('buildDailyQueue keeps resweep order ahead of interleave so an earlier card cannot be skipped', () => {
  stored.clear();
  const cards = [
    queueCard('L1', 'earlier'),
    queueCard('L2', 'later'),
    queueCard('L1', 'due'),
  ];
  const progress = {
    'L1:due': { nextReviewAt: Date.now() - 1000, interval: 1 },
  };
  const lessons = [{ id: 'L1', cards: [] }, { id: 'L2', cards: [] }];

  const round = buildDailyQueue(cards, progress, lessons, 0);
  assert.deepEqual(round.cards.map(c => c._cardKey), ['L1:due', 'L1:earlier', 'L2:later']);
  assert.deepEqual([...round.resweepKeys], ['L1:earlier', 'L2:later']);

  // This is the only safe cursor movement the existing app API can express:
  // the first resweep card was the one actually presented and confirmed.
  advanceResweepCursor(1, cards.length);
  assert.equal(loadResweepState().position, 1);
  const following = buildDailyQueue(cards, progress, lessons, 0);
  assert.equal(following.resweepKeys.has('L2:later'), true);
  assert.equal(following.cards.find(c => following.resweepKeys.has(c._cardKey))._cardKey, 'L2:later');
});

test('buildDailyQueue blocks a legacy key collision instead of advancing past it', () => {
  stored.clear();
  const duplicateA = queueCard('L1', 'same');
  const duplicateB = queueCard('L1', 'same');
  const later = queueCard('L2', 'later');
  const cards = [duplicateA, duplicateB, later];
  const lessons = [{ id: 'L1', cards: [] }, { id: 'L2', cards: [] }];
  const progress = {};

  const round = buildDailyQueue(cards, progress, lessons, 0);
  assert.equal(round.resweepKeys.size, 0);
  assert.equal(loadResweepState().position, 0);
  assert.equal(round.resweepKeys.has('L2:later'), false);
});

test('buildDailyQueue resweep portion continues from the persisted cursor position', () => {
  stored.clear();
  const cards = [queueCard('L1', 'x1'), queueCard('L1', 'x2'), queueCard('L1', 'x3')];
  const progress = {};
  const lessons = [{ id: 'L1', cards: [] }];
  advanceResweepCursor(1, cards.length); // 假裝 x1 已經掃過
  const { cards: queue } = buildDailyQueue(cards, progress, lessons, 0);
  assert.deepEqual(queue.map(c => c.thai), ['x2', 'x3']);
});

test('buildDailyQueue interleaves lessons so the same lesson does not run unbroken when another lesson has cards ready', () => {
  stored.clear();
  const now = Date.now();
  const cards = [
    queueCard('L1', 'a1'), queueCard('L1', 'a2'), queueCard('L1', 'a3'),
    queueCard('L2', 'b1'),
  ];
  const progress = {};
  for (const c of cards) progress[c._cardKey] = { nextReviewAt: now - 1000, interval: 1 };
  const lessons = [{ id: 'L1', cards: [] }, { id: 'L2', cards: [] }];
  const { cards: queue } = buildDailyQueue(cards, progress, lessons, 0);
  const seq = queue.map(c => c._lessonId);
  let run = 1, maxRun = 1;
  for (let i = 1; i < seq.length; i++) {
    run = seq[i] === seq[i - 1] ? run + 1 : 1;
    maxRun = Math.max(maxRun, run);
  }
  assert.ok(maxRun <= 2, `expected no long same-lesson run, got ${seq.join(',')}`);
});

test('buildDailyQueue returns fewer cards once today\'s time budget is already spent, but never zero', () => {
  stored.clear();
  const now = Date.now();
  const cards = [];
  const progress = {};
  for (let i = 0; i < 300; i++) {
    const c = queueCard('L1', `w${i}`);
    cards.push(c);
    progress[c._cardKey] = { nextReviewAt: now - 1000, interval: 1 };
  }
  const lessons = [{ id: 'L1', cards: [] }];
  const fresh = buildDailyQueue(cards, progress, lessons, 0).cards.length;
  const spent = buildDailyQueue(cards, progress, lessons, 999999).cards.length;
  assert.ok(fresh > spent, `expected fresh budget to yield more cards (${fresh} vs ${spent})`);
  assert.ok(spent > 0, '就算今天預算已經用完，保底時間也該回傳非空隊列');
});

/* ===== Phase B：跨裝置合併對日誌／結算的影響 ===== */

test('別台裝置的出席紀錄併進來後，連續天數變長（這才是同步要解的痛點）', () => {
  localStorage.removeItem(DAILY_KEY);
  localStorage.removeItem('thai-review-remote-days-v1');
  const now = NOON_TAIPEI(2026, 8, 22);
  logReview('good', now);                                    // 只有今天在這台複習過
  assert.equal(streakDays(dailyDays(), now), 1);

  saveRemoteDays({                                           // 手機上前兩天有複習
    '2026-08-21': { reviewed: 5 },
    '2026-08-20': { reviewed: 3 },
  });
  assert.equal(streakDays(dailyDays(), now), 3);
  localStorage.removeItem('thai-review-remote-days-v1');
});

test('自己那份 days 不會被合併結果污染（推上去才不會重複計數）', () => {
  localStorage.removeItem(DAILY_KEY);
  const now = NOON_TAIPEI(2026, 8, 22);
  logReview('good', now);
  saveRemoteDays({ '2026-08-22': { reviewed: 99 } });

  assert.equal(dailyDays()['2026-08-22'].reviewed, 100, '顯示值要含別台的');
  assert.equal(loadDailyLog().days['2026-08-22'].reviewed, 1, '自己那份只能有 1');
  localStorage.removeItem('thai-review-remote-days-v1');
});

test('合併別台的出席紀錄後結算不會誤扣安神保護', () => {
  localStorage.removeItem(DAILY_KEY);
  const now = NOON_TAIPEI(2026, 8, 22);
  // 這台從 8/19 之後就沒用過，看起來斷了兩天
  const log = { v: 1, backfilled: true, days: { '2026-08-19': { reviewed: 4 } }, protection: 2 };
  localStorage.setItem(DAILY_KEY, JSON.stringify(log));

  // 但那兩天其實是在手機上複習的
  const remote = { '2026-08-20': { reviewed: 6 }, '2026-08-21': { reviewed: 5 } };
  const { log: settled, event } = runStreakSettlement(loadDailyLog(), now, remote);

  assert.equal(event.type, 'none', '別台有來就不算缺口');
  assert.equal(settled.protection, 2, '保護不該被扣掉');
  localStorage.removeItem('thai-review-remote-days-v1');
});

test('真的斷線時仍照常扣保護（確認上一個測試不是把功能關掉了）', () => {
  localStorage.removeItem(DAILY_KEY);
  const now = NOON_TAIPEI(2026, 8, 22);
  const log = { v: 1, backfilled: true, days: { '2026-08-20': { reviewed: 4 } }, protection: 2 };
  localStorage.setItem(DAILY_KEY, JSON.stringify(log));
  const { log: settled, event } = runStreakSettlement(loadDailyLog(), now, {});
  assert.equal(event.type, 'protected');
  assert.equal(settled.protection, 1);
});

test('沒有 remote 資料時 dailyDays 等同原本的 log.days（未登入回歸）', () => {
  localStorage.removeItem(DAILY_KEY);
  localStorage.removeItem('thai-review-remote-days-v1');
  logReview('good', NOON_TAIPEI(2026, 8, 22));
  assert.deepEqual(dailyDays(), loadDailyLog().days);
});
