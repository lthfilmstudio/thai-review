import assert from 'node:assert/strict';
import test from 'node:test';

const stored = new Map();
globalThis.localStorage = {
  getItem(key) { return stored.get(key) ?? null; },
  setItem(key, value) { stored.set(key, value); },
  removeItem(key) { stored.delete(key); },
};

const {
  catalogCardKeyIndex,
  computeCatalogDigest,
  startPracticeLedgerRuntime,
} = await import('../src/practice-ledger-runtime.js');
const { loadDailyLog } = await import('../src/today.js');

const CARD_A = '550e8400-e29b-41d4-a716-446655440000';
const CARD_B = '550e8400-e29b-41d4-a716-446655440001';

function catalog(cards, lessonId = 'L1') {
  return { lessons: [{ id: lessonId, cards }] };
}

test('catalog digest 只綁認領相關欄位：改 zh／note 不換 digest', async () => {
  const a = await computeCatalogDigest(catalog([{ thai: 'one', zh: '一', card_id: CARD_A }]));
  const b = await computeCatalogDigest(catalog([{ thai: 'one', zh: '壹', note: 'x', card_id: CARD_A }]));
  assert.equal(a, b);
  assert.match(a, /^sha256:[0-9a-f]{64}$/);
});

test('catalog digest 在課號、card ID 或泰文改動時會換', async () => {
  const base = await computeCatalogDigest(catalog([{ thai: 'one', card_id: CARD_A }]));
  assert.notEqual(base, await computeCatalogDigest(catalog([{ thai: 'two', card_id: CARD_A }])));
  assert.notEqual(base, await computeCatalogDigest(catalog([{ thai: 'one', card_id: CARD_B }])));
  assert.notEqual(base, await computeCatalogDigest(catalog([{ thai: 'one', card_id: CARD_A }], 'L2')));
});

test('cardId → cardKey 對照表：撞名的整個不收，不猜', () => {
  const index = catalogCardKeyIndex({
    lessons: [
      { id: 'L1', cards: [{ thai: 'one', card_id: CARD_A }, { thai: 'two', card_id: CARD_B }] },
      { id: 'L2', cards: [{ thai: 'dup', card_id: CARD_B }] },
    ],
  });
  assert.equal(index.get(CARD_A), 'L1:one');
  assert.equal(index.has(CARD_B), false, '同一個 cardId 對到兩個 alias 就整個丟掉');
});

function fakeConnection() {
  const meta = new Map();
  const srs = new Map();
  const quarantine = new Map();
  return {
    meta,
    srs,
    __port: {
      async transaction(names, mode, work) {
        return work({
          getWorkspaceMeta: (_w, key) => structuredClone(meta.get(key) || null),
          putWorkspaceMeta: (_w, key, row) => { meta.set(key, structuredClone(row)); },
          getSrs: (_w, cardId) => structuredClone(srs.get(cardId) || null),
          addSrsBaseline: (_w, cardId, row) => {
            if (srs.has(cardId)) return false;
            srs.set(cardId, structuredClone(row));
            return true;
          },
          addQuarantine: (_w, row) => {
            if (quarantine.has(row.quarantineId)) return false;
            quarantine.set(row.quarantineId, structuredClone(row));
            return true;
          },
        });
      },
    },
  };
}

/* 真的 createPracticeTransactionPort 要 IDBDatabase，這裡注入假的，只驗
   startPracticeLedgerRuntime 自己的編排；真 IndexedDB 的行為由 browser fixture 顧。 */
async function startWith(options) {
  const connection = options.connection ?? fakeConnection();
  return {
    connection,
    result: await startPracticeLedgerRuntime({
      ...options, connection, createPort: () => connection.__port,
    }),
  };
}

test('連不上 practice DB 時回 unavailable，不丟出去', async () => {
  const result = await startPracticeLedgerRuntime({ connection: null, catalog: catalog([]) });
  assert.deepEqual(result, { status: 'unavailable', reason: 'PRACTICE_DB_UNAVAILABLE' });
});

test('算不出 catalog digest 時回 unavailable，App 照舊走 legacy', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true });
  try {
    const result = await startPracticeLedgerRuntime({
      connection: fakeConnection(), workspaceId: 'user:A', catalog: catalog([]),
    });
    assert.equal(result.status, 'unavailable');
    assert.equal(result.reason, 'CATALOG_DIGEST_UNAVAILABLE');
  } finally {
    Object.defineProperty(globalThis, 'crypto', descriptor);
  }
});

test('沒有可信 lineage 時回 blocked，但已經在 IDB 的投影照樣鏡射', async () => {
  stored.clear();
  const { result } = await startWith({
    workspaceId: 'user:A',
    catalog: catalog([{ thai: 'one', card_id: CARD_A }]),
    legacyProgress: { 'L1:one': { grade: 'good', interval: 3 } },
    loadLineageEvidence: null,
    projections: {
      'daily:2026-08-24': {
        workspaceId: 'user:A', name: 'daily:2026-08-24', schemaVersion: 1,
        projectorVersion: 'practice-daily-v1', dayKey: '2026-08-24',
        reviewed: 2, again: 0, hard: 0, good: 2, easy: 0, practice: 1,
      },
    },
  });

  assert.equal(result.status, 'blocked', 'ledger 評分不開放');
  assert.equal(result.mirror.days, 1, '但畫面上的數字不能因此少一截');
  assert.equal(loadDailyLog().days['2026-08-24'].ledger.reviewed, 2);
});

