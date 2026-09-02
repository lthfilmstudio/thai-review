/* Workspace routing and conservative legacy learning migration.
   This module deliberately has no auth, network, IndexedDB, or DOM dependency.
   Callers supply those adapters so boot and migration can fail closed before any
   learning read/write reaches a store. */

import {
  indexLegacyAliases,
  isStableCardId,
  resolveLegacyAlias,
} from './card-identity.js';
import { isSrsStateSnapshot } from './srs.js';

const BOOT_SCREENS = Object.freeze({
  'checking-session': {
    title: '正在確認學習空間',
    message: '先確認目前登入狀態，避免讀到另一個帳號的進度。',
    actions: [],
    focusTarget: 'boot-status',
  },
  'loading-catalog': {
    title: '正在讀取課程版本',
    message: '核對卡片身分後，才會處理既有學習紀錄。',
    actions: [],
    focusTarget: 'boot-status',
  },
  'opening-storage': {
    title: '正在開啟這個學習空間',
    message: '你的進度會依這台裝置或目前帳號分開保存。',
    actions: [],
    focusTarget: 'boot-status',
  },
  migrating: {
    title: '正在整理既有進度',
    message: '能確認身分的紀錄會保留；不確定的會完整留在待確認區。',
    actions: [],
    focusTarget: 'boot-status',
  },
  ready: {
    title: '可以開始了',
    message: '學習空間已就緒。',
    actions: [],
    focusTarget: 'primary-practice-action',
  },
  'recoverable-failure': {
    title: '還沒準備完成',
    message: '資料仍完整保留，可以重試或查看診斷。',
    actions: [
      { id: 'retry', label: '再試一次' },
      { id: 'diagnostics', label: '查看診斷' },
    ],
    focusTarget: 'boot-retry',
  },
  'storage-unavailable': {
    title: '無法安全開啟學習資料',
    message: '瀏覽器儲存空間目前不可用；尚未寫入任何假完成紀錄。',
    actions: [{ id: 'diagnostics', label: '查看診斷' }],
    focusTarget: 'boot-diagnostics',
  },
});

export const BOOT_STATE_ORDER = Object.freeze(Object.keys(BOOT_SCREENS));

const BOOT_TRANSITIONS = Object.freeze({
  'checking-session': new Set(['loading-catalog', 'recoverable-failure', 'storage-unavailable']),
  'loading-catalog': new Set(['opening-storage', 'recoverable-failure', 'storage-unavailable']),
  'opening-storage': new Set(['migrating', 'ready', 'recoverable-failure', 'storage-unavailable']),
  migrating: new Set(['ready', 'recoverable-failure', 'storage-unavailable']),
  ready: new Set(['checking-session', 'recoverable-failure']),
  'recoverable-failure': new Set(['checking-session']),
  'storage-unavailable': new Set(['checking-session']),
});

export const LEARNING_STORE_KEYS = Object.freeze({
  state: 'thai-review-v1',
  daily: 'thai-review-daily-v1',
  history: 'thai-review-grade-history-v1',
  achievements: 'thai-review-achievements-v1',
  events: 'thai-review-practice-events-v1',
  outbox: 'thai-review-practice-outbox-v1',
  cycle: 'thai-review-practice-cycle-v1',
  cursors: 'thai-review-sync-v1',
  remoteDays: 'thai-review-remote-days-v1',
  resweep: 'thai-review-resweep-v1',
  installation: 'thai-review-installation-v1',
});

const CLAIM_LOCAL_STORES = Object.freeze([
  'state', 'daily', 'history', 'achievements', 'events',
  'outbox', 'cycle', 'cursors', 'remoteDays', 'resweep',
]);

const LEGACY_DEVICE_STATE_FIELDS = new Set([
  'settingsVersion', 'settings', 'collapsed', 'currentLessonId', 'mode',
  'lastOpenDate', 'cardIndex', 'listFilter', 'listLessonId', 'listOrder',
]);

function plainRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function requireRecord(value, label) {
  if (!plainRecord(value)) throw codedError('LEARNING_STORE_CORRUPT', `${label} must be an object`);
  return value;
}

function readLearningStores(storage) {
  if (!storage || typeof storage.getItem !== 'function') {
    throw codedError('STORAGE_UNAVAILABLE', 'learning storage is unavailable');
  }
  const stores = {};
  for (const name of CLAIM_LOCAL_STORES) {
    let raw;
    try { raw = storage.getItem(LEARNING_STORE_KEYS[name]); }
    catch { throw codedError('STORAGE_UNAVAILABLE', `cannot read ${name} learning store`); }
    if (raw == null) {
      stores[name] = null;
      continue;
    }
    try {
      stores[name] = JSON.parse(raw);
      if (stores[name] === null) {
        throw codedError('LEARNING_STORE_CORRUPT', `${name} learning store cannot be null`);
      }
    }
    catch { throw codedError('LEARNING_STORE_CORRUPT', `${name} learning store is not valid JSON`); }
  }
  return stores;
}

function keyedFacts(logicalStore, sourceStore, record, identityKind = 'legacy_alias') {
  return Object.entries(record).map(([sourceKey, value]) => ({
    logicalStore,
    sourceStore,
    sourceKey,
    ...(identityKind === 'legacy_alias' ? { legacyAlias: sourceKey } : { identityKind }),
    value: structuredClone(value),
  }));
}

function genericFacts(logicalStore, value) {
  if (value === null) return [];
  if (Array.isArray(value)) {
    return value.map((entry, index) => ({
      logicalStore,
      sourceStore: logicalStore,
      sourceKey: String(index),
      identityKind: 'unknown',
      value: structuredClone(entry),
    }));
  }
  const record = requireRecord(value, logicalStore);
  return keyedFacts(logicalStore, logicalStore, record, 'unknown');
}

function extractLearningFacts(stores, { legacy = false } = {}) {
  const facts = [];
  const stateStore = stores.state;
  if (stateStore !== null) {
    const root = requireRecord(stateStore, 'state');
    for (const field of ['progress', 'favorites', 'edits']) {
      if (Object.hasOwn(root, field)) requireRecord(root[field], `state.${field}`);
    }
    facts.push(...keyedFacts('state', 'state', root.progress || {}));
    facts.push(...keyedFacts('state', 'edits', root.edits || {}));
    facts.push(...Object.entries(root.favorites || {}).map(([thai, value]) => ({
      logicalStore: 'state',
      sourceStore: 'favorites',
      sourceKey: thai,
      identityKind: 'workspace',
      value: { thai, favorite: structuredClone(value) },
    })));
    for (const [field, value] of Object.entries(root)) {
      if (['progress', 'favorites', 'edits'].includes(field)
          || (legacy && LEGACY_DEVICE_STATE_FIELDS.has(field))) continue;
      facts.push({
        logicalStore: 'state',
        sourceStore: 'state_unknown',
        sourceKey: field,
        identityKind: 'unknown',
        value: structuredClone(value),
      });
    }
  }

  const dailyStore = stores.daily;
  if (dailyStore !== null) {
    const daily = requireRecord(dailyStore, 'daily');
    if (Object.hasOwn(daily, 'days')) requireRecord(daily.days, 'daily.days');
    facts.push(...keyedFacts('daily', 'daily', daily.days || {}, 'workspace'));
    const meta = {};
    for (const field of ['protection', 'protectionRefillCheckpoint', 'makeupPending']) {
      if (daily[field] !== undefined && daily[field] !== null && daily[field] !== 0) meta[field] = daily[field];
    }
    if (Object.keys(meta).length) {
      facts.push({
        logicalStore: 'daily', sourceStore: 'daily', sourceKey: 'meta',
        identityKind: 'workspace', value: structuredClone(meta),
      });
    }
    for (const [field, value] of Object.entries(daily)) {
      if (['v', 'backfilled', 'days', 'protection', 'protectionRefillCheckpoint', 'makeupPending'].includes(field)) continue;
      facts.push({
        logicalStore: 'daily', sourceStore: 'daily', sourceKey: `unknown:${field}`,
        identityKind: 'unknown', value: structuredClone(value),
      });
    }
  }

  const historyStore = stores.history;
  if (historyStore !== null) {
    const history = requireRecord(historyStore, 'history');
    if (Object.hasOwn(history, 'cards')) requireRecord(history.cards, 'history.cards');
    facts.push(...keyedFacts('history', 'history', history.cards || {}));
    for (const [field, value] of Object.entries(history)) {
      if (['v', 'cards'].includes(field)) continue;
      facts.push({
        logicalStore: 'history', sourceStore: 'history', sourceKey: `unknown:${field}`,
        identityKind: 'unknown', value: structuredClone(value),
      });
    }
  }

  if (stores.achievements !== null) {
    facts.push(...keyedFacts(
      'achievements', 'achievements', requireRecord(stores.achievements, 'achievements'), 'workspace',
    ));
  }
  if (stores.remoteDays !== null) {
    facts.push(...keyedFacts(
      'remoteDays', 'remoteDays', requireRecord(stores.remoteDays, 'remoteDays'), 'workspace',
    ));
  }
  for (const name of ['events', 'outbox', 'cycle', 'cursors']) {
    facts.push(...genericFacts(name, stores[name]));
  }
  if (stores.resweep !== null) {
    const resweep = requireRecord(stores.resweep, 'resweep');
    const meaningful = Object.keys(resweep).some(key => resweep[key] !== null && resweep[key] !== 0 && resweep[key] !== '');
    if (meaningful) {
      facts.push({
        logicalStore: 'resweep', sourceStore: 'resweep', sourceKey: 'legacy-cursor',
        identityKind: 'legacy_cursor', value: structuredClone(resweep),
      });
    }
  }
  return facts;
}

