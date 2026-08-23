import assert from 'node:assert/strict';
import test from 'node:test';

import {
  commitLegacyMigration,
  evaluateLegacyClaim,
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

/* This fake proves the synchronous transactional-port contract only. It is not
   evidence that a real browser IndexedDB upgrade/abort is atomic. */
function fakeTransactionalPort({
  crashBeforeCommit = false,
  localEligibility = {
    workspaceId: 'user:A',
    revision: 'local-empty-1',
    counts: EMPTY_LOCAL_COUNTS,
  },
} = {}) {
  const values = new Map();
  let shouldCrash = crashBeforeCommit;
  let eligibility = structuredClone(localEligibility);
  return {
    values,
    allowCommit() { shouldCrash = false; },
    setLocalEligibility(next) { eligibility = structuredClone(next); },
    async transaction(work) {
      const staged = new Map(values);
      const tx = {
        get: key => staged.get(key),
        set: (key, value) => staged.set(key, structuredClone(value)),
        getClaimEligibility: workspaceId => (
          eligibility?.workspaceId === workspaceId ? structuredClone(eligibility) : null
        ),
      };
      const result = await work(tx);
      if (shouldCrash) throw new Error('simulated crash before commit');
      values.clear();
      for (const [key, value] of staged) values.set(key, value);
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

test('daily／achievements 等 workspace facts 可直接保留，canonical event identity 不改寫', () => {
  const event = {
    eventId: 'event-1',
    cardId: CARD_A,
    eventKind: 'practice-first',
  };
  const legacy = snapshot([
    { ...fact('daily', 'days/2026-08-23', null, { reviewed: 2 }), identityKind: 'workspace' },
    { ...fact('achievements', 'streak7', null, 123), identityKind: 'workspace' },
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
  assert.equal(plan.summary.resolved, 3);
  assert.equal(plan.summary.quarantined, 0);
  assert.deepEqual(plan.resolved.find(row => row.sourceStore === 'events').value, event);
  assert.equal(plan.resolved.find(row => row.sourceStore === 'events').value.userWorkspace, undefined);
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

  store.allowCommit();
  const first = await commitLegacyMigration({
    transactionalPort: store,
    eligibilityGuard: eligibilityGuard(),
    workspaceId: 'user:A',
    plan,
    authorization,
  });
  const afterFirst = structuredClone([...store.values.entries()]);
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

test('不同 snapshot 的 migration records 使用獨立 key，不互相覆寫', async () => {
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
  await commitLegacyMigration({
    transactionalPort: store,
    eligibilityGuard: eligibilityGuard(),
    workspaceId: 'user:A',
    plan: secondPlan,
    authorization: secondAuthorization,
  });

  assert.equal(store.values.size, 4, '2 snapshot records + 2 claim journals');
  const snapshotRecords = [...store.values.entries()]
    .filter(([key]) => !key.includes(':claim-journal:'));
  assert.match(snapshotRecords[0][0], /snapshot:legacy-copy-1/);
  assert.deepEqual(snapshotRecords[0][1].value, { grade: 'good' });
  assert.match(snapshotRecords[1][0], /snapshot:legacy-copy-2/);
  assert.deepEqual(snapshotRecords[1][1].value, { grade: 'easy' });
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
