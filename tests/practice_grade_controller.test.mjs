import assert from 'node:assert/strict';
import test from 'node:test';

const { createPracticeGradeController } = await import('../src/practice-grade-controller.js');

const OPERATION = Object.freeze({
  workspaceId: 'user:A',
  workspaceGeneration: 0,
  cardId: '44444444-4444-4444-8444-444444444444',
  currentLessonId: '__TODAY__',
  mode: 'cards',
  contextEpoch: 0,
  catalogDigest: 'sha256:a',
  attemptId: '55555555-5555-4555-8555-555555555555',
});

/* overrides 只換「行為」，記錄呼叫那層永遠由 harness 包在外面——直接覆蓋
   commit 會把 calls.commits 一起蓋掉，測試就變成在量自己的假資料。 */
function harness({ commit, mirror, advance, buildAttempt } = {}) {
  const calls = { commits: [], mirrors: [], advances: [], states: [] };
  let operation = { ...OPERATION };
  let attemptSeq = 0;
  const defaultBuild = ({ existingContext }) => {
    attemptSeq += 1;
    return {
      kind: 'attempt',
      seq: attemptSeq,
      phase: existingContext ? 'retry-1' : 'first',
      lane: existingContext?.lane || 'due',
      attemptId: existingContext?.attemptId || OPERATION.attemptId,
    };
  };
  const defaultCommit = async input => ({
    status: 'committed', event: { eventId: `evt-${input.attempt.seq}` },
  });
  return {
    calls,
    setOperation: patch => { operation = { ...operation, ...patch }; },
    controller: createPracticeGradeController({
      buildAttempt: buildAttempt || defaultBuild,
      captureOperation: () => ({ ...operation }),
      commit: async input => {
        calls.commits.push(input);
        return (commit || defaultCommit)(input);
      },
      mirror: async result => {
        calls.mirrors.push(result);
        if (mirror) await mirror(result);
      },
      advance: result => {
        calls.advances.push(result);
        if (advance) advance(result);
      },
      onStateChange: s => { calls.states.push(s.status); },
    }),
  };
}

test('click 與鍵盤同時觸發：CAS guard 只放行一筆', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const rig = harness({
    commit: async input => {
      await gate;
      return { status: 'committed', event: { eventId: 'evt-1' }, attempt: input.attempt };
    },
  });

  // 兩筆都先發出去再放行 gate：guard 拿掉的話這裡不會卡死，會是「送出兩筆」的紅燈。
  const first = rig.controller.submitGrade('good');
  const second = rig.controller.submitGrade('good');
  assert.equal(rig.controller.isLocked(), true);
  release();
  const [a, b] = await Promise.all([first, second]);

  assert.deepEqual(b, { status: 'busy' }, '第二筆被擋掉，不送出');
  assert.equal(rig.calls.commits.length, 1, '同一次作答只准送一筆交易');
  assert.equal(a.status, 'done');
  assert.equal(rig.controller.isLocked(), false);
});

test('saving 期間 isLocked 為真，UI 據此擋掉換卡換課', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const rig = harness({ commit: async () => { await gate; return { status: 'committed' }; } });

  assert.equal(rig.controller.isLocked(), false);
  const pending = rig.controller.submitGrade('good');
  assert.equal(rig.controller.getStatus(), 'saving');
  assert.equal(rig.controller.isLocked(), true);
  release();
  await pending;
  assert.equal(rig.controller.isLocked(), false);
});

test('交易失敗：不鏡射、不前進，用同一個 attempt 重試', async () => {
  let attempts = 0;
  const rig = harness({
    commit: async input => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error('quota'), { code: 'PRACTICE_DB_REQUEST_FAILED' });
      return { status: 'committed', attempt: input.attempt };
    },
  });

  const failed = await rig.controller.submitGrade('good');
  assert.equal(failed.status, 'save-failed');
  assert.equal(rig.controller.getStatus(), 'save-failed');
  assert.equal(rig.calls.mirrors.length, 0);
  assert.equal(rig.calls.advances.length, 0);
  assert.equal(rig.controller.isLocked(), true, '失敗期間一樣不准換卡');

  const retried = await rig.controller.retry();
  assert.equal(retried.status, 'done');
  assert.equal(rig.calls.commits.length, 2);
  assert.equal(
    rig.calls.commits[0].attempt.seq,
    rig.calls.commits[1].attempt.seq,
    '重試沿用同一個 attempt，不能變成兩筆作答',
  );
});

