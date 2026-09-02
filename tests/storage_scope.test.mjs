import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  BOOT_STATE_ORDER,
  LEARNING_STORE_KEYS,
  bootScreenFor,
  createWorkspaceBoot,
  getOrCreateWorkspaceInstallationId,
  createWorkspaceStorage,
  inspectNamespacedLocalCounts,
  requireWorkspaceStorage,
  inspectStorageDurability,
  logoutToAnonymous,
  commitRuntimeSrsBaseline,
  ensureRuntimeLedgerContext,
  planRuntimeSrsBaseline,
  resolveWorkspaceId,
  runLegacyLearningBootGate,
  runWorkspaceBoot,
} from '../src/storage-scope.js';

const CARD_A = '550e8400-e29b-41d4-a716-446655440000';
const CARD_B = '550e8400-e29b-41d4-a716-446655440001';
const CARD_C = '550e8400-e29b-41d4-a716-446655440002';

function completeLineage(entries) {
  const revisions = entries.map(([revision]) => revision);
  return {
    lineageEvidence: {
      kind: 'production-lineage-evidence-v1',
      evidenceId: `storage-scope:${revisions.join('+')}`,
      completeness: 'complete',
      expectedRevisions: revisions,
      snapshots: entries.map(([revision, aliases]) => ({ revision, aliases, complete: true })),
    },
    trustedRevisionManifest: {
      kind: 'trusted-lineage-revision-manifest-v1',
      revisions,
      allowHistoricalSnapshotEvidence: true,
    },
  };
}

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

test('workspace coordinator 依 session → catalog → storage → migration → ready 排序', async () => {
  const events = [];
  const backing = memoryStorage();
  const result = await runWorkspaceBoot({
    resolveSession: async () => {
      events.push('resolve-session');
      return { status: 'authenticated', session: { user: { id: 'A' } } };
    },
    resolveDeviceId: () => {
      events.push('resolve-device');
      return 'device-1';
    },
    loadCatalog: async ({ workspaceId }) => {
      events.push(`catalog:${workspaceId}`);
      return { revision: 'catalog-1' };
    },
    openStorage: ({ workspaceId, boot }) => {
      events.push(`storage:${workspaceId}`);
      return createWorkspaceStorage(backing, { workspaceId, boot });
    },
    inspectDurability: async ({ workspaceId }) => {
      events.push(`durability:${workspaceId}`);
      return { supported: true };
    },
    migrate: async ({ workspaceId, storage }) => {
      events.push(`migration:${workspaceId}`);
      assert.throws(() => storage.getItem(LEARNING_STORE_KEYS.state), {
        code: 'WORKSPACE_NOT_READY',
      });
      return { summary: { original: 0, resolved: 0, quarantined: 0 } };
    },
    onState: snapshot => events.push(`state:${snapshot.state}`),
  });

  assert.equal(result.status, 'ready');
  assert.equal(result.workspaceId, 'user:A');
  assert.deepEqual(events, [
    'state:checking-session',
    'resolve-session',
    'state:loading-catalog',
    'catalog:user:A',
    'state:opening-storage',
    'storage:user:A',
    'durability:user:A',
    'state:migrating',
    'migration:user:A',
    'state:ready',
  ]);
  assert.equal(backing.values.size, 0, 'boot and migration adapters must not write learning facts');
  result.storage.setItem(LEARNING_STORE_KEYS.state, '{}');
  assert.equal(result.storage.getItem(LEARNING_STORE_KEYS.state), '{}');
});

test('migrate 只用 boot-bound capability 盤點 local eligibility，runtime storage 仍鎖到 ready', async () => {
  const backing = memoryStorage();
  let capturedMigrationStorage = null;
  const result = await runWorkspaceBoot({
    resolveSession: async () => ({
      status: 'authenticated', session: { user: { id: 'A' } },
    }),
    resolveDeviceId: () => 'must-not-run',
    loadCatalog: async () => ({ revision: 'catalog-1' }),
    openStorage: ({ workspaceId, boot }) => createWorkspaceStorage(backing, {
      workspaceId, boot,
    }),
    migrate: async ({ workspaceId, storage, migrationStorage }) => {
      capturedMigrationStorage = migrationStorage;
      assert.notEqual(migrationStorage, storage);
      assert.throws(() => inspectNamespacedLocalCounts(storage, workspaceId), {
        code: 'STORAGE_UNAVAILABLE',
      });
      const inspected = inspectNamespacedLocalCounts(migrationStorage, workspaceId);
      assert.equal(inspected.workspaceId, workspaceId);
      assert.ok(Object.values(inspected.counts).every(value => value === 0));
      return { status: 'offer-path-reached' };
    },
  });

  assert.equal(result.status, 'ready', result.error?.stack);
  assert.equal(result.migration.status, 'offer-path-reached');
  assert.throws(() => capturedMigrationStorage.getItem(LEARNING_STORE_KEYS.state), {
    code: 'WORKSPACE_NOT_READY',
  });
});

