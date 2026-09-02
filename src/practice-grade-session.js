/* 把 ledger runtime、practice-runtime 的分類器與評分 controller 組起來，交給 app.js
   一個「這次評分該怎麼走」的入口。

   本輪的三個語意決定（計畫書 KD4 沒有寫死，實作時定的）：

   - round／cycle：一次 buildDailyQueue（或進入 __ALL__）算一個 round，cycleOrdinal
     固定 1。本輪不做四軌 engine，沒有「第二圈」。retry 一律沿用 first claim 記下來的
     round／cycle，所以關掉重開產生新 round 不影響任何判定。
   - contextEpoch：只在「卡片／課程／模式／catalog digest 都沒變、但底下資料變了」時
     bump——佇列重建、cloud-sync 併入遠端進度。其餘欄位本來就各自在 token 裡。
   - __ALL__ 的 lane 由 IDB 的權威 SRS 判定；讀不到就這一筆退回 legacy，不猜。 */

import {
  buildPracticeRuntimeAttempt,
  capturePracticeOperation,
} from './practice-runtime.js';
import { createPracticeGradeController } from './practice-grade-controller.js';
import { commitPracticeAttempt, readPracticeDayContext } from './practice-commit.js';
import { applyLedgerCommitToMirror } from './ledger-mirror.js';

/* 本輪只接 __TODAY__。__ALL__ 的 lane 要靠權威 SRS 判定（classifyPracticeLane 會
   要求 authoritativeSrs.status === 'ready'），而那份資料在 IDB、要 async 讀，
   readContext() 是同步的。把整條 context 改成 async 會波及 controller；拿
   state.progress 當代理又正好是那道 gate 要擋的「用未稽核的資料判 lane」。兩個都
   不該草率決定，所以 __ALL__ 這輪維持 legacy。__TODAY__ 的 lane 來自佇列快照，
   不需要那道讀取。 */
const LEDGER_LESSONS = Object.freeze(['__TODAY__']);

export function ledgerGradeEligible(ledger, currentLessonId) {
  return ledger?.status === 'ready' && LEDGER_LESSONS.includes(currentLessonId);
}

export function createLedgerGradeSession({
  ledger,
  readContext,
  cardKeyById = null,
  storage = localStorage,
  deviceId,
  createId,
  now = () => Date.now(),
  advance,
  onStateChange = () => {},
  commit = commitPracticeAttempt,
  readDayContext = readPracticeDayContext,
} = {}) {
  let roundId = createId();
  let cycleId = createId();
  let contextEpoch = 0;

  const snapshot = () => {
    const ctx = readContext();
    return {
      ...ctx,
      runtimeContext: { roundId, cycleId, cycleOrdinal: 1 },
    };
  };

  const controller = createPracticeGradeController({
    buildAttempt: ({ existingContext, grade }) => {
      const ctx = snapshot();
      return buildPracticeRuntimeAttempt({
        currentLessonId: ctx.currentLessonId,
        card: ctx.card,
        cardKey: ctx.cardKey,
        todayLaneByCardKey: ctx.todayLaneByCardKey,
        authoritativeSrs: ctx.authoritativeSrs,
        grade: grade ?? ctx.grade,
        dayKey: ctx.dayKey,
        now: now(),
        existingContext,
        runtimeContext: ctx.runtimeContext,
        createId,
      });
    },
    captureOperation: () => {
      const ctx = snapshot();
      return capturePracticeOperation({
        workspaceId: ctx.workspaceId,
        workspaceGeneration: ctx.workspaceGeneration,
        cardId: ctx.cardId,
        currentLessonId: ctx.currentLessonId,
        mode: ctx.mode,
        contextEpoch,
        catalogDigest: ledger.catalogDigest,
        attemptId: ctx.attemptId ?? ctx.cardId,
      });
    },
    /* eventId 每次都新產生。「同一次作答不會變成兩筆」靠的不是重用 eventId，而是
       attemptPhaseClaims 的 [workspaceId, attemptId, phase]——交易其實成功了但
       promise 掛掉的重試會在那裡被攔下來走 replay。 */
    commit: ({ attempt }) => commit({
      port: ledger.port,
      workspaceId: readContext().workspaceId,
      attempt: {
        eventId: createId(),
        roundId: attempt.roundId,
        cycleId: attempt.cycleId,
        cycleOrdinal: attempt.cycleOrdinal,
        cardId: attempt.cardId,
        attemptId: attempt.attemptId,
        dayKey: attempt.dayKey,
        lane: attempt.lane,
        phase: attempt.phase,
        result: attempt.result,
        ...(attempt.formalGrade == null ? {} : { formalGrade: attempt.formalGrade }),
        ...(attempt.resweep ? { resweep: attempt.resweep } : {}),
      },
      now: now(),
      createId,
      deviceId,
    }),
    mirror: result => applyLedgerCommitToMirror(result, { cardKeyById, storage }),
    advance,
    onStateChange,
  });

  return {
    controller,
    /* 佇列重建、或 cloud-sync 併入遠端進度時呼叫：卡片與課程沒變，但底下的到期
       狀態變了，進行中的那筆評分不該把結果套到已經換過內容的畫面上。 */
    bumpContextEpoch() {
      contextEpoch += 1;
    },
    /* 新的一輪佇列 = 新的 round。 */
    startRound() {
      roundId = createId();
      cycleId = createId();
      contextEpoch += 1;
    },
    /* U6 的 controller 送出前要知道今天這張卡是不是已經有人評過。 */
    readDayContext(dayKey, cardId) {
      return readDayContext({
        port: ledger.port,
        workspaceId: readContext().workspaceId,
        dayKey,
        cardId,
      });
    },
    debugState: () => ({ roundId, cycleId, contextEpoch }),
  };
}
