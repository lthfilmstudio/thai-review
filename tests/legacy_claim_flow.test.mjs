import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createLegacyClaimFlow,
  fetchProductionLineageEvidence,
} from '../src/legacy-claim-flow.js';

function storageWithLegacy() {
  const values = new Map([['thai-review-state', '{"legacy":true}']]);
  return {
    values,
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

function fixture({
  localCount = 0,
  remoteCount = 0,
  remoteCompleted = true,
  decision = 'cancel',
  lineageValid = true,
  lineageFailure = null,
  commitFailure = null,
} = {}) {
  const calls = [];
  const rootStorage = storageWithLegacy();
  const eligibilityValues = new Map();
  const eligibilityStorage = {
    workspaceId: 'user:A',
    getItem(key) { return eligibilityValues.get(key) ?? null; },
    setItem(key, value) { eligibilityValues.set(key, String(value)); },
  };
  const snapshot = {
    snapshotId: 'legacy:snapshot',
    facts: [{ sourceStore: 'state', sourceKey: 'legacy', value: { grade: 'good' } }],
  };
  const plan = {
    snapshotId: snapshot.snapshotId,
    planId: 'plan:1',
    lineageProvenance: lineageValid ? { evidenceId: 'trusted:evidence' } : { evidenceId: null },
    conservation: { valid: true },
    summary: {
      original: 1, resolved: 1, quarantined: 0, materialized: 1,
      materializedSrs: 1, materializedProjectionFacts: 0, auditOnly: 0,
    },
  };
  const localEligibility = {
    workspaceId: 'user:A',
    revision: 'composite:1',
    counts: { state: localCount },
  };
  const remoteReceipt = {
    completed: remoteCompleted,
    rowCount: remoteCompleted ? remoteCount : null,
    workspaceId: 'user:A',
    receiptId: remoteCompleted && remoteCount === 0 ? 'receipt:1' : undefined,
    ...(!remoteCompleted ? { reason: 'request-failed', error: new Error('offline') } : {}),
  };
  const port = {
    async inspectClaimEligibility() {
      calls.push(['inspect-local']);
      return localEligibility;
    },
  };
  const probe = {
    async inspect(workspaceId) {
      calls.push(['inspect-remote', workspaceId]);
      return remoteReceipt;
    },
    async verifyRemotePull() { return true; },
    invalidate() { calls.push(['invalidate-probe']); },
  };
  const offerToken = Object.freeze({ kind: 'offer', id: 1 });
  const authorization = Object.freeze({ kind: 'authorization', id: 1 });
  const core = {
    captureLegacyLearningSnapshot(storage) {
      calls.push(['capture', storage]);
      return { status: 'ok', snapshot };
    },
    planLegacyMigration(args) {
      calls.push(['plan', args]);
      return plan;
    },
    createLegacyMigrationTransactionPort(connection, args) {
      calls.push(['create-port', connection, args]);
      return port;
    },
    inspectNamespacedLocalCounts(storage, workspaceId) {
      calls.push(['inspect-local-storage', storage, workspaceId]);
      return { workspaceId, revision: 'local-storage:1', counts: { state: 0 } };
    },
    evaluateLegacyClaim(args) {
      calls.push(['evaluate', args]);
      if (args.decision === 'cancel') return { status: 'cancelled' };
      if (args.decision === 'claim') {
        assert.equal(args.offerToken, offerToken, 'claim must consume the exact offered token');
        return { status: 'confirmed', authorization };
      }
      if (localCount !== 0 || remoteCount !== 0) {
        return { status: 'not-offered', mergeAnonymous: false };
      }
      return {
        status: 'offer', offerToken,
        actions: [
          { id: 'claim', label: '將這台裝置的進度加入此帳號' },
          { id: 'cancel', label: '先不要' },
        ],
      };
    },
    async commitLegacyMigration(args) {
      calls.push(['commit', args]);
      if (commitFailure) throw commitFailure;
      return { status: 'applied', summary: plan.summary };
    },
  };
  const diagnostics = [];
  const flow = createLegacyClaimFlow({
    rootStorage,
    eligibilityStorage,
    practiceConnection: { id: 'practice' },
    assertBootActive: workspaceId => calls.push(['assert-active', workspaceId]),
    requestDecision: async payload => {
      calls.push(['decision', payload]);
      return decision;
    },
    onDiagnostics: details => diagnostics.push(details),
    loadLineageEvidence: async () => {
      calls.push(['load-lineage']);
      if (lineageFailure) throw lineageFailure;
      return { evidenceId: 'trusted:evidence' };
    },
    trustedRevisionManifest: { evidenceId: 'trusted:evidence' },
    remoteProbe: probe,
    core,
  });
  return {
    flow, calls, diagnostics, rootStorage, eligibilityStorage, eligibilityValues, snapshot, plan,
    localEligibility, remoteReceipt, port, probe, offerToken, authorization,
  };
}

const authenticated = {
  workspaceId: 'user:A',
  session: { user: { id: 'A', email: 'nalin@example.com' } },
};

async function sha256Hex(text) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function servedBytes(body) {
  return { ok: true, status: 200, async text() { return body; } };
}

test('production lineage evidence 固定讀絕對路徑並使用 no-store', async () => {
  const calls = [];
  const body = JSON.stringify({ kind: 'lineage' });
  const evidence = await fetchProductionLineageEvidence({
    expectedEvidenceSha256: await sha256Hex(body),
    fetchImpl: async (...args) => {
      calls.push(args);
      return servedBytes(body);
    },
  });

  assert.deepEqual(evidence, { kind: 'lineage' });
  assert.equal(calls[0][0], '/data/card-id-lineage.json');
  assert.equal(calls[0][1].cache, 'no-store');
  assert.equal(calls[0][1].signal?.aborted, false);
});

/* payload 自報的 kind／evidenceId 都是攻擊者可控的，唯一不可控的是編進 bundle 的
   SHA-256。少了這道，偽造的 v1 payload 或 FNV 碰撞版本都能一路走到 migration。
   分類成 UNAVAILABLE 而不是 INVALID：bytes 不符也可能只是 SW 還快取著上一版
   artifact，讓 claim 延後重試就好，不要把已登入的人鎖在開機畫面外。 */
test('lineage evidence bytes 對不上 trust manifest 的 SHA-256 就 fail closed', async () => {
  const genuine = JSON.stringify({ kind: 'production-lineage-evidence-v2' });
  const expected = await sha256Hex(genuine);

  await assert.rejects(
    fetchProductionLineageEvidence({
      expectedEvidenceSha256: expected,
      fetchImpl: async () => servedBytes(`${genuine} `),   // 只多一個空白
    }),
    error => error.code === 'LEGACY_LINEAGE_UNAVAILABLE'
      && /digest mismatch/.test(error.message || ''),
  );
});

/* 沒有 digest 綁定的話這份 HTML 會落到 JSON.parse 才炸成 INVALID（鎖死開機）。
   斷言 UNAVAILABLE 等於斷言「是 digest 這關先擋下來的」。 */
test('Pages SPA fallback 的 200 text/html 在 digest 這關就被擋下', async () => {
  await assert.rejects(
    fetchProductionLineageEvidence({
      expectedEvidenceSha256: await sha256Hex('{}'),
      fetchImpl: async () => servedBytes('<!DOCTYPE html>\n<html lang="zh-Hant">'),
    }),
    { code: 'LEGACY_LINEAGE_UNAVAILABLE' },
  );
});

/* 顯式傳 undefined 會觸發預設參數，測不到這條；用 null／壞格式代表「trust manifest
   裡那個欄位不見了或被改壞」。少了這道守衛，digest 會永遠不等於 undefined，
   等於把所有人一起鎖在開機畫面外。 */
test('trust manifest 沒有可用的 evidenceSha256 時不發請求、也不鎖死開機', async () => {
  for (const broken of [null, '', 'not-a-sha', 'A'.repeat(64)]) {
    let fetched = false;
    await assert.rejects(
      fetchProductionLineageEvidence({
        expectedEvidenceSha256: broken,
        fetchImpl: async () => { fetched = true; return servedBytes('{}'); },
      }),
      { code: 'LEGACY_LINEAGE_UNAVAILABLE' },
      `expectedEvidenceSha256=${JSON.stringify(broken)} 應該 fail closed`,
    );
    assert.equal(fetched, false, '沒有可比對的基準就不該發出請求');
  }
});

test('編進 bundle 的 evidenceSha256 跟實際 artifact 一致', async () => {
  const [{ TRUSTED_PRODUCTION_LINEAGE }, { readFile }] = await Promise.all([
    import('../src/production-lineage-trust.js'),
    import('node:fs/promises'),
  ]);
  const artifact = await readFile(new URL('../data/card-id-lineage.json', import.meta.url), 'utf8');

  assert.equal(
    TRUSTED_PRODUCTION_LINEAGE.evidenceSha256,
    await sha256Hex(artifact),
    'trust manifest 與 data/card-id-lineage.json 不同步；重跑 build-card-id-lineage.mjs',
  );
});

test('production lineage evidence timeout fails closed instead of hanging boot', async () => {
  let requestSignal;
  await assert.rejects(
    fetchProductionLineageEvidence({
      timeoutMs: 1,
      fetchImpl: async (_url, options) => {
        requestSignal = options.signal;
        return new Promise(() => {});
      },
    }),
    { code: 'LEGACY_LINEAGE_UNAVAILABLE' },
  );
  assert.equal(requestSignal?.aborted, true);
});

test('anonymous boot 不讀 legacy、不 probe、也不顯示 claim', async () => {
  const fx = fixture();
  const result = await fx.flow.migrate({
    workspaceId: 'anon:device-1', session: null,
  });

  assert.deepEqual(result, { status: 'not-offered', reason: 'anonymous', summary: null });
  assert.equal(fx.calls.some(([name]) => name === 'capture'), false);
  assert.equal(fx.calls.some(([name]) => name === 'inspect-remote'), false);
  assert.equal(fx.calls.some(([name]) => name === 'decision'), false);
});

test('eligible claim 顯示帳號與保守摘要；取消保留 legacy bytes 且不 commit', async () => {
  const fx = fixture({ decision: 'cancel' });
  const before = new Map(fx.rootStorage.values);
  const result = await fx.flow.migrate(authenticated);

  assert.equal(result.status, 'cancelled');
  assert.deepEqual(fx.rootStorage.values, before);
  const decision = fx.calls.find(([name]) => name === 'decision')[1];
  assert.equal(decision.accountLabel, 'nalin@example.com');
  assert.equal(decision.legacyFactCount, 1);
  assert.deepEqual(decision.summary, fx.plan.summary);
  assert.equal(decision.offer.actions[0].label, '將這台裝置的進度加入此帳號');
  assert.equal(decision.offer.actions[1].label, '先不要');
  assert.equal(fx.calls.some(([name]) => name === 'commit'), false);
  assert.equal(fx.calls.at(-1)[0], 'invalidate-probe');
});

test('claim 使用同一次 offer token、同一個 probe 與 transaction port commit', async () => {
  const fx = fixture({ decision: 'claim' });
  const result = await fx.flow.migrate(authenticated);

  assert.equal(result.status, 'applied');
  const claimEvaluation = fx.calls
    .filter(([name]) => name === 'evaluate')
    .find(([, args]) => args.decision === 'claim')[1];
  assert.equal(claimEvaluation.offerToken, fx.offerToken);
  const commit = fx.calls.find(([name]) => name === 'commit')[1];
  assert.equal(commit.transactionalPort, fx.port);
  assert.equal(commit.eligibilityGuard, fx.probe);
  assert.equal(commit.workspaceId, 'user:A');
  assert.equal(commit.plan, fx.plan);
  assert.equal(commit.authorization, fx.authorization);
});

test('local v2 非空或 remote 非空時不 offer', async t => {
  for (const scenario of [
    { name: 'local', options: { localCount: 1 }, remoteInspected: false },
    { name: 'remote', options: { remoteCount: 1 }, remoteInspected: true },
  ]) {
    await t.test(scenario.name, async () => {
      const fx = fixture(scenario.options);
      const result = await fx.flow.migrate(authenticated);
      assert.equal(result.status, 'not-offered');
      assert.equal(fx.calls.some(([name]) => name === 'decision'), false);
      assert.equal(fx.calls.some(([name]) => name === 'inspect-remote'), scenario.remoteInspected);
    });
  }
});

test('lineage 無效會 fail closed；離線讀不到 evidence 則延後 claim 但不阻塞 boot', async () => {
  const invalid = fixture({ lineageValid: false });
  await assert.rejects(invalid.flow.migrate(authenticated), { code: 'LEGACY_LINEAGE_INVALID' });
  assert.equal(invalid.diagnostics[0].code, 'LEGACY_LINEAGE_INVALID');

  const offline = fixture({ lineageFailure: new Error('offline') });
  assert.deepEqual(await offline.flow.migrate(authenticated), {
    status: 'not-offered', reason: 'deferred-offline', summary: null,
  });
  assert.equal(offline.calls.some(([name]) => name === 'decision'), false);
  assert.equal(offline.calls.some(([name]) => name === 'inspect-remote'), false);
  assert.equal(offline.diagnostics[0].code, 'LEGACY_LINEAGE_UNAVAILABLE');
});

test('remote probe request failure 進 diagnostics，延後 claim 且不假 offer', async () => {
  const fx = fixture({ remoteCompleted: false });

  assert.deepEqual(await fx.flow.migrate(authenticated), {
    status: 'not-offered', reason: 'deferred-offline', summary: null,
  });
  assert.equal(fx.calls.some(([name]) => name === 'decision'), false);
  assert.equal(fx.diagnostics[0].code, 'REMOTE_WORKSPACE_PROBE_UNAVAILABLE');
  assert.equal(fx.calls.at(-1)[0], 'invalidate-probe');
});

test('先不要會記住同一 snapshot，下一次 boot 不再阻塞詢問或打 remote probe', async () => {
  const fx = fixture({ decision: 'cancel' });
  assert.equal((await fx.flow.migrate(authenticated)).reason, 'user-cancelled');
  const firstDecisionCount = fx.calls.filter(([name]) => name === 'decision').length;
  const firstRemoteCount = fx.calls.filter(([name]) => name === 'inspect-remote').length;

  assert.deepEqual(await fx.flow.migrate(authenticated), {
    status: 'not-offered', reason: 'user-declined', summary: null,
  });
  assert.equal(fx.calls.filter(([name]) => name === 'decision').length, firstDecisionCount);
  assert.equal(fx.calls.filter(([name]) => name === 'inspect-remote').length, firstRemoteCount);
});

test('stale remote/local recheck 失敗後 diagnostics，不能重用 token 或假成功', async () => {
  const stale = Object.assign(new Error('stale'), { code: 'CLAIM_ELIGIBILITY_STALE' });
  const fx = fixture({ decision: 'claim', commitFailure: stale });

  await assert.rejects(fx.flow.migrate(authenticated), stale);
  assert.equal(fx.calls.filter(([name]) => name === 'decision').length, 1);
  assert.equal(fx.calls.filter(([name]) => name === 'commit').length, 1);
  assert.equal(fx.diagnostics[0].code, 'CLAIM_ELIGIBILITY_STALE');
  assert.equal(fx.calls.at(-1)[0], 'invalidate-probe');
});

test('成功回傳一次性 migration summary 給 ready 後顯示', async () => {
  const fx = fixture({ decision: 'claim' });
  const result = await fx.flow.migrate(authenticated);

  assert.deepEqual(result, {
    status: 'applied',
    summary: fx.plan.summary,
  });
  assert.equal(fx.calls.filter(([name]) => name === 'inspect-local').length, 1);
  assert.equal(fx.calls.filter(([name]) => name === 'inspect-remote').length, 1);
});

test('沒有 SubtleCrypto 的環境走「驗不了」而不是「驗不過」，不把人鎖在開機畫面外', async () => {
  // globalThis.crypto 在 Node 是 getter-only，要用 defineProperty 蓋掉再還原
  const realCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true });
  try {
    await assert.rejects(
      fetchProductionLineageEvidence({
        expectedEvidenceSha256: 'deadbeef',
        fetchImpl: async () => servedBytes('{"kind":"production-lineage-evidence-v2"}'),
      }),
      { code: 'LEGACY_LINEAGE_UNAVAILABLE' },
    );
  } finally {
    Object.defineProperty(globalThis, 'crypto', realCrypto);
  }
});
