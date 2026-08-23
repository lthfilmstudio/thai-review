/* Workspace routing and conservative legacy learning migration.
   This module deliberately has no auth, network, IndexedDB, or DOM dependency.
   Callers supply those adapters so boot and migration can fail closed before any
   learning read/write reaches a store. */

import { isStableCardId } from './card-identity.js';

const BOOT_SCREENS = Object.freeze({
  'checking-session': {
    title: '正在確認學習空間',
    message: '先確認目前登入狀態，避免讀到另一個帳號的進度。',
    actions: [],
    focusTarget: 'boot-status',
  },
  'loading-catalog': {
    title: '正在讀取課程版本',
    message: '核對卡片身分後，才會處理既有學習紀錄。',
    actions: [],
    focusTarget: 'boot-status',
  },
  'opening-storage': {
    title: '正在開啟這個學習空間',
    message: '你的進度會依這台裝置或目前帳號分開保存。',
    actions: [],
    focusTarget: 'boot-status',
  },
  migrating: {
    title: '正在整理既有進度',
    message: '能確認身分的紀錄會保留；不確定的會完整留在待確認區。',
    actions: [],
    focusTarget: 'boot-status',
  },
  ready: {
    title: '可以開始了',
    message: '學習空間已就緒。',
    actions: [],
    focusTarget: 'primary-practice-action',
  },
  'recoverable-failure': {
    title: '還沒準備完成',
    message: '資料仍完整保留，可以重試或查看診斷。',
    actions: [
      { id: 'retry', label: '再試一次' },
      { id: 'diagnostics', label: '查看診斷' },
    ],
    focusTarget: 'boot-retry',
  },
  'storage-unavailable': {
    title: '無法安全開啟學習資料',
    message: '瀏覽器儲存空間目前不可用；尚未寫入任何假完成紀錄。',
    actions: [{ id: 'diagnostics', label: '查看診斷' }],
    focusTarget: 'boot-diagnostics',
  },
});

export const BOOT_STATE_ORDER = Object.freeze(Object.keys(BOOT_SCREENS));

const BOOT_TRANSITIONS = Object.freeze({
  'checking-session': new Set(['loading-catalog', 'recoverable-failure', 'storage-unavailable']),
  'loading-catalog': new Set(['opening-storage', 'recoverable-failure', 'storage-unavailable']),
  'opening-storage': new Set(['migrating', 'ready', 'recoverable-failure', 'storage-unavailable']),
  migrating: new Set(['ready', 'recoverable-failure', 'storage-unavailable']),
  ready: new Set(['checking-session']),
  'recoverable-failure': new Set(['checking-session']),
  'storage-unavailable': new Set(['checking-session']),
});

export const LEARNING_STORE_KEYS = Object.freeze({
  state: 'thai-review-v1',
  daily: 'thai-review-daily-v1',
  history: 'thai-review-grade-history-v1',
  achievements: 'thai-review-achievements-v1',
  events: 'thai-review-practice-events-v1',
  outbox: 'thai-review-practice-outbox-v1',
  cycle: 'thai-review-practice-cycle-v1',
  cursors: 'thai-review-sync-v1',
  remoteDays: 'thai-review-remote-days-v1',
  resweep: 'thai-review-resweep-v1',
  installation: 'thai-review-installation-v1',
});

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function bootScreenFor(state) {
  const screen = BOOT_SCREENS[state];
  if (!screen) throw codedError('UNKNOWN_BOOT_STATE', `unknown boot state: ${state}`);
  return structuredClone(screen);
}

