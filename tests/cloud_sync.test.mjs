import assert from 'node:assert/strict';
import test from 'node:test';

const stored = new Map();
globalThis.localStorage = {
  getItem(key) { return stored.get(key) ?? null; },
  setItem(key, value) { stored.set(key, String(value)); },
  removeItem(key) { stored.delete(key); },
};
globalThis.location = { search: '' };

const { state } = await import('../src/state.js');
const { __setSyncTestDeps, syncNow, syncThrottled, invalidateSync, resetProgressEverywhere, flushOnHide } =
  await import('../src/cloud-sync.js');

const ok = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  async json() { return body; },
});

const session = userId => ({ access_token: `token-${userId}`, user: { id: userId } });

function resetLocal() {
  stored.clear();
  state.progress = {};
  state.edits = {};
  state.favorites = {};
  state.lessons = [];
  state.currentLessonId = null;
  invalidateSync();
}

function metaRow() {
  return [{
    reset_at: 0,
    protection: null,
    protection_refill_checkpoint: null,
    makeup_pending: null,
    resweep_position: 0,
    resweep_started_at: 0,
    achievements: {},
    favorites: {},
    meta_updated_at: 0,
  }];
}

function installFetch({ userId = 'A', cards = [], onRequest } = {}) {
  const requests = [];
  const fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    onRequest?.(String(url), init, requests);
    const method = init.method || 'GET';
    if (String(url).includes('/thai_meta') && method === 'GET') return ok(metaRow());
    if (String(url).includes('/thai_cards') && method === 'GET') return ok(cards);
    if (String(url).includes('/thai_days') && method === 'GET') return ok([]);
    if (method === 'POST') return ok([]);
    throw new Error(`unexpected request ${method} ${url}`);
  };
  const restore = __setSyncTestDeps({
    getSession: async () => session(userId),
    fetch,
    now: () => 10_000,
  });
  return { requests, restore };
}

test('remote progress winner 不會吞掉 local newer history 與 edit outgoing', async () => {
  resetLocal();
  state.progress = {
    'L1:ก': {
      grade: 'again', reviewedAt: 100, nextReviewAt: 200,
      interval: 1, easeFactor: 2.5, reps: 1, updatedAt: 100, deviceId: 'A',
    },
  };
  state.edits = { 'L1:ก': { zh: '本機新翻譯', updatedAt: 300 } };
  stored.set('thai-review-grade-history-v1', JSON.stringify({
    v: 1, cards: { 'L1:ก': [[0, 300]] },
  }));

  const outgoing = [];
  const { restore } = installFetch({ cards: [{
    card_key: 'L1:ก', grade: 'good', reviewed_at: 200,
    next_review_at: 500, interval_days: 3, ease_factor: 2.5, reps: 2,
    progress_updated_at: 200, history: [[2, 200]], history_updated_at: 200,
  }], onRequest(url, init) {
    if (url.includes('/thai_cards') && init.method === 'POST') outgoing.push(JSON.parse(init.body));
  } });

  try {
    const result = await syncNow();
    assert.equal(result?.pushed, 1);
    assert.equal(outgoing.length, 1);
    const [row] = outgoing[0];
    assert.deepEqual(row.history, [[2, 200], [0, 300]]);
    assert.equal(row.edit.zh, '本機新翻譯');
    assert.equal(row.progress_updated_at, 200);

    await syncNow();
    assert.equal(outgoing.length, 1, '第二輪 watermark 後不得重推 remote winner');
  } finally {
    restore();
  }
});

test('anonymous／no-session sync 是 no-op，不寫 watermark 也不改 state', async () => {
  resetLocal();
  const before = {
    progress: { 'L1:本機': { grade: 'good', updatedAt: 123 } },
    edits: { 'L1:本機': { zh: '保留', updatedAt: 123 } },
  };
  state.progress = structuredClone(before.progress);
  state.edits = structuredClone(before.edits);
  const restore = __setSyncTestDeps({
    getSession: async () => null,
    fetch: async () => { throw new Error('no-session 不應發 fetch'); },
    now: () => 10_000,
  });

  try {
    assert.equal(await syncNow(), null);
    assert.equal(stored.has('thai-review-sync-v1'), false);
    assert.deepEqual(state.progress, before.progress);
    assert.deepEqual(state.edits, before.edits);
  } finally {
    restore();
  }
});

