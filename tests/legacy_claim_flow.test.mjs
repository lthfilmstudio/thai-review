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
  const eligibilityStorage = { workspaceId: 'user:A' };
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
    flow, calls, diagnostics, rootStorage, eligibilityStorage, snapshot, plan,
    localEligibility, remoteReceipt, port, probe, offerToken, authorization,
  };
}

const authenticated = {
  workspaceId: 'user:A',
  session: { user: { id: 'A', email: 'nalin@example.com' } },
};

test('production lineage evidence 固定讀絕對路徑並使用 no-store', async () => {
  const calls = [];
  const evidence = await fetchProductionLineageEvidence({
    fetchImpl: async (...args) => {
      calls.push(args);
      return { ok: true, async json() { return { kind: 'lineage' }; } };
    },
  });

  assert.deepEqual(evidence, { kind: 'lineage' });
  assert.deepEqual(calls, [[
    '/data/card-id-lineage.json',
    { cache: 'no-store' },
  ]]);
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

test('lineage 無效或 request failure 都 fail closed，只送 diagnostics', async t => {
  for (const scenario of [
    { name: 'invalid', options: { lineageValid: false }, code: 'LEGACY_LINEAGE_INVALID' },
    {
      name: 'request-failed',
      options: { lineageFailure: new Error('offline') },
      code: 'LEGACY_LINEAGE_UNAVAILABLE',
    },
  ]) {
    await t.test(scenario.name, async () => {
      const fx = fixture(scenario.options);
      await assert.rejects(fx.flow.migrate(authenticated), { code: scenario.code });
      assert.equal(fx.calls.some(([name]) => name === 'decision'), false);
      assert.equal(fx.calls.some(([name]) => name === 'inspect-remote'), false);
      assert.equal(fx.diagnostics.length, 1);
      assert.equal(fx.diagnostics[0].code, scenario.code);
      assert.equal(fx.calls.at(-1)[0], 'invalidate-probe');
    });
  }
});

test('remote probe request failure 進 diagnostics，不 offer 或 ready', async () => {
  const fx = fixture({ remoteCompleted: false });

  await assert.rejects(fx.flow.migrate(authenticated), {
    code: 'REMOTE_WORKSPACE_PROBE_FAILED',
  });
  assert.equal(fx.calls.some(([name]) => name === 'decision'), false);
  assert.equal(fx.diagnostics[0].code, 'REMOTE_WORKSPACE_PROBE_FAILED');
  assert.equal(fx.calls.at(-1)[0], 'invalidate-probe');
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