test('authenticated boot 不建立或讀取裝置 ID', async () => {
  let deviceReads = 0;
  const result = await runWorkspaceBoot({
    resolveSession: async () => ({
      status: 'authenticated',
      session: { user: { id: 'A' } },
    }),
    resolveDeviceId: () => { deviceReads += 1; return 'device-1'; },
    loadCatalog: async () => ({ revision: 'catalog-1' }),
    openStorage: ({ workspaceId, boot }) => createWorkspaceStorage(memoryStorage(), {
      workspaceId,
      boot,
    }),
  });

  assert.equal(result.status, 'ready');
  assert.equal(result.workspaceId, 'user:A');
  assert.equal(deviceReads, 0);
});

test('workspace hydration 在 migration 後、ready 前，失敗不會 emit ready', async () => {
  const events = [];
  const backing = memoryStorage();
  let capturedHydrationStorage = null;
  const bootArgs = {
    resolveSession: async () => ({ status: 'anonymous', session: null }),
    resolveDeviceId: () => 'device-1',
    loadCatalog: async () => ({ revision: 'catalog-1' }),
    openStorage: ({ workspaceId, boot }) => createWorkspaceStorage(backing, { workspaceId, boot }),
    migrate: async () => { events.push('migrate'); return { migrated: true }; },
    hydrate: async ({ migration, boot, hydrationStorage, writeHydration }) => {
      capturedHydrationStorage = hydrationStorage;
      events.push(`hydrate:${migration.migrated}:${boot.snapshot().state}`);
      assert.equal(hydrationStorage.workspaceId, 'anon:device-1');
      assert.equal(hydrationStorage.getItem(LEARNING_STORE_KEYS.daily), null);
      writeHydration(LEARNING_STORE_KEYS.daily, '{"days":{}}');
      assert.equal(hydrationStorage.getItem(LEARNING_STORE_KEYS.daily), '{"days":{}}');
      return { snapshot: 'hydrated' };
    },
    onState: snapshot => events.push(`state:${snapshot.state}`),
  };
  const ready = await runWorkspaceBoot(bootArgs);
  assert.equal(ready.status, 'ready');
  assert.deepEqual(ready.hydration, { snapshot: 'hydrated' });
  assert.deepEqual(events, [
    'state:checking-session', 'state:loading-catalog', 'state:opening-storage',
    'state:migrating', 'migrate', 'hydrate:true:migrating', 'state:ready',
  ]);
  assert.equal(ready.storage.getItem(LEARNING_STORE_KEYS.daily), '{"days":{}}');
  assert.throws(() => capturedHydrationStorage.getItem(LEARNING_STORE_KEYS.daily), {
    code: 'WORKSPACE_NOT_READY',
  });

  const failedEvents = [];
  const failed = await runWorkspaceBoot({
    ...bootArgs,
    hydrate: async () => { failedEvents.push('hydrate'); throw Object.assign(new Error('bad hydration'), { code: 'HYDRATION_INVALID' }); },
    onState: snapshot => failedEvents.push(`state:${snapshot.state}`),
  });
  assert.equal(failed.status, 'recoverable-failure');
  assert.equal(failed.error.code, 'HYDRATION_INVALID');
  assert.equal(failedEvents.includes('state:ready'), false);

  const writeBacking = memoryStorage();
  const rawSetItem = writeBacking.setItem.bind(writeBacking);
  let rejectHydrationWrite = false;
  writeBacking.setItem = (key, value) => {
    if (rejectHydrationWrite && key.endsWith(LEARNING_STORE_KEYS.daily)) {
      throw Object.assign(new Error('projection write blocked'), { code: 'HYDRATION_WRITE_FAILED' });
    }
    rawSetItem(key, value);
  };
  const writeFailureEvents = [];
  const writeFailure = await runWorkspaceBoot({
    ...bootArgs,
    openStorage: ({ workspaceId, boot }) => createWorkspaceStorage(writeBacking, { workspaceId, boot }),
    hydrate: async ({ writeHydration }) => {
      writeFailureEvents.push('hydrate');
      rejectHydrationWrite = true;
      writeHydration(LEARNING_STORE_KEYS.daily, '{"days":{}}');
    },
    onState: snapshot => writeFailureEvents.push(`state:${snapshot.state}`),
  });
  assert.equal(writeFailure.status, 'recoverable-failure');
  assert.equal(writeFailure.error.code, 'HYDRATION_WRITE_FAILED');
  assert.equal(writeFailureEvents.includes('state:ready'), false);
});

test('auth unavailable 不得降級成 anonymous workspace，也不開 catalog 或 storage', async () => {
  const events = [];
  const result = await runWorkspaceBoot({
    resolveSession: async () => ({ status: 'unavailable', session: null }),
    resolveDeviceId: () => { events.push('device'); return 'device-1'; },
    loadCatalog: async () => { events.push('catalog'); return {}; },
    openStorage: () => { events.push('storage'); return memoryStorage(); },
    onState: snapshot => events.push(`state:${snapshot.state}`),
  });

  assert.equal(result.status, 'recoverable-failure');
  assert.equal(result.workspaceId, null);
  assert.equal(result.error.code, 'SESSION_UNAVAILABLE');
  assert.deepEqual(events, ['state:checking-session', 'state:recoverable-failure']);
});

