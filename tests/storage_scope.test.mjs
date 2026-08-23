import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BOOT_STATE_ORDER,
  LEARNING_STORE_KEYS,
  bootScreenFor,
  createWorkspaceBoot,
  getOrCreateWorkspaceInstallationId,
  createWorkspaceStorage,
  inspectStorageDurability,
  logoutToAnonymous,
  resolveWorkspaceId,
} from '../src/storage-scope.js';

function memoryStorage() {
  const values = new Map();
  return {
    values,
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
    clear() { values.clear(); },
  };
}

function readyBoot(workspaceId = 'anon:device-1') {
  const boot = createWorkspaceBoot();
  boot.moveTo('loading-catalog', { workspaceId });
  boot.moveTo('opening-storage');
  boot.moveTo('ready');
  return boot;
}

test('7 個 boot states 都有明確畫面、動作與完成後 focus', () => {
  assert.deepEqual(BOOT_STATE_ORDER, [
    'checking-session',
    'loading-catalog',
    'opening-storage',
    'migrating',
    'ready',
    'recoverable-failure',
    'storage-unavailable',
  ]);

  for (const state of BOOT_STATE_ORDER) {
    const screen = bootScreenFor(state);
    assert.equal(typeof screen.title, 'string', state);
    assert.ok(screen.title.length > 0, state);
    assert.equal(typeof screen.message, 'string', state);
    assert.ok(Array.isArray(screen.actions), state);
    assert.equal(typeof screen.focusTarget, 'string', state);
    assert.ok(screen.focusTarget.length > 0, state);
  }
});

test('workspace ready 前與 storage unavailable 都 fail closed，沒有假完成寫入', () => {
  const backing = memoryStorage();
  const boot = createWorkspaceBoot();
  const storage = createWorkspaceStorage(backing, {
    workspaceId: 'anon:device-1',
    boot,
  });

  assert.throws(() => storage.setItem(LEARNING_STORE_KEYS.state, '{}'), {
    code: 'WORKSPACE_NOT_READY',
  });
  assert.equal(backing.values.size, 0);

  boot.moveTo('storage-unavailable', { reason: 'quota' });
  assert.throws(() => storage.getItem(LEARNING_STORE_KEYS.state), {
    code: 'WORKSPACE_NOT_READY',
  });
  assert.equal(boot.snapshot().state, 'storage-unavailable');
  assert.equal(boot.snapshot().ready, false);
});

test('storage construction 以 scoped canary 驗證可寫可讀，成功或失敗都不殘留', () => {
  const backing = memoryStorage();
  createWorkspaceStorage(backing, {
    workspaceId: 'user:A',
    boot: readyBoot('user:A'),
  });
  assert.equal(backing.values.size, 0);

  const blocked = memoryStorage();
  blocked.setItem = () => { throw new Error('site data blocked'); };
  assert.throws(() => createWorkspaceStorage(blocked, {
    workspaceId: 'user:A',
    boot: readyBoot('user:A'),
  }), { code: 'STORAGE_UNAVAILABLE' });
  assert.equal(blocked.values.size, 0);

  const mismatch = memoryStorage();
  mismatch.getItem = () => null;
  assert.throws(() => createWorkspaceStorage(mismatch, {
    workspaceId: 'user:A',
    boot: readyBoot('user:A'),
  }), { code: 'STORAGE_UNAVAILABLE' });
  assert.equal(mismatch.values.size, 0);
});

test('boot state machine 禁止任意跳 ready', () => {
  const boot = createWorkspaceBoot();
  assert.throws(() => boot.moveTo('ready'), { code: 'INVALID_BOOT_TRANSITION' });
  assert.equal(boot.snapshot().state, 'checking-session');

  boot.moveTo('loading-catalog', { workspaceId: 'anon:device-1' });
  boot.moveTo('opening-storage');
  boot.moveTo('migrating');
  boot.moveTo('ready');
  assert.equal(boot.snapshot().ready, true);
});

test('storage handle 綁 boot epoch 與 workspace，重新 boot 後舊 handle 永久失效', () => {
  const backing = memoryStorage();
  const boot = createWorkspaceBoot();
  boot.moveTo('loading-catalog', { workspaceId: 'anon:device-1' });
  boot.moveTo('opening-storage');
  boot.moveTo('ready');
  const stale = createWorkspaceStorage(backing, {
    workspaceId: 'anon:device-1',
    boot,
  });
  stale.setItem(LEARNING_STORE_KEYS.state, 'anonymous');

  boot.moveTo('checking-session');
  boot.moveTo('loading-catalog', { workspaceId: 'user:A' });
  boot.moveTo('opening-storage');
  boot.moveTo('ready');

  assert.throws(() => stale.setItem(LEARNING_STORE_KEYS.state, 'late-write'), {
    code: 'WORKSPACE_INVALIDATED',
  });
  assert.equal(stale.workspaceId, 'anon:device-1');
  assert.equal(backing.values.size, 1);
});

