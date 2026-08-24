import assert from 'node:assert/strict';
import test from 'node:test';

const storageCalls = [];
globalThis.localStorage = {
  getItem(key) { storageCalls.push(['get', key]); return null; },
  setItem(key, value) { storageCalls.push(['set', key, value]); },
  removeItem(key) { storageCalls.push(['remove', key]); },
};
globalThis.location = { search: '' };

const { createRemoteWorkspaceProbe } = await import('../src/remote-workspace-probe.js');

const sessionResult = userId => ({
  status: 'authenticated',
  session: { access_token: `token-${userId}`, user: { id: userId } },
});

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return structuredClone(body); },
  };
}

function tableName(url) {
  return new URL(url).pathname.split('/').at(-1);
}

function fixtureFetch(fixtures = {}, requests = []) {
  return async (url, init = {}) => {
    requests.push({ url: String(url), init });
    const value = fixtures[tableName(url)] ?? [];
    return value?.httpStatus ? response([], value.httpStatus) : response(value);
  };
}

function emptyMetaRow(overrides = {}) {
  return {
    reset_at: 0,
    protection: 0,
    protection_refill_checkpoint: 0,
    makeup_pending: null,
    resweep_position: 0,
    resweep_started_at: 0,
    achievements: {},
    favorites: {},
    meta_updated_at: 123,
    ...overrides,
  };
}

test('三張表語意皆空時發 receipt，且全程只有最小 GET、零 storage write', async () => {
  storageCalls.length = 0;
  const requests = [];
  const probe = createRemoteWorkspaceProbe({
    resolveSession: async () => sessionResult('A'),
    fetchImpl: fixtureFetch({
      thai_cards: [],
      thai_days: [],
      thai_meta: [emptyMetaRow({ protection: null, protection_refill_checkpoint: null })],
    }, requests),
    createId: () => 'receipt-1',
    now: () => 123,
  });

  const result = await probe.inspect('user:A');
  assert.equal(result.completed, true);
  assert.equal(result.rowCount, 0);
  assert.match(result.receiptId, /receipt-1$/);
  assert.deepEqual(Object.keys(result.tables).sort(), ['thai_cards', 'thai_days', 'thai_meta']);
  assert.equal(requests.length, 3);
  assert.deepEqual(storageCalls, []);
  for (const { url, init } of requests) {
    const parsed = new URL(url);
    assert.equal(init.method, 'GET');
    assert.equal(init.headers.Authorization, 'Bearer token-A');
    assert.equal(parsed.searchParams.get('limit'), '1');
    assert.equal(parsed.searchParams.has('user_id'), false);
    assert.ok(parsed.searchParams.get('select'));
  }
});

test('任一 card、day 或實質 meta 都讓 remote workspace 非空', async () => {
  for (const fixtures of [
    { thai_cards: [{ card_key: 'L1:ก' }] },
    { thai_days: [{ date: '2026-08-24', device_id: 'D' }] },
    { thai_meta: [emptyMetaRow({ reset_at: 1 })] },
    { thai_meta: [emptyMetaRow({ achievements: { streak7: 1 } })] },
    { thai_meta: [emptyMetaRow({ favorites: { ก: { v: 1, ts: 1 } } })] },
    { thai_meta: [emptyMetaRow({ protection: 1 })] },
  ]) {
    const probe = createRemoteWorkspaceProbe({
      resolveSession: async () => sessionResult('A'),
      fetchImpl: fixtureFetch(fixtures),
      createId: () => 'must-not-issue',
    });
    const result = await probe.inspect('user:A');
    assert.equal(result.completed, true);
    assert.ok(result.rowCount > 0);
    assert.equal(result.receiptId, undefined);
  }
});

test('空 meta 的 0 值是 bookkeeping；缺欄或錯型別則 fail closed', async () => {
  const emptyMeta = emptyMetaRow();
  const valid = createRemoteWorkspaceProbe({
    resolveSession: async () => sessionResult('A'),
    fetchImpl: fixtureFetch({ thai_meta: [emptyMeta] }),
    createId: () => 'valid-empty',
  });
  assert.equal((await valid.inspect('user:A')).rowCount, 0);

  for (const meta of [
    { ...emptyMeta, achievements: 'oops' },
    { ...emptyMeta, achievements: [] },
    { ...emptyMeta, reset_at: '0' },
    { ...emptyMeta, favorites: null },
    { ...emptyMeta, makeup_pending: [] },
    { ...emptyMeta, meta_updated_at: Number.NaN },
    { ...emptyMeta, protection: -1 },
    Object.fromEntries(Object.entries(emptyMeta).filter(([key]) => key !== 'reset_at')),
  ]) {
    const probe = createRemoteWorkspaceProbe({
      resolveSession: async () => sessionResult('A'),
      fetchImpl: fixtureFetch({ thai_meta: [meta] }),
      createId: () => 'must-not-issue',
    });
    const result = await probe.inspect('user:A');
    assert.equal(result.completed, false);
    assert.equal(result.receiptId, undefined);
  }
});