test('storage opening failure 進 storage-unavailable，catalog failure 可安全重試', async () => {
  const base = {
    resolveSession: async () => ({ status: 'anonymous', session: null }),
    resolveDeviceId: () => 'device-1',
  };
  const catalogFailure = await runWorkspaceBoot({
    ...base,
    loadCatalog: async () => { throw new Error('offline'); },
    openStorage: () => { throw new Error('must not run'); },
  });
  assert.equal(catalogFailure.status, 'recoverable-failure');
  assert.equal(catalogFailure.workspaceId, 'anon:device-1');

  const storageFailure = await runWorkspaceBoot({
    ...base,
    loadCatalog: async () => ({ revision: 'catalog-1' }),
    openStorage: () => { throw new Error('blocked'); },
  });
  assert.equal(storageFailure.status, 'storage-unavailable');
  assert.equal(storageFailure.workspaceId, 'anon:device-1');

  const unscopedStorage = await runWorkspaceBoot({
    ...base,
    loadCatalog: async () => ({ revision: 'catalog-1' }),
    openStorage: () => memoryStorage(),
  });
  assert.equal(unscopedStorage.status, 'storage-unavailable');
  assert.equal(unscopedStorage.error.code, 'STORAGE_UNAVAILABLE');
});

test('foreign ready boot 的同 workspace storage 不能繞過本次 boot gate', async () => {
  const backing = memoryStorage();
  const foreign = createWorkspaceStorage(backing, {
    workspaceId: 'user:A',
    boot: readyBoot('user:A'),
  });
  const result = await runWorkspaceBoot({
    resolveSession: async () => ({
      status: 'authenticated',
      session: { user: { id: 'A' } },
    }),
    resolveDeviceId: () => 'device-1',
    loadCatalog: async () => ({ revision: 'catalog-1' }),
    openStorage: () => foreign,
  });

  assert.equal(result.status, 'storage-unavailable');
  assert.equal(result.error.code, 'STORAGE_UNAVAILABLE');
  assert.equal(backing.values.size, 0);
});

test('ready 畫面 callback 失敗時保留原錯誤並使 storage handle 失效', async () => {
  const backing = memoryStorage();
  const renderError = new Error('ready render failed');
  const result = await runWorkspaceBoot({
    resolveSession: async () => ({ status: 'anonymous', session: null }),
    resolveDeviceId: () => 'device-1',
    loadCatalog: async () => ({ revision: 'catalog-1' }),
    openStorage: ({ workspaceId, boot }) => createWorkspaceStorage(backing, {
      workspaceId,
      boot,
    }),
    onState: snapshot => {
      if (snapshot.state === 'ready') throw renderError;
    },
  });

  assert.equal(result.status, 'recoverable-failure');
  assert.equal(result.error, renderError);
  assert.equal(result.boot.snapshot().state, 'recoverable-failure');
  assert.throws(() => result.boot.assertReady('anon:device-1', 1), {
    code: 'WORKSPACE_NOT_READY',
  });
});

test('corrupt legacy learning outcome renders recoverable actions and skips ready side effects', async () => {
  const events = [];
  const ready = runLegacyLearningBootGate({
    loadStateResult: () => {
      events.push('load-state');
      return { status: 'corrupt', reason: 'schema' };
    },
    onFailure: failure => events.push(['failure', failure]),
    onReady: () => events.push('learning-side-effects'),
  });

  assert.equal(ready, false);
  assert.equal(events.length, 2);
  assert.equal(events[0], 'load-state');
  assert.equal(events[1][0], 'failure');
  assert.equal(events[1][1].state, 'recoverable-failure');
  assert.deepEqual(events[1][1].screen.actions.map(action => action.id), ['retry', 'diagnostics']);
  assert.equal(events[1][1].screen.focusTarget, 'boot-retry');
  assert.match(events[1][1].diagnostics, /原始資料已保留，尚未寫入/);
  assert.doesNotMatch(events[1][1].screen.message, /儲存空間目前不可用/,
    'corruption must not be presented as storage unavailable');

  const successEvents = [];
  assert.equal(runLegacyLearningBootGate({
    loadStateResult: () => ({ status: 'ok', source: 'missing' }),
    onFailure: () => successEvents.push('failure'),
    onReady: () => successEvents.push('learning-side-effects'),
  }), true);
  assert.deepEqual(successEvents, ['learning-side-effects']);

});

