import assert from 'node:assert/strict';
import test from 'node:test';

const stored = new Map();
globalThis.localStorage = {
  getItem(key) { return stored.get(key) ?? null; },
  setItem(key, value) { stored.set(key, value); },
  removeItem(key) { stored.delete(key); },
};

const {
  createLedgerGradeSession,
  ledgerCardEligible,
  ledgerGradeEligible,
} = await import('../src/practice-grade-session.js');
const { loadDailyLog } = await import('../src/today.js');

const CARD_A = '44444444-4444-4444-8444-444444444444';

test('只有 ledger ready 且身在 Today 才走 ledger（R1，__ALL__ 本輪未接）', () => {
  assert.equal(ledgerGradeEligible({ status: 'ready' }, '__TODAY__'), true);
  assert.equal(ledgerGradeEligible({ status: 'ready' }, '__ALL__'), false,
    '__ALL__ 的 lane 要非同步讀權威 SRS，本輪維持 legacy');
  assert.equal(ledgerGradeEligible({ status: 'ready' }, 'gid-123'), false, '單堂課走 legacy');
  assert.equal(ledgerGradeEligible({ status: 'blocked' }, '__TODAY__'), false);
  assert.equal(ledgerGradeEligible({ status: 'unavailable' }, '__TODAY__'), false);
  assert.equal(ledgerGradeEligible(null, '__TODAY__'), false);
});

function session(overrides = {}) {
  const calls = { commits: [], advances: [] };
  let seq = 0;
  const ids = () => {
    seq += 1;
    return `${seq}`.padStart(8, '0') + '-0000-4000-8000-000000000000';
  };
  const context = {
    workspaceId: 'user:A',
    workspaceGeneration: 0,
    currentLessonId: '__TODAY__',
    mode: 'srs',
    dayKey: '2026-08-24',
    cardId: CARD_A,
    cardKey: 'L1:one',
    card: { thai: 'one', card_id: CARD_A, _lessonId: 'L1', _cardKey: 'L1:one' },
    todayLaneByCardKey: new Map([['L1:one', 'due']]),
    authoritativeSrs: { status: 'ready', state: null },
    grade: 'good',
    ...overrides.context,
  };
  const handle = createLedgerGradeSession({
    ledger: { status: 'ready', catalogDigest: 'sha256:a', port: {} },
    readContext: () => context,
    deviceId: 'device-1',
    createId: ids,
    now: () => Date.parse('2026-08-24T10:00:00.000Z'),
    advance: r => calls.advances.push(r),
    commit: async input => {
      calls.commits.push(input);
      return {
        status: 'committed',
        event: { eventId: input.attempt.eventId, dayKey: input.attempt.dayKey },
        daily: {
          workspaceId: 'user:A', name: `daily:${input.attempt.dayKey}`, schemaVersion: 1,
          projectorVersion: 'practice-daily-v1', dayKey: input.attempt.dayKey,
          reviewed: 1, again: 0, hard: 0, good: 1, easy: 0, practice: 0,
        },
      };
    },
    ...overrides.session,
  });
  return { calls, context, handle };
}

test('Today Due first：lane 由佇列快照決定，formalGrade 帶得下去', async () => {
  stored.clear();
  const rig = session();
  const result = await rig.handle.controller.submitGrade('good');

  assert.equal(result.status, 'done');
  const attempt = rig.calls.commits[0].attempt;
  assert.equal(attempt.lane, 'due');
  assert.equal(attempt.phase, 'first');
  assert.equal(attempt.formalGrade, 'good');
  assert.equal(attempt.cardId, CARD_A);
  assert.equal(attempt.dayKey, '2026-08-24');
  assert.equal(attempt.cycleOrdinal, 1, '本輪不做第二圈');
  assert.equal(rig.calls.advances.length, 1);
  assert.equal(loadDailyLog().days['2026-08-24'].ledger.reviewed, 1, '成功後才鏡射');
});

test('Today Sweep 不帶 formalGrade（R5）', async () => {
  stored.clear();
  const rig = session({
    context: { todayLaneByCardKey: new Map([['L1:one', 'sweep']]) },
  });
  await rig.handle.controller.submitGrade('good');

  const attempt = rig.calls.commits[0].attempt;
  assert.equal(attempt.lane, 'sweep');
  assert.equal(Object.hasOwn(attempt, 'formalGrade'), false);
});

test('All 的 lane 由權威 SRS 判：到期是 due，沒排程是 sweep（session 未接，直接驗分類器）', async () => {
  stored.clear();
  const dueAt = Date.parse('2026-08-24T09:00:00.000Z');
  const overdue = session({
    context: {
      currentLessonId: '__ALL__',
      authoritativeSrs: { status: 'ready', state: { nextReviewAt: dueAt } },
    },
  });
  await overdue.handle.controller.submitGrade('good');
  assert.equal(overdue.calls.commits[0].attempt.lane, 'due');

  const unseen = session({
    context: { currentLessonId: '__ALL__', authoritativeSrs: { status: 'ready', state: null } },
  });
  await unseen.handle.controller.submitGrade('good');
  assert.equal(unseen.calls.commits[0].attempt.lane, 'sweep');
});

test('All 的權威 SRS 沒 ready 就不送出，交回 legacy 處理', async () => {
  stored.clear();
  const rig = session({
    context: {
      currentLessonId: '__ALL__',
      authoritativeSrs: { status: 'missing', state: null },
    },
  });
  const result = await rig.handle.controller.submitGrade('good');
  assert.equal(result.status, 'context-invalid');
  assert.equal(result.error.code, 'PRACTICE_BASELINE_NOT_READY');
  assert.equal(rig.calls.commits.length, 0, '不猜 lane，一筆都不送');
  assert.equal(rig.calls.advances.length, 0);
});