export function captureLegacyLearningSnapshot(storage) {
  try {
    const stores = readLearningStores(storage);
    const facts = extractLearningFacts(stores, { legacy: true });
    const signature = stableSerialize(facts);
    return {
      status: 'ok',
      snapshot: {
        kind: 'legacy-learning-snapshot-v1',
        snapshotId: `legacy-learning-fnv1a32-${smallStableHash(signature)}`,
        facts,
      },
    };
  } catch (error) {
    return {
      status: error?.code === 'STORAGE_UNAVAILABLE' ? 'unavailable' : 'corrupt',
      error,
    };
  }
}

export function inspectNamespacedLocalCounts(storage, workspaceId) {
  const workspace = requiredIdentity(workspaceId);
  if (storage?.workspaceId !== workspace) {
    throw codedError('CLAIM_WORKSPACE_MISMATCH', 'local counts belong to another workspace');
  }
  const stores = readLearningStores(storage);
  const facts = extractLearningFacts(stores);
  const counts = Object.fromEntries(CLAIM_LOCAL_STORES.map(name => [name, 0]));
  for (const fact of facts) counts[fact.logicalStore] += 1;
  return {
    workspaceId: workspace,
    revision: `local-learning-fnv1a32-${smallStableHash(stableSerialize(stores))}`,
    counts,
  };
}

const workspaceStorageBindings = new WeakMap();

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function bootScreenFor(state) {
  const screen = BOOT_SCREENS[state];
  if (!screen) throw codedError('UNKNOWN_BOOT_STATE', `unknown boot state: ${state}`);
  return structuredClone(screen);
}

export function runLegacyLearningBootGate({ loadStateResult, onFailure, onReady } = {}) {
  if (typeof loadStateResult !== 'function' || typeof onFailure !== 'function') {
    throw codedError(
      'LEGACY_BOOT_ADAPTER_INCOMPLETE',
      'legacy boot requires loadStateResult and onFailure',
    );
  }
  let outcome;
  try {
    outcome = loadStateResult();
  } catch {
    outcome = { status: 'unavailable', phase: 'read' };
  }
  if (outcome?.status === 'ok') {
    onReady?.(outcome);
    return true;
  }

  const unavailable = outcome?.status === 'unavailable';
  const state = unavailable ? 'storage-unavailable' : 'recoverable-failure';
  onFailure({
    state,
    screen: bootScreenFor(state),
    diagnostics: unavailable
      ? '瀏覽器未能完成安全讀取或必要寫入，請確認儲存權限與可用空間後重試。'
      : '原始資料已保留，尚未寫入。學習資料未通過安全驗證，請重試或保留此畫面供診斷。',
    outcome,
  });
  return false;
}

export function createWorkspaceBoot() {
  let current = {
    state: 'checking-session',
    details: null,
    workspaceId: null,
    epoch: 0,
  };
  return {
    moveTo(state, details = null) {
      if (!BOOT_SCREENS[state]) {
        throw codedError('UNKNOWN_BOOT_STATE', `unknown boot state: ${state}`);
      }
      if (!BOOT_TRANSITIONS[current.state].has(state)) {
        throw codedError(
          'INVALID_BOOT_TRANSITION',
          `cannot move workspace boot from ${current.state} to ${state}`,
        );
      }
      const bindingWorkspaceId = current.state === 'checking-session' && state === 'loading-catalog'
        ? requiredIdentity(details?.workspaceId)
        : current.workspaceId;
      current = {
        state,
        details: details ? structuredClone(details) : null,
        workspaceId: state === 'checking-session' ? null : bindingWorkspaceId,
        epoch: current.state === 'checking-session' && state === 'loading-catalog'
          ? current.epoch + 1
          : current.epoch,
      };
      return this.snapshot();
    },
    snapshot() {
      return {
        ...structuredClone(current),
        ready: current.state === 'ready',
        screen: bootScreenFor(current.state),
      };
    },
    assertReady(expectedWorkspaceId, expectedEpoch) {
      if (current.state !== 'ready') {
        throw codedError('WORKSPACE_NOT_READY', `workspace boot is ${current.state}`);
      }
      if (current.workspaceId !== requiredIdentity(expectedWorkspaceId)
          || current.epoch !== expectedEpoch) {
        throw codedError('WORKSPACE_INVALIDATED', 'workspace storage handle belongs to an older boot');
      }
    },
  };
}

function validateSessionResolution(result) {
  if (result?.status === 'authenticated' && result?.session?.user?.id) return result;
  if (result?.status === 'anonymous' && result?.session == null) return result;
  if (result?.status === 'unavailable') {
    throw codedError('SESSION_UNAVAILABLE', 'session could not be resolved safely');
  }
  throw codedError('SESSION_RESULT_INVALID', 'session resolver returned an invalid result');
}

function bootFailureState(error, phase) {
  return error?.code === 'STORAGE_UNAVAILABLE' || phase === 'opening-storage'
    ? 'storage-unavailable'
    : 'recoverable-failure';
}

/* Pure boot coordinator. Adapters own auth, catalog, storage, migration, hydration,
   and DOM. Learning state is intentionally absent from this function: callers may
   only read or write it after the returned storage handle has reached ready. */
export async function runWorkspaceBoot({
  boot = createWorkspaceBoot(),
  resolveSession,
  resolveDeviceId,
  loadCatalog,
  openStorage,
  inspectDurability = async () => null,
  migrate = null,
  hydrate = null,
  onState = () => {},
} = {}) {
  if (typeof resolveSession !== 'function'
      || typeof resolveDeviceId !== 'function'
      || typeof loadCatalog !== 'function'
      || typeof openStorage !== 'function'
      || typeof inspectDurability !== 'function'
      || typeof onState !== 'function'
      || (migrate !== null && typeof migrate !== 'function')
      || (hydrate !== null && typeof hydrate !== 'function')) {
    throw codedError('WORKSPACE_BOOT_ADAPTER_INCOMPLETE', 'workspace boot adapters are incomplete');
  }

  let phase = 'checking-session';
  let workspaceId = null;
  const emit = () => onState(boot.snapshot());

  try {
    emit();
    const sessionResult = validateSessionResolution(await resolveSession());
    const deviceId = sessionResult.status === 'anonymous'
      ? requiredIdentity(await resolveDeviceId())
      : null;
    workspaceId = resolveWorkspaceId({ session: sessionResult.session, deviceId });

    phase = 'loading-catalog';
    boot.moveTo(phase, { workspaceId });
    emit();
    const catalog = await loadCatalog({ workspaceId, session: sessionResult.session });
    if (!catalog) throw codedError('CATALOG_UNAVAILABLE', 'catalog loader returned no catalog');

    phase = 'opening-storage';
    boot.moveTo(phase);
    emit();
    const storage = await openStorage({ workspaceId, boot });
    const binding = storage && workspaceStorageBindings.get(storage);
    if (!binding
        || binding.boot !== boot
        || binding.workspaceId !== workspaceId
        || binding.epoch !== boot.snapshot().epoch) {
      throw codedError('STORAGE_UNAVAILABLE', 'workspace storage was not opened safely');
    }
    const durability = await inspectDurability({ workspaceId, storage });

    let migration = null;
    if (migrate) {
      phase = 'migrating';
      boot.moveTo(phase);
      emit();
      migration = await migrate({
        workspaceId,
        session: sessionResult.session,
        catalog,
        storage,
        migrationStorage: binding.hydrationStorage,
      });
    }

    let hydration = null;
    if (hydrate) {
      phase = 'hydrating';
      hydration = await hydrate({
        workspaceId,
        session: sessionResult.session,
        catalog,
        storage,
        boot,
        migration,
        hydrationStorage: binding.hydrationStorage,
        writeHydration: binding.writeHydration,
      });
    }

    phase = 'ready';
    boot.moveTo(phase, migration || hydration ? { migration, hydration } : null);
    emit();
    return {
      status: 'ready',
      workspaceId,
      session: sessionResult.session,
      catalog,
      storage,
      durability,
      migration,
      hydration,
      boot,
    };
  } catch (error) {
    const state = bootFailureState(error, phase);
    if (boot.snapshot().state !== state) {
      boot.moveTo(state, {
        phase,
        code: error?.code || 'WORKSPACE_BOOT_FAILED',
      });
    }
    try { emit(); } catch { /* failure rendering must not replace the boot error */ }
    return {
      status: state,
      workspaceId,
      error,
      boot,
    };
  }
}

function requiredIdentity(value) {
  const identity = typeof value === 'string' ? value.trim() : '';
  if (!identity || /[\u0000-\u001f\u007f]/.test(identity)) {
    throw codedError('WORKSPACE_ID_MISSING', 'workspace identity is missing');
  }
  return identity;
}

export function resolveWorkspaceId({ session = null, deviceId } = {}) {
  if (session) return `user:${requiredIdentity(session?.user?.id)}`;
  return `anon:${requiredIdentity(deviceId)}`;
}

