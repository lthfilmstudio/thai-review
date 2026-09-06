/* 開機時把 ledger 這一側叫起來：確認 catalog fence、把 IDB 投影鏡射回本機，
   然後交出一個可以評分的 runtime handle。

   全程 fail-open 到 legacy：任何一步失敗都只是「這次開機不開放 ledger 評分」，
   App 照舊走原本那條路。ledger 還不是任何使用者看得到的東西的權威來源，為了它
   把人擋在門外不划算（R14）。 */

import { cardIdOf, legacyAliasOf } from './card-identity.js';
import { createPracticeTransactionPort } from './practice-db.js';
import {
  commitLegacyV1Import,
  commitRuntimeSrsBaseline,
  ensureRuntimeLedgerContext,
  pendingBaselineAliases,
  pendingLegacyAdoptions,
  planLegacyV1Import,
  planRuntimeSrsBaseline,
  readRuntimeAuthoritativeSrs,
  readRuntimeBaselineState,
} from './storage-scope.js';
import { reconcileLedgerMirror } from './ledger-mirror.js';

/* digest 只綁「會影響認領結果」的欄位：課號、stable card ID、legacy alias。
   改動 zh 或 note 不該害整份 baseline 重新 audit 一次。 */
export async function computeCatalogDigest(catalog) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    const error = new Error('這個環境沒有 SubtleCrypto，算不出 catalog digest');
    error.code = 'CATALOG_DIGEST_UNAVAILABLE';
    throw error;
  }
  const parts = [];
  for (const lesson of catalog?.lessons || []) {
    parts.push(`L ${lesson?.id ?? ''}`);
    for (const card of lesson?.cards || []) {
      parts.push(`C ${cardIdOf(card) || ''} ${legacyAliasOf(card, lesson?.id) || ''}`);
    }
  }
  const bytes = new TextEncoder().encode(parts.join('\n'));
  const buffer = await subtle.digest('SHA-256', bytes);
  const hex = [...new Uint8Array(buffer)].map(b => b.toString(16).padStart(2, '0')).join('');
  return `sha256:${hex}`;
}

/* stable card ID → legacy cardKey。history 鏡射要靠它；IDB 用 stable ID，本機的
   評分歷史用 legacy key。同一個 cardId 對到多個 alias（撞名）就整個不收，不猜。 */
export function catalogCardKeyIndex(catalog) {
  const index = new Map();
  const conflicted = new Set();
  for (const lesson of catalog?.lessons || []) {
    for (const card of lesson?.cards || []) {
      const cardId = cardIdOf(card);
      const alias = legacyAliasOf(card, lesson?.id);
      if (!cardId || !alias) continue;
      if (index.has(cardId) && index.get(cardId) !== alias) conflicted.add(cardId);
      index.set(cardId, alias);
    }
  }
  for (const cardId of conflicted) index.delete(cardId);
  return index;
}