test('每筆評分都有自己的 eventId，round／cycle 在同一輪內不變', async () => {
  stored.clear();
  const rig = session();
  await rig.handle.controller.submitGrade('good');
  await rig.handle.controller.submitGrade('good');

  const [a, b] = rig.calls.commits.map(c => c.attempt);
  assert.notEqual(a.eventId, b.eventId);
  assert.equal(a.roundId, b.roundId);
  assert.equal(a.cycleId, b.cycleId);
});

test('startRound 換新 round 並 bump epoch；bumpContextEpoch 只動 epoch', async () => {
  const rig = session();
  const before = rig.handle.debugState();

  rig.handle.bumpContextEpoch();
  const bumped = rig.handle.debugState();
  assert.equal(bumped.roundId, before.roundId, '只是底下資料變了，不是新的一輪');
  assert.equal(bumped.contextEpoch, before.contextEpoch + 1);

  rig.handle.startRound();
  const rounded = rig.handle.debugState();
  assert.notEqual(rounded.roundId, before.roundId);
  assert.notEqual(rounded.cycleId, before.cycleId);
  assert.equal(rounded.contextEpoch, bumped.contextEpoch + 1);
});

test('AE7：送出後 epoch 被 bump，結果不套用也不前進', async () => {
  stored.clear();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const rig = session({
    session: {
      commit: async () => {
        await gate;
        return { status: 'committed', event: { eventId: 'e', dayKey: '2026-08-24' } };
      },
    },
  });

  const pending = rig.handle.controller.submitGrade('good');
  rig.handle.bumpContextEpoch(); // 例如 cloud-sync 併入了遠端進度
  release();
  const result = await pending;

  assert.equal(result.status, 'stale-operation');
  assert.equal(rig.calls.advances.length, 0);
  assert.equal(loadDailyLog().days?.['2026-08-24'], undefined, '不把結果套到已經變了的畫面');
});

/* ===== 逐卡閘門（P0-1）=====
   認領失敗的卡沒有權威 SRS 列，硬走帳本會被拿空狀態當基準重算，把累積數月的
   interval 重設成 1 再推上雲端。真實資料裡 12968 個 alias 只認得出 94 個。 */

const OLD_STAMP = 1_780_000_000_000;
const NEW_STAMP = 1_790_000_000_000;
const srs = (interval, updatedAt) => ({
  grade: 'good', interval, reps: 5, easeFactor: 2.6,
  reviewedAt: updatedAt, nextReviewAt: updatedAt, updatedAt,
});

test('P0-1：認領失敗又有本機進度的卡，一律不走帳本', () => {
  assert.equal(
    ledgerCardEligible({ authoritativeSrs: null, legacyProgress: srs(64, OLD_STAMP) }),
    false,
    '這正是會把 interval 64 重設成 1 的那種',
  );
});

test('全新的卡（本機也沒進度）可以走帳本——空狀態本來就是對的起點', () => {
  assert.equal(ledgerCardEligible({ authoritativeSrs: null, legacyProgress: null }), true);
});

test('有權威列而且不比本機舊 → 收', () => {
  assert.equal(
    ledgerCardEligible({ authoritativeSrs: srs(30, NEW_STAMP), legacyProgress: srs(30, OLD_STAMP) }),
    true,
  );
  assert.equal(
    ledgerCardEligible({ authoritativeSrs: srs(30, OLD_STAMP), legacyProgress: srs(30, OLD_STAMP) }),
    true,
    '一樣新也算數',
  );
  assert.equal(ledgerCardEligible({ authoritativeSrs: srs(30, OLD_STAMP), legacyProgress: null }), true);
});

test('P0-2：權威列比本機舊 → 不收，避免排程回捲', () => {
  // 使用者在單堂課或別台裝置評過，帳本還沒跟上
  assert.equal(
    ledgerCardEligible({ authoritativeSrs: srs(3, OLD_STAMP), legacyProgress: srs(50, NEW_STAMP) }),
    false,
  );
});

test('session 的 acceptsCard 用開機帶進來的權威列判斷', () => {
  const rig = session({
    session: {
      authoritativeSrsRows: [
        { cardId: CARD_A, version: 2, state: srs(30, NEW_STAMP) },
      ],
    },
  });
  assert.equal(rig.handle.authoritativeCardCount(), 1);
  assert.equal(rig.handle.acceptsCard(CARD_A, srs(30, OLD_STAMP)), true);
  assert.equal(rig.handle.acceptsCard(CARD_A, srs(50, NEW_STAMP + 1)), false, '本機較新就不收');
  assert.equal(rig.handle.acceptsCard('unknown-card', srs(64, OLD_STAMP)), false, '認領失敗的不收');
  assert.equal(rig.handle.acceptsCard('unknown-card', null), true, '全新的卡收');
});

test('commit 成功後權威快取跟著更新，下次仍然收得下', async () => {
  stored.clear();
  const rig = session({
    session: { authoritativeSrsRows: [{ cardId: CARD_A, version: 1, state: srs(10, OLD_STAMP) }] },
  });
  await rig.handle.controller.submitGrade('good');
  // commit 的 mirror 步驟把新的 after-state 記進快取；本機那份也會被 app 同步寫成
  // 同一個值，所以下一輪仍然 eligible
  assert.equal(rig.handle.acceptsCard(CARD_A, srs(10, OLD_STAMP)), true);
});
