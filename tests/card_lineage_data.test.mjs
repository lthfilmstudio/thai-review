import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { indexLegacyAliases } from '../src/card-identity.js';
import { TRUSTED_PRODUCTION_LINEAGE } from '../src/production-lineage-trust.js';

const ROOT = new URL('../', import.meta.url);
const STABLE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function load(path) {
  return JSON.parse(readFileSync(new URL(path, ROOT), 'utf8'));
}

function jsonBytes(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/* 產品允許在 Sheet 刪卡（R15「刪除卡移出分母」），所以 lineage 的 canonical card ID
   不一定還在 catalog。分兩種情況：
   - deleted：這個 ID 在 lineage 裡的每個 alias，現行 catalog 都已經找不到——卡被刪了。
     runtime 的 planRuntimeSrsBaseline 會先要求 alias 在現行 catalog 解析得到，
     找不到就隔離，不會拿 lineage 的 ID 去認領，所以放行。
   - drift：alias 還在 catalog，卻已經不是這個 ID——card_id 被換掉或重新 backfill，
     舊進度會整批被隔離，必須擋下來。
   2026-09-12 以前這條測試要求 canonical ID 全部都在 catalog，Sheet 刪一張 Gate B
   之前的卡就會擋住所有部署（Nalin 同意放寬）。 */
function lineageCatalogDrift(lineage, catalog) {
  const cards = catalog.lessons.flatMap(lesson => (
    lesson.cards.map(card => ({ ...card, _lessonId: lesson.id }))
  ));
  const catalogIds = new Set(cards.map(card => card.card_id));
  const aliasIndex = indexLegacyAliases(cards);
  const aliasesById = new Map();
  for (const [alias, cardId] of Object.entries(lineage.resolvedAliases)) {
    if (!aliasesById.has(cardId)) aliasesById.set(cardId, []);
    aliasesById.get(cardId).push(alias);
  }
  const drift = [];
  const deleted = [];
  for (const cardId of lineage.canonicalCardIds) {
    if (catalogIds.has(cardId)) continue;
    const stillPresent = (aliasesById.get(cardId) || []).filter(alias => aliasIndex.has(alias));
    if (stillPresent.length) drift.push({ cardId, aliases: stillPresent });
    else deleted.push(cardId);
  }
  return { drift, deleted };
}

test('production deployment manifest 完整守恆且 self-hash 可重建', () => {
  const manifest = load('data/production-deployments.json');
  assert.equal(manifest.kind, 'cloudflare-pages-production-deployment-manifest-v1');
  assert.equal(manifest.environment, 'production');
  assert.equal(manifest.enumeration.totalCount, manifest.deployments.length);
  assert.equal(manifest.trustedRevisionManifest.revisions.length, manifest.deployments.length);
  assert.equal(new Set(manifest.deployments.map(row => row.revisionId)).size, manifest.deployments.length);
  assert.deepEqual(
    manifest.trustedRevisionManifest.revisions,
    manifest.deployments.map(row => row.revisionId),
  );
  const { manifestSha256, ...core } = manifest;
  assert.equal(createHash('sha256').update(jsonBytes(core)).digest('hex'), manifestSha256);
  assert.ok(manifest.deployments.every(row => row.revisionId.includes(row.dataSha256)));
  assert.ok(manifest.deployments.every(row => !Object.hasOwn(row, 'url') && !Object.hasOwn(row, 'deploymentId')));
  assert.ok(manifest.deployments.every(row => /^[0-9a-f]{40}$/.test(row.matchingCatalogCommit)));
});

test('compact lineage 與 trusted revisions 精確一致且 aliases 守恆', () => {
  const manifest = load('data/production-deployments.json');
  const lineage = load('data/card-id-lineage.json');
  assert.equal(lineage.kind, 'production-lineage-evidence-v2');
  assert.equal(lineage.completeness, 'complete');
  assert.equal(lineage.source.deploymentManifestSha256, manifest.manifestSha256);
  assert.deepEqual(lineage.expectedRevisions, manifest.trustedRevisionManifest.revisions);
  assert.equal(TRUSTED_PRODUCTION_LINEAGE.evidenceId, lineage.evidenceId);
  assert.equal(TRUSTED_PRODUCTION_LINEAGE.sourceManifestSha256, manifest.manifestSha256);
  assert.equal(TRUSTED_PRODUCTION_LINEAGE.projectName, lineage.source.projectName);
  assert.equal(TRUSTED_PRODUCTION_LINEAGE.environment, lineage.source.environment);
  assert.deepEqual(TRUSTED_PRODUCTION_LINEAGE.revisions, lineage.expectedRevisions);
  const resolved = Object.entries(lineage.resolvedAliases);
  const unresolved = Object.entries(lineage.unresolvedReasons);
  assert.equal(resolved.length, lineage.summary.resolvedAliasCount);
  assert.equal(unresolved.length, lineage.summary.unresolvedAliasCount);
  assert.equal(resolved.length + unresolved.length, lineage.summary.currentAliasCount);
  assert.equal(lineage.collisionAliases.length, lineage.summary.historicalCollisionAliasCount);
  assert.ok(resolved.every(([alias, cardId]) => alias.trim() && STABLE_ID.test(cardId)));
  assert.ok(unresolved.every(([alias, reason]) => alias.trim() && typeof reason === 'string'));
  assert.ok(lineage.collisionAliases.every(alias => (
    !Object.hasOwn(lineage.unresolvedReasons, alias)
    || lineage.unresolvedReasons[alias] === 'historical_collision'
  )));
  assert.ok(lineage.collisionAliases.every(alias => !Object.hasOwn(lineage.resolvedAliases, alias)));
  assert.deepEqual(
    [...new Set(resolved.map(([, cardId]) => cardId))].sort(),
    [...lineage.canonicalCardIds].sort(),
  );
});

test('lineage 的 current card IDs 只會因為刪卡而不在 catalog，不能漂移', () => {
  const lineage = load('data/card-id-lineage.json');
  const catalog = load('data.json');
  assert.deepEqual(lineageCatalogDrift(lineage, catalog).drift, []);
  const cards = catalog.lessons.flatMap(lesson => lesson.cards);
  assert.equal(new Set(cards.map(card => card.card_id)).size, cards.length);
});

test('lineageCatalogDrift：刪卡放行，同一個 alias 換了 card_id 要擋', () => {
  const idA = '11111111-1111-5111-8111-111111111111';
  const idB = '22222222-2222-5222-8222-222222222222';
  const idC = '33333333-3333-5333-8333-333333333333';
  const lineage = {
    canonicalCardIds: [idA, idB],
    resolvedAliases: { 'gid-1:甲': idA, 'gid-1:乙': idB },
  };
  const lesson = cards => ({ lessons: [{ id: 'gid-1', cards }] });

  const intact = lesson([{ thai: '甲', card_id: idA }, { thai: '乙', card_id: idB }]);
  assert.deepEqual(lineageCatalogDrift(lineage, intact), { drift: [], deleted: [] });

  const deleted = lesson([{ thai: '甲', card_id: idA }]);
  assert.deepEqual(lineageCatalogDrift(lineage, deleted), { drift: [], deleted: [idB] });

  const reassigned = lesson([{ thai: '甲', card_id: idA }, { thai: '乙', card_id: idC }]);
  assert.deepEqual(lineageCatalogDrift(lineage, reassigned), {
    drift: [{ cardId: idB, aliases: ['gid-1:乙'] }],
    deleted: [],
  });

  const movedToOtherLesson = {
    lessons: [
      { id: 'gid-1', cards: [{ thai: '甲', card_id: idA }] },
      { id: 'gid-2', cards: [{ thai: '乙', card_id: idC }] },
    ],
  };
  assert.deepEqual(lineageCatalogDrift(lineage, movedToOtherLesson), { drift: [], deleted: [idB] });
});
