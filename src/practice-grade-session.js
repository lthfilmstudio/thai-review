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
import { progressStamp } from './cloud-merge.js';

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

/* 逐卡閘門。整份 catalog 開不開放是一回事，這張卡能不能安全地走帳本是另一回事。

   帳本把 IDB 的 srsV2 當權威：commitPracticeAttempt 讀不到那一列就拿空狀態算下一次
   到期。認領失敗（lineage 認不出這個 alias）的卡沒有那一列，硬走帳本就會把使用者
   累積數月的 interval 重設成 1，再經 LWW 推上雲端擴散。所以：

   - 有權威列、而且不比本機那份舊 → 收。帳本確實掌握這張卡最新的狀態。
   - 有權威列但比本機舊 → 不收。使用者在單堂課或別台裝置評過、帳本還沒跟上，
     用舊的當基準算出來的排程會回捲。
   - 沒有權威列，本機也沒有進度 → 收。全新的卡，空狀態本來就是對的起點。
   - 沒有權威列、本機卻有進度 → 不收。這正是會毀資料的那種，一律留給 legacy。 */
export function ledgerCardEligible({ authoritativeSrs = null, legacyProgress = null } = {}) {
  if (!authoritativeSrs) return !legacyProgress;
  if (!legacyProgress) return true;
  return progressStamp(authoritativeSrs) >= progressStamp(legacyProgress);
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
  authoritativeSrsRows = null,
} = {}) {
  let roundId = createId();
  let cycleId = createId();
  let contextEpoch = 0;
  /* cardId → 這張卡在 IDB 的權威 SRS state。開機由 hydration 帶進來，每次 commit
     成功後更新。逐卡閘門靠它做同步判斷，不必為了一次評分去 await 一個 IDB 讀。 */
  const authoritativeByCardId = new Map(
    (authoritativeSrsRows || [])
      .filter(row => row && typeof row.cardId === 'string' && row.state)
      .map(row => [row.cardId, structuredClone(row.state)]),
  );

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
    mirror: result => {
      // 交易已經落地，這張卡的權威狀態換人了；逐卡閘門下次才判得準。
      if (result?.srs && result.event?.cardId) {
        authoritativeByCardId.set(result.event.cardId, structuredClone(result.srs));
      }
      return applyLedgerCommitToMirror(result, { cardKeyById, storage });
    },
    advance,
    onStateChange,
  });

  return {
    controller,
    /* 這張卡這次能不能走帳本。呼叫端在送出前問一次，不行就走 legacy。 */
    acceptsCard(cardId, legacyProgress) {
      return ledgerCardEligible({
        authoritativeSrs: authoritativeByCardId.get(cardId) || null,
        legacyProgress: legacyProgress || null,
      });
    },
    authoritativeCardCount: () => authoritativeByCardId.size,
    /* 重置之後一定要呼叫。IDB 的權威列被清光了，這份記憶體快取要是還留著舊值，
       逐卡閘門會拿它跟本機比而放行，然後 commitPracticeAttempt 讀 IDB 讀到空的、
       拿空狀態當基準重算——interval 直接塌成 1，再鏡射回本機推上雲端。
       清掉之後那張卡會退回 legacy（本機那筆才是對的），不會毀資料。 */
    clearAuthoritative() {
      authoritativeByCardId.clear();
    },
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
