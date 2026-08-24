import assert from 'node:assert/strict';
import test from 'node:test';

import { buildLineageEvidence, contentFingerprint } from '../scripts/build-card-id-lineage.mjs';

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';
const ID_C = '33333333-3333-4333-8333-333333333333';

function card(thai, zh) {
  return { thai, karaoke: '', zh, type: 'word', note: '', audio_url: '', lesson: '' };
}

function fixture() {
  const stable = card('คงเดิม', '不變');
  const changed = card('เคยแก้', '現在');
  const duplicateA = card('ซ้ำ', '甲');
  const duplicateB = card('ซ้ำ', '乙');
  const removedDuplicateA = card('หายไป', '舊甲');
  const removedDuplicateB = card('หายไป', '舊乙');
  const revisions = ['deploy:r1', 'deploy:r2'];
  return {
    deploymentManifest: {
      kind: 'cloudflare-pages-production-deployment-manifest-v1',
      projectName: 'thai-review',
      environment: 'production',
      manifestSha256: 'manifest-sha',
      trustedRevisionManifest: { kind: 'trusted-lineage-revision-manifest-v1', revisions },
    },
    gateManifest: {
      proposals: [
        { legacy_alias: 'L1:คงเดิม', content_fingerprint: contentFingerprint(stable), proposed_card_id: ID_A },
        { legacy_alias: 'L1:เคยแก้', content_fingerprint: contentFingerprint(changed), proposed_card_id: ID_B },
        { legacy_alias: 'L1:ซ้ำ', content_fingerprint: contentFingerprint(duplicateA), proposed_card_id: ID_C },
        { legacy_alias: 'L1:ซ้ำ', content_fingerprint: contentFingerprint(duplicateB), proposed_card_id: '44444444-4444-4444-8444-444444444444' },
      ],
    },
    catalogs: [
      { revisionId: revisions[0], data: { lessons: [{ id: 'L1', cards: [stable, card('เคยแก้', '以前'), duplicateA, duplicateB, removedDuplicateA, removedDuplicateB] }] } },
      { revisionId: revisions[1], data: { lessons: [{ id: 'L1', cards: [stable, changed, duplicateA, duplicateB] }] } },
    ],
  };
}

test('只 resolve 每個 production snapshot 都能精確證明的唯一 alias', () => {
  const input = fixture();
  const evidence = buildLineageEvidence({
    ...input,
    gateManifestSha256: 'gate-sha',
    generatedAt: '2026-08-24T17:39:14+08:00',
  });
  assert.equal(evidence.kind, 'production-lineage-evidence-v2');
  assert.equal(evidence.completeness, 'complete');
  assert.equal(evidence.resolvedAliases['L1:คงเดิม'], ID_A);
  assert.equal(evidence.unresolvedReasons['L1:เคยแก้'], 'missing_historical_evidence');
  assert.equal(evidence.unresolvedReasons['L1:ซ้ำ'], 'historical_collision');
  assert.deepEqual(evidence.collisionAliases, ['L1:ซ้ำ', 'L1:หายไป']);
  assert.deepEqual(evidence.canonicalCardIds, [ID_A]);
  assert.equal(evidence.summary.resolvedAliasCount + evidence.summary.unresolvedAliasCount, 3);
});

test('缺少任一 trusted production snapshot 時 fail closed', () => {
  const input = fixture();
  assert.throws(() => buildLineageEvidence({
    ...input,
    catalogs: input.catalogs.slice(0, 1),
    gateManifestSha256: 'gate-sha',
    generatedAt: '2026-08-24T17:39:14+08:00',
  }), /未完整|不完整/);
});

test('已部署 stable card ID 可跨內容修訂證明同一 lineage', () => {
  const input = fixture();
  input.catalogs[0].data.lessons[0].cards[0] = { ...card('舊字面', '舊內容'), card_id: ID_A };
  const evidence = buildLineageEvidence({
    ...input,
    gateManifestSha256: 'gate-sha',
    generatedAt: '2026-08-24T17:39:14+08:00',
  });
  assert.equal(evidence.unresolvedReasons['L1:คงเดิม'], 'missing_historical_evidence');

  input.catalogs[0].data.lessons[0].cards[0] = { ...card('คงเดิม', '舊內容'), card_id: ID_A };
  const stableEvidence = buildLineageEvidence({
    ...input,
    gateManifestSha256: 'gate-sha',
    generatedAt: '2026-08-24T17:39:14+08:00',
  });
  assert.equal(stableEvidence.resolvedAliases['L1:คงเดิม'], ID_A);
});

test('historical stable ID 必須屬於同一 alias 且在 snapshot 全域唯一', () => {
  const wrongAlias = fixture();
  wrongAlias.catalogs[0].data.lessons[0].cards[0] = { ...card('คงเดิม', '舊內容'), card_id: ID_B };
  wrongAlias.catalogs[1].data.lessons[0].cards[0] = { ...card('คงเดิม', '新內容'), card_id: ID_B };
  const wrongEvidence = buildLineageEvidence({
    ...wrongAlias,
    gateManifestSha256: 'gate-sha',
    generatedAt: '2026-08-24T17:39:14+08:00',
  });
  assert.equal(wrongEvidence.unresolvedReasons['L1:คงเดิม'], 'lineage_changed');
  assert.equal(wrongEvidence.resolvedAliases['L1:คงเดิม'], undefined);

  const duplicate = fixture();
  for (const snapshot of duplicate.catalogs) {
    snapshot.data.lessons[0].cards[0] = { ...card('คงเดิม', '內容'), card_id: ID_A };
    snapshot.data.lessons[0].cards[1] = { ...card('เคยแก้', '內容'), card_id: ID_A };
  }
  const duplicateEvidence = buildLineageEvidence({
    ...duplicate,
    gateManifestSha256: 'gate-sha',
    generatedAt: '2026-08-24T17:39:14+08:00',
  });
  assert.equal(duplicateEvidence.unresolvedReasons['L1:คงเดิม'], 'duplicate_stable_card_id');
  assert.equal(duplicateEvidence.unresolvedReasons['L1:เคยแก้'], 'duplicate_stable_card_id');
});