export function scopedStorageKey(workspaceId, logicalKey) {
  const workspace = requiredIdentity(workspaceId);
  const key = requiredIdentity(logicalKey);
  return `thai-review-workspace:${encodeURIComponent(workspace)}:${key}`;
}

export function createWorkspaceStorage(storage, { workspaceId, boot } = {}) {
  if (!storage
      || typeof storage.getItem !== 'function'
      || typeof storage.setItem !== 'function'
      || typeof storage.removeItem !== 'function') {
    throw codedError('STORAGE_UNAVAILABLE', 'storage adapter is unavailable');
  }
  const workspace = requiredIdentity(workspaceId);
  const canaryKey = scopedStorageKey(workspace, '__storage_canary__');
  let previousCanary = null;
  try {
    previousCanary = storage.getItem(canaryKey);
    const canaryValue = `workspace-canary:${workspace}`;
    storage.setItem(canaryKey, canaryValue);
    if (storage.getItem(canaryKey) !== canaryValue) {
      throw new Error('storage canary read-back mismatch');
    }
    if (previousCanary === null) storage.removeItem(canaryKey);
    else storage.setItem(canaryKey, previousCanary);
    if (storage.getItem(canaryKey) !== previousCanary) {
      throw new Error('storage canary cleanup mismatch');
    }
  } catch {
    try {
      if (previousCanary === null) storage.removeItem(canaryKey);
      else storage.setItem(canaryKey, previousCanary);
    } catch { /* best-effort cleanup before failing closed */ }
    throw codedError('STORAGE_UNAVAILABLE', 'storage write verification failed');
  }
  const bootBinding = boot && typeof boot.snapshot === 'function'
    ? boot.snapshot()
    : null;
  const ready = boot && typeof boot.assertReady === 'function'
    ? () => boot.assertReady(workspace, bootBinding?.epoch)
    : () => { throw codedError('WORKSPACE_NOT_READY', 'workspace readiness gate is missing'); };
  const prefix = `thai-review-workspace:${encodeURIComponent(workspace)}:`;
  const physicalKey = key => scopedStorageKey(workspace, key);
  const ownKeys = () => {
    const keys = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (typeof key === 'string' && key.startsWith(prefix)) keys.push(key);
    }
    return keys;
  };

  const workspaceStorage = {
    workspaceId: workspace,
    get length() { ready(); return ownKeys().length; },
    key(index) {
      ready();
      const key = ownKeys()[index];
      return key ? key.slice(prefix.length) : null;
    },
    getItem(key) { ready(); return storage.getItem(physicalKey(key)); },
    setItem(key, value) { ready(); storage.setItem(physicalKey(key), value); },
    removeItem(key) { ready(); storage.removeItem(physicalKey(key)); },
    clear() {
      ready();
      for (const key of ownKeys()) storage.removeItem(key);
    },
  };
  const assertHydrationActive = () => {
    const snapshot = boot.snapshot();
    if (snapshot.workspaceId !== workspace || snapshot.epoch !== bootBinding?.epoch
        || !['opening-storage', 'migrating'].includes(snapshot.state)) {
      throw codedError('WORKSPACE_NOT_READY', 'workspace hydration storage is not active');
    }
  };
  const hydrationStorage = {
    workspaceId: workspace,
    getItem(key) {
      assertHydrationActive();
      return storage.getItem(physicalKey(key));
    },
    setItem(key, value) {
      assertHydrationActive();
      storage.setItem(physicalKey(key), value);
    },
  };
  const writeHydration = (key, value) => hydrationStorage.setItem(key, value);
  workspaceStorageBindings.set(workspaceStorage, {
    boot,
    workspaceId: workspace,
    epoch: bootBinding?.epoch,
    hydrationStorage,
    writeHydration,
  });
  return workspaceStorage;
}

/* Production runtime entry gate.  App code must pass the capability-bound port
   returned by runWorkspaceBoot; plain localStorage and stale boot handles are
   rejected before any learning helper can fall back to a legacy key. */
export function requireWorkspaceStorage(storage) {
  if (!storage
      || typeof storage.workspaceId !== 'string'
      || typeof storage.getItem !== 'function'
      || typeof storage.setItem !== 'function'
      || typeof storage.removeItem !== 'function') {
    throw codedError('WORKSPACE_NOT_READY', 'workspace storage is not ready');
  }
  storage.getItem('__runtime_readiness__');
  return storage;
}

export async function inspectStorageDurability(storageManager) {
  if (!storageManager
      || typeof storageManager.persist !== 'function'
      || typeof storageManager.estimate !== 'function') {
    return {
      supported: false,
      persistedBefore: null,
      persistGranted: null,
      usage: null,
      quota: null,
    };
  }
  const persistedBefore = typeof storageManager.persisted === 'function'
    ? await storageManager.persisted()
    : null;
  const persistGranted = persistedBefore === true
    ? true
    : await storageManager.persist();
  const estimate = await storageManager.estimate();
  return {
    supported: true,
    persistedBefore,
    persistGranted,
    usage: Number.isFinite(estimate?.usage) ? estimate.usage : null,
    quota: Number.isFinite(estimate?.quota) ? estimate.quota : null,
  };
}

export function getOrCreateWorkspaceInstallationId(storage, createId) {
  const key = LEARNING_STORE_KEYS.installation;
  const existing = storage.getItem(key);
  if (existing) return existing;
  const installationId = requiredIdentity(createId?.());
  storage.setItem(key, installationId);
  return installationId;
}

export async function logoutToAnonymous({
  deviceId,
  invalidate,
  cleanup,
  clearAuth,
  activate,
  reload,
} = {}) {
  if (typeof invalidate !== 'function'
      || typeof clearAuth !== 'function'
      || typeof activate !== 'function'
      || typeof reload !== 'function') {
    throw codedError('LOGOUT_ADAPTER_INCOMPLETE', 'logout requires invalidate, clearAuth, activate, and reload');
  }
  const workspaceId = resolveWorkspaceId({ deviceId });
  invalidate();
  await clearAuth();
  cleanup?.();
  activate(workspaceId);
  reload();
  return workspaceId;
}

function allCountsZero(counts) {
  const values = counts?.counts ?? counts;
  return !!values && CLAIM_LOCAL_STORES.every(name => {
    const value = values[name];
    return Object.hasOwn(values, name)
      && typeof value === 'number'
      && Number.isFinite(value)
      && Number.isInteger(value)
      && value >= 0
      && value === 0;
  });
}

const issuedClaimAuthorizations = new WeakSet();
const issuedClaimOffers = new WeakSet();

function snapshotSignature(snapshot) {
  return stableSerialize({
    snapshotId: snapshot?.snapshotId,
    facts: snapshot?.facts,
  });
}

function claimBindingIsValid(legacyFactCount, legacySnapshot, migrationPlan) {
  return Number.isInteger(legacyFactCount)
    && legacyFactCount > 0
    && Array.isArray(legacySnapshot?.facts)
    && legacyFactCount === legacySnapshot.facts.length
    && legacyFactCount === migrationPlan?.summary?.original
    && !!legacySnapshot?.snapshotId
    && legacySnapshot.snapshotId === migrationPlan?.snapshotId
    && migrationPlan?.sourceSnapshotSignature === snapshotSignature(legacySnapshot)
    && migrationPlan?.conservation?.valid === true
    && typeof migrationPlan?.planId === 'string'
    && typeof migrationPlan?.planSignature === 'string'
    && migrationPlan.planSignature === migrationPlanSignature(migrationPlan);
}

function claimEligibilityIsValid(localCounts, remotePull, workspaceId) {
  return typeof workspaceId === 'string'
    && workspaceId.startsWith('user:')
    && localCounts?.workspaceId === workspaceId
    && remotePull?.workspaceId === workspaceId
    && typeof localCounts?.revision === 'string'
    && localCounts.revision === localCounts.revision.trim()
    && localCounts.revision.length > 0
    && typeof remotePull?.receiptId === 'string'
    && remotePull.receiptId === remotePull.receiptId.trim()
    && remotePull.receiptId.length > 0;
}

function issueClaimAuthorization({
  workspaceId,
  legacySnapshot,
  migrationPlan,
  namespacedLocalCounts,
  firstRemotePull,
}) {
  const workspace = requiredIdentity(workspaceId);
  if (!workspace.startsWith('user:')) {
    throw codedError('CLAIM_BINDING_INVALID', 'legacy claim target must be a user workspace');
  }
  if (!claimBindingIsValid(legacySnapshot?.facts?.length, legacySnapshot, migrationPlan)) {
    throw codedError('CLAIM_BINDING_INVALID', 'legacy snapshot and migration plan do not match');
  }
  if (!claimEligibilityIsValid(namespacedLocalCounts, firstRemotePull, workspace)) {
    throw codedError('CLAIM_WORKSPACE_MISMATCH', 'claim eligibility belongs to another workspace');
  }
  const authorization = Object.freeze({
    kind: 'legacy-claim-authorization-v1',
    confirmed: true,
    workspaceId: workspace,
    snapshotId: migrationPlan.snapshotId,
    sourceSnapshotSignature: migrationPlan.sourceSnapshotSignature,
    planId: migrationPlan.planId,
    planSignature: migrationPlan.planSignature,
    localRevision: namespacedLocalCounts.revision,
    remotePullReceiptId: firstRemotePull.receiptId,
  });
  issuedClaimAuthorizations.add(authorization);
  return authorization;
}

