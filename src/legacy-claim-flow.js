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

export async function fetchProductionLineageEvidence({
  fetchImpl = (...args) => fetch(...args),
} = {}) {
  let response;
  try {
    response = await fetchImpl('/data/card-id-lineage.json', { cache: 'no-store' });
  } catch (cause) {
    throw codedError('LEGACY_LINEAGE_UNAVAILABLE', '無法讀取 production lineage evidence', cause);
  }
  if (!response?.ok) {
    throw codedError(
      'LEGACY_LINEAGE_UNAVAILABLE',
      `production lineage evidence request failed (${response?.status || 'unknown'})`,
    );
  }
  try {
    const evidence = await response.json();
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
      throw new Error('invalid lineage payload');
    }
    return evidence;
  } catch (cause) {
    throw codedError('LEGACY_LINEAGE_INVALID', 'production lineage evidence is invalid', cause);
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

      let lineageEvidence;
      try {
        lineageEvidence = await loadLineageEvidence();
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
          'REMOTE_WORKSPACE_PROBE_FAILED',
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
      return reportAndThrow(error, 'LEGACY_CLAIM_FAILED');
    }
  }

  return Object.freeze({ migrate, invalidate });
}