test('logout invalidate 後，舊 delayed pull 不得污染新 operation，舊 finally 不得清掉新 operation', async () => {
  resetLocal();
  let currentUser = 'A';
  let resolveA;
  let resolveB;
  let aPullSeen;
  let bPullSeen;
  const aPull = new Promise(resolve => { resolveA = resolve; });
  const bPull = new Promise(resolve => { resolveB = resolve; });
  const requests = [];
  const fetch = async (url, init = {}) => {
    const text = String(url);
    requests.push({ text, init });
    const token = init.headers?.Authorization || '';
    if (text.includes('/thai_meta') && !init.method) return ok(metaRow());
    if (text.includes('/thai_cards') && !init.method) {
      if (token.includes('token-A')) { aPullSeen?.(); return aPull; }
      bPullSeen?.();
      return bPull;
    }
    if (text.includes('/thai_days') && !init.method) return ok([]);
    if (init.method === 'POST') return ok([]);
    throw new Error(`unexpected request ${init.method || 'GET'} ${text}`);
  };
  const restore = __setSyncTestDeps({
    getSession: async () => session(currentUser),
    fetch,
    now: () => 10_000,
  });

  try {
    const first = syncNow();
    await new Promise(resolve => { aPullSeen = resolve; });
    invalidateSync();

    currentUser = 'B';
    const second = syncNow();
    await new Promise(resolve => { bPullSeen = resolve; });
    resolveA(ok([{ card_key: 'L1:舊帳號', grade: 'easy', progress_updated_at: 900 }]));
    await first;

    let secondSettled = false;
    void second.then(() => { secondSettled = true; });
    await Promise.resolve();
    assert.equal(secondSettled, false, '舊 operation 的 finally 不得清掉 B 的 inFlight');

    resolveB(ok([]));
    const result = await second;
    assert.equal(result?.pulled, 0);
    assert.deepEqual(state.progress, {});
    assert.ok(requests.some(r => r.init.headers?.Authorization === 'Bearer token-B'));
  } finally {
    restore();
    invalidateSync();
  }
});

test('logout invalidate 後，舊 delayed push 不得 commit watermark', async () => {
  resetLocal();
  state.progress = {
    'L1:待送': {
      grade: 'good', reviewedAt: 1000, nextReviewAt: 2000,
      interval: 2, easeFactor: 2.5, reps: 1, updatedAt: 1000, deviceId: 'A',
    },
  };
  let resolvePush;
  let pushSeen;
  const pushPending = new Promise(resolve => { resolvePush = resolve; });
  const fetch = async (url, init = {}) => {
    const text = String(url);
    if (text.includes('/thai_meta') && !init.method) return ok(metaRow());
    if (text.includes('/thai_cards') && !init.method) return ok([]);
    if (text.includes('/thai_cards') && init.method === 'POST') {
      pushSeen?.();
      return pushPending;
    }
    throw new Error(`unexpected request ${init.method || 'GET'} ${text}`);
  };
  const restore = __setSyncTestDeps({
    getSession: async () => session('A'),
    fetch,
    now: () => 10_000,
  });

  try {
    const first = syncNow();
    await new Promise(resolve => { pushSeen = resolve; });
    invalidateSync();
    resolvePush(ok([]));
    assert.equal(await first, null);
    assert.equal(stored.has('thai-review-sync-v1'), false);
  } finally {
    restore();
    invalidateSync();
  }
});