export function createWorkspaceBoot() {
  let current = {
    state: 'checking-session',
    details: null,
    workspaceId: null,
    epoch: 0,
  };
  return {
    moveTo(state, details = null) {
      if (!BOOT_SCREENS[state]) {
        throw codedError('UNKNOWN_BOOT_STATE', `unknown boot state: ${state}`);
      }
      if (!BOOT_TRANSITIONS[current.state].has(state)) {
        throw codedError(
          'INVALID_BOOT_TRANSITION',
          `cannot move workspace boot from ${current.state} to ${state}`,
        );
      }
      const bindingWorkspaceId = current.state === 'checking-session' && state === 'loading-catalog'
        ? requiredIdentity(details?.workspaceId)
        : current.workspaceId;
      current = {
        state,
        details: details ? structuredClone(details) : null,
        workspaceId: state === 'checking-session' ? null : bindingWorkspaceId,
        epoch: current.state === 'checking-session' && state === 'loading-catalog'
          ? current.epoch + 1
          : current.epoch,
      };
      return this.snapshot();
    },
    snapshot() {
      return {
        ...structuredClone(current),
        ready: current.state === 'ready',
        screen: bootScreenFor(current.state),
      };
    },
    assertReady(expectedWorkspaceId, expectedEpoch) {
      if (current.state !== 'ready') {
        throw codedError('WORKSPACE_NOT_READY', `workspace boot is ${current.state}`);
      }
      if (current.workspaceId !== requiredIdentity(expectedWorkspaceId)
          || current.epoch !== expectedEpoch) {
        throw codedError('WORKSPACE_INVALIDATED', 'workspace storage handle belongs to an older boot');
      }
    },
  };
}

function requiredIdentity(value) {
  const identity = typeof value === 'string' ? value.trim() : '';
  if (!identity || /[\u0000-\u001f\u007f]/.test(identity)) {
    throw codedError('WORKSPACE_ID_MISSING', 'workspace identity is missing');
  }
  return identity;
}

export function resolveWorkspaceId({ session = null, deviceId } = {}) {
  if (session) return `user:${requiredIdentity(session?.user?.id)}`;
  return `anon:${requiredIdentity(deviceId)}`;
}

export function scopedStorageKey(workspaceId, logicalKey) {
  const workspace = requiredIdentity(workspaceId);
  const key = requiredIdentity(logicalKey);
  return `thai-review-workspace:${encodeURIComponent(workspace)}:${key}`;
}

export function createWorkspaceStorage(storage, { workspaceId, boot } = {}) {
  if (!storage
      || typeof storage.getItem !== 'function'
      || typeof storage.setItem !== 'function'
      || typeof storage.removeItem !== 'function') {
    throw codedError('STORAGE_UNAVAILABLE', 'storage adapter is unavailable');
  }
  const workspace = requiredIdentity(workspaceId);
  const canaryKey = scopedStorageKey(workspace, '__storage_canary__');
  let previousCanary = null;
  try {
    previousCanary = storage.getItem(canaryKey);
    const canaryValue = `workspace-canary:${workspace}`;
    storage.setItem(canaryKey, canaryValue);
    if (storage.getItem(canaryKey) !== canaryValue) {
      throw new Error('storage canary read-back mismatch');
    }
    if (previousCanary === null) storage.removeItem(canaryKey);
    else storage.setItem(canaryKey, previousCanary);
    if (storage.getItem(canaryKey) !== previousCanary) {
      throw new Error('storage canary cleanup mismatch');
    }
  } catch {
    try {
      if (previousCanary === null) storage.removeItem(canaryKey);
      else storage.setItem(canaryKey, previousCanary);
    } catch { /* best-effort cleanup before failing closed */ }
    throw codedError('STORAGE_UNAVAILABLE', 'storage write verification failed');
  }
  const bootBinding = boot && typeof boot.snapshot === 'function'
    ? boot.snapshot()
    : null;
  const ready = boot && typeof boot.assertReady === 'function'
    ? () => boot.assertReady(workspace, bootBinding?.epoch)
    : () => { throw codedError('WORKSPACE_NOT_READY', 'workspace readiness gate is missing'); };
  const prefix = `thai-review-workspace:${encodeURIComponent(workspace)}:`;
  const physicalKey = key => scopedStorageKey(workspace, key);
  const ownKeys = () => {
    const keys = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (typeof key === 'string' && key.startsWith(prefix)) keys.push(key);
    }
    return keys;
  };

  return {
    workspaceId: workspace,
    get length() { ready(); return ownKeys().length; },
    key(index) {
      ready();
      const key = ownKeys()[index];
      return key ? key.slice(prefix.length) : null;
    },
    getItem(key) { ready(); return storage.getItem(physicalKey(key)); },
    setItem(key, value) { ready(); storage.setItem(physicalKey(key), value); },
    removeItem(key) { ready(); storage.removeItem(physicalKey(key)); },
    clear() {
      ready();
      for (const key of ownKeys()) storage.removeItem(key);
    },
  };
}