test('鏡射失敗進 projection-repair，重試只重跑鏡射不重送交易', async () => {
  let mirrors = 0;
  const rig = harness({
    mirror: async () => {
      mirrors += 1;
      if (mirrors === 1) throw new Error('localStorage full');
    },
  });

  const first = await rig.controller.submitGrade('good');
  assert.equal(first.status, 'projection-repair');
  assert.equal(rig.calls.commits.length, 1);
  assert.equal(rig.calls.advances.length, 0, '沒鏡射成功就不前進');
  assert.equal(mirrors, 1);

  const repaired = await rig.controller.repairProjection();
  assert.equal(repaired.status, 'done');
  assert.equal(rig.calls.commits.length, 1, '交易絕不重送');
  assert.equal(mirrors, 2);
  assert.equal(rig.calls.advances.length, 1);
});

test('AE7：背景換掉 catalog，回來的結果不套用也不前進', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const rig = harness({ commit: async () => { await gate; return { status: 'committed' }; } });

  const pending = rig.controller.submitGrade('good');
  rig.setOperation({ catalogDigest: 'sha256:b' }); // 背景刷新 catalog
  release();
  const result = await pending;

  assert.equal(result.status, 'stale-operation');
  assert.equal(rig.calls.mirrors.length, 0, '不把結果套到已經不是那張的卡上');
  assert.equal(rig.calls.advances.length, 0);
  assert.equal(rig.controller.getStatus(), 'idle', '解鎖讓使用者繼續操作');
});

test('AE7：saving 中切帳號，同樣不套用', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const rig = harness({ commit: async () => { await gate; return { status: 'committed' }; } });
  const pending = rig.controller.submitGrade('good');
  rig.setOperation({ workspaceId: 'user:B', workspaceGeneration: 1 });
  release();
  assert.equal((await pending).status, 'stale-operation');
  assert.equal(rig.calls.advances.length, 0);
});

test('AE3：被另一個入口搶走 claim 時，拿它的 context 補送一次 retry', async () => {
  const rig = harness({
    commit: async input => {
      if (input.attempt.phase === 'first') {
        return {
          status: 'daily-card-already-claimed',
          context: {
            phases: ['first'], lane: 'sweep',
            roundId: 'r', cycleId: 'c', cycleOrdinal: 1, attemptId: 'winner-attempt',
          },
        };
      }
      return { status: 'committed', attempt: input.attempt };
    },
  });

  const result = await rig.controller.submitGrade('good');
  assert.equal(result.status, 'done');
  assert.equal(rig.calls.commits.length, 2);
  assert.equal(rig.calls.commits[1].attempt.phase, 'retry-1');
  assert.equal(rig.calls.commits[1].attempt.attemptId, 'winner-attempt', '沿用 first 的 attempt');
  assert.equal(rig.calls.advances.length, 1);
});

test('補送的那筆還是被擋：不再無限互搶，解鎖交還使用者', async () => {
  const rig = harness({
    commit: async () => ({
      status: 'daily-card-already-claimed',
      context: {
        phases: ['first'], lane: 'due', roundId: 'r', cycleId: 'c',
        cycleOrdinal: 1, attemptId: 'winner',
      },
    }),
  });
  const result = await rig.controller.submitGrade('good');
  assert.equal(result.status, 'daily-card-already-claimed');
  assert.equal(rig.calls.commits.length, 2, '只補送一次');
  assert.equal(rig.calls.advances.length, 0);
  assert.equal(rig.controller.getStatus(), 'idle');
});

test('retry-limit 不送出交易', async () => {
  const rig = harness({
    buildAttempt: () => ({ kind: 'retry-limit', cardId: OPERATION.cardId }),
  });
  const result = await rig.controller.submitGrade('good');
  assert.equal(result.status, 'retry-limit');
  assert.equal(rig.calls.commits.length, 0);
  assert.equal(rig.controller.getStatus(), 'idle');
});

test('already-committed 走跟 committed 一樣的鏡射與前進', async () => {
  const rig = harness({ commit: async () => ({ status: 'already-committed', event: { eventId: 'e' } }) });
  const result = await rig.controller.submitGrade('good');
  assert.equal(result.status, 'done');
  assert.equal(rig.calls.mirrors.length, 1);
  assert.equal(rig.calls.advances.length, 1);
});

test('沒有 repair／retry 可做時是安全的 no-op', async () => {
  const rig = harness();
  assert.deepEqual(await rig.controller.retry(), { status: 'nothing-to-retry' });
  assert.deepEqual(await rig.controller.repairProjection(), { status: 'nothing-to-repair' });
  assert.equal(rig.calls.commits.length, 0);
});

test('缺 adapter 直接拒絕建立 controller', () => {
  assert.throws(() => createPracticeGradeController({}), { code: 'PRACTICE_CONTROLLER_INCOMPLETE' });
});
