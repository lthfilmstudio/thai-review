import {
  captureLegacyLearningSnapshot,
  commitLegacyMigration,
  evaluateLegacyClaim,
  inspectNamespacedLocalCounts,
  planLegacyMigration,
} from './storage-scope.js';
import { createLegacyMigrationTransactionPort } from './practice-db.js';
import { TRUSTED_PRODUCTION_LINEAGE } from './production-lineage-trust.js';
import { createRemoteWorkspaceProbe } from './remote-workspace-probe.js';

const PRODUCTION_CORE = Object.freeze({
  captureLegacyLearningSnapshot,
  commitLegacyMigration,
  createLegacyMigrationTransactionPort,
  evaluateLegacyClaim,
  inspectNamespacedLocalCounts,
  planLegacyMigration,
});

const CLAIM_DECLINED_KEY = 'thai-review-legacy-claim-declined-v1';
const DEFERRED_CLAIM_ERRORS = new Set([
  'LEGACY_LINEAGE_UNAVAILABLE',
  'REMOTE_WORKSPACE_PROBE_UNAVAILABLE',
]);

function codedError(code, message, cause = null) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function countsAreEmpty(evidence) {
  const counts = evidence?.counts;
  return !!counts && Object.values(counts).length > 0
    && Object.values(counts).every(value => Number.isInteger(value) && value === 0);
}

function accountLabel(session) {
  return session?.user?.email || session?.user?.user_metadata?.name || '目前帳號';
}

function abortable(value, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      const error = new Error('production lineage evidence request aborted');
      error.name = 'AbortError';
      reject(error);
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(value).then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

/* 非安全脈絡（例如用 http:// 加區網 IP 開）沒有 SubtleCrypto。「驗不了」跟「驗不過」
   要分開：前者不該把已登入的人鎖在開機畫面外，走 UNAVAILABLE 讓 claim 延後就好，
   反正沒驗過就不會有任何 migration 寫入。 */
async function sha256Hex(text) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw codedError('LEGACY_LINEAGE_UNAVAILABLE', '這個環境沒有 SubtleCrypto，無法驗證 lineage evidence');
  }
  const bytes = new TextEncoder().encode(text);
  const digest = await subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function fetchProductionLineageEvidence({
  fetchImpl = (...args) => fetch(...args),
  signal: parentSignal,
  timeoutMs = 10000,
  expectedEvidenceSha256 = TRUSTED_PRODUCTION_LINEAGE.evidenceSha256,
} = {}) {
  const controller = new AbortController();
  const onParentAbort = () => controller.abort();
  if (parentSignal) {
    if (parentSignal.aborted) controller.abort();
    else parentSignal.addEventListener('abort', onParentAbort, { once: true });
  }
  const timer = setTimeout(
    () => controller.abort(),
    Math.max(1, Number(timeoutMs) || 1),
  );
  try {
    let response;
    try {
      response = await abortable(fetchImpl('/data/card-id-lineage.json', {
        cache: 'no-store', signal: controller.signal,
      }), controller.signal);
    } catch (cause) {
      throw codedError(
        'LEGACY_LINEAGE_UNAVAILABLE',
        '無法讀取 production lineage evidence',
        cause,
      );
    }
    if (!response?.ok) {
      throw codedError(
        'LEGACY_LINEAGE_UNAVAILABLE',
        `production lineage evidence request failed (${response?.status || 'unknown'})`,
      );
    }
    try {
      const raw = await abortable(response.text(), controller.signal);
      // 先綁 bytes 再談內容：payload 自報的 kind／evidenceId 都是攻擊者可控的，
      // 只有跟編進 bundle 的 SHA-256 對得起來才往下走。
      const digest = await abortable(sha256Hex(raw), controller.signal);
      if (digest !== expectedEvidenceSha256) {
        throw new Error(`lineage evidence digest mismatch (${digest})`);
      }
      const evidence = JSON.parse(raw);
      if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
        throw new Error('invalid lineage payload');
      }
      return evidence;
    } catch (cause) {
      if (cause?.name === 'AbortError') {
        throw codedError('LEGACY_LINEAGE_UNAVAILABLE', '無法讀取 production lineage evidence', cause);
      }
      if (cause?.code) throw cause;   // 已經分類過的（例如驗不了 vs 驗不過）不要再被蓋掉
      throw codedError(
        'LEGACY_LINEAGE_INVALID',
        'production lineage evidence is invalid',
        cause,
      );
    }
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', onParentAbort);
  }
}