export async function inspectStorageDurability(storageManager) {
  if (!storageManager
      || typeof storageManager.persist !== 'function'
      || typeof storageManager.estimate !== 'function') {
    return {
      supported: false,
      persistedBefore: null,
      persistGranted: null,
      usage: null,
      quota: null,
    };
  }
  const persistedBefore = typeof storageManager.persisted === 'function'
    ? await storageManager.persisted()
    : null;
  const persistGranted = persistedBefore === true
    ? true
    : await storageManager.persist();
  const estimate = await storageManager.estimate();
  return {
    supported: true,
    persistedBefore,
    persistGranted,
    usage: Number.isFinite(estimate?.usage) ? estimate.usage : null,
    quota: Number.isFinite(estimate?.quota) ? estimate.quota : null,
  };
}

export function getOrCreateWorkspaceInstallationId(storage, createId) {
  const key = LEARNING_STORE_KEYS.installation;
  const existing = storage.getItem(key);
  if (existing) return existing;
  const installationId = requiredIdentity(createId?.());
  storage.setItem(key, installationId);
  return installationId;
}

export async function logoutToAnonymous({
  deviceId,
  invalidate,
  clearAuth,
  activate,
  reload,
} = {}) {
  if (typeof invalidate !== 'function'
      || typeof clearAuth !== 'function'
      || typeof activate !== 'function'
      || typeof reload !== 'function') {
    throw codedError('LOGOUT_ADAPTER_INCOMPLETE', 'logout requires invalidate, clearAuth, activate, and reload');
  }
  const workspaceId = resolveWorkspaceId({ deviceId });
  invalidate();
  await clearAuth();
  activate(workspaceId);
  reload();
  return workspaceId;
}

const CLAIM_LOCAL_STORES = Object.freeze([
  'state', 'daily', 'history', 'achievements', 'events',
  'outbox', 'cycle', 'cursors', 'remoteDays', 'resweep',
]);

function allCountsZero(counts) {
  return !!counts && CLAIM_LOCAL_STORES.every(name => {
    const value = counts[name];
    return Object.hasOwn(counts, name)
      && typeof value === 'number'
      && Number.isFinite(value)
      && Number.isInteger(value)
      && value >= 0
      && value === 0;
  });
}

const issuedClaimAuthorizations = new WeakSet();
const issuedClaimOffers = new WeakSet();

function snapshotSignature(snapshot) {
  return stableSerialize({
    snapshotId: snapshot?.snapshotId,
    facts: snapshot?.facts,
  });
}

function claimBindingIsValid(legacyFactCount, legacySnapshot, migrationPlan) {
  return Number.isInteger(legacyFactCount)
    && legacyFactCount > 0
    && Array.isArray(legacySnapshot?.facts)
    && legacyFactCount === legacySnapshot.facts.length
    && legacyFactCount === migrationPlan?.summary?.original
    && !!legacySnapshot?.snapshotId
    && legacySnapshot.snapshotId === migrationPlan?.snapshotId
    && migrationPlan?.sourceSnapshotSignature === snapshotSignature(legacySnapshot)
    && migrationPlan?.conservation?.valid === true
    && typeof migrationPlan?.planId === 'string'
    && typeof migrationPlan?.planSignature === 'string'
    && migrationPlan.planSignature === migrationPlanSignature(migrationPlan);
}

function claimEligibilityIsValid(localCounts, remotePull, workspaceId) {
  return typeof workspaceId === 'string'
    && workspaceId.startsWith('user:')
    && localCounts?.workspaceId === workspaceId
    && remotePull?.workspaceId === workspaceId
    && typeof localCounts?.revision === 'string'
    && localCounts.revision === localCounts.revision.trim()
    && localCounts.revision.length > 0
    && typeof remotePull?.receiptId === 'string'
    && remotePull.receiptId === remotePull.receiptId.trim()
    && remotePull.receiptId.length > 0;
}