test('reset epoch 成功後若 ownership 消失，不得寫 local watermark', async () => {
  resetLocal();
  let releaseDelete;
  const deletePending = new Promise(resolve => { releaseDelete = resolve; });
  let restore;
  const fetch = async (url, init = {}) => {
    const text = String(url);
    if (text.includes('/thai_meta') && init.method === 'POST') return ok([]);
    if (init.method === 'DELETE') {
      // 模擬 epoch 已成功、但 logout 在 local commit 前發生；刻意忽略 signal。
      invalidateSync();
      await deletePending;
      return ok([]);
    }
    throw new Error(`unexpected reset request ${init.method || 'GET'} ${text}`);
  };
  restore = __setSyncTestDeps({
    getSession: async () => session('A'),
    fetch,
    now: () => 20_000,
  });

  try {
    const reset = resetProgressEverywhere();
    await Promise.resolve();
    releaseDelete();
    assert.equal(await reset, null);
    assert.equal(stored.has('thai-review-sync-v1'), false);
  } finally {
    restore();
    invalidateSync();
  }
});

test('reset 進行中 ticker syncNow 不得搶走 reset ownership', async () => {
  resetLocal();
  let resolveMeta;
  let metaSeen;
  let syncRequestCount = 0;
  const metaPending = new Promise(resolve => { resolveMeta = resolve; });
  const fetch = async (url, init = {}) => {
    const text = String(url);
    if (text.includes('/thai_meta') && init.method === 'POST') {
      metaSeen?.();
      return metaPending;
    }
    if (init.method === 'DELETE') return ok([]);
    syncRequestCount++;
    throw new Error(`sync must wait for reset: ${init.method || 'GET'} ${text}`);
  };
  const restore = __setSyncTestDeps({
    getSession: async () => session('A'),
    fetch,
    now: () => 30_000,
  });

  try {
    const reset = resetProgressEverywhere();
    await new Promise(resolve => { metaSeen = resolve; });
    assert.equal(await syncNow(), null);
    assert.equal(syncRequestCount, 0);

    resolveMeta(ok([]));
    assert.equal(await reset, true);
    assert.ok(stored.has('thai-review-sync-v1'));
  } finally {
    restore();
    invalidateSync();
  }
});

test('reset 期間 ticker 不消耗 throttle window，完成後可立即同步', async () => {
  resetLocal();
  let releaseReset;
  let resolveResetSeen;
  let resolveSyncSeen;
  let syncMetaRequests = 0;
  const resetPending = new Promise(resolve => { releaseReset = resolve; });
  const resetSeen = new Promise(resolve => { resolveResetSeen = resolve; });
  const syncSeen = new Promise(resolve => { resolveSyncSeen = resolve; });
  const fetch = async (url, init = {}) => {
    const text = String(url);
    if (text.includes('/thai_meta') && init.method === 'POST') {
      resolveResetSeen();
      return resetPending;
    }
    if (text.includes('/thai_meta') && !init.method) {
      syncMetaRequests++;
      resolveSyncSeen();
      return ok(metaRow());
    }
    if (text.includes('/thai_cards') && !init.method) return ok([]);
    if (text.includes('/thai_days') && !init.method) return ok([]);
    if (init.method === 'POST') return ok([]);
    throw new Error(`unexpected request ${init.method || 'GET'} ${text}`);
  };
  const restore = __setSyncTestDeps({
    getSession: async () => session('A'), fetch, now: () => 30_000, sleep: async () => {},
  });

  try {
    const reset = resetProgressEverywhere();
    await resetSeen;
    syncThrottled();
    assert.equal(syncMetaRequests, 0, 'reset 期間 ticker 不得啟動 sync');

    releaseReset(ok([]));
    assert.equal(await reset, true);
    syncThrottled();
    const started = await Promise.race([
      syncSeen.then(() => true),
      new Promise(resolve => setTimeout(() => resolve(false), 100)),
    ]);
    assert.equal(started, true, 'reset 完成後第一個 ticker 不得被舊 throttle window 擋住');
  } finally {
    restore();
    invalidateSync();
  }
});

