import assert from 'node:assert/strict';
import test from 'node:test';

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

function blockedStorage() {
  return {
    getItem() { throw new Error('storage blocked'); },
    setItem() { throw new Error('storage blocked'); },
    removeItem() { throw new Error('storage blocked'); },
  };
}

test('沒有既有 auth 資料時明確回 anonymous，不載入 auth client', async () => {
  globalThis.localStorage = memoryStorage();
  globalThis.location = { search: '', origin: 'https://example.test', pathname: '/' };
  const auth = await import(`../src/cloud-auth.js?anonymous=${Date.now()}`);

  assert.deepEqual(await auth.getSessionResult(), { status: 'anonymous', session: null });
  assert.equal(await auth.getSession(), null);
});

test('boot session result 的公開 contract 保留三態，舊 getSession contract 仍相容', async () => {
  globalThis.localStorage = memoryStorage({ 'thai-review-auth-v1': '{}' });
  globalThis.location = { search: '', origin: 'https://example.test', pathname: '/' };
  const auth = await import(`../src/cloud-auth.js?three-state=${Date.now()}`);
  const session = { access_token: 'token', user: { id: 'A' } };

  let restore = auth.__setAuthTestSessionLoader(async () => ({ data: { session } }));
  assert.deepEqual(await auth.getSessionResult(), { status: 'authenticated', session });
  assert.equal(await auth.getSession(), session);
  restore();

  const failure = new Error('auth offline');
  restore = auth.__setAuthTestSessionLoader(async () => { throw failure; });
  assert.deepEqual(await auth.getSessionResult(), {
    status: 'unavailable',
    session: null,
    error: failure,
  });
  assert.equal(await auth.getSession(), null);
  restore();

  const returnedFailure = new Error('session invalid');
  restore = auth.__setAuthTestSessionLoader(async () => ({
    data: { session: null },
    error: returnedFailure,
  }));
  assert.deepEqual(await auth.getSessionResult(), {
    status: 'unavailable',
    session: null,
    error: returnedFailure,
  });
  restore();
});

test('auth storage 被封鎖時不得誤判為 anonymous', async () => {
  globalThis.localStorage = blockedStorage();
  globalThis.location = { search: '', origin: 'https://example.test', pathname: '/' };
  const auth = await import(`../src/cloud-auth.js?blocked=${Date.now()}`);

  const result = await auth.getSessionResult();
  assert.equal(result.status, 'unavailable');
  assert.equal(result.session, null);
  assert.match(result.error.message, /storage blocked/);
});