function issueClaimAuthorization({
  workspaceId,
  legacySnapshot,
  migrationPlan,
  namespacedLocalCounts,
  firstRemotePull,
}) {
  const workspace = requiredIdentity(workspaceId);
  if (!workspace.startsWith('user:')) {
    throw codedError('CLAIM_BINDING_INVALID', 'legacy claim target must be a user workspace');
  }
  if (!claimBindingIsValid(legacySnapshot?.facts?.length, legacySnapshot, migrationPlan)) {
    throw codedError('CLAIM_BINDING_INVALID', 'legacy snapshot and migration plan do not match');
  }
  if (!claimEligibilityIsValid(namespacedLocalCounts, firstRemotePull, workspace)) {
    throw codedError('CLAIM_WORKSPACE_MISMATCH', 'claim eligibility belongs to another workspace');
  }
  const authorization = Object.freeze({
    kind: 'legacy-claim-authorization-v1',
    confirmed: true,
    workspaceId: workspace,
    snapshotId: migrationPlan.snapshotId,
    sourceSnapshotSignature: migrationPlan.sourceSnapshotSignature,
    planId: migrationPlan.planId,
    planSignature: migrationPlan.planSignature,
    localRevision: namespacedLocalCounts.revision,
    remotePullReceiptId: firstRemotePull.receiptId,
  });
  issuedClaimAuthorizations.add(authorization);
  return authorization;
}

function issueClaimOffer(workspaceId, migrationPlan) {
  const offerToken = Object.freeze({
    kind: 'legacy-claim-offer-v1',
    workspaceId,
    snapshotId: migrationPlan.snapshotId,
    planId: migrationPlan.planId,
  });
  issuedClaimOffers.add(offerToken);
  return offerToken;
}

function consumeClaimOffer(offerToken, workspaceId, migrationPlan) {
  if (!offerToken || !issuedClaimOffers.delete(offerToken)
      || offerToken.kind !== 'legacy-claim-offer-v1'
      || offerToken.workspaceId !== workspaceId
      || offerToken.snapshotId !== migrationPlan.snapshotId
      || offerToken.planId !== migrationPlan.planId) {
    throw codedError(
      'CLAIM_CONFIRMATION_REQUIRED',
      'a current one-shot legacy claim offer is required',
    );
  }
}

export function evaluateLegacyClaim({
  accountLabel,
  namespacedLocalCounts,
  firstRemotePull,
  legacyFactCount = 0,
  decision = null,
  legacySnapshot = null,
  targetWorkspaceId = null,
  migrationPlan = null,
  offerToken = null,
} = {}) {
  const eligible = allCountsZero(namespacedLocalCounts)
    && firstRemotePull?.completed === true
    && firstRemotePull?.rowCount === 0
    && claimEligibilityIsValid(namespacedLocalCounts, firstRemotePull, targetWorkspaceId)
    && claimBindingIsValid(legacyFactCount, legacySnapshot, migrationPlan);

  if (!eligible) {
    return { status: 'not-offered', mergeAnonymous: false, plan: null };
  }
  if (decision === 'cancel') {
    return {
      status: 'cancelled',
      mergeAnonymous: false,
      plan: null,
      legacySnapshot,
    };
  }
  if (decision === 'claim') {
    consumeClaimOffer(offerToken, targetWorkspaceId, migrationPlan);
    return {
      status: 'confirmed',
      mergeAnonymous: false,
      authorization: issueClaimAuthorization({
        workspaceId: targetWorkspaceId,
        legacySnapshot,
        migrationPlan,
        namespacedLocalCounts,
        firstRemotePull,
      }),
    };
  }
  return {
    status: 'offer',
    accountLabel: accountLabel || '目前帳號',
    legacyFactCount: legacySnapshot.facts.length,
    mergeAnonymous: false,
    message: `將這台裝置的進度加入此帳號（${legacySnapshot.facts.length} 筆）`,
    offerToken: issueClaimOffer(targetWorkspaceId, migrationPlan),
    actions: [
      { id: 'claim', label: '將這台裝置的進度加入此帳號' },
      { id: 'cancel', label: '先不要' },
    ],
  };
}

function stableCardId(value) {
  return typeof value === 'string'
    && value === value.trim()
    && isStableCardId(value);
}

const WORKSPACE_FACT_STORES = new Set(['daily', 'achievements', 'remoteDays']);

