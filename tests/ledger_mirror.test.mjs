import assert from 'node:assert/strict';
import test from 'node:test';

const stored = new Map();
globalThis.localStorage = {
  getItem(key) { return stored.get(key) ?? null; },
  setItem(key, value) { stored.set(key, value); },
  removeItem(key) { stored.delete(key); },
};

const { reconcileLedgerMirror } = await import('../src/ledger-mirror.js');
const { loadDailyLog, dailyDays } = await import('../src/today.js');
const { loadResweepState, setResweepPosition } = await import('../src/resweep.js');
const { loadGradeHistory } = await import('../src/grade-history.js');

const CARD_A = '550e8400-e29b-41d4-a716-446655440000';

function daily(dayKey, fields) {
  return {
    workspaceId: 'user:A', name: `daily:${dayKey}`, schemaVersion: 1,
    projectorVersion: 'practice-daily-v1', dayKey,
    reviewed: 0, again: 0, hard: 0, good: 0, easy: 0, practice: 0, ...fields,
  };
}

test('把 daily 投影鏡射進本機日誌，重跑不重複加', () => {
  stored.clear();
  const projections = {
    'daily:2026-08-24': daily('2026-08-24', { reviewed: 2, good: 2 }),
    'daily:2026-08-25': daily('2026-08-25', { practice: 3 }),
  };
  const first = reconcileLedgerMirror({ projections });
  assert.equal(first.days, 2);

  const second = reconcileLedgerMirror({ projections });
  assert.equal(second.days, 0, '沒變就不重寫');

  const days = loadDailyLog().days;
  assert.equal(days['2026-08-24'].ledger.reviewed, 2);
  assert.equal(days['2026-08-25'].ledger.practice, 3);
  assert.equal(dailyDays()['2026-08-24'].reviewed, 2);
});

test('鏡射落後時直接收斂到權威快照，不是疊加', () => {
  stored.clear();
  reconcileLedgerMirror({ projections: { 'daily:2026-08-24': daily('2026-08-24', { reviewed: 1, good: 1 }) } });
  // commit 又前進了，鏡射前當掉，重開再跑一次
  reconcileLedgerMirror({ projections: { 'daily:2026-08-24': daily('2026-08-24', { reviewed: 3, good: 2, easy: 1 }) } });
  assert.deepEqual(loadDailyLog().days['2026-08-24'].ledger, {
    reviewed: 3, again: 0, hard: 0, good: 2, easy: 1, practice: 0,
  });
});

test('resweep 游標只往前，不把本機推回去', () => {
  stored.clear();
  const at = position => ({
    workspaceId: 'user:A', name: 'resweep', schemaVersion: 1,
    projectorVersion: 'practice-resweep-v1', position,
  });

  assert.equal(reconcileLedgerMirror({ projections: { resweep: at(5) } }).resweep, 1);
  assert.equal(loadResweepState().position, 5);

  setResweepPosition(9); // 例如 cloud-sync 合併後推得更前面
  assert.equal(reconcileLedgerMirror({ projections: { resweep: at(5) } }).resweep, 0);
  assert.equal(loadResweepState().position, 9, '不得退回去讓掃過的卡重新冒出來');
});

test('history 靠 eventId 鏡射，重跑不重複記；認不出 cardId 就跳過', () => {
  stored.clear();
  const projections = {
    [`history:${CARD_A}`]: {
      workspaceId: 'user:A', name: `history:${CARD_A}`, schemaVersion: 1,
      projectorVersion: 'practice-history-v1', cardId: CARD_A,
      entries: [[2, 1_700_000_000, 'evt-a'], [1, 1_700_000_100, 'evt-b']],
    },
  };

  const noMap = reconcileLedgerMirror({ projections });
  assert.equal(noMap.historyCards, 0);
  assert.deepEqual(noMap.skipped, [`history:${CARD_A}`], '沒有對照表就不猜');

  const cardKeyById = new Map([[CARD_A, 'L1:สวัสดี']]);
  const first = reconcileLedgerMirror({ projections, cardKeyById });
  assert.equal(first.historyEntries, 2);
  assert.deepEqual(loadGradeHistory().cards['L1:สวัสดี'], [
    [2, 1_700_000_000, 'evt-a'], [1, 1_700_000_100, 'evt-b'],
  ]);

  const second = reconcileLedgerMirror({ projections, cardKeyById });
  assert.equal(second.historyEntries, 0);
  assert.equal(loadGradeHistory().cards['L1:สวัสดี'].length, 2);
});

test('沒有 eventId 的 history 列不鏡射——認不出重播就會愈記愈多', () => {
  stored.clear();
  const projections = {
    [`history:${CARD_A}`]: {
      workspaceId: 'user:A', name: `history:${CARD_A}`, schemaVersion: 1,
      cardId: CARD_A, entries: [[2, 1_700_000_000]],
    },
  };
  reconcileLedgerMirror({ projections, cardKeyById: new Map([[CARD_A, 'L1:a']]) });
  reconcileLedgerMirror({ projections, cardKeyById: new Map([[CARD_A, 'L1:a']]) });
  assert.equal(loadGradeHistory().cards['L1:a'], undefined);
});

test('認不得的投影名稱與 schemaVersion 一律跳過，不半套套用', () => {
  stored.clear();
  const summary = reconcileLedgerMirror({
    projections: {
      'daily:2026-08-24': { ...daily('2026-08-24', { reviewed: 9 }), schemaVersion: 2 },
      'achievements:v1': { workspaceId: 'user:A', name: 'achievements:v1', schemaVersion: 1 },
      resweep: { workspaceId: 'user:A', name: 'resweep', schemaVersion: 1, position: -1 },
    },
  });
  assert.deepEqual(summary.skipped.sort(), ['achievements:v1', 'daily:2026-08-24', 'resweep']);
  assert.equal(summary.days, 0);
  assert.equal(loadDailyLog().days['2026-08-24'], undefined);
});

test('沒有投影時是安全的 no-op', () => {
  stored.clear();
  assert.deepEqual(reconcileLedgerMirror({}), {
    days: 0, resweep: 0, historyCards: 0, historyEntries: 0, skipped: [],
  });
  assert.deepEqual(reconcileLedgerMirror({ projections: null }).days, 0);
});

test('hydration 給的陣列形式也收，名稱以 row.name 為準', () => {
  stored.clear();
  const summary = reconcileLedgerMirror({
    projections: [
      daily('2026-08-24', { reviewed: 2, good: 2 }),
      { workspaceId: 'user:A', schemaVersion: 1, reviewed: 9 }, // 沒有 name，跳過
      daily('2026-08-25', { practice: 1 }),
    ],
  });
  assert.equal(summary.days, 2);
  assert.equal(loadDailyLog().days['2026-08-24'].ledger.reviewed, 2);
  assert.equal(loadDailyLog().days['2026-08-25'].ledger.practice, 1);
});