export async function startPracticeLedgerRuntime({
  connection,
  workspaceId,
  catalog,
  projections = null,
  storage = localStorage,
  legacyProgress = null,
  loadLineageEvidence = null,
  assertActive = () => {},
  createPort = createPracticeTransactionPort,
} = {}) {
  try {
    if (!connection) return { status: 'unavailable', reason: 'PRACTICE_DB_UNAVAILABLE' };
    const catalogDigest = await computeCatalogDigest(catalog);
    const port = createPort(connection, { workspaceId, assertActive });

    const runBaseline = async () => {
      const evidence = loadLineageEvidence ? await loadLineageEvidence() : null;
        // 有 legacy progress 要搬、卻拿不到可信 lineage 的話，planRuntimeSrsBaseline
        // 不會丟——它會把每個 alias 都 quarantine 掉然後「成功」。放行的話等於在
        // 完全沒有 baseline 的狀態下開放評分，使用者既有的排程就從畫面上消失。
        // 這是「驗不了」不是「驗失敗」，往上回 blocked，App 繼續走 legacy。
        if (Object.keys(legacyProgress || {}).length
            && (!evidence?.lineageEvidence || !evidence?.trustedRevisionManifest)) {
          const error = new Error('沒有可信的 lineage evidence，不能認領既有進度');
          error.code = 'LEGACY_LINEAGE_UNAVAILABLE';
          throw error;
        }
        const plan = planRuntimeSrsBaseline({
          progress: legacyProgress || {},
          currentCatalog: catalog,
          catalogDigest,
          lineageEvidence: evidence?.lineageEvidence ?? null,
          trustedRevisionManifest: evidence?.trustedRevisionManifest ?? null,
        });
      return commitRuntimeSrsBaseline({ port, workspaceId, plan });
    };

    const context = await ensureRuntimeLedgerContext({
      port, workspaceId, catalogDigest, auditBaseline: runBaseline,
    });

    // digest 沒變 → 上面不會重跑 baseline。但 legacy progress 會在開機之後長大
    // （cloud-sync 把別台的進度併進來），那些新 alias 沒人補就永遠進不了 ledger。
    // baseline 是 add-only 而且會跳過處理過的 alias，所以這裡補跑是安全的；沒有
    // 待補的 alias 就完全不動，也不會白白去抓一次 lineage evidence。
    let backfill = null;
    if (context.status === 'ready') {
      const pending = pendingBaselineAliases(
        legacyProgress,
        await readRuntimeBaselineState({ port, workspaceId }),
        catalogDigest,
      );
      if (pending.length) {
        try {
          backfill = await runBaseline();
        } catch (error) {
          // 補跑失敗不影響這次開機：已經認領過的照樣可用，沒補到的下次再說。
          backfill = { status: 'failed', reason: error?.code || 'RUNTIME_BASELINE_BACKFILL_FAILED' };
        }
      }
    }

    /* 採納：本機比 IDB 新的卡要寫回權威列，否則帳本永遠收不回它。

       這條路每天都會走到——單堂課評分一律走 legacy，評完 localStorage 的時間戳就
       比 IDB 那份新，而逐卡閘門要求「IDB 不比本機舊」才放行。沒有這一步的話，
       一張卡只要被 legacy 評過一次就永久離開帳本，覆蓋率會隨著使用一路掉。

       走的是 planLegacyV1Import／commitLegacyV1Import：同一套信任閘門（認不出
       alias 就 quarantine，不猜）、同一套單調保護（IDB 較新就不覆蓋）。 */
    /* 讀失敗不能拖垮整個 boot。這一行如果直接往外丟，會被最外層 catch 成
       status:'unavailable'，底下的 reconcileLedgerMirror 就永遠跑不到——畫面數字
       少一截，比「帳本這輪不開放」嚴重得多。讀不到就當成沒有權威列，逐卡閘門
       自然把所有卡踢回 legacy，那是安全方向。 */
    let authoritativeSrs = [];
    let authoritativeReadFailed = false;
    if (context.status === 'ready') {
      try {
        authoritativeSrs = await readRuntimeAuthoritativeSrs({ port, workspaceId });
      } catch {
        authoritativeReadFailed = true;
      }
    }
    let adopted = null;
    if (context.status === 'ready' && !authoritativeReadFailed) {
      const stale = pendingLegacyAdoptions(legacyProgress, authoritativeSrs, catalog);
      if (Object.keys(stale).length) {
        try {
          const evidence = loadLineageEvidence ? await loadLineageEvidence() : null;
          const plan = planLegacyV1Import({
            winners: stale,
            currentCatalog: catalog,
            catalogDigest,
            lineageEvidence: evidence?.lineageEvidence ?? null,
            trustedRevisionManifest: evidence?.trustedRevisionManifest ?? null,
          });
          const result = await commitLegacyV1Import({ port, workspaceId, plan });
          adopted = { summary: plan.summary, result };
          authoritativeSrs = await readRuntimeAuthoritativeSrs({ port, workspaceId });
        } catch (error) {
          // 採納失敗不影響這次開機：那些卡這輪繼續走 legacy，下次再試。
          adopted = { status: 'failed', reason: error?.code || 'LEGACY_ADOPTION_FAILED' };
        }
      }
    }

    // 鏡射跟 fence 分開：就算 ledger 評分沒開放，已經在 IDB 裡的東西還是該讓
    // 使用者在畫面上看到，不然重開一次數字就少一截。
    const mirror = reconcileLedgerMirror({
      projections,
      cardKeyById: catalogCardKeyIndex(catalog),
      storage,
    });

    return {
      status: context.status === 'ready' ? 'ready' : 'blocked',
      reason: context.reason,
      catalogDigest,
      port,
      mirror,
      backfill,
      adopted,
      /* 評分 session 的逐卡閘門要用這份，不能用開機前的 hydration 快照——
         baseline 與採納都是在那之後才寫的。 */
      authoritativeSrs,
    };
  } catch (error) {
    return { status: 'unavailable', reason: error?.code || 'PRACTICE_LEDGER_START_FAILED', error };
  }
}