test('anonymous 與 user workspace 解析為唯一且不同的 namespace', () => {
  assert.equal(resolveWorkspaceId({ deviceId: 'device-1' }), 'anon:device-1');
  assert.equal(
    resolveWorkspaceId({ deviceId: 'device-1', session: { user: { id: 'A' } } }),
    'user:A',
  );
  assert.throws(() => resolveWorkspaceId({}), { code: 'WORKSPACE_ID_MISSING' });
  assert.throws(() => resolveWorkspaceId({ session: { user: {} } }), {
    code: 'WORKSPACE_ID_MISSING',
  });
});

test('anonymous、A、B 的 state/daily/history/achievements/events/cursors 完全隔離', () => {
  const backing = memoryStorage();
  const workspaces = {
    anon: createWorkspaceStorage(backing, { workspaceId: 'anon:device-1', boot: readyBoot('anon:device-1') }),
    A: createWorkspaceStorage(backing, { workspaceId: 'user:A', boot: readyBoot('user:A') }),
    B: createWorkspaceStorage(backing, { workspaceId: 'user:B', boot: readyBoot('user:B') }),
  };
  const requiredStores = [
    'state', 'daily', 'history', 'achievements', 'events', 'outbox',
    'cycle', 'cursors', 'remoteDays', 'resweep', 'installation',
  ];

  for (const storeName of requiredStores) {
    const key = LEARNING_STORE_KEYS[storeName];
    workspaces.anon.setItem(key, `anon-${storeName}`);
    workspaces.A.setItem(key, `A-${storeName}`);
    workspaces.B.setItem(key, `B-${storeName}`);
  }

  for (const storeName of requiredStores) {
    const key = LEARNING_STORE_KEYS[storeName];
    assert.equal(workspaces.anon.getItem(key), `anon-${storeName}`);
    assert.equal(workspaces.A.getItem(key), `A-${storeName}`);
    assert.equal(workspaces.B.getItem(key), `B-${storeName}`);
  }
  assert.equal(backing.values.size, requiredStores.length * 3);
});

test('登出先同步 invalidate，再等 auth ownership 清除後才切 anonymous 並 reload', async () => {
  const events = [];
  let releaseAuth;
  const clearing = new Promise(resolve => { releaseAuth = resolve; });
  const result = logoutToAnonymous({
    deviceId: 'device-1',
    invalidate: () => events.push('invalidate'),
    clearAuth: async () => { events.push('clear-auth:start'); await clearing; events.push('clear-auth:end'); },
    activate: id => events.push(`activate:${id}`),
    reload: () => events.push('reload'),
  });

  assert.deepEqual(events, ['invalidate', 'clear-auth:start']);
  releaseAuth();
  const workspaceId = await result;

  assert.equal(workspaceId, 'anon:device-1');
  assert.deepEqual(events, [
    'invalidate',
    'clear-auth:start',
    'clear-auth:end',
    'activate:anon:device-1',
    'reload',
  ]);
});

test('opening storage 會呼叫 persist／estimate 並保留診斷，不虛構結果', async () => {
  const calls = [];
  const diagnostics = await inspectStorageDurability({
    async persisted() { calls.push('persisted'); return false; },
    async persist() { calls.push('persist'); return true; },
    async estimate() { calls.push('estimate'); return { usage: 120, quota: 1000 }; },
  });

  assert.deepEqual(calls, ['persisted', 'persist', 'estimate']);
  assert.deepEqual(diagnostics, {
    supported: true,
    persistedBefore: false,
    persistGranted: true,
    usage: 120,
    quota: 1000,
  });
});

test('remote installation ID 每個 workspace 各自建立，且不等於裝置全域 ID', () => {
  const backing = memoryStorage();
  const a = createWorkspaceStorage(backing, { workspaceId: 'user:A', boot: readyBoot('user:A') });
  const b = createWorkspaceStorage(backing, { workspaceId: 'user:B', boot: readyBoot('user:B') });
  const ids = ['install-A', 'install-B'];
  const createId = () => ids.shift();

  assert.equal(getOrCreateWorkspaceInstallationId(a, createId), 'install-A');
  assert.equal(getOrCreateWorkspaceInstallationId(a, createId), 'install-A');
  assert.equal(getOrCreateWorkspaceInstallationId(b, createId), 'install-B');
  assert.notEqual(a.getItem(LEARNING_STORE_KEYS.installation), 'device-global-id');
});
