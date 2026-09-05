/* Ledger-first 評分協調器。

   Today／All 的評分只從這裡進去，click 跟鍵盤共用同一個入口（KTD9）。核心是三件事：

   1. CAS pending guard：狀態不是 idle 就不收新的評分。double submit（連點、按鍵
      跟按鈕同時觸發）在這裡就被擋掉，不會送出兩筆。
   2. operation token：送出前拍一張 context 快照，交易回來後比對還是不是同一張卡、
      同一個 workspace、同一份 catalog。背景把 catalog 換掉或帳號切走的話，這筆
      結果就不套用——ledger 已經寫進去了，開機的 reconcile 會補鏡射（AE7）。
   3. ledger-first：交易成功才鏡射、才前進。失敗留在原卡，用同一個 attempt 重試
      （KD3）。鏡射失敗不重送交易，進 projection-repair 等重試。 */

import { operationStillCurrent } from './practice-runtime.js';

const CLAIM_BLOCKED = Object.freeze(new Set([
  'daily-card-already-claimed',
  'daily-lane-already-claimed',
]));
const COMMITTED = Object.freeze(new Set(['committed', 'already-committed']));

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requiredFunction(value, label) {
  if (typeof value !== 'function') {
    throw codedError('PRACTICE_CONTROLLER_INCOMPLETE', `${label} is required`);
  }
  return value;
}

export function createPracticeGradeController({
  buildAttempt,
  captureOperation,
  commit,
  mirror,
  advance,
  onStateChange = () => {},
} = {}) {
  const build = requiredFunction(buildAttempt, 'buildAttempt');
  const capture = requiredFunction(captureOperation, 'captureOperation');
  const commitAttempt = requiredFunction(commit, 'commit');
  const mirrorResult = requiredFunction(mirror, 'mirror');
  const advanceUi = requiredFunction(advance, 'advance');
  const emit = requiredFunction(onStateChange, 'onStateChange');

  let status = 'idle';
  // saving 期間任何人為的 context 變動都要擋掉；背景變動則是 bump epoch 讓
  // 已經在路上的那筆失效，而不是擋住使用者。
  let pendingRetry = null;
  let pendingRepair = null;

  const setStatus = next => {
    if (status === next) return;
    status = next;
    emit({ status, canRetry: !!pendingRetry, canRepair: !!pendingRepair });
  };

  async function runCommit(attempt, operation) {
    let result = await commitAttempt({ attempt, operation });
    // AE3：同日同卡被另一個入口（Today／All 另一個 tab）先認領走了，拿它的
    // context 重建成 retry-N 再送一次。只補送一次，避免無限互搶。
    if (CLAIM_BLOCKED.has(result?.status) && result.context) {
      const retryAttempt = build({ existingContext: result.context });
      if (!retryAttempt || retryAttempt.kind === 'retry-limit') {
        return { result, attempt, exhausted: true };
      }
      result = await commitAttempt({ attempt: retryAttempt, operation });
      return { result, attempt: retryAttempt, exhausted: false };
    }
    return { result, attempt, exhausted: false };
  }

  async function finish(attempt, operation) {
    let committed;
    try {
      committed = await runCommit(attempt, operation);
    } catch (error) {
      // 交易失敗：什麼都沒寫進去，留在原卡用同一個 attempt 重試。operation 要一起
      // 留著——重試時要拿它跟當下的 context 比，不能重新拍一張再跟自己比。
      pendingRetry = { attempt, operation, error };
      setStatus('save-failed');
      return { status: 'save-failed', error };
    }

    const { result } = committed;
    if (!COMMITTED.has(result?.status)) {
      pendingRetry = null;
      setStatus('idle');
      return { status: result?.status || 'not-committed', result };
    }

    /* 交易已經落地。以下任何一步失敗都不准重送交易。
       capture() 這裡要包起來（retry() 那邊本來就有包，兩邊要一致）：背景把 catalog
       換掉之後目前這張卡可能從 filteredCards() 掉出來，cardId 變空字串，
       capturePracticeOperation 就丟。讓它往上冒的話狀態永遠停在 saving，而
       saving 沒有對應的動作按鈕，使用者只能重新整理。拍不到 context 就當 stale——
       帳本已經有這筆，開機的 reconcileLedgerMirror 會補鏡射。 */
    let current = null;
    try {
      current = capture();
    } catch {
      current = null;
    }
    if (!operationStillCurrent(operation, current)) {
      pendingRetry = null;
      pendingRepair = null;
      setStatus('idle');
      return { status: 'stale-operation', result };
    }

    try {
      await mirrorResult(result);
    } catch (error) {
      pendingRepair = { result, error };
      setStatus('projection-repair');
      return { status: 'projection-repair', result, error };
    }

    pendingRetry = null;
    pendingRepair = null;
    setStatus('idle');
    advanceUi(result);
    return { status: 'done', result };
  }

  return {
    getStatus: () => status,
    /* saving、save-failed、projection-repair 期間 UI 一律不准換卡、換課、換模式、
       shuffle、搜尋跳卡（AE7）。 */
    isLocked: () => status !== 'idle',

    async submitGrade(grade) {
      if (status !== 'idle') return { status: 'busy' };
      let attempt;
      let operation;
      try {
        attempt = build({ existingContext: null, grade });
        operation = capture();
      } catch (error) {
        return { status: 'context-invalid', error };
      }
      if (!attempt) return { status: 'not-eligible' };
      if (attempt.kind === 'retry-limit') return { status: 'retry-limit', attempt };
      setStatus('saving');
      return finish(attempt, operation);
    },

    /* 失敗後重試：沿用同一個 attempt（同一組 attemptId／phase）。eventId 由呼叫端
       每次新產生，擋住重複的是 attemptPhaseClaims，不是 eventId。 */
    async retry() {
      if (status !== 'save-failed' || !pendingRetry) return { status: 'nothing-to-retry' };
      const { attempt, operation } = pendingRetry;
      let current;
      try {
        current = capture();
      } catch (error) {
        return { status: 'context-invalid', error };
      }
      /* 失敗期間 UI 有鎖，但手勢／深連結之類的漏網之魚仍可能換掉卡片。這裡拿
         「當初送出時」那張 operation 跟現在比，不是重新拍一張跟自己比——重拍的話
         A 卡的 attempt 會配上 B 卡的 token，兩邊都是 B 就永遠比對得過，結果就是
         把 A 卡的排程寫進 B 卡。交易還沒落地，直接丟掉是安全的。 */
      if (!operationStillCurrent(operation, current)) {
        pendingRetry = null;
        setStatus('idle');
        return { status: 'stale-operation' };
      }
      setStatus('saving');
      return finish(attempt, operation);
    },

    /* 鏡射修復：交易早就成功了，只重跑鏡射，絕不重送交易。 */
    async repairProjection() {
      if (status !== 'projection-repair' || !pendingRepair) return { status: 'nothing-to-repair' };
      const { result } = pendingRepair;
      try {
        await mirrorResult(result);
      } catch (error) {
        pendingRepair = { result, error };
        /* 狀態沒變，但一定要再 emit 一次：呼叫端在 await 之前就把按鈕 disabled 了，
           而按鈕只有 onStateChange 驅動的 render 會重新啟用。setStatus 對相同狀態
           是 no-op，所以這裡直接 emit，否則重試一次失敗按鈕就永遠灰掉。 */
        emit({ status, canRetry: !!pendingRetry, canRepair: !!pendingRepair });
        return { status: 'projection-repair', error };
      }
      pendingRepair = null;
      setStatus('idle');
      advanceUi(result);
      return { status: 'done', result };
    },
  };
}