function normalizeLineageEvidence(evidence, trustedRevisionManifest) {
  const expected = evidence?.expectedRevisions;
  const snapshots = evidence?.snapshots;
  const requiredRevisions = trustedRevisionManifest?.revisions;
  if (trustedRevisionManifest?.kind !== 'trusted-lineage-revision-manifest-v1'
      || !Array.isArray(requiredRevisions)
      || requiredRevisions.length === 0
      || new Set(requiredRevisions).size !== requiredRevisions.length
      || requiredRevisions.some(revision => (
        typeof revision !== 'string' || !revision.trim() || revision !== revision.trim()
      ))
      || evidence?.kind !== 'production-lineage-evidence-v1'
      || typeof evidence?.evidenceId !== 'string'
      || !evidence.evidenceId.trim()
      || evidence.evidenceId !== evidence.evidenceId.trim()
      || evidence?.completeness !== 'complete'
      || !Array.isArray(expected)
      || expected.length === 0
      || new Set(expected).size !== expected.length
      || expected.some(revision => typeof revision !== 'string' || !revision.trim())
      || stableSerialize(expected) !== stableSerialize(requiredRevisions)
      || !Array.isArray(snapshots)
      || snapshots.length !== expected.length) {
    return { complete: false, snapshots: [] };
  }
  const byRevision = new Map();
  for (const snapshot of snapshots) {
    if (snapshot?.complete !== true
        || typeof snapshot?.revision !== 'string'
        || !snapshot.revision.trim()
        || !snapshot.aliases
        || typeof snapshot.aliases !== 'object'
        || Array.isArray(snapshot.aliases)
        || byRevision.has(snapshot.revision)) {
      return { complete: false, snapshots: [] };
    }
    const aliases = structuredClone(snapshot.aliases);
    const cardIdOccurrences = new Map();
    for (const candidates of Object.values(aliases)) {
      if (!Array.isArray(candidates)) continue;
      for (const candidate of candidates) {
        if (typeof candidate !== 'string') continue;
        const normalized = candidate.toLowerCase();
        cardIdOccurrences.set(normalized, (cardIdOccurrences.get(normalized) || 0) + 1);
      }
    }
    byRevision.set(snapshot.revision, {
      revision: snapshot.revision,
      aliases,
      cardIdOccurrences,
    });
  }
  if (expected.some(revision => !byRevision.has(revision))
      || [...byRevision.keys()].some(revision => !expected.includes(revision))) {
    return { complete: false, snapshots: [] };
  }
  const normalizedSnapshots = expected.map(revision => byRevision.get(revision));
  const aliasResolutionCache = new Map();
  const lineageProvenance = {
    evidenceId: evidence.evidenceId,
    digest: `fnv1a32:${smallStableHash(stableSerialize({ evidence, trustedRevisionManifest }))}`,
    revisionManifest: {
      kind: trustedRevisionManifest.kind,
      revisions: structuredClone(requiredRevisions),
    },
  };
  return {
    complete: true,
    snapshots: normalizedSnapshots,
    lineageProvenance,
    canonicalCardIdProven(cardId) {
      const normalized = cardId.toLowerCase();
      return normalizedSnapshots.every(snapshot => (
        snapshot.cardIdOccurrences.get(normalized) === 1
      ));
    },
    resolveAlias(alias) {
      if (!aliasResolutionCache.has(alias)) {
        aliasResolutionCache.set(alias, resolveHistoricalLineage(alias, normalizedSnapshots));
      }
      return aliasResolutionCache.get(alias);
    },
  };
}

function resolveHistoricalLineage(alias, snapshots) {
  if (!snapshots.length) return { status: 'quarantine', reason: 'missing_historical_evidence' };
  const ids = [];
  for (const snapshot of snapshots) {
    const candidates = snapshot?.aliases?.[alias];
    if (!Array.isArray(candidates) || candidates.length === 0) {
      return { status: 'quarantine', reason: 'missing_historical_evidence' };
    }
    if (candidates.length !== 1) {
      return { status: 'quarantine', reason: 'historical_collision' };
    }
    const cardId = candidates[0];
    if (!stableCardId(cardId)) {
      return { status: 'quarantine', reason: 'invalid_lineage_identity' };
    }
    if (snapshot.cardIdOccurrences.get(cardId.toLowerCase()) !== 1) {
      return { status: 'quarantine', reason: 'duplicate_stable_card_id' };
    }
    ids.push(cardId.toLowerCase());
  }
  if (new Set(ids).size !== 1) {
    return { status: 'quarantine', reason: 'lineage_changed' };
  }
  return { status: 'resolved', cardId: ids[0] };
}