test('cards keyset pagination handles PAGE+1, same timestamp, and an inserted row', async () => {
  resetLocal();
  const rowUpdatedAt = '2026-08-23T00:00:00.000Z';
  const cards = Array.from({ length: 1001 }, (_, i) => ({
    card_key: `k${String(i).padStart(4, '0')}`,
    grade: 'good', progress_updated_at: i + 1, row_updated_at: rowUpdatedAt,
  }));
  let cardRequests = 0;
  const queries = [];
  const fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/thai_meta') && !init.method) return ok(metaRow());
    if (parsed.pathname.endsWith('/thai_cards') && !init.method) {
      cardRequests++;
      queries.push(parsed.search);
      const all = [...cards];
      if (cardRequests === 2) {
        all.push({ card_key: 'k0999.5', grade: 'good', progress_updated_at: 2000,
          row_updated_at: rowUpdatedAt });
      }
      all.sort((a, b) => a.card_key.localeCompare(b.card_key));
      const filter = parsed.searchParams.get('or') || '';
      const match = filter.match(/card_key\.gt\."((?:\\.|[^"])*)"/);
      const after = match ? match[1].replace(/\\(["\\])/g, '$1') : null;
      const start = after ? all.findIndex(row => row.card_key > after) : 0;
      return ok(all.slice(start < 0 ? all.length : start, (start < 0 ? all.length : start) + 1000));
    }
    if (parsed.pathname.endsWith('/thai_days') && !init.method) return ok([]);
    if (init.method === 'POST') return ok([]);
    throw new Error(`unexpected request ${init.method || 'GET'} ${url}`);
  };
  const restore = __setSyncTestDeps({
    getSession: async () => session('A'), fetch, now: () => 10_000, sleep: async () => {},
  });

  try {
    const result = await syncNow();
    assert.equal(result?.pulled, 1002);
    assert.equal(cardRequests, 2);
    assert.match(queries[1], /or=/);
    const watermark = JSON.parse(stored.get('thai-review-sync-v1'));
    assert.equal(watermark.pulledAt, rowUpdatedAt);
    assert.equal(watermark.pulledKey, 'k1000');
  } finally {
    restore();
    invalidateSync();
  }
});

test('old cards watermark without pulledKey forces a complete re-pull', async () => {
  resetLocal();
  const rowUpdatedAt = '2026-08-23T00:00:00.000Z';
  stored.set('thai-review-sync-v1', JSON.stringify({
    pulledAt: rowUpdatedAt, pushedAt: 0, metaAt: 0, resetAt: 0, at: 0,
  }));
  let cardsUrl;
  const fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/thai_meta') && !init.method) return ok(metaRow());
    if (parsed.pathname.endsWith('/thai_cards') && !init.method) {
      cardsUrl = parsed;
      return ok([{ card_key: 'same-time-old-key', grade: 'good', progress_updated_at: 10,
        row_updated_at: rowUpdatedAt }]);
    }
    if (parsed.pathname.endsWith('/thai_days') && !init.method) return ok([]);
    if (init.method === 'POST') return ok([]);
    throw new Error(`unexpected request ${init.method || 'GET'} ${url}`);
  };
  const restore = __setSyncTestDeps({ getSession: async () => session('A'), fetch,
    now: () => 10_000, sleep: async () => {} });

  try {
    assert.equal((await syncNow())?.pulled, 1);
    assert.equal(cardsUrl.searchParams.has('row_updated_at'), false);
    assert.equal(cardsUrl.searchParams.has('or'), false);
    assert.equal(JSON.parse(stored.get('thai-review-sync-v1')).pulledKey, 'same-time-old-key');
  } finally {
    restore();
    invalidateSync();
  }
});