function issueClaimOffer(workspaceId, migrationPlan) {
  const offerToken = Object.freeze({
    kind: 'legacy-claim-offer-v1',
    workspaceId,
    snapshotId: migrationPlan.snapshotId,
    planId: migrationPlan.planId,
  });
  issuedClaimOffers.add(offerToken);
  return offerToken;
}

function consumeClaimOffer(offerToken, workspaceId, migrationPlan) {
  if (!offerToken || !issuedClaimOffers.delete(offerToken)
      || offerToken.kind !== 'legacy-claim-offer-v1'
      || offerToken.workspaceId !== workspaceId
      || offerToken.snapshotId !== migrationPlan.snapshotId
      || offerToken.planId !== migrationPlan.planId) {
    throw codedError(
      'CLAIM_CONFIRMATION_REQUIRED',
      'a current one-shot legacy claim offer is required',
    );
  }
}

export function evaluateLegacyClaim({
  accountLabel,
  namespacedLocalCounts,
  firstRemotePull,
  legacyFactCount = 0,
  decision = null,
  legacySnapshot = null,
  targetWorkspaceId = null,
  migrationPlan = null,
  offerToken = null,
} = {}) {
  const eligible = allCountsZero(namespacedLocalCounts)
    && firstRemotePull?.completed === true
    && firstRemotePull?.rowCount === 0
    && claimEligibilityIsValid(namespacedLocalCounts, firstRemotePull, targetWorkspaceId)
    && claimBindingIsValid(legacyFactCount, legacySnapshot, migrationPlan);

  if (!eligible) {
    return { status: 'not-offered', mergeAnonymous: false, plan: null };
  }
  if (decision === 'cancel') {
    return {
      status: 'cancelled',
      mergeAnonymous: false,
      plan: null,
      legacySnapshot,
    };
  }
  if (decision === 'claim') {
    consumeClaimOffer(offerToken, targetWorkspaceId, migrationPlan);
    return {
      status: 'confirmed',
      mergeAnonymous: false,
      authorization: issueClaimAuthorization({
        workspaceId: targetWorkspaceId,
        legacySnapshot,
        migrationPlan,
        namespacedLocalCounts,
        firstRemotePull,
      }),
    };
  }
  return {
    status: 'offer',
    accountLabel: accountLabel || '目前帳號',
    legacyFactCount: legacySnapshot.facts.length,
    mergeAnonymous: false,
    message: `將這台裝置的進度加入此帳號（${legacySnapshot.facts.length} 筆）`,
    offerToken: issueClaimOffer(targetWorkspaceId, migrationPlan),
    actions: [
      { id: 'claim', label: '將這台裝置的進度加入此帳號' },
      { id: 'cancel', label: '先不要' },
    ],
  };
}

function stableCardId(value) {
  return typeof value === 'string'
    && value === value.trim()
    && isStableCardId(value);
}

const WORKSPACE_FACT_STORES = new Set(['daily', 'achievements', 'remoteDays', 'favorites']);

function buildLegacyMaterializations(resolved) {
  const progressByCard = new Map();
  for (const row of resolved) {
    if (row.sourceStore !== 'state'
        || !stableCardId(row.cardId)) continue;
    const rows = progressByCard.get(row.cardId) || [];
    rows.push(row);
    progressByCard.set(row.cardId, rows);
  }

  const srs = [];
  for (const [cardId, rows] of progressByCard) {
    if (rows.length !== 1 || !isSrsStateSnapshot(rows[0].value)) continue;
    const row = rows[0];
    row.materialization = 'srs_v2';
    srs.push({
      cardId,
      state: structuredClone(row.value),
      sourceStore: row.sourceStore,
      sourceKey: row.sourceKey,
    });
  }

  const projectionGroups = new Map();
  for (const row of resolved) {
    if (row.migrationKind !== 'workspace_fact' || !WORKSPACE_FACT_STORES.has(row.sourceStore)) {
      continue;
    }
    row.materialization = `projection:${row.sourceStore}`;
    const facts = projectionGroups.get(row.sourceStore) || [];
    facts.push({
      sourceStore: row.sourceStore,
      sourceKey: row.sourceKey,
      value: structuredClone(row.value),
    });
    projectionGroups.set(row.sourceStore, facts);
  }
  const projections = [...projectionGroups.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, facts]) => ({ name, facts }));
  return { schemaVersion: 1, srs, projections };
}

function normalizeLineageEvidence(evidence, trustedRevisionManifest) {
  const expected = evidence?.expectedRevisions;
  const snapshots = evidence?.snapshots;
  const requiredRevisions = trustedRevisionManifest?.revisions;
  if (trustedRevisionManifest?.kind !== 'trusted-lineage-revision-manifest-v1'
      || !Array.isArray(requiredRevisions)
      || requiredRevisions.length === 0
      || new Set(requiredRevisions).size !== requiredRevisions.length
      || requiredRevisions.some(revision => (
        typeof revision !== 'string' || !revision.trim() || revision !== revision.trim()
      ))
      || !['production-lineage-evidence-v1', 'production-lineage-evidence-v2'].includes(evidence?.kind)
      // v1 的 evidenceId 沒有從內容重算，任何人湊出對的 expectedRevisions 就能塞任意
      // alias 對應。Production 產生的 trust manifest 不會開這個旗標；只有拿手寫 manifest
      // 的歷史 snapshot 測試才收 v1。
      || (evidence.kind === 'production-lineage-evidence-v1'
        && trustedRevisionManifest?.allowHistoricalSnapshotEvidence !== true)
      || typeof evidence?.evidenceId !== 'string'
      || !evidence.evidenceId.trim()
      || evidence.evidenceId !== evidence.evidenceId.trim()
      || evidence?.completeness !== 'complete'
      || !Array.isArray(expected)
      || expected.length === 0
      || new Set(expected).size !== expected.length
      || expected.some(revision => typeof revision !== 'string' || !revision.trim())
      || stableSerialize(expected) !== stableSerialize(requiredRevisions)
      || (evidence.kind === 'production-lineage-evidence-v1'
        && (!Array.isArray(snapshots) || snapshots.length !== expected.length))) {
    return { complete: false, snapshots: [] };
  }
  if (evidence.kind === 'production-lineage-evidence-v2') {
    return normalizeCompactLineageEvidence(evidence, trustedRevisionManifest);
  }
  const byRevision = new Map();
  for (const snapshot of snapshots) {
    if (snapshot?.complete !== true
        || typeof snapshot?.revision !== 'string'
        || !snapshot.revision.trim()
        || !snapshot.aliases
        || typeof snapshot.aliases !== 'object'
        || Array.isArray(snapshot.aliases)
        || byRevision.has(snapshot.revision)) {
      return { complete: false, snapshots: [] };
    }
    const aliases = structuredClone(snapshot.aliases);
    const cardIdOccurrences = new Map();
    for (const candidates of Object.values(aliases)) {
      if (!Array.isArray(candidates)) continue;
      for (const candidate of candidates) {
        if (typeof candidate !== 'string') continue;
        const normalized = candidate.toLowerCase();
        cardIdOccurrences.set(normalized, (cardIdOccurrences.get(normalized) || 0) + 1);
      }
    }
    byRevision.set(snapshot.revision, {
      revision: snapshot.revision,
      aliases,
      cardIdOccurrences,
    });
  }
  if (expected.some(revision => !byRevision.has(revision))
      || [...byRevision.keys()].some(revision => !expected.includes(revision))) {
    return { complete: false, snapshots: [] };
  }
  const normalizedSnapshots = expected.map(revision => byRevision.get(revision));
  const aliasResolutionCache = new Map();
  const lineageProvenance = {
    evidenceId: evidence.evidenceId,
    digest: `fnv1a32:${smallStableHash(stableSerialize({ evidence, trustedRevisionManifest }))}`,
    revisionManifest: {
      kind: trustedRevisionManifest.kind,
      revisions: structuredClone(requiredRevisions),
    },
  };
  return {
    complete: true,
    snapshots: normalizedSnapshots,
    collisionAliases: new Set(normalizedSnapshots.flatMap(snapshot => (
      Object.entries(snapshot.aliases)
        .filter(([, candidates]) => Array.isArray(candidates) && candidates.length > 1)
        .map(([alias]) => alias)
    ))),
    lineageProvenance,
    canonicalCardIdProven(cardId) {
      const normalized = cardId.toLowerCase();
      return normalizedSnapshots.every(snapshot => (
        snapshot.cardIdOccurrences.get(normalized) === 1
      ));
    },
    resolveAlias(alias) {
      if (!aliasResolutionCache.has(alias)) {
        aliasResolutionCache.set(alias, resolveHistoricalLineage(alias, normalizedSnapshots));
      }
      return aliasResolutionCache.get(alias);
    },
  };
}

/* evidenceId 是 32-bit FNV，塞得進額外 bytes 就有空間湊碰撞。只擋未知的 top-level
   key 不夠——白名單內的自由字串（generatedAt）與可延伸的子物件（source）一樣是填充
   空間，所以形狀也要一起釘死。 */