function nonempty(value) {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return value !== '';
}

function migrationAudit(facts, snapshots) {
  const collisionAliases = new Set();
  for (const snapshot of snapshots) {
    for (const [alias, candidates] of Object.entries(snapshot?.aliases || {})) {
      if (Array.isArray(candidates) && candidates.length > 1) collisionAliases.add(alias);
    }
  }
  const factsByAlias = new Map();
  for (const row of facts) {
    const alias = typeof row.legacyAlias === 'string' ? row.legacyAlias.trim() : '';
    const rows = factsByAlias.get(alias) || [];
    rows.push(row);
    factsByAlias.set(alias, rows);
  }
  const details = [...collisionAliases].sort().map(legacyAlias => {
    const rows = factsByAlias.get(legacyAlias) || [];
    const nonemptySrs = rows.some(row => row.sourceStore === 'state' && nonempty(row.value));
    const nonemptyGradeHistory = rows.some(row => row.sourceStore === 'history' && nonempty(row.value));
    return {
      legacyAlias,
      factCount: rows.length,
      nonemptySrs,
      nonemptyGradeHistory,
      sourceKeys: rows.map(row => `${row.sourceStore}:${row.sourceKey}`).sort(),
    };
  });
  const total = details.length;
  const srs = details.filter(row => row.nonemptySrs).length;
  const history = details.filter(row => row.nonemptyGradeHistory).length;
  const any = details.filter(row => row.nonemptySrs || row.nonemptyGradeHistory).length;
  return {
    collisionAliasCount: total,
    collisionAliasesWithNonemptySrsCount: srs,
    collisionAliasesWithNonemptySrsRatio: total ? srs / total : 0,
    collisionAliasesWithNonemptyGradeHistoryCount: history,
    collisionAliasesWithNonemptyGradeHistoryRatio: total ? history / total : 0,
    collisionAliasesWithAnyLearningCount: any,
    collisionAliasesWithAnyLearningRatio: total ? any / total : 0,
    details,
  };
}