export function createLegacyClaimFlow({
  rootStorage,
  eligibilityStorage,
  practiceConnection,
  assertBootActive,
  requestDecision,
  onDiagnostics = () => {},
  loadLineageEvidence = fetchProductionLineageEvidence,
  trustedRevisionManifest = TRUSTED_PRODUCTION_LINEAGE,
  remoteProbe = createRemoteWorkspaceProbe(),
  core = PRODUCTION_CORE,
} = {}) {
  if (!rootStorage
      || !eligibilityStorage
      || !practiceConnection
      || typeof assertBootActive !== 'function'
      || typeof requestDecision !== 'function'
      || typeof onDiagnostics !== 'function'
      || typeof loadLineageEvidence !== 'function'
      || !remoteProbe
      || typeof remoteProbe.inspect !== 'function'
      || typeof remoteProbe.verifyRemotePull !== 'function'
      || typeof remoteProbe.invalidate !== 'function') {
    throw codedError('LEGACY_CLAIM_ADAPTER_INCOMPLETE', 'legacy claim adapters are incomplete');
  }
  for (const method of [
    'captureLegacyLearningSnapshot', 'commitLegacyMigration',
    'createLegacyMigrationTransactionPort', 'evaluateLegacyClaim',
    'inspectNamespacedLocalCounts', 'planLegacyMigration',
  ]) {
    if (typeof core?.[method] !== 'function') {
      throw codedError('LEGACY_CLAIM_ADAPTER_INCOMPLETE', `legacy claim core.${method} is required`);
    }
  }

  let activeOperation = null;

  const invalidate = () => {
    activeOperation?.abort();
    activeOperation = null;
    remoteProbe.invalidate();
  };

  const reportAndThrow = (error, fallbackCode) => {
    const failure = error?.code
      ? error
      : codedError(fallbackCode, error?.message || 'legacy claim failed', error);
    onDiagnostics({ phase: 'legacy-claim', code: failure.code, error: failure });
    throw failure;
  };

  async function migrate({ workspaceId, session } = {}) {
    if (!session || !workspaceId?.startsWith('user:')) {
      return { status: 'not-offered', reason: 'anonymous', summary: null };
    }
    const operation = new AbortController();
    activeOperation?.abort();
    activeOperation = operation;
    const assertActive = requestedWorkspace => {
      if (activeOperation !== operation || operation.signal.aborted) {
        throw codedError('WORKSPACE_INVALIDATED', 'legacy claim belongs to an inactive boot');
      }
      assertBootActive(requestedWorkspace);
    };
    const finish = result => {
      if (activeOperation === operation) activeOperation = null;
      remoteProbe.invalidate();
      return result;
    };

    try {
      assertActive(workspaceId);
      const captured = core.captureLegacyLearningSnapshot(rootStorage);
      if (captured?.status !== 'ok') {
        throw codedError(
          captured?.status === 'unavailable'
            ? 'LEGACY_STORAGE_UNAVAILABLE'
            : 'LEGACY_SNAPSHOT_INVALID',
          'legacy learning snapshot could not be captured safely',
          captured?.error,
        );
      }
      const legacySnapshot = captured.snapshot;
      if (!Array.isArray(legacySnapshot?.facts) || legacySnapshot.facts.length === 0) {
        return finish({ status: 'not-offered', reason: 'legacy-empty', summary: null });
      }
      if (eligibilityStorage.getItem(CLAIM_DECLINED_KEY) === legacySnapshot.snapshotId) {
        return finish({ status: 'not-offered', reason: 'user-declined', summary: null });
      }

      let lineageEvidence;
      try {
        lineageEvidence = await loadLineageEvidence({ signal: operation.signal });
      } catch (error) {
        throw error?.code
          ? error
          : codedError('LEGACY_LINEAGE_UNAVAILABLE', 'production lineage evidence is unavailable', error);
      }
      assertActive(workspaceId);
      const plan = core.planLegacyMigration({
        legacySnapshot,
        lineageEvidence,
        trustedRevisionManifest,
      });
      if (plan?.lineageProvenance?.evidenceId !== trustedRevisionManifest?.evidenceId
          || plan?.conservation?.valid !== true) {
        throw codedError('LEGACY_LINEAGE_INVALID', 'production lineage evidence did not pass trust validation');
      }

      const transactionalPort = core.createLegacyMigrationTransactionPort(
        practiceConnection,
        {
          workspaceId,
          assertBootActive: assertActive,
          inspectLocalEligibility: id => core.inspectNamespacedLocalCounts(eligibilityStorage, id),
        },
      );
      const namespacedLocalCounts = await transactionalPort.inspectClaimEligibility();
      assertActive(workspaceId);
      if (!countsAreEmpty(namespacedLocalCounts)) {
        return finish({ status: 'not-offered', reason: 'local-nonempty', summary: null });
      }

      const firstRemotePull = await remoteProbe.inspect(workspaceId);
      assertActive(workspaceId);
      if (firstRemotePull?.completed !== true) {
        throw codedError(
          ['request-failed', 'aborted'].includes(firstRemotePull?.reason)
            ? 'REMOTE_WORKSPACE_PROBE_UNAVAILABLE'
            : 'REMOTE_WORKSPACE_PROBE_FAILED',
          `remote workspace probe failed (${firstRemotePull?.reason || 'unknown'})`,
          firstRemotePull?.error,
        );
      }
      if (firstRemotePull.rowCount !== 0) {
        return finish({ status: 'not-offered', reason: 'remote-nonempty', summary: null });
      }
      if (typeof firstRemotePull.receiptId !== 'string' || !firstRemotePull.receiptId.trim()) {
        throw codedError(
          'REMOTE_WORKSPACE_PROBE_FAILED',
          'empty remote workspace probe did not issue a verification receipt',
        );
      }

      const claimInput = {
        accountLabel: accountLabel(session),
        namespacedLocalCounts,
        firstRemotePull,
        legacyFactCount: legacySnapshot.facts.length,
        legacySnapshot,
        targetWorkspaceId: workspaceId,
        migrationPlan: plan,
      };
      const offer = core.evaluateLegacyClaim(claimInput);
      if (offer?.status !== 'offer') {
        return finish({ status: 'not-offered', reason: 'eligibility-rejected', summary: null });
      }
      const decision = await requestDecision({
        offer,
        accountLabel: claimInput.accountLabel,
        legacyFactCount: legacySnapshot.facts.length,
        summary: plan.summary,
        signal: operation.signal,
      });
      assertActive(workspaceId);
      if (decision === 'cancel') {
        const cancelled = core.evaluateLegacyClaim({ ...claimInput, decision });
        eligibilityStorage.setItem(CLAIM_DECLINED_KEY, legacySnapshot.snapshotId);
        return finish({ status: cancelled.status, reason: 'user-cancelled', summary: null });
      }
      if (decision !== 'claim') {
        throw codedError('LEGACY_CLAIM_DECISION_INVALID', 'legacy claim decision is invalid');
      }

      const confirmation = core.evaluateLegacyClaim({
        ...claimInput,
        decision,
        offerToken: offer.offerToken,
      });
      if (confirmation?.status !== 'confirmed' || !confirmation.authorization) {
        throw codedError('CLAIM_CONFIRMATION_REQUIRED', 'legacy claim was not confirmed');
      }
      const committed = await core.commitLegacyMigration({
        transactionalPort,
        eligibilityGuard: remoteProbe,
        workspaceId,
        plan,
        authorization: confirmation.authorization,
      });
      assertActive(workspaceId);
      if (!['applied', 'already-applied'].includes(committed?.status)) {
        throw codedError('LEGACY_MIGRATION_NOT_APPLIED', 'legacy migration did not complete');
      }
      return finish({ status: committed.status, summary: committed.summary });
    } catch (error) {
      invalidate();
      if (DEFERRED_CLAIM_ERRORS.has(error?.code)) {
        onDiagnostics({ phase: 'legacy-claim', code: error.code, error });
        return { status: 'not-offered', reason: 'deferred-offline', summary: null };
      }
      return reportAndThrow(error, 'LEGACY_CLAIM_FAILED');
    }
  }

  return Object.freeze({ migrate, invalidate });
}