test('HTTP、JSON、auth 錯誤全部 fail closed，不能把未知當成空', async () => {
  const cases = [
    {
      resolveSession: async () => ({ status: 'unavailable', session: null }),
      fetchImpl: async () => { throw new Error('must not fetch'); },
    },
    ...[401, 403, 404, 500].map(httpStatus => ({
      resolveSession: async () => sessionResult('A'),
      fetchImpl: fixtureFetch({ thai_days: { httpStatus } }),
    })),
    {
      resolveSession: async () => sessionResult('A'),
      fetchImpl: async () => response({ malformed: true }),
    },
  ];
  for (const adapters of cases) {
    const probe = createRemoteWorkspaceProbe({ ...adapters, createId: () => 'none' });
    const result = await probe.inspect('user:A');
    assert.equal(result.completed, false);
    assert.equal(result.rowCount, null);
    assert.equal(result.receiptId, undefined);
  }
});

test('timeout 會中止 probe 並回 incomplete，不發 receipt', async () => {
  const probe = createRemoteWorkspaceProbe({
    resolveSession: async () => sessionResult('A'),
    fetchImpl: async (_url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    }),
    createId: () => 'must-not-issue',
    timeoutMs: 1,
  });

  const result = await probe.inspect('user:A');
  assert.equal(result.completed, false);
  assert.equal(result.rowCount, null);
  assert.equal(result.reason, 'aborted');
  assert.equal(result.receiptId, undefined);
});

test('timeout 也涵蓋卡住的 JSON body', async () => {
  const probe = createRemoteWorkspaceProbe({
    resolveSession: async () => sessionResult('A'),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => new Promise(() => {}),
    }),
    timeoutMs: 1,
  });
  const result = await probe.inspect('user:A');
  assert.equal(result.completed, false);
  assert.equal(result.reason, 'aborted');
  assert.equal(result.receiptId, undefined);
});

test('timeout 也涵蓋卡住的 session resolver', async () => {
  const probe = createRemoteWorkspaceProbe({
    resolveSession: async () => new Promise(() => {}),
    fetchImpl: async () => { throw new Error('must not fetch'); },
    timeoutMs: 1,
  });
  const result = await probe.inspect('user:A');
  assert.equal(result.completed, false);
  assert.equal(result.reason, 'aborted');
  assert.equal(result.receiptId, undefined);
});

test('任一並行 GET 失敗時會 abort 其他仍在等待的 requests', async () => {
  let aborted = 0;
  const probe = createRemoteWorkspaceProbe({
    resolveSession: async () => sessionResult('A'),
    fetchImpl: async (url, init) => {
      if (tableName(url) === 'thai_cards') return response([], 403);
      return new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          aborted += 1;
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
    },
  });
  const result = await probe.inspect('user:A');
  assert.equal(result.completed, false);
  assert.equal(result.reason, 'request-failed');
  assert.equal(aborted, 2);
});

test('receipt 綁 workspace；重新檢查出現新資料後回 false', async () => {
  let cards = [];
  let currentUser = 'A';
  const probe = createRemoteWorkspaceProbe({
    resolveSession: async () => sessionResult(currentUser),
    fetchImpl: async url => response(tableName(url) === 'thai_cards' ? cards : []),
    createId: () => 'receipt-1',
  });
  const first = await probe.inspect('user:A');
  assert.equal(await probe.verifyRemotePull({
    workspaceId: 'user:B',
    receiptId: first.receiptId,
  }), false);

  currentUser = 'B';
  assert.equal(await probe.verifyRemotePull({
    workspaceId: 'user:A',
    receiptId: first.receiptId,
  }), false);

  currentUser = 'A';
  cards = [{ card_key: 'L1:new' }];
  assert.equal(await probe.verifyRemotePull({
    workspaceId: 'user:A',
    receiptId: first.receiptId,
  }), false);
});

test('同一次 inspect 在 fetch 中途 A 切到 B，不得發 A receipt', async () => {
  let currentUser = 'A';
  let release;
  const delayed = new Promise(resolve => { release = resolve; });
  const probe = createRemoteWorkspaceProbe({
    resolveSession: async () => sessionResult(currentUser),
    fetchImpl: async url => (
      tableName(url) === 'thai_cards' ? delayed : response([])
    ),
    createId: () => 'must-not-issue',
  });
  const pending = probe.inspect('user:A');
  await Promise.resolve();
  currentUser = 'B';
  release(response([]));
  const result = await pending;
  assert.equal(result.completed, false);
  assert.equal(result.reason, 'ownership-lost');
  assert.equal(result.receiptId, undefined);
});

test('invalidate 讓 delayed response 與舊 receipt 都失效', async () => {
  let release;
  const delayed = new Promise(resolve => { release = resolve; });
  const probe = createRemoteWorkspaceProbe({
    resolveSession: async () => sessionResult('A'),
    fetchImpl: async url => {
      if (tableName(url) === 'thai_cards') return delayed;
      return response([]);
    },
    createId: () => 'receipt-1',
  });
  const pending = probe.inspect('user:A');
  await Promise.resolve();
  probe.invalidate();
  release(response([]));
  const result = await pending;
  assert.equal(result.completed, false);
  assert.equal(result.receiptId, undefined);

  const freshProbe = createRemoteWorkspaceProbe({
    resolveSession: async () => sessionResult('A'),
    fetchImpl: fixtureFetch(),
    createId: () => 'receipt-2',
  });
  const first = await freshProbe.inspect('user:A');
  freshProbe.invalidate();
  assert.equal(await freshProbe.verifyRemotePull({
    workspaceId: 'user:A', receiptId: first.receiptId,
  }), false);
});