function stableSerialize(value) {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function smallStableHash(serialized) {
  let hash = 2166136261;
  for (const char of serialized) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function migrationPlanCore(plan) {
  return {
    snapshotId: plan?.snapshotId,
    sourceSnapshotSignature: plan?.sourceSnapshotSignature,
    lineageProvenance: plan?.lineageProvenance,
    resolved: plan?.resolved,
    quarantined: plan?.quarantined,
    summary: plan?.summary,
  };
}

function migrationPlanSignature(plan) {
  return stableSerialize(migrationPlanCore(plan));
}

export function planLegacyMigration({
  legacySnapshot,
  lineageEvidence = null,
  trustedRevisionManifest = null,
} = {}) {
  const snapshotId = requiredIdentity(legacySnapshot?.snapshotId);
  const facts = Array.isArray(legacySnapshot?.facts)
    ? structuredClone(legacySnapshot.facts)
    : [];
  const sourceSnapshotSignature = snapshotSignature({ snapshotId, facts });
  const normalizedEvidence = normalizeLineageEvidence(lineageEvidence, trustedRevisionManifest);
  const lineageProvenance = normalizedEvidence.lineageProvenance || {
    evidenceId: null,
    digest: null,
    revisionManifest: null,
  };
  const snapshots = normalizedEvidence.snapshots;
  const resolved = [];
  const quarantined = [];

  for (const sourceFact of facts) {
    const legacyAlias = typeof sourceFact?.legacyAlias === 'string'
      ? sourceFact.legacyAlias.trim()
      : '';
    let lineage;
    if (sourceFact?.identityKind === 'workspace') {
      lineage = WORKSPACE_FACT_STORES.has(sourceFact.sourceStore)
        ? { status: 'resolved', migrationKind: 'workspace_fact' }
        : { status: 'quarantine', reason: 'workspace_identity_not_allowed' };
    } else if (sourceFact?.identityKind === 'canonical') {
      if (!stableCardId(sourceFact.cardId)) {
        lineage = { status: 'quarantine', reason: 'invalid_lineage_identity' };
      } else if (!normalizedEvidence.complete
          || !normalizedEvidence.canonicalCardIdProven(sourceFact.cardId)) {
        lineage = { status: 'quarantine', reason: 'canonical_identity_unproven' };
      } else {
        lineage = {
          status: 'resolved',
          cardId: sourceFact.cardId.toLowerCase(),
          migrationKind: 'canonical_fact',
        };
      }
    } else {
      lineage = !normalizedEvidence.complete
        ? { status: 'quarantine', reason: 'incomplete_lineage_evidence' }
        : legacyAlias
        ? normalizedEvidence.resolveAlias(legacyAlias)
        : { status: 'quarantine', reason: 'missing_historical_evidence' };
    }
    const row = { ...sourceFact, legacyAlias };
    if (lineage.status === 'resolved') {
      resolved.push({
        ...row,
        ...(lineage.cardId ? { cardId: lineage.cardId } : {}),
        migrationKind: lineage.migrationKind || 'historical_lineage',
      });
    }
    else quarantined.push({ ...row, reason: lineage.reason });
  }

  const summary = {
    original: facts.length,
    resolved: resolved.length,
    quarantined: quarantined.length,
  };
  const conservation = {
    valid: summary.resolved + summary.quarantined === summary.original,
    equation: `${summary.resolved} + ${summary.quarantined} = ${summary.original}`,
  };
  const planCore = {
    snapshotId,
    sourceSnapshotSignature,
    lineageProvenance,
    resolved,
    quarantined,
    summary,
  };
  const planSignature = migrationPlanSignature(planCore);
  return {
    planId: `legacy-migration-${smallStableHash(planSignature)}`,
    planSignature,
    ...planCore,
    conservation,
    audit: migrationAudit(facts, normalizedEvidence.complete ? snapshots : []),
  };
}

function migrationRecordKey(workspaceId, snapshotId, group, row, index) {
  const identity = group === 'resolved'
    ? row.cardId || row.sourceKey || 'workspace-fact'
    : row.legacyAlias || 'no-alias';
  return [
    'workspace', encodeURIComponent(workspaceId),
    'snapshot', encodeURIComponent(snapshotId), group,
    encodeURIComponent(row.sourceStore || 'unknown'),
    encodeURIComponent(identity),
    encodeURIComponent(row.sourceKey || 'no-source-key'),
    String(index),
  ].join(':');
}

function assertClaimAuthorization(authorization, workspace, plan) {
  if (!authorization) {
    throw codedError('CLAIM_AUTHORIZATION_REQUIRED', 'confirmed legacy claim authorization is required');
  }
  if (!issuedClaimAuthorizations.has(authorization)
      || authorization.kind !== 'legacy-claim-authorization-v1'
      || authorization.confirmed !== true) {
    throw codedError('CLAIM_AUTHORIZATION_INVALID', 'legacy claim authorization was not issued here');
  }
  if (authorization.workspaceId !== workspace) {
    throw codedError('CLAIM_WORKSPACE_MISMATCH', 'legacy claim authorization targets another workspace');
  }
  if (authorization.snapshotId !== plan?.snapshotId) {
    throw codedError('CLAIM_SNAPSHOT_MISMATCH', 'legacy claim authorization targets another snapshot');
  }
  if (authorization.sourceSnapshotSignature !== plan?.sourceSnapshotSignature) {
    throw codedError('CLAIM_SNAPSHOT_MISMATCH', 'legacy claim authorization targets other facts');
  }
  if (plan?.planSignature !== migrationPlanSignature(plan)
      || authorization.planId !== plan?.planId
      || authorization.planSignature !== plan?.planSignature) {
    throw codedError('CLAIM_PLAN_MISMATCH', 'legacy claim authorization targets another migration plan');
  }
}

/* This is a synchronous transactional-port contract. verifyRemotePull and
   tx.getClaimEligibility are fail-closed adapter guards; real runtime coordinator
   wiring and browser IndexedDB create/upgrade/abort atomicity need separate proof. */
export async function commitLegacyMigration({
  transactionalPort,
  eligibilityGuard,
  workspaceId,
  plan,
  authorization,
} = {}) {
  const workspace = requiredIdentity(workspaceId);
  assertClaimAuthorization(authorization, workspace, plan);
  if (!transactionalPort || typeof transactionalPort.transaction !== 'function') {
    throw codedError('STORAGE_UNAVAILABLE', 'transactional migration store is unavailable');
  }
  if (!plan?.conservation?.valid
      || plan.summary?.resolved + plan.summary?.quarantined !== plan.summary?.original) {
    throw codedError('MIGRATION_CONSERVATION_FAILED', 'legacy migration is not conservative');
  }
  const verifiedPlan = Object.freeze(structuredClone(plan));
  if (!eligibilityGuard || typeof eligibilityGuard.verifyRemotePull !== 'function') {
    throw codedError(
      'CLAIM_ELIGIBILITY_REVALIDATION_REQUIRED',
      'remote claim eligibility revalidation is required',
    );
  }
  const remoteStillEmpty = await eligibilityGuard.verifyRemotePull({
    workspaceId: workspace,
    receiptId: authorization.remotePullReceiptId,
  });
  if (remoteStillEmpty !== true) {
    throw codedError('CLAIM_ELIGIBILITY_STALE', 'remote claim eligibility is stale');
  }
  const journalKey = `workspace:${encodeURIComponent(workspace)}:claim-journal:${encodeURIComponent(verifiedPlan.snapshotId)}`;

  return transactionalPort.transaction(async tx => {
    if (typeof tx.getClaimEligibility !== 'function') {
      throw codedError(
        'CLAIM_ELIGIBILITY_REVALIDATION_REQUIRED',
        'transactional local eligibility evidence is required',
      );
    }
    const localEligibility = tx.getClaimEligibility(workspace);
    if (localEligibility?.workspaceId !== workspace
        || localEligibility?.revision !== authorization.localRevision
        || !allCountsZero(localEligibility?.counts)) {
      throw codedError('CLAIM_ELIGIBILITY_STALE', 'local claim eligibility is stale');
    }
    const existing = tx.get(journalKey);
    if (existing?.status === 'completed') {
      if (existing.planId !== verifiedPlan.planId
          || existing.planSignature !== verifiedPlan.planSignature) {
        throw codedError('MIGRATION_PLAN_CHANGED', 'completed snapshot has a different migration plan');
      }
      return { status: 'already-applied', summary: structuredClone(existing.summary) };
    }

    verifiedPlan.resolved.forEach((row, index) => {
      tx.set(migrationRecordKey(workspace, verifiedPlan.snapshotId, 'resolved', row, index), {
        sourceSnapshotId: verifiedPlan.snapshotId,
        sourceStore: row.sourceStore,
        sourceKey: row.sourceKey,
        legacyAlias: row.legacyAlias,
        cardId: row.cardId,
        lineageProvenance: structuredClone(verifiedPlan.lineageProvenance),
        value: structuredClone(row.value),
      });
    });
    verifiedPlan.quarantined.forEach((row, index) => {
      tx.set(migrationRecordKey(workspace, verifiedPlan.snapshotId, 'legacy_unresolved', row, index), {
        sourceSnapshotId: verifiedPlan.snapshotId,
        sourceStore: row.sourceStore,
        sourceKey: row.sourceKey,
        legacyAlias: row.legacyAlias,
        reason: row.reason,
        value: structuredClone(row.value),
      });
    });
    const summary = {
      ...structuredClone(verifiedPlan.summary),
      conservationValid: true,
      audit: structuredClone(verifiedPlan.audit),
    };
    tx.set(journalKey, {
      status: 'completed',
      planId: verifiedPlan.planId,
      planSignature: verifiedPlan.planSignature,
      sourceSnapshotId: verifiedPlan.snapshotId,
      lineageProvenance: structuredClone(verifiedPlan.lineageProvenance),
      workspaceId: workspace,
      summary,
    });
    return { status: 'applied', summary };
  });
}