test('App 只以 workspace boot 開機，ready 前不做 daily/streak/save/render', async () => {
  const appSource = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
  const initStart = appSource.indexOf('async function init()');
  const boot = appSource.indexOf('await runWorkspaceBoot({', initStart);
  const ready = appSource.indexOf("if (bootResult.status !== 'ready')", boot);
  const assignStorage = appSource.indexOf('workspaceStorage = bootResult.storage;', ready);
  const requireStorage = appSource.indexOf('const storage = requireWorkspaceStorage();', assignStorage);
  const firstDaily = appSource.indexOf('initDailyLog(state.progress, storage)', requireStorage);
  const firstSettle = appSource.indexOf('settleStreakOnOpen(undefined, storage)', requireStorage);
  const firstSave = appSource.indexOf('saveState(storage);', ready);
  const firstRender = appSource.indexOf('rerender(storage);', ready);
  assert.ok(initStart >= 0 && boot > initStart && ready > boot);
  assert.equal(appSource.includes('runLegacyLearningBootGate'), false);
  assert.ok(assignStorage > ready && requireStorage > assignStorage);
  assert.ok(firstDaily > requireStorage && firstSettle > firstDaily);
  assert.ok(firstSave > firstSettle && firstRender > firstSave);
  assert.match(appSource, /resolveSession: cloudAuth\.getSessionResult/);
  assert.match(appSource, /resolveDeviceId: getDeviceId/);
  assert.match(appSource, /hydrateWorkspaceSnapshot\(practiceConnection/);
  assert.match(appSource, /projectHydratedWorkspaceState\(hydration\)/);
  assert.match(appSource, /projectWorkspaceAuxiliaryState\(/);
  assert.match(appSource, /hydrationStorage\.getItem\(STORAGE_KEY\)/);
});

test('unavailable legacy learning outcome uses storage-unavailable without raw-preserved claim', () => {
  let failure;
  assert.equal(runLegacyLearningBootGate({
    loadStateResult: () => ({ status: 'unavailable', phase: 'read' }),
    onFailure: value => { failure = value; },
  }), false);

  assert.equal(failure.state, 'storage-unavailable');
  assert.deepEqual(failure.screen.actions.map(action => action.id), ['diagnostics']);
  assert.equal(failure.screen.focusTarget, 'boot-diagnostics');
  assert.match(failure.screen.message, /儲存空間目前不可用/);
  assert.doesNotMatch(failure.diagnostics, /原始資料已保留|尚未寫入/);
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

test('runtime learning entry requires a ready explicit workspace port and rejects stale handles', () => {
  const backing = memoryStorage();
  const boot = readyBoot('user:A');
  const port = createWorkspaceStorage(backing, { workspaceId: 'user:A', boot });

  assert.throws(() => requireWorkspaceStorage(), {
    code: 'WORKSPACE_NOT_READY',
  });
  assert.equal(requireWorkspaceStorage(port), port);

  boot.moveTo('checking-session');
  assert.throws(() => requireWorkspaceStorage(port), {
    code: 'WORKSPACE_NOT_READY',
  });
  assert.equal(backing.values.size, 0, 'readiness probes must not create legacy or scoped data');
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

test('登出 auth 清除失敗時不清理同步狀態、不切 anonymous、也不 reload', async () => {
  const events = [];
  await assert.rejects(
    logoutToAnonymous({
      deviceId: 'device-1',
      invalidate: () => events.push('invalidate'),
      cleanup: () => events.push('cleanup'),
      clearAuth: async () => { events.push('clear-auth'); throw new Error('auth unavailable'); },
      activate: id => events.push(`activate:${id}`),
      reload: () => events.push('reload'),
    }),
    /auth unavailable/,
  );
  assert.deepEqual(events, ['invalidate', 'clear-auth']);
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

function runtimeCatalog(cards, digest = 'sha256:catalog-a') {
  return {
    digest,
    lessons: [{ id: 'L1', cards }],
  };
}

function runtimeBaselinePort(existing = [], expectedWorkspace = 'user:A') {
  const srs = new Map(existing.map(row => [row.cardId, structuredClone(row)]));
  const quarantine = new Map();
  const meta = new Map();
  return {
    srs, quarantine, meta,
    async transaction(names, mode, work) {
      assert.deepEqual(names, ['srsV2', 'quarantine', 'workspaceMeta']);
      assert.equal(mode, 'readwrite');
      const stagedSrs = new Map([...srs].map(([key, value]) => [key, structuredClone(value)]));
      const stagedQuarantine = new Map([...quarantine].map(([key, value]) => [key, structuredClone(value)]));
      const stagedMeta = new Map([...meta].map(([key, value]) => [key, structuredClone(value)]));
      // 真的 port 每個方法都會 assertWorkspaceArgument，假的也要擋，不然 workspace
      // fence 這條在單元測試裡等於沒驗。
      const fence = workspaceId => {
        assert.equal(workspaceId, expectedWorkspace, 'runtime baseline crossed workspaces');
      };
      const result = await work({
        getSrs(workspaceId, cardId) {
          fence(workspaceId);
          return structuredClone(stagedSrs.get(cardId) || null);
        },
        async addSrsBaseline(workspaceId, cardId, row) {
          fence(workspaceId);
          if (stagedSrs.has(cardId)) return false;
          stagedSrs.set(cardId, structuredClone(row));
          return true;
        },
        getWorkspaceMeta(workspaceId, key) {
          fence(workspaceId);
          return structuredClone(stagedMeta.get(key) || null);
        },
        putWorkspaceMeta(workspaceId, key, row) {
          fence(workspaceId);
          stagedMeta.set(key, structuredClone(row));
        },
        async addQuarantine(workspaceId, row) {
          fence(workspaceId);
          if (stagedQuarantine.has(row.quarantineId)) return false;
          stagedQuarantine.set(row.quarantineId, structuredClone(row));
          return true;
        },
      });
      srs.clear();
      quarantine.clear();
      meta.clear();
      for (const [key, value] of stagedSrs) srs.set(key, value);
      for (const [key, value] of stagedQuarantine) quarantine.set(key, value);
      for (const [key, value] of stagedMeta) meta.set(key, value);
      return result;
    },
  };
}

test('runtime baseline 同時要求 current catalog 與 trusted lineage，合法 SRS 才排入 version 0 seed', () => {
  const progress = {
    'L1:one': {
      grade: 'good', reviewedAt: 10, nextReviewAt: 20,
      interval: 3, easeFactor: 2.5, reps: 2, updatedAt: 10,
    },
  };
  const lineage = completeLineage([
    ['r1', { 'L1:one': [CARD_A] }],
    ['r2', { 'L1:one': [CARD_A] }],
  ]);
  const plan = planRuntimeSrsBaseline({
    progress,
    currentCatalog: runtimeCatalog([{ thai: 'one', card_id: CARD_A }]),
    catalogDigest: 'sha256:catalog-a',
    ...lineage,
  });

  assert.equal(plan.kind, 'runtime-srs-baseline-plan-v1');
  assert.equal(plan.summary.seedable, 1);
  assert.equal(plan.summary.quarantined, 0);
  assert.deepEqual(plan.seeds[0], {
    cardId: CARD_A,
    legacyAlias: 'L1:one',
    state: progress['L1:one'],
  });
  assert.equal(typeof plan.lineageProvenance.digest, 'string');
});

test('runtime baseline 不把 current-only 唯一誤當可信：歷史 collision、證據不完整、重複 ID、壞 SRS 全 quarantine', () => {
  const valid = { grade: 'good', interval: 3 };
  const historicalCollision = planRuntimeSrsBaseline({
    progress: { 'L1:one': valid },
    currentCatalog: runtimeCatalog([{ thai: 'one', card_id: CARD_A }]),
    catalogDigest: 'sha256:catalog-a',
    ...completeLineage([
      ['r1', { 'L1:one': [CARD_A, CARD_B] }],
      ['r2', { 'L1:one': [CARD_A] }],
    ]),
  });
  assert.equal(historicalCollision.quarantined[0].reason, 'historical_collision');

  const incomplete = planRuntimeSrsBaseline({
    progress: { 'L1:one': valid },
    currentCatalog: runtimeCatalog([{ thai: 'one', card_id: CARD_A }]),
    catalogDigest: 'sha256:catalog-a',
    lineageEvidence: null,
    trustedRevisionManifest: null,
  });
  assert.equal(incomplete.quarantined[0].reason, 'incomplete_lineage_evidence');

  const duplicateId = planRuntimeSrsBaseline({
    progress: { 'L1:one': valid },
    currentCatalog: runtimeCatalog([
      { thai: 'one', card_id: CARD_A },
      { thai: 'two', card_id: CARD_A },
    ]),
    catalogDigest: 'sha256:catalog-a',
    ...completeLineage([
      ['r1', { 'L1:one': [CARD_A], 'L1:two': [CARD_A] }],
      ['r2', { 'L1:one': [CARD_A], 'L1:two': [CARD_A] }],
    ]),
  });
  assert.equal(duplicateId.quarantined[0].reason, 'duplicate_stable_card_id');

  const invalidShape = planRuntimeSrsBaseline({
    progress: { 'L1:one': { grade: 'good', interval: '3' } },
    currentCatalog: runtimeCatalog([{ thai: 'one', card_id: CARD_A }]),
    catalogDigest: 'sha256:catalog-a',
    ...completeLineage([
      ['r1', { 'L1:one': [CARD_A] }],
      ['r2', { 'L1:one': [CARD_A] }],
    ]),
  });
  assert.equal(invalidShape.quarantined[0].reason, 'invalid_srs_snapshot');
});

test('runtime baseline add-only：既有 IDB 勝出、合法 row 補 version 0、重跑冪等', async () => {
  const existing = {
    workspaceId: 'user:A', cardId: CARD_A, version: 4,
    state: { grade: 'easy', interval: 21 }, sourceEventId: 'event-newer',
  };
  const port = runtimeBaselinePort([existing]);
  const plan = planRuntimeSrsBaseline({
    progress: {
      'L1:one': { grade: 'good', interval: 3 },
      'L1:two': { grade: 'hard', interval: 1 },
      'L1:bad': { grade: 'good', interval: 'bad' },
    },
    currentCatalog: runtimeCatalog([
      { thai: 'one', card_id: CARD_A },
      { thai: 'two', card_id: CARD_B },
      { thai: 'bad', card_id: CARD_C },
    ]),
    catalogDigest: 'sha256:catalog-a',
    ...completeLineage([
      ['r1', { 'L1:one': [CARD_A], 'L1:two': [CARD_B], 'L1:bad': [CARD_C] }],
      ['r2', { 'L1:one': [CARD_A], 'L1:two': [CARD_B], 'L1:bad': [CARD_C] }],
    ]),
  });

  const first = await commitRuntimeSrsBaseline({
    port, workspaceId: 'user:A', plan,
  });
  const second = await commitRuntimeSrsBaseline({
    port, workspaceId: 'user:A', plan,
  });

  assert.equal(first.status, 'applied');
  assert.deepEqual(first.summary, { seeded: 1, existing: 1, quarantined: 1, skipped: 0 });
  assert.equal(second.status, 'no-op');
  assert.deepEqual(second.summary, { seeded: 0, existing: 0, quarantined: 0, skipped: 3 });
  assert.deepEqual(port.srs.get(CARD_A), existing);
  assert.equal(port.srs.get(CARD_B).version, 0);
  assert.deepEqual(port.srs.get(CARD_B).state, { grade: 'hard', interval: 1 });
  assert.equal(port.quarantine.size, 1);
  assert.equal(port.meta.size, 1);
});

test('runtime baseline transaction abort 不留下半套 seed、quarantine 或完成標記', async () => {
  const port = runtimeBaselinePort();
  const transact = port.transaction.bind(port);
  port.transaction = (names, mode, work) => transact(names, mode, tx => work({
    ...tx,
    async addSrsBaseline(...args) {
      await tx.addSrsBaseline(...args);
      throw Object.assign(new Error('workspace invalidated during baseline'), {
        code: 'WORKSPACE_INVALIDATED',
      });
    },
  }));
  const plan = planRuntimeSrsBaseline({
    progress: {
      'L1:one': { grade: 'good', interval: 3 },
      'L1:bad': { grade: 'hard', interval: 'bad' },
    },
    currentCatalog: runtimeCatalog([
      { thai: 'one', card_id: CARD_A },
      { thai: 'bad', card_id: CARD_B },
    ]),
    catalogDigest: 'sha256:catalog-a',
    ...completeLineage([
      ['r1', { 'L1:one': [CARD_A], 'L1:bad': [CARD_B] }],
      ['r2', { 'L1:one': [CARD_A], 'L1:bad': [CARD_B] }],
    ]),
  });

  await assert.rejects(
    commitRuntimeSrsBaseline({ port, workspaceId: 'user:A', plan }),
    { code: 'WORKSPACE_INVALIDATED' },
  );
  assert.equal(port.srs.size, 0);
  assert.equal(port.quarantine.size, 0);
  assert.equal(port.meta.size, 0);
});

test('legacy progress 在開機後變動（cloud-sync 合併）不擋開機，新 alias add-only 補上', async () => {
  // cloud-sync.js 會在開機後把別台裝置的進度併進 state.progress，所以「plan 跟上次
  // 不一樣」是多裝置的日常。舊版把這個當成 RUNTIME_BASELINE_CHANGED 丟出來，等於
  // 一台裝置同步回來就把開機炸掉，而且那張卡永遠補不進 SRS。
  const port = runtimeBaselinePort();
  const lineage = completeLineage([
    ['r1', { 'L1:one': [CARD_A], 'L1:two': [CARD_B] }],
    ['r2', { 'L1:one': [CARD_A], 'L1:two': [CARD_B] }],
  ]);
  const catalog = runtimeCatalog([
    { thai: 'one', card_id: CARD_A },
    { thai: 'two', card_id: CARD_B },
  ]);
  const planFor = progress => planRuntimeSrsBaseline({
    progress, currentCatalog: catalog, catalogDigest: 'sha256:catalog-a', ...lineage,
  });

  const first = await commitRuntimeSrsBaseline({
    port, workspaceId: 'user:A', plan: planFor({ 'L1:one': { grade: 'good', interval: 3 } }),
  });
  const second = await commitRuntimeSrsBaseline({
    port,
    workspaceId: 'user:A',
    plan: planFor({
      'L1:one': { grade: 'good', interval: 3 },
      'L1:two': { grade: 'hard', interval: 1 },
    }),
  });

  assert.deepEqual(first.summary, { seeded: 1, existing: 0, quarantined: 0, skipped: 0 });
  assert.deepEqual(second.summary, { seeded: 1, existing: 0, quarantined: 0, skipped: 1 });
  assert.equal(port.srs.get(CARD_B).version, 0, '後來同步回來的 alias 也要補得到 seed');
  assert.deepEqual(port.srs.get(CARD_B).state, { grade: 'hard', interval: 1 });
  assert.deepEqual(second.totals, { seeded: 2, existing: 0, quarantined: 0 });
});

test('seed 過的 alias 不會因為 SRS row 被刪掉就被 legacy progress 救回來', async () => {
  const port = runtimeBaselinePort();
  const plan = planRuntimeSrsBaseline({
    progress: { 'L1:one': { grade: 'good', interval: 3 } },
    currentCatalog: runtimeCatalog([{ thai: 'one', card_id: CARD_A }]),
    catalogDigest: 'sha256:catalog-a',
    ...completeLineage([['r1', { 'L1:one': [CARD_A] }], ['r2', { 'L1:one': [CARD_A] }]]),
  });

  await commitRuntimeSrsBaseline({ port, workspaceId: 'user:A', plan });
  port.srs.delete(CARD_A); // 使用者重置進度
  const replay = await commitRuntimeSrsBaseline({ port, workspaceId: 'user:A', plan });

  assert.deepEqual(replay.summary, { seeded: 0, existing: 0, quarantined: 0, skipped: 1 });
  assert.equal(port.srs.size, 0, '重置掉的進度不能被 legacy progress 復活');
});

test('catalog 換版後重新判定當初被 quarantine 的 alias', async () => {
  const port = runtimeBaselinePort();
  const progress = { 'L1:one': { grade: 'good', interval: 3 } };
  const collided = planRuntimeSrsBaseline({
    progress,
    // 同一個 alias 在 current catalog 撞到兩張卡 → quarantine
    currentCatalog: runtimeCatalog([
      { thai: 'one', card_id: CARD_A },
      { thai: 'one', card_id: CARD_B },
    ]),
    catalogDigest: 'sha256:catalog-a',
    ...completeLineage([['r1', { 'L1:one': [CARD_A] }], ['r2', { 'L1:one': [CARD_A] }]]),
  });
  const fixed = planRuntimeSrsBaseline({
    progress,
    currentCatalog: runtimeCatalog([{ thai: 'one', card_id: CARD_A }], 'sha256:catalog-b'),
    catalogDigest: 'sha256:catalog-b',
    ...completeLineage([['r1', { 'L1:one': [CARD_A] }], ['r2', { 'L1:one': [CARD_A] }]]),
  });

  const before = await commitRuntimeSrsBaseline({ port, workspaceId: 'user:A', plan: collided });
  const same = await commitRuntimeSrsBaseline({ port, workspaceId: 'user:A', plan: collided });
  const after = await commitRuntimeSrsBaseline({ port, workspaceId: 'user:A', plan: fixed });

  assert.deepEqual(before.summary, { seeded: 0, existing: 0, quarantined: 1, skipped: 0 });
  assert.deepEqual(same.summary, { seeded: 0, existing: 0, quarantined: 0, skipped: 1 },
    '同一份 catalog 下不重複寫 quarantine');
  assert.deepEqual(after.summary, { seeded: 1, existing: 0, quarantined: 0, skipped: 0 },
    'catalog 換版解掉 collision 後要補得回來');
  assert.equal(port.srs.get(CARD_A).version, 0);
});

test('quarantineId 直接用 alias，不留雜湊撞號靜默漏寫的空間', async () => {
  const port = runtimeBaselinePort();
  const plan = planRuntimeSrsBaseline({
    progress: {
      'L1:one': { grade: 'good', interval: 'bad' },
      'L1:two': { grade: 'good', interval: 'bad' },
    },
    currentCatalog: runtimeCatalog([
      { thai: 'one', card_id: CARD_A },
      { thai: 'two', card_id: CARD_B },
    ]),
    catalogDigest: 'sha256:catalog-a',
    ...completeLineage([
      ['r1', { 'L1:one': [CARD_A], 'L1:two': [CARD_B] }],
      ['r2', { 'L1:one': [CARD_A], 'L1:two': [CARD_B] }],
    ]),
  });
  const result = await commitRuntimeSrsBaseline({ port, workspaceId: 'user:A', plan });

  assert.equal(result.summary.quarantined, 2, 'summary 要數真的寫進去幾筆');
  assert.deepEqual([...port.quarantine.keys()].sort(), [
    'runtime-baseline:sha256:catalog-a:L1:one',
    'runtime-baseline:sha256:catalog-a:L1:two',
  ]);
});

test('手刻的 plan 收不下：planSignature 只防手滑，WeakSet 才是閘門', async () => {
  // stableSerialize / smallStableHash 都在出貨的 bundle 裡，任何 caller 都算得出
  // 一個對得起來的簽章，所以簽章本身不是來源證明。
  const port = runtimeBaselinePort();
  const real = planRuntimeSrsBaseline({
    progress: { 'L1:one': { grade: 'good', interval: 3 } },
    currentCatalog: runtimeCatalog([{ thai: 'one', card_id: CARD_A }]),
    catalogDigest: 'sha256:catalog-a',
    ...completeLineage([['r1', { 'L1:one': [CARD_A] }], ['r2', { 'L1:one': [CARD_A] }]]),
  });
  // 原封不動複製一份：欄位、簽章全對，就是沒走過 planRuntimeSrsBaseline
  const copied = { ...real, seeds: structuredClone(real.seeds) };

  await assert.rejects(
    commitRuntimeSrsBaseline({ port, workspaceId: 'user:A', plan: copied }),
    { code: 'RUNTIME_BASELINE_INVALID' },
  );
  assert.equal(port.srs.size, 0);
  assert.equal(port.meta.size, 0);
});

test('catalogDigest 跟它描述的 catalog 對不起來就不出 plan', () => {
  assert.throws(() => planRuntimeSrsBaseline({
    progress: { 'L1:one': { grade: 'good', interval: 3 } },
    currentCatalog: runtimeCatalog([{ thai: 'one', card_id: CARD_A }]), // digest: sha256:catalog-a
    catalogDigest: 'sha256:some-other-catalog',
    ...completeLineage([['r1', { 'L1:one': [CARD_A] }], ['r2', { 'L1:one': [CARD_A] }]]),
  }), { code: 'RUNTIME_BASELINE_INVALID' });
});

test('runtime baseline 不跨 workspace 寫入', async () => {
  const port = runtimeBaselinePort([], 'user:A');
  const plan = planRuntimeSrsBaseline({
    progress: { 'L1:one': { grade: 'good', interval: 3 } },
    currentCatalog: runtimeCatalog([{ thai: 'one', card_id: CARD_A }]),
    catalogDigest: 'sha256:catalog-a',
    ...completeLineage([['r1', { 'L1:one': [CARD_A] }], ['r2', { 'L1:one': [CARD_A] }]]),
  });
  await assert.rejects(commitRuntimeSrsBaseline({ port, workspaceId: 'user:B', plan }));
  assert.equal(port.srs.size, 0);
});

function contextPort() {
  const meta = new Map();
  return {
    meta,
    async transaction(names, mode, work) {
      assert.deepEqual(names, ['workspaceMeta']);
      return work({
        getWorkspaceMeta: (_w, key) => structuredClone(meta.get(key) || null),
        putWorkspaceMeta: (_w, key, row) => {
          if (mode !== 'readwrite') throw new Error('write in a readonly transaction');
          meta.set(key, structuredClone(row));
        },
      });
    },
  };
}

test('catalog digest 沒變就不重跑 baseline audit', async () => {
  const port = contextPort();
  let audits = 0;
  const audit = async () => { audits += 1; return { summary: { seeded: 1 } }; };

  const first = await ensureRuntimeLedgerContext({
    port, workspaceId: 'user:A', catalogDigest: 'sha256:a', auditBaseline: audit,
  });
  const second = await ensureRuntimeLedgerContext({
    port, workspaceId: 'user:A', catalogDigest: 'sha256:a', auditBaseline: audit,
  });

  assert.deepEqual(first, {
    status: 'ready', catalogDigest: 'sha256:a', audited: true, reason: null,
  });
  assert.equal(second.status, 'ready');
  assert.equal(second.audited, false);
  assert.equal(audits, 1);
  assert.deepEqual(port.meta.get('runtime-context').baselineSummary, { seeded: 1 });
});

test('catalog digest 換了就重新 audit，過了才換 context', async () => {
  const port = contextPort();
  const seen = [];
  const audit = async ({ catalogDigest }) => { seen.push(catalogDigest); return { summary: null }; };

  await ensureRuntimeLedgerContext({
    port, workspaceId: 'user:A', catalogDigest: 'sha256:a', auditBaseline: audit,
  });
  const afterRefresh = await ensureRuntimeLedgerContext({
    port, workspaceId: 'user:A', catalogDigest: 'sha256:b', auditBaseline: audit,
  });

  assert.deepEqual(seen, ['sha256:a', 'sha256:b']);
  assert.equal(afterRefresh.audited, true);
  assert.equal(port.meta.get('runtime-context').catalogDigest, 'sha256:b');
});

test('audit 失敗回 blocked 而不是丟出去，context 維持舊的', async () => {
  // 呼叫端是開機路徑。丟出去就是把使用者鎖在門外，legacy 也一起用不了。
  const port = contextPort();
  await ensureRuntimeLedgerContext({
    port, workspaceId: 'user:A', catalogDigest: 'sha256:a', auditBaseline: async () => ({}),
  });

  const blocked = await ensureRuntimeLedgerContext({
    port,
    workspaceId: 'user:A',
    catalogDigest: 'sha256:b',
    auditBaseline: async () => {
      throw Object.assign(new Error('lineage unavailable'), { code: 'LEGACY_LINEAGE_UNAVAILABLE' });
    },
  });

  assert.deepEqual(blocked, {
    status: 'blocked',
    catalogDigest: 'sha256:b',
    audited: false,
    reason: 'LEGACY_LINEAGE_UNAVAILABLE',
  });
  assert.equal(port.meta.get('runtime-context').catalogDigest, 'sha256:a',
    'audit 沒過就不能把 context 換成新的 digest');
});

test('audit 完成、context 還沒寫就當掉：下次開機重跑一次（baseline 冪等）', async () => {
  const port = contextPort();
  let audits = 0;
  const audit = async () => { audits += 1; return {}; };
  const crashingPort = {
    ...port,
    async transaction(names, mode, work) {
      if (mode === 'readwrite') throw new Error('crashed before writing context');
      return port.transaction(names, mode, work);
    },
  };

  await assert.rejects(ensureRuntimeLedgerContext({
    port: crashingPort, workspaceId: 'user:A', catalogDigest: 'sha256:a', auditBaseline: audit,
  }), /crashed before writing context/);
  assert.equal(port.meta.size, 0);

  const retried = await ensureRuntimeLedgerContext({
    port, workspaceId: 'user:A', catalogDigest: 'sha256:a', auditBaseline: audit,
  });
  assert.equal(retried.status, 'ready');
  assert.equal(audits, 2, '重跑一次 audit，靠 baseline 自己冪等');
});

test('未知 schemaVersion 的 runtime context 當成失效，重新 audit', async () => {
  const port = contextPort();
  port.meta.set('runtime-context', {
    workspaceId: 'user:A', key: 'runtime-context', schemaVersion: 2, catalogDigest: 'sha256:a',
  });
  let audits = 0;
  const result = await ensureRuntimeLedgerContext({
    port,
    workspaceId: 'user:A',
    catalogDigest: 'sha256:a',
    auditBaseline: async () => { audits += 1; return {}; },
  });
  assert.equal(audits, 1);
  assert.equal(result.audited, true);
  assert.equal(port.meta.get('runtime-context').schemaVersion, 1);
});