const COMPACT_LINEAGE_FIELDS = Object.freeze(new Set([
  'kind', 'schemaVersion', 'completeness', 'generatedAt', 'expectedRevisions',
  'source', 'resolvedAliases', 'unresolvedReasons', 'collisionAliases',
  'canonicalCardIds', 'summary', 'evidenceId',
]));
const COMPACT_LINEAGE_SOURCE_FIELDS = Object.freeze(new Set([
  'deploymentManifestSha256', 'gateManifestSha256', 'projectName', 'environment',
]));
const COMPACT_LINEAGE_SUMMARY_FIELDS = Object.freeze(new Set([
  'deploymentCount', 'currentCardCount', 'currentAliasCount',
  'resolvedAliasCount', 'unresolvedAliasCount', 'historicalCollisionAliasCount',
]));
const ISO_OFFSET_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{4}$/;

function boundedShape(value, allowed) {
  return !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).every(field => allowed.has(field));
}

function normalizeCompactLineageEvidence(evidence, trustedRevisionManifest) {
  if (Object.keys(evidence).some(field => !COMPACT_LINEAGE_FIELDS.has(field))
      || evidence.schemaVersion !== 2
      || typeof evidence.generatedAt !== 'string'
      || !ISO_OFFSET_TIMESTAMP.test(evidence.generatedAt)
      || !boundedShape(evidence.source, COMPACT_LINEAGE_SOURCE_FIELDS)
      || !boundedShape(evidence.summary, COMPACT_LINEAGE_SUMMARY_FIELDS)
      || Object.values(evidence.summary).some(count => !Number.isSafeInteger(count) || count < 0)
      || Object.values(evidence.source).some(field => typeof field !== 'string' || !field.trim())) {
    return { complete: false, snapshots: [] };
  }
  const resolvedAliases = evidence?.resolvedAliases;
  const unresolvedReasons = evidence?.unresolvedReasons;
  const collisionAliases = evidence?.collisionAliases;
  const canonicalCardIds = evidence?.canonicalCardIds;
  if (!resolvedAliases || typeof resolvedAliases !== 'object' || Array.isArray(resolvedAliases)
      || !unresolvedReasons || typeof unresolvedReasons !== 'object' || Array.isArray(unresolvedReasons)
      || !Array.isArray(collisionAliases) || new Set(collisionAliases).size !== collisionAliases.length
      || !Array.isArray(canonicalCardIds) || new Set(canonicalCardIds).size !== canonicalCardIds.length) {
    return { complete: false, snapshots: [] };
  }
  const resolvedEntries = Object.entries(resolvedAliases);
  const unresolvedEntries = Object.entries(unresolvedReasons);
  const resolvedKeys = new Set(resolvedEntries.map(([alias]) => alias));
  const unresolvedKeys = new Set(unresolvedEntries.map(([alias]) => alias));
  const resolvedIds = [...new Set(resolvedEntries.map(([, cardId]) => cardId))].sort();
  const { evidenceId, ...evidenceCore } = evidence;
  const expectedEvidenceId = `production-lineage-evidence-v2:fnv1a32:${smallStableHash(stableSerialize(evidenceCore))}`;
  const validReasons = new Set([
    'missing_historical_evidence', 'historical_collision', 'invalid_lineage_identity',
    'duplicate_stable_card_id', 'lineage_changed',
  ]);
  if (evidenceId !== expectedEvidenceId
      || trustedRevisionManifest?.evidenceId !== evidenceId
      || trustedRevisionManifest?.sourceManifestSha256 !== evidence?.source?.deploymentManifestSha256
      || trustedRevisionManifest?.projectName !== evidence?.source?.projectName
      || trustedRevisionManifest?.environment !== evidence?.source?.environment
      || resolvedEntries.some(([alias, cardId]) => !alias.trim() || !stableCardId(cardId))
      || unresolvedEntries.some(([alias, reason]) => !alias.trim() || !validReasons.has(reason))
      || [...resolvedKeys].some(alias => unresolvedKeys.has(alias))
      || collisionAliases.some(alias => (
        typeof alias !== 'string'
        || !alias.trim()
        || resolvedKeys.has(alias)
        || (unresolvedKeys.has(alias) && unresolvedReasons[alias] !== 'historical_collision')
      ))
      || resolvedIds.length !== resolvedEntries.length
      || stableSerialize([...canonicalCardIds].sort()) !== stableSerialize(resolvedIds)
      || evidence?.summary?.resolvedAliasCount !== resolvedEntries.length
      || evidence?.summary?.unresolvedAliasCount !== unresolvedEntries.length
      || evidence?.summary?.currentAliasCount !== resolvedEntries.length + unresolvedEntries.length
      || evidence?.summary?.historicalCollisionAliasCount !== collisionAliases.length) {
    return { complete: false, snapshots: [] };
  }
  const canonicalSet = new Set(canonicalCardIds);
  return {
    complete: true,
    snapshots: [],
    collisionAliases: new Set(collisionAliases),
    lineageProvenance: {
      evidenceId: evidence.evidenceId,
      digest: `fnv1a32:${smallStableHash(stableSerialize({ evidence, trustedRevisionManifest }))}`,
      revisionManifest: {
        kind: trustedRevisionManifest.kind,
        revisions: structuredClone(trustedRevisionManifest.revisions),
      },
    },
    canonicalCardIdProven(cardId) {
      return canonicalSet.has(cardId.toLowerCase());
    },
    resolveAlias(alias) {
      if (Object.hasOwn(resolvedAliases, alias)) {
        return { status: 'resolved', cardId: resolvedAliases[alias].toLowerCase() };
      }
      return {
        status: 'quarantine',
        reason: unresolvedReasons[alias] || 'missing_historical_evidence',
      };
    },
  };
}

function resolveHistoricalLineage(alias, snapshots) {
  if (!snapshots.length) return { status: 'quarantine', reason: 'missing_historical_evidence' };
  const ids = [];
  for (const snapshot of snapshots) {
    const candidates = snapshot?.aliases?.[alias];
    if (!Array.isArray(candidates) || candidates.length === 0) {
      return { status: 'quarantine', reason: 'missing_historical_evidence' };
    }
    if (candidates.length !== 1) {
      return { status: 'quarantine', reason: 'historical_collision' };
    }
    const cardId = candidates[0];
    if (!stableCardId(cardId)) {
      return { status: 'quarantine', reason: 'invalid_lineage_identity' };
    }
    if (snapshot.cardIdOccurrences.get(cardId.toLowerCase()) !== 1) {
      return { status: 'quarantine', reason: 'duplicate_stable_card_id' };
    }
    ids.push(cardId.toLowerCase());
  }
  if (new Set(ids).size !== 1) {
    return { status: 'quarantine', reason: 'lineage_changed' };
  }
  return { status: 'resolved', cardId: ids[0] };
}

function nonempty(value) {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return value !== '';
}

function migrationAudit(facts, collisionAliases = new Set()) {
  const factsByAlias = new Map();
  for (const row of facts) {
    const alias = typeof row.legacyAlias === 'string' ? row.legacyAlias.trim() : '';
    const rows = factsByAlias.get(alias) || [];
    rows.push(row);
    factsByAlias.set(alias, rows);
  }
  const details = [...collisionAliases].sort().map(legacyAlias => {
    const rows = factsByAlias.get(legacyAlias) || [];
    const nonemptySrs = rows.some(row => row.sourceStore === 'state' && nonempty(row.value));
    const nonemptyGradeHistory = rows.some(row => row.sourceStore === 'history' && nonempty(row.value));
    return {
      legacyAlias,
      factCount: rows.length,
      nonemptySrs,
      nonemptyGradeHistory,
      sourceKeys: rows.map(row => `${row.sourceStore}:${row.sourceKey}`).sort(),
    };
  });
  const total = details.length;
  const srs = details.filter(row => row.nonemptySrs).length;
  const history = details.filter(row => row.nonemptyGradeHistory).length;
  const any = details.filter(row => row.nonemptySrs || row.nonemptyGradeHistory).length;
  return {
    collisionAliasCount: total,
    collisionAliasesWithNonemptySrsCount: srs,
    collisionAliasesWithNonemptySrsRatio: total ? srs / total : 0,
    collisionAliasesWithNonemptyGradeHistoryCount: history,
    collisionAliasesWithNonemptyGradeHistoryRatio: total ? history / total : 0,
    collisionAliasesWithAnyLearningCount: any,
    collisionAliasesWithAnyLearningRatio: total ? any / total : 0,
    details,
  };
}

