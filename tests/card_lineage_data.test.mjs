import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { TRUSTED_PRODUCTION_LINEAGE } from '../src/production-lineage-trust.js';

const ROOT = new URL('../', import.meta.url);
const STABLE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function load(path) {
  return JSON.parse(readFileSync(new URL(path, ROOT), 'utf8'));
}

function jsonBytes(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
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

test('lineage 的 current card IDs 全都存在於 mandatory catalog', () => {
  const lineage = load('data/card-id-lineage.json');
  const catalog = load('data.json');
  const catalogIds = new Set(catalog.lessons.flatMap(lesson => lesson.cards.map(card => card.card_id)));
  assert.ok(lineage.canonicalCardIds.every(cardId => catalogIds.has(cardId)));
  assert.equal(catalogIds.size, catalog.lessons.flatMap(lesson => lesson.cards).length);
});