test('lineage 齊全時 ready，baseline 只跑一次', async () => {
  stored.clear();
  let audits = 0;
  const lineage = async () => {
    audits += 1;
    return {
      lineageEvidence: {
        kind: 'production-lineage-evidence-v1', evidenceId: 'x:r1+r2',
        completeness: 'complete', expectedRevisions: ['r1', 'r2'],
        snapshots: [
          { revision: 'r1', complete: true, aliases: { 'L1:one': [CARD_A] } },
          { revision: 'r2', complete: true, aliases: { 'L1:one': [CARD_A] } },
        ],
      },
      trustedRevisionManifest: {
        kind: 'trusted-lineage-revision-manifest-v1',
        revisions: ['r1', 'r2'], allowHistoricalSnapshotEvidence: true,
      },
    };
  };
  const options = {
    workspaceId: 'user:A',
    catalog: catalog([{ thai: 'one', card_id: CARD_A }]),
    legacyProgress: { 'L1:one': { grade: 'good', interval: 3 } },
    loadLineageEvidence: lineage,
  };

  const first = await startWith(options);
  assert.equal(first.result.status, 'ready');
  assert.equal(first.connection.srs.get(CARD_A).version, 0);

  const second = await startWith({ ...options, connection: first.connection });
  assert.equal(second.result.status, 'ready');
  assert.equal(audits, 1, 'digest 沒變就不重跑 baseline');
});

test('全新使用者沒有 legacy progress 要搬時，不需要 lineage 也能 ready', async () => {
  stored.clear();
  const { result } = await startWith({
    workspaceId: 'user:A',
    catalog: catalog([{ thai: 'one', card_id: CARD_A }]),
    legacyProgress: {},
    loadLineageEvidence: null,
  });
  assert.equal(result.status, 'ready', '沒東西要認領就沒有認錯的風險');
});

test('digest 沒變、但開機後多出來的 legacy alias 會被補上', async () => {
  // cloud-sync 會在開機之後把別台的進度併進 state.progress。digest 沒變的話
  // ensureRuntimeLedgerContext 不會重跑 audit，那些新 alias 沒人補就永遠進不了 ledger。
  stored.clear();
  let audits = 0;
  const evidence = aliases => async () => {
    audits += 1;
    const snapshot = revision => ({ revision, complete: true, aliases });
    return {
      lineageEvidence: {
        kind: 'production-lineage-evidence-v1', evidenceId: 'x:r1+r2',
        completeness: 'complete', expectedRevisions: ['r1', 'r2'],
        snapshots: [snapshot('r1'), snapshot('r2')],
      },
      trustedRevisionManifest: {
        kind: 'trusted-lineage-revision-manifest-v1',
        revisions: ['r1', 'r2'], allowHistoricalSnapshotEvidence: true,
      },
    };
  };
  const cards = [{ thai: 'one', card_id: CARD_A }, { thai: 'two', card_id: CARD_B }];
  const aliasMap = { 'L1:one': [CARD_A], 'L1:two': [CARD_B] };
  const entry = { grade: 'good', interval: 3 };

  const first = await startWith({
    workspaceId: 'user:A',
    catalog: catalog(cards),
    legacyProgress: { 'L1:one': entry },
    loadLineageEvidence: evidence(aliasMap),
  });
  assert.equal(first.result.status, 'ready');
  assert.equal(first.connection.srs.size, 1);

  // 同一份 catalog，progress 多了一張（別台同步回來的）
  const second = await startWith({
    connection: first.connection,
    workspaceId: 'user:A',
    catalog: catalog(cards),
    legacyProgress: { 'L1:one': entry, 'L1:two': entry },
    loadLineageEvidence: evidence(aliasMap),
  });
  assert.equal(second.result.status, 'ready');
  assert.equal(second.result.backfill?.summary.seeded, 1, '新的 alias 要補上');
  assert.equal(second.connection.srs.size, 2);
  assert.equal(audits, 2);

  // 沒有新東西就不該再抓一次 lineage
  const third = await startWith({
    connection: first.connection,
    workspaceId: 'user:A',
    catalog: catalog(cards),
    legacyProgress: { 'L1:one': entry, 'L1:two': entry },
    loadLineageEvidence: evidence(aliasMap),
  });
  assert.equal(third.result.backfill, null);
  assert.equal(audits, 2, '沒有待補的 alias 就不白抓 lineage evidence');
});

test('補跑 baseline 失敗不影響這次開機', async () => {
  stored.clear();
  const cards = [{ thai: 'one', card_id: CARD_A }];
  const first = await startWith({
    workspaceId: 'user:A', catalog: catalog(cards), legacyProgress: {}, loadLineageEvidence: null,
  });
  assert.equal(first.result.status, 'ready');

  const second = await startWith({
    connection: first.connection,
    workspaceId: 'user:A',
    catalog: catalog(cards),
    legacyProgress: { 'L1:one': { grade: 'good', interval: 3 } },
    loadLineageEvidence: async () => { throw Object.assign(new Error('offline'), { code: 'LEGACY_LINEAGE_UNAVAILABLE' }); },
  });
  assert.equal(second.result.status, 'ready', '已經認領過的照樣可用');
  assert.equal(second.result.backfill.status, 'failed');
  assert.equal(second.result.backfill.reason, 'LEGACY_LINEAGE_UNAVAILABLE');
});