test('keyset cursor quotes reserved card_key characters for PostgREST', async () => {
  resetLocal();
  const specialKey = 'L1:泰文,測試(一).';
  const cards = [
    ...Array.from({ length: 999 }, (_, i) => ({
      card_key: `A${String(i).padStart(4, '0')}`,
      grade: 'good', progress_updated_at: i + 1,
      row_updated_at: '2026-08-23T00:00:00.000Z',
    })),
    { card_key: specialKey, grade: 'good', progress_updated_at: 1000,
      row_updated_at: '2026-08-23T00:00:00.000Z' },
    { card_key: 'z-last', grade: 'good', progress_updated_at: 1001,
      row_updated_at: '2026-08-23T00:00:00.000Z' },
  ];
  let cardRequests = 0;
  let secondOr;
  const fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/thai_meta') && !init.method) return ok(metaRow());
    if (parsed.pathname.endsWith('/thai_cards') && !init.method) {
      cardRequests++;
      const all = [...cards].sort((a, b) => a.card_key.localeCompare(b.card_key));
      const filter = parsed.searchParams.get('or') || '';
      if (cardRequests === 2) secondOr = filter;
      const match = filter.match(/card_key\.gt\."((?:\\.|[^"])*)"/);
      const after = match ? match[1].replace(/\\(["\\])/g, '$1') : null;
      const start = after ? all.findIndex(row => row.card_key > after) : 0;
      return ok(all.slice(start < 0 ? all.length : start, (start < 0 ? all.length : start) + 1000));
    }
    if (parsed.pathname.endsWith('/thai_days') && !init.method) return ok([]);
    if (init.method === 'POST') return ok([]);
    throw new Error(`unexpected request ${init.method || 'GET'} ${url}`);
  };
  const restore = __setSyncTestDeps({ getSession: async () => session('A'), fetch,
    now: () => 10_000, sleep: async () => {} });

  try {
    assert.equal((await syncNow())?.pulled, 1001);
    assert.equal(cardRequests, 2);
    assert.match(secondOr, /row_updated_at\.gt\."2026-08-23T00:00:00\.000Z"/);
    assert.match(secondOr, /card_key\.gt\."L1:泰文,測試\(一\)\."/);
  } finally {
    restore();
    invalidateSync();
  }
});

test('days keyset pagination stores the complete remote view', async () => {
  resetLocal();
  const days = Array.from({ length: 1001 }, (_, i) => ({
    date: '2026-08-23', device_id: `d${String(i).padStart(4, '0')}`,
    reviewed: 1, again: 0, hard: 0, good: 0, easy: 0, games: 0, seconds: 0,
    game_ids: [], bridged: false,
  }));
  let dayRequests = 0;
  const fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/thai_meta') && !init.method) return ok(metaRow());
    if (parsed.pathname.endsWith('/thai_cards') && !init.method) return ok([]);
    if (parsed.pathname.endsWith('/thai_days') && !init.method) {
      dayRequests++;
      const filter = parsed.searchParams.get('or') || '';
      const match = filter.match(/device_id\.gt\."((?:\\.|[^"])*)"/);
      const after = match ? match[1].replace(/\\(["\\])/g, '$1') : null;
      const start = after ? days.findIndex(row => row.device_id > after) : 0;
      return ok(days.slice(start < 0 ? days.length : start, (start < 0 ? days.length : start) + 1000));
    }
    if (init.method === 'POST') return ok([]);
    throw new Error(`unexpected request ${init.method || 'GET'} ${url}`);
  };
  const restore = __setSyncTestDeps({ getSession: async () => session('A'), fetch,
    now: () => 10_000, sleep: async () => {} });

  try {
    assert.ok(await syncNow());
    assert.equal(dayRequests, 2);
    const remote = JSON.parse(stored.get('thai-review-remote-days-v1'));
    assert.equal(remote['2026-08-23'].reviewed, 1001);
  } finally {
    restore();
    invalidateSync();
  }
});