function stableSerialize(value) {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function smallStableHash(serialized) {
  let hash = 2166136261;
  for (const char of serialized) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function migrationPlanCore(plan) {
  return {
    snapshotId: plan?.snapshotId,
    sourceSnapshotSignature: plan?.sourceSnapshotSignature,
    lineageProvenance: plan?.lineageProvenance,
    resolved: plan?.resolved,
    quarantined: plan?.quarantined,
    materializations: plan?.materializations,
    summary: plan?.summary,
  };
}

function migrationPlanSignature(plan) {
  return stableSerialize(migrationPlanCore(plan));
}

function requiredContextMethod(tx, name) {
  if (typeof tx?.[name] !== 'function') {
    throw codedError('PRACTICE_ADAPTER_INCOMPLETE', `runtime context transaction.${name} is required`);
  }
}

function runtimeCatalogCards(currentCatalog) {
  if (!Array.isArray(currentCatalog?.lessons)) {
    throw codedError('RUNTIME_BASELINE_INVALID', 'runtime baseline requires a complete catalog');
  }
  const cards = [];
  for (const lesson of currentCatalog.lessons) {
    const lessonId = typeof lesson?.id === 'string' ? lesson.id.trim() : '';
    if (!lessonId || !Array.isArray(lesson.cards)) {
      throw codedError('RUNTIME_BASELINE_INVALID', 'runtime catalog lesson is incomplete');
    }
    for (const card of lesson.cards) cards.push({ ...card, _lessonId: lessonId });
  }
  return cards;
}

function runtimeBaselineCore(plan) {
  return {
    kind: plan?.kind,
    schemaVersion: plan?.schemaVersion,
    catalogDigest: plan?.catalogDigest,
    lineageProvenance: plan?.lineageProvenance,
    seeds: plan?.seeds,
    quarantined: plan?.quarantined,
    summary: plan?.summary,
  };
}

function runtimeBaselineSignature(plan) {
  return stableSerialize(runtimeBaselineCore(plan));
}

/* planSignature 只擋得住「拿到 plan 之後又去動它」，擋不住「自己照 stableSerialize
   刻一份出來」——那兩個函式都在出貨的 bundle 裡。真正的閘門是這個 WeakSet：要進得來
   就一定得走 planRuntimeSrsBaseline，也就一定過了 lineage 檢查。 */
const RUNTIME_BASELINE_PLANS = new WeakSet();

/* baseline 是 add-only 的補寫，不是一次定生死：legacy progress 會被 cloud-sync
   在開機後改（多裝置合併、reset epoch 清除），所以「plan 跟上次不一樣」是正常狀態，
   帳要記在 alias 層級而不是整份 plan 層級。 */
const RUNTIME_CONTEXT_META_KEY = 'runtime-context';
const RUNTIME_CONTEXT_META_VERSION = 1;
const RUNTIME_BASELINE_META_KEY = 'runtime-srs-baseline-v1';
const RUNTIME_BASELINE_META_VERSION = 1;

/* Runtime cutover is deliberately stricter than current-catalog resolution.
   An alias must resolve uniquely in today's catalog and in trusted production
   lineage, and both sources must name the same stable card. */
export function planRuntimeSrsBaseline({
  progress,
  currentCatalog,
  catalogDigest,
  lineageEvidence = null,
  trustedRevisionManifest = null,
} = {}) {
  if (!plainRecord(progress)) {
    throw codedError('RUNTIME_BASELINE_INVALID', 'runtime progress must be an object');
  }
  const digest = requiredIdentity(catalogDigest);
  // digest 是冪等鍵。跟它描述的 catalog 對不起來的話，整份 baseline 會被記在錯的
  // 鍵底下，之後就靜默不再執行。
  if (typeof currentCatalog?.digest === 'string' && currentCatalog.digest !== digest) {
    throw codedError('RUNTIME_BASELINE_INVALID', 'catalogDigest does not match the given catalog');
  }
  const catalogIndex = indexLegacyAliases(runtimeCatalogCards(currentCatalog));
  const lineage = normalizeLineageEvidence(lineageEvidence, trustedRevisionManifest);
  const seeds = [];
  const quarantined = [];

  for (const legacyAlias of Object.keys(progress).sort()) {
    const state = structuredClone(progress[legacyAlias]);
    let reason = null;
    let cardId = null;
    if (!isSrsStateSnapshot(state)) {
      reason = 'invalid_srs_snapshot';
    } else {
      const current = resolveLegacyAlias(legacyAlias, catalogIndex);
      if (current.status !== 'resolved') {
        reason = current.reason === 'ambiguous_legacy_alias'
          ? 'current_catalog_collision'
          : current.reason;
      } else if (!lineage.complete) {
        reason = 'incomplete_lineage_evidence';
      } else {
        const historical = lineage.resolveAlias(legacyAlias);
        if (historical.status !== 'resolved') {
          reason = historical.reason;
        } else if (historical.cardId !== current.cardId
            || !lineage.canonicalCardIdProven(current.cardId)) {
          reason = 'current_lineage_mismatch';
        } else {
          cardId = current.cardId;
        }
      }
    }

    if (cardId) seeds.push({ cardId, legacyAlias, state });
    else quarantined.push({ legacyAlias, reason, state });
  }

  const core = {
    kind: 'runtime-srs-baseline-plan-v1',
    schemaVersion: 1,
    catalogDigest: digest,
    lineageProvenance: structuredClone(lineage.lineageProvenance || {
      evidenceId: null, digest: null, revisionManifest: null,
    }),
    seeds,
    quarantined,
    summary: {
      original: Object.keys(progress).length,
      seedable: seeds.length,
      quarantined: quarantined.length,
    },
  };
  const planSignature = runtimeBaselineSignature(core);
  const plan = Object.freeze({
    ...core,
    planId: `runtime-baseline-${smallStableHash(planSignature)}`,
    planSignature,
  });
  RUNTIME_BASELINE_PLANS.add(plan);
  return plan;
}

export async function commitRuntimeSrsBaseline({
  port,
  workspaceId,
  plan,
} = {}) {
  const workspace = requiredIdentity(workspaceId);
  if (!workspace.startsWith('anon:') && !workspace.startsWith('user:')) {
    throw codedError('WORKSPACE_ID_MISSING', 'runtime baseline requires a workspace');
  }
  if (!port || typeof port.transaction !== 'function') {
    throw codedError('STORAGE_UNAVAILABLE', 'runtime baseline transaction port is unavailable');
  }
  if (!RUNTIME_BASELINE_PLANS.has(plan)) {
    throw codedError('RUNTIME_BASELINE_INVALID', 'runtime baseline plan did not come from planRuntimeSrsBaseline');
  }
  if (plan.kind !== 'runtime-srs-baseline-plan-v1'
      || plan.schemaVersion !== 1
      || plan.planSignature !== runtimeBaselineSignature(plan)
      || !Array.isArray(plan.seeds)
      || !Array.isArray(plan.quarantined)
      || plan.summary?.seedable !== plan.seeds.length
      || plan.summary?.quarantined !== plan.quarantined.length
      || plan.summary?.original !== plan.seeds.length + plan.quarantined.length) {
    throw codedError('RUNTIME_BASELINE_INVALID', 'runtime baseline plan is invalid');
  }
  const snapshot = structuredClone(plan);

  return port.transaction(
    ['srsV2', 'quarantine', 'workspaceMeta'],
    'readwrite',
    async tx => {
      for (const method of [
        'getSrs', 'addSrsBaseline', 'addQuarantine',
        'getWorkspaceMeta', 'putWorkspaceMeta',
      ]) {
        if (typeof tx?.[method] !== 'function') {
          throw codedError('PRACTICE_ADAPTER_INCOMPLETE', `runtime baseline transaction.${method} is required`);
        }
      }
      const prior = await tx.getWorkspaceMeta(workspace, RUNTIME_BASELINE_META_KEY);
      // 未來版本寫過的帳就別碰：舊 code 不知道新語意，硬補只會補壞。
      if (prior && prior.schemaVersion !== RUNTIME_BASELINE_META_VERSION) {
        return { status: 'skipped', reason: 'unknown_meta_schema', summary: null };
      }
      // seeded 過的 alias 永遠不再看：使用者之後把 SRS 重置掉，legacy progress
      // 不能把它救回來。quarantine 過的只在同一份 catalog 下算數——catalog 換了
      // 有機會解掉當初的 collision，就再判一次。
      const seededAliases = new Set(
        Array.isArray(prior?.seededAliases) ? prior.seededAliases : [],
      );
      const sameCatalog = prior?.catalogDigest === snapshot.catalogDigest;
      const quarantinedAliases = new Set(
        sameCatalog && Array.isArray(prior?.quarantinedAliases) ? prior.quarantinedAliases : [],
      );

      let seeded = 0;
      let existing = 0;
      let quarantined = 0;
      let skipped = 0;

      for (const row of snapshot.seeds) {
        if (seededAliases.has(row.legacyAlias)) {
          skipped += 1;
          continue;
        }
        const current = await tx.getSrs(workspace, row.cardId);
        if (current) {
          existing += 1;
          seededAliases.add(row.legacyAlias);
          continue;
        }
        const added = await tx.addSrsBaseline(workspace, row.cardId, {
          workspaceId: workspace,
          cardId: row.cardId,
          version: 0,
          state: structuredClone(row.state),
          sourceEventId: null,
          baseline: {
            kind: 'runtime-progress-v1',
            catalogDigest: snapshot.catalogDigest,
            legacyAlias: row.legacyAlias,
            lineageProvenance: structuredClone(snapshot.lineageProvenance),
          },
        });
        if (added) seeded += 1;
        else existing += 1;
        seededAliases.add(row.legacyAlias);
      }

      for (const row of snapshot.quarantined) {
        if (quarantinedAliases.has(row.legacyAlias) || seededAliases.has(row.legacyAlias)) {
          skipped += 1;
          continue;
        }
        // alias 在一份 plan 裡本來就唯一，不需要雜湊；雜湊只會多一條撞號靜默漏寫
        // 的路，也跟既有 quarantineId 用原字串的作法不一致。
        const added = await tx.addQuarantine(workspace, {
          workspaceId: workspace,
          quarantineId: `runtime-baseline:${snapshot.catalogDigest}:${row.legacyAlias}`,
          snapshotId: snapshot.planId,
          reason: row.reason,
          legacyAlias: row.legacyAlias,
          value: structuredClone(row.state),
          source: 'runtime-srs-baseline-v1',
        });
        // 數真的寫進去的，不是數打算寫幾筆。
        if (added) quarantined += 1;
        quarantinedAliases.add(row.legacyAlias);
      }

      const summary = { seeded, existing, quarantined, skipped };
      const totals = {
        seeded: (prior?.totals?.seeded || 0) + seeded,
        existing: (prior?.totals?.existing || 0) + existing,
        quarantined: (prior?.totals?.quarantined || 0) + quarantined,
      };
      await tx.putWorkspaceMeta(workspace, RUNTIME_BASELINE_META_KEY, {
        workspaceId: workspace,
        key: RUNTIME_BASELINE_META_KEY,
        schemaVersion: RUNTIME_BASELINE_META_VERSION,
        catalogDigest: snapshot.catalogDigest,
        lastPlanId: snapshot.planId,
        lineageProvenance: structuredClone(snapshot.lineageProvenance),
        seededAliases: [...seededAliases].sort(),
        quarantinedAliases: [...quarantinedAliases].sort(),
        totals,
      });
      return {
        status: seeded || quarantined ? 'applied' : 'no-op',
        summary,
        totals,
      };
    },
  );
}

/* R12：ledger 評分的開關綁在 catalog digest 上。digest 一變（發了新課、改了卡），
   之前那份 baseline 的認領結論就不一定還成立——當初撞名被 quarantine 的 alias 現在
   可能解得開，反過來也可能多出新的撞名。所以先重跑一次 baseline audit，過了才把
   context 換成新的 digest。

   audit 失敗不丟出去：呼叫端是開機路徑，丟出去就是把使用者鎖在門外（U2 那個
   RUNTIME_BASELINE_CHANGED 就是這樣炸的）。回 blocked 讓 App 照舊走 legacy，
   ledger 評分維持關著。audit 完成、context 還沒寫就當掉的話下次開機會重跑一次
   ——baseline 是 add-only 而且冪等，重跑安全。 */
export async function ensureRuntimeLedgerContext({
  port,
  workspaceId,
  catalogDigest,
  auditBaseline,
} = {}) {
  const workspace = requiredIdentity(workspaceId);
  const digest = requiredIdentity(catalogDigest);
  if (!port || typeof port.transaction !== 'function') {
    throw codedError('STORAGE_UNAVAILABLE', 'runtime context transaction port is unavailable');
  }
  if (typeof auditBaseline !== 'function') {
    throw codedError('PRACTICE_ADAPTER_INCOMPLETE', 'auditBaseline is required');
  }

  const prior = await port.transaction(['workspaceMeta'], 'readonly', async tx => {
    requiredContextMethod(tx, 'getWorkspaceMeta');
    return tx.getWorkspaceMeta(workspace, RUNTIME_CONTEXT_META_KEY);
  });
  if (prior
      && prior.schemaVersion === RUNTIME_CONTEXT_META_VERSION
      && prior.catalogDigest === digest) {
    return Object.freeze({
      status: 'ready', catalogDigest: digest, audited: false, reason: null,
    });
  }

  let audit = null;
  try {
    audit = await auditBaseline({ workspaceId: workspace, catalogDigest: digest });
  } catch (error) {
    return Object.freeze({
      status: 'blocked',
      catalogDigest: digest,
      audited: false,
      reason: error?.code || 'RUNTIME_BASELINE_AUDIT_FAILED',
    });
  }

  await port.transaction(['workspaceMeta'], 'readwrite', async tx => {
    requiredContextMethod(tx, 'getWorkspaceMeta');
    requiredContextMethod(tx, 'putWorkspaceMeta');
    await tx.putWorkspaceMeta(workspace, RUNTIME_CONTEXT_META_KEY, {
      workspaceId: workspace,
      key: RUNTIME_CONTEXT_META_KEY,
      schemaVersion: RUNTIME_CONTEXT_META_VERSION,
      catalogDigest: digest,
      baselineSummary: audit && typeof audit === 'object'
        ? structuredClone(audit.summary || null)
        : null,
    });
  });
  return Object.freeze({
    status: 'ready', catalogDigest: digest, audited: true, reason: null,
  });
}

/* R11：遠端重置 epoch 生效後清掉 IDB 這邊的權威 SRS。

   順序是「先清 IDB，再清本機鏡射」，不能反過來：先清本機的話，清完到清 IDB 之間
   當掉，下次開機 reconcileLedgerMirror() 會從 IDB 把資料原樣鏡射回來，等於重置沒
   發生過。

   刻意保留三樣東西：
   - append-only 的 practice events 與已提交的 projections（R11 明列）。重置清的是
     排程進度，不是「做過什麼」的紀錄；現行 legacy 重置也只清 state.progress，沒有
     動每日日誌或評分歷史。
   - baseline 的 seededAliases 紀錄。那份紀錄正是「重置掉的進度不准被 legacy
     progress 救回來」的依據（見 commitRuntimeSrsBaseline）；把它清掉的話，下次開機
     baseline 會從還沒被同步清乾淨的 legacy progress 重新 seed 一次，重置就白做了。
     只清 runtime-context，強迫下次開機重新 audit。 */
export async function resetRuntimeLedgerAuthority({
  port,
  workspaceId,
} = {}) {
  const workspace = requiredIdentity(workspaceId);
  if (!port || typeof port.transaction !== 'function') {
    throw codedError('STORAGE_UNAVAILABLE', 'runtime reset transaction port is unavailable');
  }
  return port.transaction(['srsV2', 'workspaceMeta'], 'readwrite', async tx => {
    for (const method of ['getAllSrs', 'deleteSrs', 'deleteWorkspaceMeta']) {
      requiredContextMethod(tx, method);
    }
    const rows = await tx.getAllSrs(workspace);
    let cleared = 0;
    for (const row of rows) {
      if (typeof row?.cardId !== 'string' || !row.cardId) continue;
      await tx.deleteSrs(workspace, row.cardId);
      cleared += 1;
    }
    await tx.deleteWorkspaceMeta(workspace, RUNTIME_CONTEXT_META_KEY);
    return { clearedSrs: cleared };
  });
}

export function planLegacyMigration({
  legacySnapshot,
  lineageEvidence = null,
  trustedRevisionManifest = null,
} = {}) {
  const snapshotId = requiredIdentity(legacySnapshot?.snapshotId);
  const facts = Array.isArray(legacySnapshot?.facts)
    ? structuredClone(legacySnapshot.facts)
    : [];
  const sourceSnapshotSignature = snapshotSignature({ snapshotId, facts });
  const normalizedEvidence = normalizeLineageEvidence(lineageEvidence, trustedRevisionManifest);
  const lineageProvenance = normalizedEvidence.lineageProvenance || {
    evidenceId: null,
    digest: null,
    revisionManifest: null,
  };
  const snapshots = normalizedEvidence.snapshots;
  const resolved = [];
  const quarantined = [];

  for (const sourceFact of facts) {
    const legacyAlias = typeof sourceFact?.legacyAlias === 'string'
      ? sourceFact.legacyAlias.trim()
      : '';
    let lineage;
    if (sourceFact?.identityKind === 'workspace') {
      lineage = WORKSPACE_FACT_STORES.has(sourceFact.sourceStore)
        ? { status: 'resolved', migrationKind: 'workspace_fact' }
        : { status: 'quarantine', reason: 'workspace_identity_not_allowed' };
    } else if (sourceFact?.identityKind === 'canonical') {
      if (!stableCardId(sourceFact.cardId)) {
        lineage = { status: 'quarantine', reason: 'invalid_lineage_identity' };
      } else if (!normalizedEvidence.complete
          || !normalizedEvidence.canonicalCardIdProven(sourceFact.cardId)) {
        lineage = { status: 'quarantine', reason: 'canonical_identity_unproven' };
      } else {
        lineage = {
          status: 'resolved',
          cardId: sourceFact.cardId.toLowerCase(),
          migrationKind: 'canonical_fact',
        };
      }
    } else {
      lineage = !normalizedEvidence.complete
        ? { status: 'quarantine', reason: 'incomplete_lineage_evidence' }
        : legacyAlias
        ? normalizedEvidence.resolveAlias(legacyAlias)
        : { status: 'quarantine', reason: 'missing_historical_evidence' };
    }
    const row = { ...sourceFact, legacyAlias };
    if (lineage.status === 'resolved') {
      resolved.push({
        ...row,
        ...(lineage.cardId ? { cardId: lineage.cardId } : {}),
        migrationKind: lineage.migrationKind || 'historical_lineage',
      });
    }
    else quarantined.push({ ...row, reason: lineage.reason });
  }

  const materializations = buildLegacyMaterializations(resolved);
  const materializedSrs = materializations.srs.length;
  const materializedProjectionFacts = materializations.projections
    .reduce((count, projection) => count + projection.facts.length, 0);
  const materialized = materializedSrs + materializedProjectionFacts;
  const auditOnly = resolved.length - materialized;
  if (auditOnly < 0) {
    throw codedError('MIGRATION_MATERIALIZATION_INVALID', 'materialized fact count exceeds resolved facts');
  }

  const summary = {
    original: facts.length,
    resolved: resolved.length,
    quarantined: quarantined.length,
    materialized,
    materializedSrs,
    materializedProjectionFacts,
    auditOnly,
  };
  const conservation = {
    valid: summary.resolved + summary.quarantined === summary.original,
    equation: `${summary.resolved} + ${summary.quarantined} = ${summary.original}`,
  };
  const planCore = {
    snapshotId,
    sourceSnapshotSignature,
    lineageProvenance,
    resolved,
    quarantined,
    materializations,
    summary,
  };
  const planSignature = migrationPlanSignature(planCore);
  return {
    planId: `legacy-migration-${smallStableHash(planSignature)}`,
    planSignature,
    ...planCore,
    conservation,
    audit: migrationAudit(
      facts,
      normalizedEvidence.complete ? normalizedEvidence.collisionAliases : new Set(),
    ),
  };
}

function migrationRecordKey(workspaceId, snapshotId, group, row, index) {
  const identity = group === 'resolved'
    ? row.cardId || row.sourceKey || 'workspace-fact'
    : row.legacyAlias || 'no-alias';
  return [
    'workspace', encodeURIComponent(workspaceId),
    'snapshot', encodeURIComponent(snapshotId), group,
    encodeURIComponent(row.sourceStore || 'unknown'),
    encodeURIComponent(identity),
    encodeURIComponent(row.sourceKey || 'no-source-key'),
    String(index),
  ].join(':');
}

function assertClaimAuthorization(authorization, workspace, plan) {
  if (!authorization) {
    throw codedError('CLAIM_AUTHORIZATION_REQUIRED', 'confirmed legacy claim authorization is required');
  }
  if (!issuedClaimAuthorizations.has(authorization)
      || authorization.kind !== 'legacy-claim-authorization-v1'
      || authorization.confirmed !== true) {
    throw codedError('CLAIM_AUTHORIZATION_INVALID', 'legacy claim authorization was not issued here');
  }
  if (authorization.workspaceId !== workspace) {
    throw codedError('CLAIM_WORKSPACE_MISMATCH', 'legacy claim authorization targets another workspace');
  }
  if (authorization.snapshotId !== plan?.snapshotId) {
    throw codedError('CLAIM_SNAPSHOT_MISMATCH', 'legacy claim authorization targets another snapshot');
  }
  if (authorization.sourceSnapshotSignature !== plan?.sourceSnapshotSignature) {
    throw codedError('CLAIM_SNAPSHOT_MISMATCH', 'legacy claim authorization targets other facts');
  }
  if (plan?.planSignature !== migrationPlanSignature(plan)
      || authorization.planId !== plan?.planId
      || authorization.planSignature !== plan?.planSignature) {
    throw codedError('CLAIM_PLAN_MISMATCH', 'legacy claim authorization targets another migration plan');
  }
}

/* Transactional-port contract. Every tx method may be async so the production
   adapter can use real IndexedDB requests. Network/UI work stays outside the
   transaction; the port resolves only after the native transaction completes. */
export async function commitLegacyMigration({
  transactionalPort,
  eligibilityGuard,
  workspaceId,
  plan,
  authorization,
} = {}) {
  const workspace = requiredIdentity(workspaceId);
  assertClaimAuthorization(authorization, workspace, plan);
  if (!transactionalPort || typeof transactionalPort.transaction !== 'function') {
    throw codedError('STORAGE_UNAVAILABLE', 'transactional migration store is unavailable');
  }
  if (!plan?.conservation?.valid
      || plan.summary?.resolved + plan.summary?.quarantined !== plan.summary?.original) {
    throw codedError('MIGRATION_CONSERVATION_FAILED', 'legacy migration is not conservative');
  }
  const verifiedPlan = Object.freeze(structuredClone(plan));
  if (!eligibilityGuard || typeof eligibilityGuard.verifyRemotePull !== 'function') {
    throw codedError(
      'CLAIM_ELIGIBILITY_REVALIDATION_REQUIRED',
      'remote claim eligibility revalidation is required',
    );
  }
  const remoteStillEmpty = await eligibilityGuard.verifyRemotePull({
    workspaceId: workspace,
    receiptId: authorization.remotePullReceiptId,
  });
  if (remoteStillEmpty !== true) {
    throw codedError('CLAIM_ELIGIBILITY_STALE', 'remote claim eligibility is stale');
  }
  const journalKey = `workspace:${encodeURIComponent(workspace)}:claim-journal:${encodeURIComponent(verifiedPlan.snapshotId)}`;

  return transactionalPort.transaction(async tx => {
    const existing = await tx.get(journalKey);
    if (existing?.status === 'completed') {
      if (existing.planId !== verifiedPlan.planId
          || existing.planSignature !== verifiedPlan.planSignature) {
        throw codedError('MIGRATION_PLAN_CHANGED', 'completed snapshot has a different migration plan');
      }
      return { status: 'already-applied', summary: structuredClone(existing.summary) };
    }
    if (typeof tx.getClaimEligibility !== 'function') {
      throw codedError(
        'CLAIM_ELIGIBILITY_REVALIDATION_REQUIRED',
        'transactional local eligibility evidence is required',
      );
    }
    const localEligibility = await tx.getClaimEligibility(workspace);
    if (localEligibility?.workspaceId !== workspace
        || localEligibility?.revision !== authorization.localRevision
        || !allCountsZero(localEligibility?.counts)) {
      throw codedError('CLAIM_ELIGIBILITY_STALE', 'local claim eligibility is stale');
    }

    const materializations = verifiedPlan.materializations;
    if (!materializations || materializations.schemaVersion !== 1
        || !Array.isArray(materializations.srs)
        || !Array.isArray(materializations.projections)) {
      throw codedError('MIGRATION_PLAN_INVALID', 'legacy materialization plan is invalid');
    }
    for (const method of ['getSrs', 'putSrs', 'getProjection', 'putProjection']) {
      if (typeof tx[method] !== 'function') {
        throw codedError('PRACTICE_ADAPTER_INCOMPLETE', `migration transaction.${method} is required`);
      }
    }

    const srsRows = [];
    for (const row of materializations.srs) {
      if (await tx.getSrs(row.cardId)) {
        throw codedError(
          'MIGRATION_AUTHORITATIVE_CONFLICT',
          'legacy migration cannot overwrite authoritative SRS',
        );
      }
      srsRows.push({
        workspaceId: workspace,
        cardId: row.cardId,
        version: 0,
        state: structuredClone(row.state),
        sourceEventId: null,
        migration: {
          kind: 'legacy-progress-v1',
          snapshotId: verifiedPlan.snapshotId,
          sourceStore: row.sourceStore,
          sourceKey: row.sourceKey,
        },
      });
    }
    const projectionRows = [];
    for (const row of materializations.projections) {
      if (await tx.getProjection(row.name)) {
        throw codedError(
          'MIGRATION_AUTHORITATIVE_CONFLICT',
          'legacy migration cannot overwrite an authoritative projection',
        );
      }
      projectionRows.push({
        workspaceId: workspace,
        name: row.name,
        schemaVersion: 1,
        projectorVersion: 'legacy-workspace-facts-v1',
        sourceSnapshotId: verifiedPlan.snapshotId,
        facts: structuredClone(row.facts),
      });
    }

    const recordWrites = verifiedPlan.resolved.map((row, index) => (
      tx.set(migrationRecordKey(workspace, verifiedPlan.snapshotId, 'resolved', row, index), {
        sourceSnapshotId: verifiedPlan.snapshotId,
        sourceStore: row.sourceStore,
        sourceKey: row.sourceKey,
        legacyAlias: row.legacyAlias,
        cardId: row.cardId,
        lineageProvenance: structuredClone(verifiedPlan.lineageProvenance),
        value: structuredClone(row.value),
      })
    ));
    recordWrites.push(...verifiedPlan.quarantined.map((row, index) => (
      tx.set(migrationRecordKey(workspace, verifiedPlan.snapshotId, 'legacy_unresolved', row, index), {
        sourceSnapshotId: verifiedPlan.snapshotId,
        sourceStore: row.sourceStore,
        sourceKey: row.sourceKey,
        legacyAlias: row.legacyAlias,
        reason: row.reason,
        value: structuredClone(row.value),
      })
    )));
    recordWrites.push(
      ...srsRows.map(row => tx.putSrs(row)),
      ...projectionRows.map(row => tx.putProjection(row)),
    );
    await Promise.all(recordWrites);
    const summary = {
      ...structuredClone(verifiedPlan.summary),
      conservationValid: true,
      audit: structuredClone(verifiedPlan.audit),
    };
    await tx.set(journalKey, {
      status: 'completed',
      planId: verifiedPlan.planId,
      planSignature: verifiedPlan.planSignature,
      sourceSnapshotId: verifiedPlan.snapshotId,
      lineageProvenance: structuredClone(verifiedPlan.lineageProvenance),
      workspaceId: workspace,
      summary,
    });
    return { status: 'applied', summary };
  });
}
