import assert from 'node:assert/strict';
import test from 'node:test';

import {
  captureLegacyLearningSnapshot,
  commitLegacyMigration,
  evaluateLegacyClaim,
  inspectNamespacedLocalCounts,
  planLegacyMigration,
} from '../src/storage-scope.js';

const CARD_A = '550e8400-e29b-41d4-a716-446655440000';
const CARD_B = '550e8400-e29b-41d4-a716-446655440001';
const CARD_C = '550e8400-e29b-41d4-a716-446655440002';
const CARD_D = '550e8400-e29b-41d4-a716-446655440003';
const CARD_E = '550e8400-e29b-41d4-a716-446655440004';
const EMPTY_LOCAL_COUNTS = {
  state: 0,
  daily: 0,
  history: 0,
  achievements: 0,
  events: 0,
  outbox: 0,
  cycle: 0,
  cursors: 0,
  remoteDays: 0,
  resweep: 0,
};

function fixtureStableSerialize(value) {
  if (Array.isArray(value)) return `[${value.map(fixtureStableSerialize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${fixtureStableSerialize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function fixtureStableHash(serialized) {
  let hash = 2166136261;
  for (const char of serialized) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function fact(sourceStore, sourceKey, legacyAlias, value) {
  return { sourceStore, sourceKey, legacyAlias, value };
}

function snapshot(facts) {
  return { snapshotId: 'legacy-copy-1', facts };
}

function lineageEvidence(entries) {
  return {
    kind: 'production-lineage-evidence-v1',
    evidenceId: `fixture:${entries.map(([revision]) => revision).join('+')}`,
    completeness: 'complete',
    expectedRevisions: entries.map(([revision]) => revision),
    snapshots: entries.map(([revision, aliases]) => ({ revision, aliases, complete: true })),
  };
}

function trustedRevisionManifest(revisions) {
  return {
    kind: 'trusted-lineage-revision-manifest-v1',
    revisions,
    // 歷史 snapshot（v1）格式沒有內容綁定的 evidenceId，production 的 trust manifest
    // 不會開這個旗標；這裡明確開，才能繼續測歷史 lineage 解析邏輯。
    allowHistoricalSnapshotEvidence: true,
  };
}

function completeLineage(entries) {
  return {
    lineageEvidence: lineageEvidence(entries),
    trustedRevisionManifest: trustedRevisionManifest(entries.map(([revision]) => revision)),
  };
}

function workspaceCounts(workspaceId = 'user:A', revision = 'local-empty-1') {
  return { ...EMPTY_LOCAL_COUNTS, workspaceId, revision };
}

function emptyRemotePull(workspaceId = 'user:A', receiptId = 'remote-empty-1') {
  return { completed: true, rowCount: 0, workspaceId, receiptId };
}

function memoryStorage(initial = {}, workspaceId = null) {
  const values = new Map(Object.entries(initial));
  const writes = [];
  return {
    workspaceId,
    writes,
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { writes.push(['set', key, value]); values.set(key, value); },
    removeItem(key) { writes.push(['remove', key]); values.delete(key); },
    raw(key) { return values.get(key); },
  };
}

test('legacy snapshot 唯讀拆出學習 facts，忽略裝置偏好並保持來源 bytes', () => {
  const initial = {
    'thai-review-v1': JSON.stringify({
      settings: { theme: 'dark' },
      currentLessonId: 'L1',
      progress: { 'L1:หนึ่ง': { interval: 3 }, 'L1:สอง': { interval: 1 } },
      edits: { 'L1:หนึ่ง': { thai: 'หนึ่งใหม่' } },
      favorites: { หนึ่ง: { v: 1, ts: 9 } },
    }),
    'thai-review-daily-v1': JSON.stringify({
      v: 1,
      days: { '2026-08-23': { reviewed: 2 }, '2026-08-24': { games: 1 } },
      protection: 1,
    }),
    'thai-review-grade-history-v1': JSON.stringify({ v: 1, cards: { 'L1:หนึ่ง': [[2, 1]] } }),
    'thai-review-achievements-v1': JSON.stringify({ streak7: 123 }),
    'thai-review-resweep-v1': JSON.stringify({ startedAt: 100, position: 2 }),
  };
  const storage = memoryStorage(initial);
  const before = structuredClone(initial);
  const first = captureLegacyLearningSnapshot(storage);
  const second = captureLegacyLearningSnapshot(storage);
  assert.equal(first.status, 'ok');
  assert.equal(first.snapshot.facts.length, 10);
  assert.equal(first.snapshot.snapshotId, second.snapshot.snapshotId);
  assert.equal(first.snapshot.facts.filter(row => row.sourceStore === 'state').length, 2);
  assert.equal(first.snapshot.facts.filter(row => row.sourceStore === 'favorites').length, 1);
  assert.equal(first.snapshot.facts.some(row => row.sourceKey === 'settings'), false);
  assert.equal(first.snapshot.facts.some(row => row.sourceKey === 'currentLessonId'), false);
  assert.deepEqual(storage.writes, []);
  for (const [key, raw] of Object.entries(before)) assert.equal(storage.raw(key), raw);
});

test('legacy 任一 learning store corrupt 時不產生半套 snapshot，也不寫來源', () => {
  const storage = memoryStorage({
    'thai-review-v1': JSON.stringify({ progress: { 'L1:ok': { interval: 1 } } }),
    'thai-review-grade-history-v1': '{broken',
  });
  const result = captureLegacyLearningSnapshot(storage);
  assert.equal(result.status, 'corrupt');
  assert.equal(result.snapshot, undefined);
  assert.deepEqual(storage.writes, []);

  const nullStore = captureLegacyLearningSnapshot(memoryStorage({
    'thai-review-achievements-v1': 'null',
  }));
  assert.equal(nullStore.status, 'corrupt');
  assert.equal(nullStore.snapshot, undefined);
});

test('namespaced local counts 精確覆蓋十個 stores，unknown fact 也阻擋空帳號 claim', () => {
  const storage = memoryStorage({
    'thai-review-v1': JSON.stringify({ progress: {}, favorites: {}, edits: {}, unexpected: { keep: true } }),
    'thai-review-daily-v1': JSON.stringify({ v: 1, days: {} }),
  }, 'user:A');
  const inspected = inspectNamespacedLocalCounts(storage, 'user:A');
  assert.deepEqual(Object.keys(inspected.counts), Object.keys(EMPTY_LOCAL_COUNTS));
  assert.equal(inspected.counts.state, 1);
  assert.equal(typeof inspected.revision, 'string');
  assert.equal(evaluateLegacyClaim({
    namespacedLocalCounts: inspected,
    firstRemotePull: emptyRemotePull(),
    targetWorkspaceId: 'user:A',
  }).status, 'not-offered');
  assert.throws(() => inspectNamespacedLocalCounts(storage, 'user:B'), /another workspace/);
});

test('全空 namespaced stores 產生可綁定、可重現的 zero counts revision', () => {
  const storage = memoryStorage({}, 'user:A');
  const first = inspectNamespacedLocalCounts(storage, 'user:A');
  const second = inspectNamespacedLocalCounts(storage, 'user:A');
  assert.deepEqual(first.counts, EMPTY_LOCAL_COUNTS);
  assert.deepEqual(first, second);
  assert.deepEqual(storage.writes, []);
});

test('inspectNamespacedLocalCounts 的 production shape 可直接通過空 workspace claim gate', () => {
  const legacy = snapshot([
    fact('state', 'progress/unique', 'L1:unique', { grade: 'good' }),
  ]);
  const plan = planLegacyMigration({ legacySnapshot: legacy, ...completeLineage([
    ['r1', { 'L1:unique': [CARD_A] }],
    ['r2', { 'L1:unique': [CARD_A] }],
  ]) });
  const inspected = inspectNamespacedLocalCounts(memoryStorage({}, 'user:A'), 'user:A');
  const offer = evaluateLegacyClaim({
    accountLabel: 'nalin@example.test',
    namespacedLocalCounts: inspected,
    firstRemotePull: emptyRemotePull(),
    legacyFactCount: legacy.facts.length,
    targetWorkspaceId: 'user:A',
    legacySnapshot: legacy,
    migrationPlan: plan,
  });
  assert.equal(offer.status, 'offer');
});

/* In-memory transactional-port fake. It is not evidence that a real browser
   IndexedDB upgrade/abort is atomic. */
function fakeTransactionalPort({
  crashBeforeCommit = false,
  localEligibility = {
    workspaceId: 'user:A',
    revision: 'local-empty-1',
    counts: EMPTY_LOCAL_COUNTS,
  },
} = {}) {
  const values = new Map();
  const srs = new Map();
  const projections = new Map();
  let shouldCrash = crashBeforeCommit;
  let eligibility = structuredClone(localEligibility);
  return {
    values,
    srs,
    projections,
    allowCommit() { shouldCrash = false; },
    setLocalEligibility(next) { eligibility = structuredClone(next); },
    async transaction(work) {
      const staged = new Map(values);
      const stagedSrs = new Map(srs);
      const stagedProjections = new Map(projections);
      const tx = {
        get: key => staged.get(key),
        set: (key, value) => staged.set(key, structuredClone(value)),
        getSrs: cardId => structuredClone(stagedSrs.get(cardId) || null),
        putSrs: row => {
          if (stagedSrs.has(row.cardId)) throw new Error('fake SRS add constraint');
          stagedSrs.set(row.cardId, structuredClone(row));
        },
        getProjection: name => structuredClone(stagedProjections.get(name) || null),
        putProjection: row => {
          if (stagedProjections.has(row.name)) throw new Error('fake projection add constraint');
          stagedProjections.set(row.name, structuredClone(row));
        },
        getClaimEligibility: workspaceId => (
          eligibility?.workspaceId === workspaceId ? structuredClone(eligibility) : null
        ),
      };
      const result = await work(tx);
      if (shouldCrash) throw new Error('simulated crash before commit');
      values.clear();
      for (const [key, value] of staged) values.set(key, value);
      srs.clear();
      for (const [key, value] of stagedSrs) srs.set(key, value);
      projections.clear();
      for (const [key, value] of stagedProjections) projections.set(key, value);
      return result;
    },
  };
}

function eligibilityGuard(workspaceId = 'user:A', receiptId = 'remote-empty-1') {
  return {
    async verifyRemotePull(candidate) {
      return candidate?.workspaceId === workspaceId && candidate?.receiptId === receiptId;
    },
  };
}

function confirmClaim({ legacySnapshot, plan, workspaceId = 'user:A' }) {
  const base = {
    accountLabel: 'nalin@example.test',
    namespacedLocalCounts: workspaceCounts(workspaceId),
    firstRemotePull: emptyRemotePull(workspaceId),
    legacyFactCount: legacySnapshot.facts.length,
    targetWorkspaceId: workspaceId,
    legacySnapshot,
    migrationPlan: plan,
  };
  const offer = evaluateLegacyClaim(base);
  assert.equal(offer.status, 'offer');
  const result = evaluateLegacyClaim({
    ...base,
    decision: 'claim',
    offerToken: offer.offerToken,
  });
  assert.equal(result.status, 'confirmed');
  return result.authorization;
}

test('第一次空帳號只在 local 空、首次 remote pull 為 0 rows 時提出完整 claim', () => {
  const legacy = snapshot([
    fact('state', 'progress/1', 'L1:one', { grade: 'good' }),
    fact('history', 'cards/2', 'L1:two', [[0, 123]]),
    fact('daily', 'days/3', '', { games: ['match'] }),
  ]);
  const plan = planLegacyMigration({ legacySnapshot: legacy, ...completeLineage([
    ['r1', { 'L1:one': [CARD_A], 'L1:two': [CARD_B] }],
    ['r2', { 'L1:one': [CARD_A], 'L1:two': [CARD_B] }],
  ]) });
  const result = evaluateLegacyClaim({
    accountLabel: 'nalin@example.test',
    namespacedLocalCounts: workspaceCounts(),
    firstRemotePull: emptyRemotePull(),
    legacyFactCount: 3,
    targetWorkspaceId: 'user:A',
    legacySnapshot: legacy,
    migrationPlan: plan,
  });

  assert.equal(result.status, 'offer');
  assert.equal(result.accountLabel, 'nalin@example.test');
  assert.equal(result.legacyFactCount, 3);
  assert.deepEqual(result.actions.map(action => action.id), ['claim', 'cancel']);
  assert.match(result.message, /將這台裝置的進度加入此帳號/);
});

test('claim 顯示筆數必須與 legacy snapshot 和 migration plan 完整綁定', () => {
  const legacy = snapshot([
    fact('state', 'progress/unique', 'L1:unique', { grade: 'good' }),
  ]);
  const plan = planLegacyMigration({ legacySnapshot: legacy, ...completeLineage([
    ['r1', { 'L1:unique': [CARD_A] }],
    ['r2', { 'L1:unique': [CARD_A] }],
  ]) });
  const base = {
    accountLabel: 'nalin@example.test',
    namespacedLocalCounts: workspaceCounts(),
    firstRemotePull: emptyRemotePull(),
    legacyFactCount: 1,
    targetWorkspaceId: 'user:A',
    legacySnapshot: legacy,
    migrationPlan: plan,
  };

  for (const overrides of [
    { legacyFactCount: 2 },
    { legacySnapshot: null },
    { migrationPlan: null },
    { legacySnapshot: snapshot([...legacy.facts, legacy.facts[0]]) },
    { migrationPlan: { ...plan, summary: { ...plan.summary, original: 2 } } },
  ]) {
    assert.equal(
      evaluateLegacyClaim({ ...base, ...overrides }).status,
      'not-offered',
    );
  }
});

test('同 snapshotId、同筆數但 facts 不同時不得授權 stale migration plan', () => {
  const confirmedSnapshot = snapshot([
    fact('state', 'progress/confirmed', 'L1:confirmed', { grade: 'good' }),
  ]);
  const staleSnapshot = snapshot([
    fact('state', 'progress/stale', 'L1:stale', { grade: 'again' }),
  ]);
  const entries = [
    ['r1', { 'L1:confirmed': [CARD_A], 'L1:stale': [CARD_B] }],
    ['r2', { 'L1:confirmed': [CARD_A], 'L1:stale': [CARD_B] }],
  ];
  const stalePlan = planLegacyMigration({
    legacySnapshot: staleSnapshot,
    lineageEvidence: lineageEvidence(entries),
    trustedRevisionManifest: trustedRevisionManifest(['r1', 'r2']),
  });

  const result = evaluateLegacyClaim({
    namespacedLocalCounts: workspaceCounts(),
    firstRemotePull: emptyRemotePull(),
    legacyFactCount: 1,
    decision: 'claim',
    targetWorkspaceId: 'user:A',
    legacySnapshot: confirmedSnapshot,
    migrationPlan: stalePlan,
  });
  assert.equal(result.status, 'not-offered');
});

test('選先不要只取消 claim，legacy snapshot 完整不變且不產生 migration plan', () => {
  const legacy = snapshot([fact('state', 'progress/a', 'L1:ก', { grade: 'good' })]);
  const plan = planLegacyMigration({ legacySnapshot: legacy, ...completeLineage([
    ['r1', { 'L1:ก': [CARD_A] }],
    ['r2', { 'L1:ก': [CARD_A] }],
  ]) });
  const before = structuredClone(legacy);
  const result = evaluateLegacyClaim({
    accountLabel: 'nalin@example.test',
    namespacedLocalCounts: workspaceCounts(),
    firstRemotePull: emptyRemotePull(),
    legacyFactCount: 1,
    decision: 'cancel',
    targetWorkspaceId: 'user:A',
    legacySnapshot: legacy,
    migrationPlan: plan,
  });

  assert.equal(result.status, 'cancelled');
  assert.equal(result.plan, null);
  assert.deepEqual(legacy, before);
});

test('claim 必須 consume 同一個 one-shot offer token，字串與 replay 都 fail closed', () => {
  const legacy = snapshot([
    fact('state', 'progress/unique', 'L1:unique', { grade: 'good' }),
  ]);
  const plan = planLegacyMigration({ legacySnapshot: legacy, ...completeLineage([
    ['r1', { 'L1:unique': [CARD_A] }],
    ['r2', { 'L1:unique': [CARD_A] }],
  ]) });
  const base = {
    namespacedLocalCounts: workspaceCounts(),
    firstRemotePull: emptyRemotePull(),
    legacyFactCount: 1,
    targetWorkspaceId: 'user:A',
    legacySnapshot: legacy,
    migrationPlan: plan,
  };
  const offer = evaluateLegacyClaim(base);
  assert.equal(offer.status, 'offer');

  for (const offerToken of [undefined, 'remembered-offer']) {
    assert.throws(
      () => evaluateLegacyClaim({ ...base, decision: 'claim', offerToken }),
      { code: 'CLAIM_CONFIRMATION_REQUIRED' },
    );
  }
  assert.equal(evaluateLegacyClaim({
    ...base,
    decision: 'claim',
    offerToken: offer.offerToken,
  }).status, 'confirmed');
  assert.throws(
    () => evaluateLegacyClaim({
      ...base,
      decision: 'claim',
      offerToken: offer.offerToken,
    }),
    { code: 'CLAIM_CONFIRMATION_REQUIRED' },
  );
});

test('remote 非空或 first pull 未完成時不 claim，也不合併 anonymous data', () => {
  for (const firstRemotePull of [
    { completed: true, rowCount: 2 },
    { completed: false, rowCount: 0 },
  ]) {
    const result = evaluateLegacyClaim({
      accountLabel: 'nalin@example.test',
      namespacedLocalCounts: EMPTY_LOCAL_COUNTS,
      firstRemotePull,
      legacyFactCount: 2,
    });
    assert.equal(result.status, 'not-offered');
    assert.equal(result.mergeAnonymous, false);
  }
});

test('namespaced local 任一 store 非空時不 claim', () => {
  const result = evaluateLegacyClaim({
    accountLabel: 'nalin@example.test',
    namespacedLocalCounts: { ...EMPTY_LOCAL_COUNTS, history: 1 },
    firstRemotePull: { completed: true, rowCount: 0 },
    legacyFactCount: 2,
  });
  assert.equal(result.status, 'not-offered');
  assert.equal(result.mergeAnonymous, false);
});

test('namespaced local store counts 不完整時 fail closed，不可推定為空', () => {
  const result = evaluateLegacyClaim({
    accountLabel: 'nalin@example.test',
    namespacedLocalCounts: { state: 0, events: 0 },
    firstRemotePull: { completed: true, rowCount: 0 },
    legacyFactCount: 2,
  });
  assert.equal(result.status, 'not-offered');
});

test('local store count 必須是 finite nonnegative integer number，弱型別一律 fail closed', () => {
  for (const invalid of [null, false, '', '0', Number.NaN, -1, 0.5, Infinity]) {
    const result = evaluateLegacyClaim({
      accountLabel: 'nalin@example.test',
      namespacedLocalCounts: { ...EMPTY_LOCAL_COUNTS, state: invalid },
      firstRemotePull: { completed: true, rowCount: 0 },
      legacyFactCount: 2,
    });
    assert.equal(result.status, 'not-offered', String(invalid));
  }
});

test('只有 historical-unique alias resolve；current-only、collision、lineage change、無證據全 quarantine', () => {
  const legacy = snapshot([
    fact('state', 'progress/unique', 'L1:unique', { grade: 'good' }),
    fact('state', 'progress/current-only', 'L1:current-only', { grade: 'easy' }),
    fact('state', 'progress/collision', 'L1:collision', { grade: 'hard' }),
    fact('state', 'progress/reused', 'L1:reused', { grade: 'again' }),
    fact('state', 'progress/missing', 'L1:missing', { grade: 'good' }),
  ]);
  const evidence = lineageEvidence([
    ['r1', {
      'L1:unique': [CARD_A],
      'L1:collision': [CARD_B, CARD_C],
      'L1:reused': [CARD_D],
    }],
    ['r2', {
      'L1:unique': [CARD_A],
      'L1:current-only': [CARD_B],
      'L1:collision': [CARD_B],
      'L1:reused': [CARD_E],
    }],
  ]);

  const plan = planLegacyMigration({
    legacySnapshot: legacy,
    lineageEvidence: evidence,
    trustedRevisionManifest: trustedRevisionManifest(evidence.expectedRevisions),
  });
  assert.equal(plan.resolved.length, 1);
  assert.equal(plan.resolved[0].cardId, CARD_A);
  assert.deepEqual(
    Object.fromEntries(plan.quarantined.map(row => [row.legacyAlias, row.reason])),
    {
      'L1:current-only': 'missing_historical_evidence',
      'L1:collision': 'historical_collision',
      'L1:reused': 'lineage_changed',
      'L1:missing': 'missing_historical_evidence',
    },
  );
  assert.equal(plan.summary.resolved + plan.summary.quarantined, plan.summary.original);
  assert.equal(plan.conservation.valid, true);
});

test('caller 只給 current snapshot 或缺 expected revision 時，不得冒充完整 lineage', () => {
  const legacy = snapshot([
    fact('state', 'progress/current', 'L1:current', { grade: 'good' }),
  ]);
  const currentOnly = [{ revision: 'r2', aliases: { 'L1:current': [CARD_A] } }];
  const rawPlan = planLegacyMigration({ legacySnapshot: legacy, catalogSnapshots: currentOnly });
  assert.equal(rawPlan.resolved.length, 0);
  assert.equal(rawPlan.quarantined[0].reason, 'incomplete_lineage_evidence');

  const missingRevision = lineageEvidence([
    ['r2', { 'L1:current': [CARD_A] }],
  ]);
  missingRevision.expectedRevisions = ['r1', 'r2'];
  const incompletePlan = planLegacyMigration({
    legacySnapshot: legacy,
    lineageEvidence: missingRevision,
    trustedRevisionManifest: trustedRevisionManifest(['r1', 'r2']),
  });
  assert.equal(incompletePlan.resolved.length, 0);
  assert.equal(incompletePlan.quarantined[0].reason, 'incomplete_lineage_evidence');
});

test('lineage evidence 必須精確匹配獨立 trusted revision manifest', () => {
  const legacy = snapshot([
    fact('state', 'progress/current', 'L1:current', { grade: 'good' }),
  ]);
  const currentOnly = lineageEvidence([
    ['r2', { 'L1:current': [CARD_A] }],
  ]);
  const requiredHistory = trustedRevisionManifest(['r1', 'r2']);

  for (const trustedRevisionManifestValue of [null, requiredHistory]) {
    const plan = planLegacyMigration({
      legacySnapshot: legacy,
      lineageEvidence: currentOnly,
      trustedRevisionManifest: trustedRevisionManifestValue,
    });
    assert.equal(plan.resolved.length, 0);
    assert.equal(plan.quarantined[0].reason, 'incomplete_lineage_evidence');
  }
});

test('compact production lineage evidence 仍須完整 manifest、partition 與守恆', () => {
  const legacySnapshot = snapshot([
    fact('state', 'progress/stable', 'L1:stable', { interval: 3 }),
    fact('state', 'progress/collision', 'L1:collision', { interval: 1 }),
  ]);
  const evidence = {
    kind: 'production-lineage-evidence-v2',
    schemaVersion: 2,
    generatedAt: '2026-08-24T17:54:31+0800',
    completeness: 'complete',
    expectedRevisions: ['deploy:r1', 'deploy:r2'],
    resolvedAliases: { 'L1:stable': CARD_A },
    unresolvedReasons: { 'L1:collision': 'historical_collision' },
    collisionAliases: ['L1:collision'],
    canonicalCardIds: [CARD_A],
    summary: {
      currentAliasCount: 2,
      resolvedAliasCount: 1,
      unresolvedAliasCount: 1,
      historicalCollisionAliasCount: 1,
    },
  };
  evidence.evidenceId = `production-lineage-evidence-v2:fnv1a32:${fixtureStableHash(fixtureStableSerialize(evidence))}`;
  const manifest = {
    kind: 'trusted-lineage-revision-manifest-v1',
    projectName: 'thai-review',
    environment: 'production',
    sourceManifestSha256: undefined,
    evidenceId: evidence.evidenceId,
    revisions: ['deploy:r1', 'deploy:r2'],
  };
  evidence.source = {
    projectName: 'thai-review',
    environment: 'production',
    deploymentManifestSha256: 'deployment-sha',
  };
  manifest.sourceManifestSha256 = evidence.source.deploymentManifestSha256;
  const { evidenceId: staleEvidenceId, ...evidenceCore } = evidence;
  evidence.evidenceId = `production-lineage-evidence-v2:fnv1a32:${fixtureStableHash(fixtureStableSerialize(evidenceCore))}`;
  manifest.evidenceId = evidence.evidenceId;
  const plan = planLegacyMigration({
    legacySnapshot,
    lineageEvidence: evidence,
    trustedRevisionManifest: manifest,
  });
  assert.equal(plan.summary.resolved, 1);
  assert.equal(plan.summary.quarantined, 1);
  assert.equal(plan.quarantined[0].reason, 'historical_collision');
  assert.equal(plan.audit.collisionAliasCount, 1);

  const tampered = structuredClone(evidence);
  tampered.canonicalCardIds = [];
  const blocked = planLegacyMigration({
    legacySnapshot,
    lineageEvidence: tampered,
    trustedRevisionManifest: manifest,
  });
  assert.equal(blocked.summary.resolved, 0);
  assert.equal(blocked.summary.quarantined, 2);
  assert.deepEqual([...new Set(blocked.quarantined.map(row => row.reason))], ['incomplete_lineage_evidence']);

  const selfConsistentTamper = structuredClone(evidence);
  selfConsistentTamper.resolvedAliases['L1:stable'] = CARD_B;
  selfConsistentTamper.canonicalCardIds = [CARD_B];
  const { evidenceId: ignored, ...tamperedCore } = selfConsistentTamper;
  selfConsistentTamper.evidenceId = `production-lineage-evidence-v2:fnv1a32:${fixtureStableHash(fixtureStableSerialize(tamperedCore))}`;
  const trustBound = planLegacyMigration({
    legacySnapshot,
    lineageEvidence: selfConsistentTamper,
    trustedRevisionManifest: manifest,
  });
  assert.equal(trustBound.summary.resolved, 0);
  assert.equal(trustBound.quarantined[0].reason, 'incomplete_lineage_evidence');

  const wrongSourceTrust = { ...manifest, projectName: 'other-project' };
  const sourceBound = planLegacyMigration({
    legacySnapshot,
    lineageEvidence: evidence,
    trustedRevisionManifest: wrongSourceTrust,
  });
  assert.equal(sourceBound.summary.resolved, 0);
});

test('historical alias 的 stable card ID 在每個 revision 也必須只出現一次', () => {
  const legacy = snapshot([
    fact('state', 'progress/one', 'L1:one', { grade: 'good' }),
  ]);
  const entries = [
    ['r1', { 'L1:one': [CARD_A], 'L1:other': [CARD_A] }],
    ['r2', { 'L1:one': [CARD_A], 'L1:other': [CARD_A] }],
  ];
  const plan = planLegacyMigration({
    legacySnapshot: legacy,
    lineageEvidence: lineageEvidence(entries),
    trustedRevisionManifest: trustedRevisionManifest(['r1', 'r2']),
  });

  assert.equal(plan.resolved.length, 0);
  assert.equal(plan.quarantined[0].reason, 'duplicate_stable_card_id');
});

test('identityKind workspace 只允許真正 workspace facts，card-specific stores 不能繞過 lineage', () => {
  const legacy = snapshot([
    { ...fact('daily', 'days/2026-08-23', null, { reviewed: 2 }), identityKind: 'workspace' },
    { ...fact('state', 'progress/a', null, { grade: 'good' }), identityKind: 'workspace' },
    { ...fact('history', 'cards/a', null, [[2, 123]]), identityKind: 'workspace' },
    { ...fact('resweep', 'position', null, 5), identityKind: 'workspace' },
  ]);
  const plan = planLegacyMigration({ legacySnapshot: legacy, ...completeLineage([
    ['r1', {}],
    ['r2', {}],
  ]) });

  assert.equal(plan.resolved.length, 1);
  assert.equal(plan.resolved[0].sourceStore, 'daily');
  assert.deepEqual(
    plan.quarantined.map(row => [row.sourceStore, row.reason]),
    [
      ['state', 'workspace_identity_not_allowed'],
      ['history', 'workspace_identity_not_allowed'],
      ['resweep', 'workspace_identity_not_allowed'],
    ],
  );
});

test('canonical fact 的 card ID 必須被完整 lineage evidence 證明', () => {
  const legacy = snapshot([
    {
      ...fact('events', 'event-unknown', null, { eventId: 'event-unknown', cardId: CARD_B }),
      identityKind: 'canonical',
      cardId: CARD_B,
    },
    {
      ...fact('events', 'event-spaced', null, { eventId: 'event-spaced', cardId: CARD_A }),
      identityKind: 'canonical',
      cardId: ` ${CARD_A} `,
    },
  ]);
  const evidence = lineageEvidence([
    ['r1', { 'L1:known': [CARD_A] }],
    ['r2', { 'L1:known': [CARD_A] }],
  ]);
  const plan = planLegacyMigration({
    legacySnapshot: legacy,
    lineageEvidence: evidence,
    trustedRevisionManifest: trustedRevisionManifest(evidence.expectedRevisions),
  });
  assert.equal(plan.resolved.length, 0);
  assert.deepEqual(
    plan.quarantined.map(row => row.reason),
    ['canonical_identity_unproven', 'invalid_lineage_identity'],
  );
});

test('collision 的非空 SRS／grade history 筆數、比例與逐筆明細可讀回', () => {
  const legacy = snapshot([
    fact('state', 'progress/collision', 'L1:collision', { grade: 'good' }),
    fact('history', 'cards/collision', 'L1:collision', [[2, 123]]),
    fact('state', 'progress/empty', 'L1:empty-collision', null),
  ]);
  const evidence = lineageEvidence([
    ['r1', {
      'L1:collision': [CARD_A, CARD_B],
      'L1:empty-collision': [CARD_A, CARD_B],
    }],
    ['r2', {
      'L1:collision': [CARD_A],
      'L1:empty-collision': [CARD_A],
    }],
  ]);

  const plan = planLegacyMigration({
    legacySnapshot: legacy,
    lineageEvidence: evidence,
    trustedRevisionManifest: trustedRevisionManifest(evidence.expectedRevisions),
  });
  assert.equal(plan.audit.collisionAliasCount, 2);
  assert.equal(plan.audit.collisionAliasesWithNonemptySrsCount, 1);
  assert.equal(plan.audit.collisionAliasesWithNonemptySrsRatio, 0.5);
  assert.equal(plan.audit.collisionAliasesWithNonemptyGradeHistoryCount, 1);
  assert.equal(plan.audit.collisionAliasesWithAnyLearningCount, 1);
  assert.deepEqual(plan.audit.details[0].legacyAlias, 'L1:collision');
  assert.equal(plan.audit.details[0].nonemptySrs, true);
  assert.equal(plan.audit.details[0].nonemptyGradeHistory, true);
});

test('migration audit 與 planner 使用相同 trimmed alias normalization', () => {
  const legacy = snapshot([
    fact('state', 'progress/spaced', ' L1:collision ', { grade: 'good' }),
  ]);
  const entries = [
    ['r1', { 'L1:collision': [CARD_A, CARD_B] }],
    ['r2', { 'L1:collision': [CARD_A] }],
  ];
  const plan = planLegacyMigration({ legacySnapshot: legacy, ...completeLineage(entries) });

  assert.equal(plan.quarantined[0].reason, 'historical_collision');
  assert.equal(plan.audit.details[0].factCount, 1);
  assert.equal(plan.audit.details[0].nonemptySrs, true);
  assert.deepEqual(plan.audit.details[0].sourceKeys, ['state:progress/spaced']);
});

test('plan signature、journal 與 resolved record 保留 trusted lineage provenance', async () => {
  const legacy = snapshot([
    fact('state', 'progress/unique', 'L1:unique', { grade: 'good' }),
  ]);
  const entries = [
    ['r1', { 'L1:unique': [CARD_A] }],
    ['r2', { 'L1:unique': [CARD_A] }],
  ];
  const changedEvidenceEntries = [
    ['r1', { 'L1:unique': [CARD_A], 'L1:unused': [CARD_C] }],
    ['r2', { 'L1:unique': [CARD_A], 'L1:unused': [CARD_C] }],
  ];
  const plan = planLegacyMigration({ legacySnapshot: legacy, ...completeLineage(entries) });
  const changedEvidencePlan = planLegacyMigration({
    legacySnapshot: legacy,
    ...completeLineage(changedEvidenceEntries),
  });

  assert.equal(plan.lineageProvenance.evidenceId, 'fixture:r1+r2');
  assert.equal(typeof plan.lineageProvenance.digest, 'string');
  assert.deepEqual(plan.lineageProvenance.revisionManifest, {
    kind: 'trusted-lineage-revision-manifest-v1',
    revisions: ['r1', 'r2'],
  });
  assert.notEqual(plan.planSignature, changedEvidencePlan.planSignature);

  const authorization = confirmClaim({ legacySnapshot: legacy, plan });
  const store = fakeTransactionalPort();
  await commitLegacyMigration({
    transactionalPort: store,
    eligibilityGuard: eligibilityGuard(),
    workspaceId: 'user:A',
    plan,
    authorization,
  });
  const resolvedRecord = [...store.values.entries()]
    .find(([key]) => key.includes(':resolved:'))[1];
  const journal = [...store.values.entries()]
    .find(([key]) => key.includes(':claim-journal:'))[1];
  assert.deepEqual(resolvedRecord.lineageProvenance, plan.lineageProvenance);
  assert.deepEqual(journal.lineageProvenance, plan.lineageProvenance);
});

test('daily／achievements／favorites workspace facts 可直接保留，canonical event identity 不改寫', () => {
  const event = {
    eventId: 'event-1',
    cardId: CARD_A,
    eventKind: 'practice-first',
  };
  const legacy = snapshot([
    { ...fact('daily', 'days/2026-08-23', null, { reviewed: 2 }), identityKind: 'workspace' },
    { ...fact('achievements', 'streak7', null, 123), identityKind: 'workspace' },
    {
      ...fact('favorites', 'หนึ่ง', null, { thai: 'หนึ่ง', favorite: { v: 1, ts: 9 } }),
      identityKind: 'workspace',
    },
    {
      ...fact('events', 'event-1', null, event),
      identityKind: 'canonical',
      cardId: CARD_A,
    },
  ]);

  const evidence = lineageEvidence([
    ['r1', { 'L1:event': [CARD_A] }],
    ['r2', { 'L1:event': [CARD_A] }],
  ]);
  const plan = planLegacyMigration({
    legacySnapshot: legacy,
    lineageEvidence: evidence,
    trustedRevisionManifest: trustedRevisionManifest(evidence.expectedRevisions),
  });
  assert.equal(plan.summary.resolved, 4);
  assert.equal(plan.summary.quarantined, 0);
  assert.equal(plan.resolved.find(row => row.sourceStore === 'favorites').migrationKind, 'workspace_fact');
  assert.deepEqual(plan.resolved.find(row => row.sourceStore === 'events').value, event);
  assert.equal(plan.resolved.find(row => row.sourceStore === 'events').value.userWorkspace, undefined);
});

test('migration plan 只把可無損還原的 SRS 與版本化 workspace facts 排入權威 materialization', () => {
  const legacy = snapshot([
    fact('state', 'progress/one', 'L1:one', {
      grade: 'good', reviewedAt: 10, nextReviewAt: 20,
      interval: 3, easeFactor: 2.5, reps: 2, updatedAt: 10, deviceId: 'legacy-device',
    }),
    fact('history', 'cards/one', 'L1:one', [[2, 10]]),
    fact('edits', 'edits/one', 'L1:one', { thai: 'แก้ไข' }),
    { ...fact('daily', '2026-08-24', null, { reviewed: 1 }), identityKind: 'workspace' },
    { ...fact('favorites', 'หนึ่ง', null, { thai: 'หนึ่ง', favorite: { v: 1, ts: 9 } }), identityKind: 'workspace' },
    {
      ...fact('events', 'event-1', null, { eventId: 'event-1', cardId: CARD_A }),
      identityKind: 'canonical', cardId: CARD_A,
    },
    fact('state', 'progress/collision', 'L1:collision', { grade: 'hard' }),
  ]);
  const plan = planLegacyMigration({ legacySnapshot: legacy, ...completeLineage([
    ['r1', { 'L1:one': [CARD_A], 'L1:collision': [CARD_B, CARD_C] }],
    ['r2', { 'L1:one': [CARD_A], 'L1:collision': [CARD_B] }],
  ]) });

  assert.equal(plan.summary.original, 7);
  assert.equal(plan.summary.resolved, 6);
  assert.equal(plan.summary.quarantined, 1);
  assert.equal(plan.summary.materialized, 3);
  assert.equal(plan.summary.materializedSrs, 1);
  assert.equal(plan.summary.materializedProjectionFacts, 2);
  assert.equal(plan.summary.auditOnly, 3);
  assert.deepEqual(plan.materializations.srs.map(row => row.cardId), [CARD_A]);
  assert.deepEqual(
    plan.materializations.projections.map(row => [row.name, row.facts.length]),
    [['daily', 1], ['favorites', 1]],
  );
  assert.deepEqual(
    plan.resolved.filter(row => !row.materialization).map(row => row.sourceStore).sort(),
    ['edits', 'events', 'history'],
  );
});

test('legacy string、壞數值與同 card 多筆 progress 都只留 audit，不猜權威 SRS', () => {
  const legacy = snapshot([
    fact('state', 'progress/string', 'L1:string', 'good'),
    fact('state', 'progress/bad-number', 'L1:bad-number', { grade: 'good', interval: '3' }),
    fact('state', 'progress/unknown-key', 'L1:unknown-key', { grade: 'good', workspaceId: 'user:A' }),
    fact('state', 'progress/fractional-reps', 'L1:fractional-reps', { grade: 'good', reps: 1.5 }),
    fact('state', 'progress/duplicate-a', 'L1:duplicate', { grade: 'good' }),
    fact('state', 'progress/duplicate-b', 'L1:duplicate', { grade: 'easy' }),
  ]);
  const plan = planLegacyMigration({ legacySnapshot: legacy, ...completeLineage([
    ['r1', {
      'L1:string': [CARD_A], 'L1:bad-number': [CARD_B], 'L1:duplicate': [CARD_C],
      'L1:unknown-key': [CARD_D], 'L1:fractional-reps': [CARD_E],
    }],
    ['r2', {
      'L1:string': [CARD_A], 'L1:bad-number': [CARD_B], 'L1:duplicate': [CARD_C],
      'L1:unknown-key': [CARD_D], 'L1:fractional-reps': [CARD_E],
    }],
  ]) });

  assert.equal(plan.summary.resolved, 6);
  assert.equal(plan.summary.materializedSrs, 0);
  assert.equal(plan.summary.auditOnly, 6);
  assert.deepEqual(plan.materializations.srs, []);
});

test('同 stable card 合法 progress 混到非法物件或字串時整組 audit only', () => {
  const legacy = snapshot([
    fact('state', 'progress/mixed-valid-a', 'L1:mixed-a', { grade: 'good', interval: 3 }),
    fact('state', 'progress/mixed-invalid', 'L1:mixed-a', { grade: 'good', interval: '3' }),
    fact('state', 'progress/mixed-valid-b', 'L1:mixed-b', { grade: 'easy', interval: 7 }),
    fact('state', 'progress/mixed-string', 'L1:mixed-b', 'easy'),
  ]);
  const plan = planLegacyMigration({ legacySnapshot: legacy, ...completeLineage([
    ['r1', { 'L1:mixed-a': [CARD_A], 'L1:mixed-b': [CARD_B] }],
    ['r2', { 'L1:mixed-a': [CARD_A], 'L1:mixed-b': [CARD_B] }],
  ]) });

  assert.equal(plan.summary.resolved, 4);
  assert.equal(plan.summary.materialized, 0);
  assert.equal(plan.summary.materializedSrs, 0);
  assert.equal(plan.summary.auditOnly, 4);
  assert.ok(plan.summary.auditOnly >= 0);
  assert.deepEqual(plan.materializations.srs, []);
});

test('transaction fake 使用 add semantics，duplicate authoritative key 整筆 rollback', async () => {
  const store = fakeTransactionalPort();
  await assert.rejects(store.transaction(async tx => {
    await tx.putSrs({ cardId: CARD_A, state: { grade: 'good' } });
    await tx.putProjection({ name: 'daily', facts: [] });
    await tx.putSrs({ cardId: CARD_A, state: { grade: 'easy' } });
  }), /fake SRS add constraint/);
  assert.equal(store.srs.size, 0);
  assert.equal(store.projections.size, 0);
});

test('claim transaction 同時 materialize、保留 audit，quarantine 永不進權威 projection', async () => {
  const srsState = {
    grade: 'good', reviewedAt: 10, nextReviewAt: 20,
    interval: 3, easeFactor: 2.5, reps: 2, updatedAt: 10, deviceId: 'legacy-device',
  };
  const legacy = snapshot([
    fact('state', 'progress/one', 'L1:one', srsState),
    fact('history', 'cards/one', 'L1:one', [[2, 10]]),
    { ...fact('daily', '2026-08-24', null, { reviewed: 1 }), identityKind: 'workspace' },
    fact('state', 'progress/collision', 'L1:collision', { grade: 'hard' }),
  ]);
  const plan = planLegacyMigration({ legacySnapshot: legacy, ...completeLineage([
    ['r1', { 'L1:one': [CARD_A], 'L1:collision': [CARD_B, CARD_C] }],
    ['r2', { 'L1:one': [CARD_A], 'L1:collision': [CARD_B] }],
  ]) });
  const authorization = confirmClaim({ legacySnapshot: legacy, plan });
  const store = fakeTransactionalPort();

  const result = await commitLegacyMigration({
    transactionalPort: store,
    eligibilityGuard: eligibilityGuard(),
    workspaceId: 'user:A',
    plan,
    authorization,
  });

  assert.equal(result.status, 'applied');
  assert.deepEqual(store.srs.get(CARD_A), {
    workspaceId: 'user:A', cardId: CARD_A, version: 0,
    state: srsState, sourceEventId: null,
    migration: {
      kind: 'legacy-progress-v1', snapshotId: legacy.snapshotId,
      sourceStore: 'state', sourceKey: 'progress/one',
    },
  });
  assert.equal(store.srs.has(CARD_B), false);
  assert.deepEqual(store.projections.get('daily'), {
    workspaceId: 'user:A', name: 'daily', schemaVersion: 1,
    projectorVersion: 'legacy-workspace-facts-v1', sourceSnapshotId: legacy.snapshotId,
    facts: [{ sourceStore: 'daily', sourceKey: '2026-08-24', value: { reviewed: 1 } }],
  });
  assert.equal(store.projections.size, 1);
  assert.equal([...store.values.keys()].filter(key => key.includes(':resolved:')).length, 3);
  assert.equal([...store.values.keys()].filter(key => key.includes(':legacy_unresolved:')).length, 1);
});

test('legacy materialization 不覆蓋任何已存在的 authoritative SRS', async () => {
  const legacy = snapshot([
    fact('state', 'progress/one', 'L1:one', { grade: 'good', updatedAt: 10 }),
  ]);
  const plan = planLegacyMigration({ legacySnapshot: legacy, ...completeLineage([
    ['r1', { 'L1:one': [CARD_A] }],
    ['r2', { 'L1:one': [CARD_A] }],
  ]) });
  const authorization = confirmClaim({ legacySnapshot: legacy, plan });
  const store = fakeTransactionalPort();
  const newer = {
    workspaceId: 'user:A', cardId: CARD_A, version: 4,
    state: { grade: 'easy', updatedAt: 999 }, sourceEventId: 'newer-event',
  };
  store.srs.set(CARD_A, structuredClone(newer));

  await assert.rejects(commitLegacyMigration({
    transactionalPort: store,
    eligibilityGuard: eligibilityGuard(),
    workspaceId: 'user:A',
    plan,
    authorization,
  }), error => error.code === 'MIGRATION_AUTHORITATIVE_CONFLICT');
  assert.deepEqual(store.srs.get(CARD_A), newer);
  assert.equal(store.values.size, 0);
});

test('claim confirmation 產生不可偽造且綁定 workspace/snapshot/plan 的 authorization', async () => {
  const legacy = snapshot([
    fact('state', 'progress/unique', 'L1:unique', { grade: 'good' }),
  ]);
  const plan = planLegacyMigration({ legacySnapshot: legacy, ...completeLineage([
    ['r1', { 'L1:unique': [CARD_A] }],
    ['r2', { 'L1:unique': [CARD_A] }],
  ]) });
  const authorization = confirmClaim({ legacySnapshot: legacy, plan });

  await assert.rejects(
    commitLegacyMigration({ transactionalPort: fakeTransactionalPort(), workspaceId: 'user:A', plan }),
    error => error.code === 'CLAIM_AUTHORIZATION_REQUIRED',
  );
  await assert.rejects(
    commitLegacyMigration({
      transactionalPort: fakeTransactionalPort(), workspaceId: 'user:A', plan,
      authorization: { ...authorization },
    }),
    error => error.code === 'CLAIM_AUTHORIZATION_INVALID',
  );
  await assert.rejects(
    commitLegacyMigration({
      transactionalPort: fakeTransactionalPort(), workspaceId: 'user:B', plan, authorization,
    }),
    error => error.code === 'CLAIM_WORKSPACE_MISMATCH',
  );
  await assert.rejects(
    commitLegacyMigration({
      transactionalPort: fakeTransactionalPort(), workspaceId: 'user:A',
      plan: { ...plan, snapshotId: 'other-snapshot' }, authorization,
    }),
    error => error.code === 'CLAIM_SNAPSHOT_MISMATCH',
  );
  await assert.rejects(
    commitLegacyMigration({
      transactionalPort: fakeTransactionalPort(), workspaceId: 'user:A',
      plan: { ...plan, planId: 'other-plan' }, authorization,
    }),
    error => error.code === 'CLAIM_PLAN_MISMATCH',
  );
  await assert.rejects(
    commitLegacyMigration({
      transactionalPort: fakeTransactionalPort(), workspaceId: 'user:A',
      plan: { ...plan, resolved: [] }, authorization,
    }),
    error => error.code === 'CLAIM_PLAN_MISMATCH',
  );
});

test('local counts 與 remote pull evidence 必須綁定 claim target workspace', () => {
  const legacy = snapshot([
    fact('state', 'progress/unique', 'L1:unique', { grade: 'good' }),
  ]);
  const entries = [
    ['r1', { 'L1:unique': [CARD_A] }],
    ['r2', { 'L1:unique': [CARD_A] }],
  ];
  const plan = planLegacyMigration({
    legacySnapshot: legacy,
    lineageEvidence: lineageEvidence(entries),
    trustedRevisionManifest: trustedRevisionManifest(['r1', 'r2']),
  });
  const base = {
    legacyFactCount: 1,
    decision: 'claim',
    targetWorkspaceId: 'user:B',
    legacySnapshot: legacy,
    migrationPlan: plan,
  };

  assert.equal(evaluateLegacyClaim({
    ...base,
    namespacedLocalCounts: workspaceCounts('user:A'),
    firstRemotePull: emptyRemotePull('user:B'),
  }).status, 'not-offered');
  assert.equal(evaluateLegacyClaim({
    ...base,
    namespacedLocalCounts: workspaceCounts('user:B'),
    firstRemotePull: emptyRemotePull('user:A'),
  }).status, 'not-offered');
});

test('authorization 綁 local revision／remote receipt，commit 對 stale evidence fail closed', async () => {
  const legacy = snapshot([
    fact('state', 'progress/unique', 'L1:unique', { grade: 'good' }),
  ]);
  const entries = [
    ['r1', { 'L1:unique': [CARD_A] }],
    ['r2', { 'L1:unique': [CARD_A] }],
  ];
  const plan = planLegacyMigration({
    legacySnapshot: legacy,
    lineageEvidence: lineageEvidence(entries),
    trustedRevisionManifest: trustedRevisionManifest(['r1', 'r2']),
  });
  const claimInput = {
    namespacedLocalCounts: workspaceCounts(),
    firstRemotePull: emptyRemotePull(),
    legacyFactCount: 1,
    targetWorkspaceId: 'user:A',
    legacySnapshot: legacy,
    migrationPlan: plan,
  };
  const offer = evaluateLegacyClaim(claimInput);
  const confirmation = evaluateLegacyClaim({
    ...claimInput,
    decision: 'claim',
    offerToken: offer.offerToken,
  });
  assert.equal(confirmation.status, 'confirmed');
  assert.equal(confirmation.authorization.localRevision, 'local-empty-1');
  assert.equal(confirmation.authorization.remotePullReceiptId, 'remote-empty-1');

  await assert.rejects(
    commitLegacyMigration({
      transactionalPort: fakeTransactionalPort(),
      workspaceId: 'user:A',
      plan,
      authorization: confirmation.authorization,
    }),
    error => error.code === 'CLAIM_ELIGIBILITY_REVALIDATION_REQUIRED',
  );

  await assert.rejects(
    commitLegacyMigration({
      transactionalPort: {
        async transaction(work) {
          return work({ get: () => null, set: () => {} });
        },
      },
      eligibilityGuard: eligibilityGuard(),
      workspaceId: 'user:A',
      plan,
      authorization: confirmation.authorization,
    }),
    error => error.code === 'CLAIM_ELIGIBILITY_REVALIDATION_REQUIRED',
  );

  const remoteStaleStore = fakeTransactionalPort();
  await assert.rejects(
    commitLegacyMigration({
      transactionalPort: remoteStaleStore,
      eligibilityGuard: eligibilityGuard('user:A', 'different-receipt'),
      workspaceId: 'user:A',
      plan,
      authorization: confirmation.authorization,
    }),
    error => error.code === 'CLAIM_ELIGIBILITY_STALE',
  );
  assert.equal(remoteStaleStore.values.size, 0);

  const localStaleStore = fakeTransactionalPort({
    localEligibility: {
      workspaceId: 'user:A',
      revision: 'local-changed-2',
      counts: { ...EMPTY_LOCAL_COUNTS, history: 1 },
    },
  });
  await assert.rejects(
    commitLegacyMigration({
      transactionalPort: localStaleStore,
      eligibilityGuard: eligibilityGuard(),
      workspaceId: 'user:A',
      plan,
      authorization: confirmation.authorization,
    }),
    error => error.code === 'CLAIM_ELIGIBILITY_STALE',
  );
  assert.equal(localStaleStore.values.size, 0);
});

test('remote revalidation pending 時突變 caller plan，不影響已驗證 snapshot 的 writes 與 journal', async () => {
  const legacy = snapshot([
    fact('state', 'progress/unique', 'L1:unique', { grade: 'good' }),
  ]);
  const plan = planLegacyMigration({ legacySnapshot: legacy, ...completeLineage([
    ['r1', { 'L1:unique': [CARD_A] }],
    ['r2', { 'L1:unique': [CARD_A] }],
  ]) });
  const verifiedVersion = structuredClone(plan);
  const authorization = confirmClaim({ legacySnapshot: legacy, plan });
  const store = fakeTransactionalPort();
  let releaseRemote;
  const remotePending = new Promise(resolve => { releaseRemote = resolve; });
  const committing = commitLegacyMigration({
    transactionalPort: store,
    eligibilityGuard: {
      async verifyRemotePull() { return remotePending; },
    },
    workspaceId: 'user:A',
    plan,
    authorization,
  });

  plan.planId = 'mutated-plan';
  plan.resolved[0].sourceKey = 'progress/mutated';
  plan.resolved[0].value.grade = 'again';
  releaseRemote(true);
  await committing;

  const resolvedRecord = [...store.values.entries()]
    .find(([key]) => key.includes(':resolved:'))[1];
  const journal = [...store.values.entries()]
    .find(([key]) => key.includes(':claim-journal:'))[1];
  assert.equal(resolvedRecord.sourceKey, verifiedVersion.resolved[0].sourceKey);
  assert.deepEqual(resolvedRecord.value, verifiedVersion.resolved[0].value);
  assert.equal(journal.planId, verifiedVersion.planId);
  assert.equal(journal.planSignature, verifiedVersion.planSignature);
});

test('cancel 沒有 authorization，不能 commit', async () => {
  const legacy = snapshot([
    fact('state', 'progress/unique', 'L1:unique', { grade: 'good' }),
  ]);
  const plan = planLegacyMigration({ legacySnapshot: legacy, ...completeLineage([
    ['r1', { 'L1:unique': [CARD_A] }],
    ['r2', { 'L1:unique': [CARD_A] }],
  ]) });
  const cancelled = evaluateLegacyClaim({
    accountLabel: 'nalin@example.test',
    namespacedLocalCounts: workspaceCounts(),
    firstRemotePull: emptyRemotePull(),
    legacyFactCount: 1,
    decision: 'cancel',
    targetWorkspaceId: 'user:A',
    legacySnapshot: legacy,
    migrationPlan: plan,
  });
  assert.equal(cancelled.authorization, undefined);
  await assert.rejects(
    commitLegacyMigration({
      transactionalPort: fakeTransactionalPort(), workspaceId: 'user:A', plan,
      authorization: cancelled.authorization,
    }),
    error => error.code === 'CLAIM_AUTHORIZATION_REQUIRED',
  );
});

test('migration crash 後無半套寫入，重跑冪等且 resolved + quarantined = original', async () => {
  const legacy = snapshot([
    fact('state', 'progress/unique', 'L1:unique', { grade: 'good' }),
    fact('history', 'cards/collision', 'L1:collision', [[0, 123]]),
  ]);
  const evidence = lineageEvidence([
    ['r1', { 'L1:unique': [CARD_A], 'L1:collision': [CARD_B, CARD_C] }],
    ['r2', { 'L1:unique': [CARD_A], 'L1:collision': [CARD_B] }],
  ]);
  const plan = planLegacyMigration({
    legacySnapshot: legacy,
    lineageEvidence: evidence,
    trustedRevisionManifest: trustedRevisionManifest(evidence.expectedRevisions),
  });
  const authorization = confirmClaim({ legacySnapshot: legacy, plan });
  const store = fakeTransactionalPort({ crashBeforeCommit: true });

  await assert.rejects(
    commitLegacyMigration({
      transactionalPort: store,
      eligibilityGuard: eligibilityGuard(),
      workspaceId: 'user:A',
      plan,
      authorization,
    }),
    /simulated crash/,
  );
  assert.equal(store.values.size, 0);
  assert.equal(store.srs.size, 0);
  assert.equal(store.projections.size, 0);

  store.allowCommit();
  const first = await commitLegacyMigration({
    transactionalPort: store,
    eligibilityGuard: eligibilityGuard(),
    workspaceId: 'user:A',
    plan,
    authorization,
  });
  const afterFirst = structuredClone([...store.values.entries()]);
  const srsAfterFirst = structuredClone([...store.srs.entries()]);
  store.setLocalEligibility({
    workspaceId: 'user:A',
    revision: 'local-now-nonempty',
    counts: { ...EMPTY_LOCAL_COUNTS, events: 1 },
  });
  const second = await commitLegacyMigration({
    transactionalPort: store,
    eligibilityGuard: eligibilityGuard(),
    workspaceId: 'user:A',
    plan,
    authorization,
  });

  assert.equal(first.status, 'applied');
  assert.equal(second.status, 'already-applied');
  assert.deepEqual([...store.values.entries()], afterFirst);
  assert.deepEqual([...store.srs.entries()], srsAfterFirst);
  assert.equal(first.summary.resolved + first.summary.quarantined, first.summary.original);
  assert.equal(first.summary.conservationValid, true);
  const records = [...store.values.entries()]
    .filter(([key]) => !key.includes(':claim-journal:'))
    .map(([, value]) => value);
  assert.deepEqual(records, [
    {
      sourceSnapshotId: 'legacy-copy-1',
      sourceStore: 'state',
      sourceKey: 'progress/unique',
      legacyAlias: 'L1:unique',
      cardId: CARD_A,
      lineageProvenance: plan.lineageProvenance,
      value: { grade: 'good' },
    },
    {
      sourceSnapshotId: 'legacy-copy-1',
      sourceStore: 'history',
      sourceKey: 'cards/collision',
      legacyAlias: 'L1:collision',
      reason: 'historical_collision',
      value: [[0, 123]],
    },
  ]);
  assert.notStrictEqual(records[0].value, plan.resolved[0].value);
  assert.notStrictEqual(records[1].value, plan.quarantined[0].value);
});

test('先前匯入資料存在時，不同 snapshot 的 claim fail closed', async () => {
  const entries = [
    ['r1', { 'L1:unique': [CARD_A] }],
    ['r2', { 'L1:unique': [CARD_A] }],
  ];
  const firstSnapshot = {
    snapshotId: 'legacy-copy-1',
    facts: [fact('state', 'progress/unique', 'L1:unique', { grade: 'good' })],
  };
  const secondSnapshot = {
    snapshotId: 'legacy-copy-2',
    facts: [fact('state', 'progress/unique', 'L1:unique', { grade: 'easy' })],
  };
  const migrationInput = legacySnapshot => ({
    legacySnapshot,
    lineageEvidence: lineageEvidence(entries),
    trustedRevisionManifest: trustedRevisionManifest(['r1', 'r2']),
  });
  const firstPlan = planLegacyMigration(migrationInput(firstSnapshot));
  const secondPlan = planLegacyMigration(migrationInput(secondSnapshot));
  const firstAuthorization = confirmClaim({ legacySnapshot: firstSnapshot, plan: firstPlan });
  const secondAuthorization = confirmClaim({ legacySnapshot: secondSnapshot, plan: secondPlan });
  const store = fakeTransactionalPort();

  await commitLegacyMigration({
    transactionalPort: store,
    eligibilityGuard: eligibilityGuard(),
    workspaceId: 'user:A',
    plan: firstPlan,
    authorization: firstAuthorization,
  });
  store.setLocalEligibility({
    workspaceId: 'user:A',
    revision: 'local-prior-imports',
    counts: { ...EMPTY_LOCAL_COUNTS, events: 2 },
  });
  await assert.rejects(commitLegacyMigration({
    transactionalPort: store,
    eligibilityGuard: eligibilityGuard(),
    workspaceId: 'user:A',
    plan: secondPlan,
    authorization: secondAuthorization,
  }), error => error.code === 'CLAIM_ELIGIBILITY_STALE');

  assert.equal(store.values.size, 2, 'first snapshot record + journal only');
  const snapshotRecords = [...store.values.entries()]
    .filter(([key]) => !key.includes(':claim-journal:'));
  assert.match(snapshotRecords[0][0], /snapshot:legacy-copy-1/);
  assert.deepEqual(snapshotRecords[0][1].value, { grade: 'good' });
  assert.equal(snapshotRecords.some(([key]) => key.includes('legacy-copy-2')), false);
});

test('相同 source key 的重複 facts 仍逐筆保存，不被 storage key 覆寫', async () => {
  const duplicateFacts = snapshot([
    fact('history', 'cards/duplicate', 'L1:unique', [[0, 123]]),
    fact('history', 'cards/duplicate', 'L1:unique', [[2, 456]]),
  ]);
  const evidence = lineageEvidence([
    ['r1', { 'L1:unique': [CARD_A] }],
    ['r2', { 'L1:unique': [CARD_A] }],
  ]);
  const plan = planLegacyMigration({
    legacySnapshot: duplicateFacts,
    lineageEvidence: evidence,
    trustedRevisionManifest: trustedRevisionManifest(evidence.expectedRevisions),
  });
  const authorization = confirmClaim({ legacySnapshot: duplicateFacts, plan });
  const store = fakeTransactionalPort();

  await commitLegacyMigration({
    transactionalPort: store,
    eligibilityGuard: eligibilityGuard(),
    workspaceId: 'user:A',
    plan,
    authorization,
  });
  assert.equal(store.values.size, 3, '2 facts + 1 claim journal');
  assert.deepEqual(
    [...store.values.entries()]
      .filter(([key]) => !key.includes(':claim-journal:'))
      .map(([, value]) => value.value),
    [[[0, 123]], [[2, 456]]],
  );
});

/* --- lineage 信任邊界（CWE-345 迴歸） ---
   v1 的 evidenceId 從來沒有從內容重算過，複製一份公開的 evidenceId 就能塞任意
   alias 對應；v2 的 evidenceId 是 32-bit FNV，塞得進未知欄位就有空間湊碰撞。 */

function forgedHistoricalEvidence(aliases) {
  return {
    kind: 'production-lineage-evidence-v1',
    evidenceId: 'production-lineage-evidence-v2:fnv1a32:05c747d1',
    completeness: 'complete',
    expectedRevisions: ['deploy:r1'],
    snapshots: [{ revision: 'deploy:r1', complete: true, aliases }],
  };
}

test('偽造的 v1 lineage 在 production trust manifest 下不被採信', () => {
  const legacySnapshot = snapshot([fact('state', 'progress/x', 'L1:x', { interval: 3 })]);
  const productionShapedManifest = {
    kind: 'trusted-lineage-revision-manifest-v1',
    projectName: 'thai-review',
    environment: 'production',
    evidenceId: 'production-lineage-evidence-v2:fnv1a32:05c747d1',
    revisions: ['deploy:r1'],
  };

  const plan = planLegacyMigration({
    legacySnapshot,
    lineageEvidence: forgedHistoricalEvidence({ 'L1:x': [CARD_A] }),
    trustedRevisionManifest: productionShapedManifest,
  });

  assert.equal(plan.summary.resolved, 0, '偽造證據不可以解出任何 alias');
  assert.equal(plan.summary.quarantined, 1);
  assert.notEqual(plan.lineageProvenance?.evidenceId, productionShapedManifest.evidenceId);
});

test('同一份 v1 證據在明確開旗標的 manifest 下才收', () => {
  const legacySnapshot = snapshot([fact('state', 'progress/x', 'L1:x', { interval: 3 })]);

  const plan = planLegacyMigration({
    legacySnapshot,
    lineageEvidence: forgedHistoricalEvidence({ 'L1:x': [CARD_A] }),
    trustedRevisionManifest: {
      kind: 'trusted-lineage-revision-manifest-v1',
      revisions: ['deploy:r1'],
      allowHistoricalSnapshotEvidence: true,
    },
  });

  assert.equal(plan.summary.resolved, 1, '旗標開了就走原本的歷史解析路徑');
});

test('v2 lineage 夾帶未知 top-level 欄位整份不收', () => {
  const legacySnapshot = snapshot([fact('state', 'progress/stable', 'L1:stable', { interval: 3 })]);
  const evidence = {
    kind: 'production-lineage-evidence-v2',
    schemaVersion: 2,
    generatedAt: '2026-08-24T17:54:31+0800',
    completeness: 'complete',
    expectedRevisions: ['deploy:r1'],
    source: {
      projectName: 'thai-review',
      environment: 'production',
      deploymentManifestSha256: 'deployment-sha',
    },
    resolvedAliases: { 'L1:stable': CARD_A },
    unresolvedReasons: {},
    collisionAliases: [],
    canonicalCardIds: [CARD_A],
    summary: {
      currentAliasCount: 1,
      resolvedAliasCount: 1,
      unresolvedAliasCount: 0,
      historicalCollisionAliasCount: 0,
    },
    nonce: '⁠⁠⁠⁠',   // 碰撞用的填充欄位
  };
  const { evidenceId: _unused, ...evidenceCore } = evidence;
  evidence.evidenceId = `production-lineage-evidence-v2:fnv1a32:${fixtureStableHash(fixtureStableSerialize(evidenceCore))}`;

  const plan = planLegacyMigration({
    legacySnapshot,
    lineageEvidence: evidence,
    trustedRevisionManifest: {
      kind: 'trusted-lineage-revision-manifest-v1',
      projectName: 'thai-review',
      environment: 'production',
      sourceManifestSha256: 'deployment-sha',
      evidenceId: evidence.evidenceId,
      revisions: ['deploy:r1'],
    },
  });

  assert.equal(plan.summary.resolved, 0, '自洽但夾帶未知欄位的證據不可以被採信');
  assert.equal(plan.summary.quarantined, 1);
});

/* 只擋未知 top-level key 不夠：白名單內的自由字串與可延伸子物件一樣是填充空間，
   FNV32 有得湊就有碰撞可能。這幾條把形狀釘死。 */
function paddableEvidence(overrides) {
  const evidence = {
    kind: 'production-lineage-evidence-v2',
    schemaVersion: 2,
    generatedAt: '2026-08-24T17:54:31+0800',
    completeness: 'complete',
    expectedRevisions: ['deploy:r1'],
    source: {
      projectName: 'thai-review',
      environment: 'production',
      deploymentManifestSha256: 'deployment-sha',
    },
    resolvedAliases: { 'L1:stable': CARD_A },
    unresolvedReasons: {},
    collisionAliases: [],
    canonicalCardIds: [CARD_A],
    summary: {
      currentAliasCount: 1,
      resolvedAliasCount: 1,
      unresolvedAliasCount: 0,
      historicalCollisionAliasCount: 0,
    },
    ...overrides,
  };
  const { evidenceId: _drop, ...core } = evidence;
  evidence.evidenceId = `production-lineage-evidence-v2:fnv1a32:${fixtureStableHash(fixtureStableSerialize(core))}`;
  return evidence;
}

function planWith(evidence) {
  return planLegacyMigration({
    legacySnapshot: snapshot([fact('state', 'progress/stable', 'L1:stable', { interval: 3 })]),
    lineageEvidence: evidence,
    trustedRevisionManifest: {
      kind: 'trusted-lineage-revision-manifest-v1',
      projectName: 'thai-review',
      environment: 'production',
      sourceManifestSha256: 'deployment-sha',
      evidenceId: evidence.evidenceId,
      revisions: ['deploy:r1'],
    },
  });
}

test('自洽的 v2 證據在乾淨形狀下仍然可用（確認下面幾條不是把功能關掉）', () => {
  assert.equal(planWith(paddableEvidence({})).summary.resolved, 1);
});

test('generatedAt 不是固定時間戳格式就不收（不留自由字串當填充空間）', () => {
  for (const generatedAt of ['x'.repeat(10240), '2026-08-24', '', 12345, null]) {
    const plan = planWith(paddableEvidence({ generatedAt }));
    assert.equal(plan.summary.resolved, 0, `generatedAt=${JSON.stringify(generatedAt)} 不該被採信`);
  }
});

test('schemaVersion 必須正好是 2', () => {
  for (const schemaVersion of [1, 3, '2', undefined]) {
    assert.equal(planWith(paddableEvidence({ schemaVersion })).summary.resolved, 0);
  }
});

test('source／summary 夾帶未知子欄位整份不收', () => {
  const withSourcePadding = paddableEvidence({
    source: {
      projectName: 'thai-review',
      environment: 'production',
      deploymentManifestSha256: 'deployment-sha',
      padding: 'y'.repeat(4096),
    },
  });
  assert.equal(planWith(withSourcePadding).summary.resolved, 0);

  const withSummaryPadding = paddableEvidence({
    summary: {
      currentAliasCount: 1,
      resolvedAliasCount: 1,
      unresolvedAliasCount: 0,
      historicalCollisionAliasCount: 0,
      padding: 'z'.repeat(4096),
    },
  });
  assert.equal(planWith(withSummaryPadding).summary.resolved, 0);
});