test('retry policy retries transient responses and network errors, but not auth or abort', async () => {
  resetLocal();
  let transientAttempts = 0;
  const transientFetch = async (url, init = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/thai_meta') && !init.method) {
      transientAttempts++;
      if (transientAttempts === 1) return ok([], 503);
      return ok(metaRow());
    }
    if (parsed.pathname.endsWith('/thai_cards') && !init.method) return ok([]);
    if (parsed.pathname.endsWith('/thai_days') && !init.method) return ok([]);
    if (init.method === 'POST') return ok([]);
    throw new Error(`unexpected request ${init.method || 'GET'} ${url}`);
  };
  const restoreTransient = __setSyncTestDeps({ getSession: async () => session('A'),
    fetch: transientFetch, now: () => 10_000, sleep: async () => {} });
  try {
    assert.ok(await syncNow());
    assert.equal(transientAttempts, 2);
  } finally {
    restoreTransient();
    invalidateSync();
  }

  for (const [label, response] of [['auth', ok([], 401)], ['forbidden', ok([], 403)]]) {
    resetLocal();
    let attempts = 0;
    const restore = __setSyncTestDeps({ getSession: async () => session('A'),
      fetch: async () => { attempts++; return response; }, now: () => 10_000,
      sleep: async () => {} });
    try {
      assert.equal(await syncNow(), null, `${label} should fail closed`);
      assert.equal(attempts, 1, `${label} must not retry`);
      assert.equal(stored.has('thai-review-sync-v1'), false);
    } finally {
      restore();
      invalidateSync();
    }
  }

  resetLocal();
  let networkAttempts = 0;
  const restoreNetwork = __setSyncTestDeps({ getSession: async () => session('A'),
    fetch: async () => { networkAttempts++; if (networkAttempts === 1) throw new TypeError('offline'); return ok(metaRow()); },
    now: () => 10_000, sleep: async () => {} });
  try {
    assert.ok(await syncNow());
    assert.equal(networkAttempts, 5, 'only the failed request is retried once; later calls are not duplicated');
  } finally {
    restoreNetwork();
    invalidateSync();
  }

  resetLocal();
  let abortAttempts = 0;
  const restoreAbort = __setSyncTestDeps({ getSession: async () => session('A'),
    fetch: async () => { abortAttempts++; throw new DOMException('cancelled', 'AbortError'); },
    now: () => 10_000, sleep: async () => {} });
  try {
    assert.equal(await syncNow(), null);
    assert.equal(abortAttempts, 1);
  } finally {
    restoreAbort();
    invalidateSync();
  }
});

test('request timeout is bounded and does not advance watermark', async () => {
  resetLocal();
  let attempts = 0;
  const restore = __setSyncTestDeps({ getSession: async () => session('A'),
    fetch: async () => { attempts++; return new Promise(() => {}); },
    now: () => 10_000, timeoutMs: 1, sleep: async () => {} });
  try {
    assert.equal(await syncNow(), null);
    assert.equal(attempts, 3);
    assert.equal(stored.has('thai-review-sync-v1'), false);
  } finally {
    restore();
    invalidateSync();
  }
});

test('flushOnHide uses complete UTF-8 byte size, one keepalive, and leaves oversized rows', async () => {
  resetLocal();
  stored.set('thai-review-auth-v1', JSON.stringify({ access_token: 'token-A', user: { id: 'A' } }));
  state.progress = { 'L1:超大': { grade: 'good', updatedAt: 1, deviceId: 'A' } };
  state.edits = { 'L1:超大': { zh: '字'.repeat(70_000), updatedAt: 2 } };
  let requests = 0;
  const restoreOversized = __setSyncTestDeps({ fetch: async () => { requests++; return ok([]); } });
  try {
    assert.equal(flushOnHide(), false);
    assert.equal(requests, 0);
    assert.equal(stored.has('thai-review-sync-v1'), false);
  } finally {
    restoreOversized();
    invalidateSync();
  }

  resetLocal();
  stored.set('thai-review-auth-v1', JSON.stringify({ access_token: 'token-A', user: { id: 'A' } }));
  state.progress = {
    'L1:正常': { grade: 'good', updatedAt: 1, deviceId: 'A' },
    'L1:超大': { grade: 'good', updatedAt: 1, deviceId: 'A' },
  };
  state.edits = { 'L1:超大': { zh: '字'.repeat(70_000), updatedAt: 2 } };
  const bodies = [];
  const restorePrefix = __setSyncTestDeps({ fetch: async (url, init) => {
    requests++;
    bodies.push({ url, init });
    return ok([]);
  } });
  try {
    assert.equal(flushOnHide(), true);
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].init.keepalive, true);
    assert.ok(new TextEncoder().encode(bodies[0].init.body).byteLength < 60 * 1024);
    assert.equal(JSON.parse(bodies[0].init.body).length, 1);
    assert.equal(stored.has('thai-review-sync-v1'), false);
  } finally {
    restorePrefix();
    invalidateSync();
  }
});
