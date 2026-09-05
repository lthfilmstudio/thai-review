/* IndexedDB owner for the durable practice ledger.
   Every key begins with workspaceId. Runtime ports are capability-bound to one
   workspace and may be invalidated by boot/logout/versionchange. */

export const PRACTICE_DB_NAME = 'thai-review-practice-v2';
export const PRACTICE_DB_VERSION = 2;

export const PRACTICE_DB_STORES = Object.freeze({
  workspaceMeta: 'workspace_meta',
  srsV2: 'srs_v2',
  practiceEvents: 'practice_events',
  eventDispositions: 'event_dispositions',
  dailyLaneClaims: 'daily_lane_claims',
  /* 借用 v2 就存在的 formal_due_claims 實體 store。keyPath 的三個欄位跟
     daily-card claim 一模一樣（只是順序不同），而那個 store 從頭到尾只被 add、
     沒有任何 reader，線上也是空的——線上跑的 0726965 裡沒有任何檔案 import
     practice-commit.js，所以 commitPracticeAttempt 一次都沒被呼叫過。
     借用它才不用動 PRACTICE_DB_VERSION——一旦動了，回滾時舊版 open(name, 2) 會拿到
     VersionError，整個 App 直接開不起來。 */
  dailyCardClaims: 'formal_due_claims',
  attemptPhaseClaims: 'attempt_phase_claims',
  outbox: 'outbox',
  syncCursors: 'sync_cursors',
  projections: 'projections',
  legacyImports: 'legacy_imports',
  quarantine: 'quarantine',
  claimJournals: 'claim_journals',
});

const STORE_DEFINITIONS = Object.freeze({
  workspaceMeta: {
    keyPath: ['workspaceId', 'key'],
    indexes: [['by_workspace', 'workspaceId']],
  },
  srsV2: {
    keyPath: ['workspaceId', 'cardId'],
    indexes: [
      ['by_workspace', 'workspaceId'],
      ['by_due', ['workspaceId', 'nextReviewAt', 'cardId']],
    ],
  },
  practiceEvents: {
    keyPath: ['workspaceId', 'eventId'],
    indexes: [
      ['by_workspace', 'workspaceId'],
      ['by_day', ['workspaceId', 'dayKey', 'eventId']],
      ['by_round', ['workspaceId', 'roundId', 'eventId']],
      ['by_cycle', ['workspaceId', 'cycleId', 'eventId']],
      ['by_card', ['workspaceId', 'cardId', 'eventId']],
      ['by_server_seq', ['workspaceId', 'serverSeq']],
      ['by_attempt_kind', ['workspaceId', 'attemptId', 'eventKind'], { unique: false }],
    ],
  },
  eventDispositions: {
    keyPath: ['workspaceId', 'eventId'],
    indexes: [['by_workspace', 'workspaceId']],
  },
  dailyLaneClaims: {
    keyPath: ['workspaceId', 'cardId', 'dayKey', 'lane'],
    indexes: [['by_workspace', 'workspaceId']],
  },
  dailyCardClaims: {
    // 實體 store 是 formal_due_claims，keyPath 沿用它 v2 就定好的欄位順序
    keyPath: ['workspaceId', 'cardId', 'dayKey'],
    indexes: [['by_workspace', 'workspaceId']],
  },
  attemptPhaseClaims: {
    keyPath: ['workspaceId', 'attemptId', 'phase'],
    indexes: [['by_workspace', 'workspaceId']],
  },
  outbox: {
    keyPath: ['workspaceId', 'eventId'],
    indexes: [
      ['by_workspace', 'workspaceId'],
      ['by_status', ['workspaceId', 'status', 'nextAttemptAt', 'eventId']],
    ],
  },
  syncCursors: {
    keyPath: ['workspaceId', 'name'],
    indexes: [['by_workspace', 'workspaceId']],
  },
  projections: {
    keyPath: ['workspaceId', 'name'],
    indexes: [['by_workspace', 'workspaceId']],
  },
  legacyImports: {
    keyPath: ['workspaceId', 'snapshotId', 'recordId'],
    indexes: [
      ['by_workspace', 'workspaceId'],
      ['by_snapshot', ['workspaceId', 'snapshotId', 'recordId']],
      ['by_card', ['workspaceId', 'cardId', 'recordId']],
    ],
  },
  quarantine: {
    keyPath: ['workspaceId', 'quarantineId'],
    indexes: [
      ['by_workspace', 'workspaceId'],
      ['by_snapshot', ['workspaceId', 'snapshotId', 'quarantineId']],
      ['by_reason', ['workspaceId', 'reason', 'quarantineId']],
    ],
  },
  claimJournals: {
    keyPath: ['workspaceId', 'snapshotId'],
    indexes: [['by_workspace', 'workspaceId']],
  },
});

function codedError(code, message, cause = null) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function requiredWorkspace(value) {
  const workspaceId = typeof value === 'string' ? value.trim() : '';
  if (!workspaceId || (!workspaceId.startsWith('anon:') && !workspaceId.startsWith('user:'))) {
    throw codedError('WORKSPACE_ID_INVALID', 'practice database requires a workspace');
  }
  return workspaceId;
}

export function upgradePracticeSchema(database, upgradeTransaction = null) {
  for (const [logicalName, definition] of Object.entries(STORE_DEFINITIONS)) {
    const physicalName = PRACTICE_DB_STORES[logicalName];
    const exists = database.objectStoreNames.contains(physicalName);
    if (exists && typeof upgradeTransaction?.objectStore !== 'function') continue;
    const store = exists
      ? upgradeTransaction.objectStore(physicalName)
      : database.createObjectStore(physicalName, { keyPath: definition.keyPath });
    for (const [name, keyPath, options] of definition.indexes) {
      if (store.indexNames?.contains?.(name)) continue;
      store.createIndex(name, keyPath, options);
    }
  }
}

function requestPromise(request, { constraintAsFalse = false } = {}) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = event => {
      if (constraintAsFalse && request.error?.name === 'ConstraintError') {
        event?.preventDefault?.();
        event?.stopPropagation?.();
        resolve(false);
        return;
      }
      reject(codedError('PRACTICE_DB_REQUEST_FAILED', request.error?.message || 'IndexedDB request failed', request.error));
    };
  });
}

function transactionPromise(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(codedError(
      'PRACTICE_DB_TRANSACTION_ABORTED',
      transaction.error?.message || 'IndexedDB transaction aborted',
      transaction.error,
    ));
    transaction.onerror = () => { /* onabort owns the final rejection */ };
  });
}

export function openPracticeDatabase({
  indexedDBFactory = globalThis.indexedDB,
  name = PRACTICE_DB_NAME,
  onVersionChange = () => {},
} = {}) {
  if (!indexedDBFactory || typeof indexedDBFactory.open !== 'function') {
    return Promise.reject(codedError('STORAGE_UNAVAILABLE', 'IndexedDB is unavailable'));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let request;
    try {
      request = indexedDBFactory.open(name, PRACTICE_DB_VERSION);
    } catch (cause) {
      reject(codedError('STORAGE_UNAVAILABLE', 'IndexedDB could not be opened', cause));
      return;
    }
    request.onupgradeneeded = () => {
      try {
        upgradePracticeSchema(request.result, request.transaction);
      } catch (cause) {
        try { request.transaction?.abort(); } catch { /* best effort */ }
        if (!settled) {
          settled = true;
          reject(codedError('PRACTICE_DB_UPGRADE_FAILED', 'practice database upgrade failed', cause));
        }
      }
    };
    request.onblocked = () => {
      if (settled) return;
      settled = true;
      reject(codedError('PRACTICE_DB_BLOCKED', 'practice database upgrade is blocked'));
    };
    request.onerror = () => {
      if (settled) return;
      settled = true;
      reject(codedError('STORAGE_UNAVAILABLE', request.error?.message || 'IndexedDB open failed', request.error));
    };
    request.onsuccess = () => {
      const database = request.result;
      if (settled) {
        database.close();
        return;
      }
      settled = true;
      let invalidated = false;
      database.onversionchange = () => {
        invalidated = true;
        database.close();
        onVersionChange();
      };
      resolve({
        database,
        close() { invalidated = true; database.close(); },
        assertOpen() {
          if (invalidated) throw codedError('PRACTICE_DB_INVALIDATED', 'practice database connection is stale');
        },
      });
    };
  });
}

function physicalStoreNames(logicalNames) {
  if (!Array.isArray(logicalNames) || !logicalNames.length) {
    throw codedError('PRACTICE_TRANSACTION_INVALID', 'transaction stores are required');
  }
  return logicalNames.map(name => {
    const physical = PRACTICE_DB_STORES[name];
    if (!physical) throw codedError('PRACTICE_TRANSACTION_INVALID', `unknown practice store: ${name}`);
    return physical;
  });
}

function assertEnvelope(workspaceId, row) {
  if (!row || typeof row !== 'object' || Array.isArray(row) || row.workspaceId !== workspaceId) {
    throw codedError('WORKSPACE_ID_MISMATCH', 'practice row belongs to another workspace');
  }
}

function assertWorkspaceArgument(expected, actual) {
  if (actual !== expected) {
    throw codedError('WORKSPACE_ID_MISMATCH', 'practice operation targets another workspace');
  }
}

function requiredRowKey(value, label) {
  const key = typeof value === 'string' ? value.trim() : '';
  if (!key) throw codedError('PRACTICE_ROW_INVALID', `${label} is required`);
  return key;
}

export function createPracticeTransactionPort(connection, {
  workspaceId,
  assertActive,
} = {}) {
  if (!connection?.database || typeof connection.assertOpen !== 'function') {
    throw codedError('STORAGE_UNAVAILABLE', 'practice database connection is unavailable');
  }
  const workspace = requiredWorkspace(workspaceId);
  if (typeof assertActive !== 'function') {
    throw codedError('PRACTICE_ADAPTER_INCOMPLETE', 'assertActive must be a function');
  }

  const active = () => {
    connection.assertOpen();
    assertActive(workspace);
  };

  return Object.freeze({
    workspaceId: workspace,
    async transaction(logicalNames, mode, work) {
      active();
      if (mode !== 'readonly' && mode !== 'readwrite') {
        throw codedError('PRACTICE_TRANSACTION_INVALID', 'transaction mode is invalid');
      }
      if (typeof work !== 'function') {
        throw codedError('PRACTICE_TRANSACTION_INVALID', 'transaction work is required');
      }
      const physicalNames = physicalStoreNames(logicalNames);
      let transaction;
      try {
        transaction = connection.database.transaction(physicalNames, mode, { durability: 'strict' });
      } catch {
        transaction = connection.database.transaction(physicalNames, mode);
      }
      const done = transactionPromise(transaction);
      const store = logical => transaction.objectStore(PRACTICE_DB_STORES[logical]);
      const key = id => [workspace, id];
      const tx = {
        async getEvent(_workspaceId, eventId) {
          active();
          assertWorkspaceArgument(workspace, _workspaceId);
          const row = await requestPromise(store('practiceEvents').get(key(eventId)));
          return row?.event ? structuredClone(row.event) : null;
        },
        async putEvent(_workspaceId, event) {
          active();
          assertWorkspaceArgument(workspace, _workspaceId);
          const row = {
            workspaceId: workspace,
            eventId: event.eventId,
            dayKey: event.dayKey,
            roundId: event.roundId,
            cycleId: event.cycleId,
            cardId: event.cardId,
            attemptId: event.attemptId,
            eventKind: event.eventKind,
            event: structuredClone(event),
          };
          await requestPromise(store('practiceEvents').add(row));
        },
        async getSrs(_workspaceId, cardId) {
          active();
          assertWorkspaceArgument(workspace, _workspaceId);
          const row = await requestPromise(store('srsV2').get(key(cardId)));
          return row ? structuredClone(row) : null;
        },
        async putSrs(_workspaceId, cardId, row) {
          active();
          assertWorkspaceArgument(workspace, _workspaceId);
          assertEnvelope(workspace, row);
          if (row.cardId !== cardId) throw codedError('PRACTICE_ROW_INVALID', 'SRS card identity mismatch');
          await requestPromise(store('srsV2').put({
            ...structuredClone(row),
            nextReviewAt: row.state?.nextReviewAt ?? 0,
          }));
        },
        async addDailyLaneClaim(_workspaceId, row) {
          active();
          assertWorkspaceArgument(workspace, _workspaceId);
          assertEnvelope(workspace, row);
          const result = await requestPromise(store('dailyLaneClaims').add(structuredClone(row)), {
            constraintAsFalse: true,
          });
          return result === false ? false : true;
        },
        async getDailyCardClaim(_workspaceId, dayKey, cardId) {
          active();
          assertWorkspaceArgument(workspace, _workspaceId);
          // keyPath 是 [workspaceId, cardId, dayKey]，順序跟參數不同，別對調
          const row = await requestPromise(store('dailyCardClaims').get([
            workspace,
            requiredRowKey(cardId, 'daily-card claim card'),
            requiredRowKey(dayKey, 'daily-card claim day'),
          ]));
          return row ? structuredClone(row) : null;
        },
        async addDailyCardClaim(_workspaceId, row) {
          active();
          assertWorkspaceArgument(workspace, _workspaceId);
          assertEnvelope(workspace, row);
          requiredRowKey(row.dayKey, 'daily-card claim day');
          requiredRowKey(row.cardId, 'daily-card claim card');
          const result = await requestPromise(store('dailyCardClaims').add(structuredClone(row)), {
            constraintAsFalse: true,
          });
          return result === false ? false : true;
        },
        async getAttemptPhaseClaim(_workspaceId, attemptId, phase) {
          active();
          assertWorkspaceArgument(workspace, _workspaceId);
          const row = await requestPromise(
            store('attemptPhaseClaims').get([workspace, attemptId, phase]),
          );
          return row ? structuredClone(row) : null;
        },
        async addAttemptPhaseClaim(_workspaceId, row) {
          active();
          assertWorkspaceArgument(workspace, _workspaceId);
          assertEnvelope(workspace, row);
          const result = await requestPromise(store('attemptPhaseClaims').add(structuredClone(row)), {
            constraintAsFalse: true,
          });
          return result === false ? false : true;
        },
        async putOutbox(_workspaceId, eventId, row) {
          active();
          assertWorkspaceArgument(workspace, _workspaceId);
          assertEnvelope(workspace, row);
          if (row.eventId !== eventId) throw codedError('PRACTICE_ROW_INVALID', 'outbox event identity mismatch');
          await requestPromise(store('outbox').add({
            nextAttemptAt: 0,
            ...structuredClone(row),
          }));
        },
        async getProjection(_workspaceId, name) {
          active();
          assertWorkspaceArgument(workspace, _workspaceId);
          const row = await requestPromise(store('projections').get([
            workspace, requiredRowKey(name, 'projection name'),
          ]));
          return row ? structuredClone(row) : null;
        },
        async putProjection(_workspaceId, name, row) {
          active();
          assertWorkspaceArgument(workspace, _workspaceId);
          assertEnvelope(workspace, row);
          const projectionName = requiredRowKey(name, 'projection name');
          if (row.name !== projectionName) {
            throw codedError('PRACTICE_ROW_INVALID', 'projection identity mismatch');
          }
          await requestPromise(store('projections').put(structuredClone(row)));
        },
        async getWorkspaceMeta(_workspaceId, metaKey) {
          active();
          assertWorkspaceArgument(workspace, _workspaceId);
          const row = await requestPromise(store('workspaceMeta').get([
            workspace, requiredRowKey(metaKey, 'workspace meta key'),
          ]));
          return row ? structuredClone(row) : null;
        },
        async putWorkspaceMeta(_workspaceId, metaKey, row) {
          active();
          assertWorkspaceArgument(workspace, _workspaceId);
          assertEnvelope(workspace, row);
          const keyName = requiredRowKey(metaKey, 'workspace meta key');
          if (row.key !== keyName) {
            throw codedError('PRACTICE_ROW_INVALID', 'workspace meta identity mismatch');
          }
          await requestPromise(store('workspaceMeta').put(structuredClone(row)));
        },
        async addSrsBaseline(_workspaceId, cardId, row) {
          active();
          assertWorkspaceArgument(workspace, _workspaceId);
          assertEnvelope(workspace, row);
          const stableCardId = requiredRowKey(cardId, 'SRS card');
          if (row.cardId !== stableCardId || row.version !== 0) {
            throw codedError('PRACTICE_ROW_INVALID', 'baseline SRS identity or version is invalid');
          }
          const result = await requestPromise(store('srsV2').add({
            ...structuredClone(row),
            nextReviewAt: row.state?.nextReviewAt ?? 0,
          }), { constraintAsFalse: true });
          return result === false ? false : true;
        },
        async getAllSrs(_workspaceId) {
          active();
          assertWorkspaceArgument(workspace, _workspaceId);
          const rows = await requestPromise(store('srsV2').index('by_workspace').getAll(workspace));
          for (const row of rows) assertEnvelope(workspace, row);
          return structuredClone(rows);
        },
        async deleteSrs(_workspaceId, cardId) {
          active();
          assertWorkspaceArgument(workspace, _workspaceId);
          await requestPromise(store('srsV2').delete([
            workspace, requiredRowKey(cardId, 'SRS card'),
          ]));
        },
        async deleteWorkspaceMeta(_workspaceId, metaKey) {
          active();
          assertWorkspaceArgument(workspace, _workspaceId);
          await requestPromise(store('workspaceMeta').delete([
            workspace, requiredRowKey(metaKey, 'workspace meta key'),
          ]));
        },
        async addQuarantine(_workspaceId, row) {
          active();
          assertWorkspaceArgument(workspace, _workspaceId);
          assertEnvelope(workspace, row);
          requiredRowKey(row.quarantineId, 'quarantine ID');
          const result = await requestPromise(store('quarantine').add(structuredClone(row)), {
            constraintAsFalse: true,
          });
          return result === false ? false : true;
        },
      };

      try {
        const result = await work(tx);
        active();
        await done;
        active();
        return result;
      } catch (error) {
        try { transaction.abort(); } catch { /* already complete or aborted */ }
        try { await done; } catch { /* preserve the domain error */ }
        throw error;
      }
    },
  });
}

const CLAIM_COUNT_KEYS = Object.freeze([
  'state', 'daily', 'history', 'achievements', 'events',
  'outbox', 'cycle', 'cursors', 'remoteDays', 'resweep',
]);

function migrationKeyParts(key, workspaceId) {
  const journalPrefix = `workspace:${encodeURIComponent(workspaceId)}:claim-journal:`;
  if (key.startsWith(journalPrefix)) {
    return {
      group: 'claim-journal',
      snapshotId: decodeURIComponent(key.slice(journalPrefix.length)),
      recordId: key,
    };
  }
  const recordPrefix = `workspace:${encodeURIComponent(workspaceId)}:snapshot:`;
  if (!key.startsWith(recordPrefix)) {
    throw codedError('PRACTICE_ROW_INVALID', 'migration key targets another workspace');
  }
  const [encodedSnapshotId, group] = key.slice(recordPrefix.length).split(':', 2);
  if (!encodedSnapshotId || !['resolved', 'legacy_unresolved'].includes(group)) {
    throw codedError('PRACTICE_ROW_INVALID', 'migration key is malformed');
  }
  return {
    group,
    snapshotId: decodeURIComponent(encodedSnapshotId),
    recordId: key,
  };
}

function requiredClaimEligibility(candidate, workspaceId) {
  if (candidate?.workspaceId !== workspaceId
      || typeof candidate?.revision !== 'string'
      || !candidate.revision.trim()) {
    throw codedError('PRACTICE_ADAPTER_INCOMPLETE', 'local eligibility inspector returned invalid evidence');
  }
  const counts = {};
  for (const name of CLAIM_COUNT_KEYS) {
    const value = candidate.counts?.[name];
    if (!Number.isInteger(value) || value < 0) {
      throw codedError('PRACTICE_ADAPTER_INCOMPLETE', 'local eligibility inspector returned invalid counts');
    }
    counts[name] = value;
  }
  return { counts, revision: candidate.revision };
}

function compositeClaimEligibility(workspaceId, idbCounts, localEligibility) {
  const local = requiredClaimEligibility(localEligibility, workspaceId);
  const counts = Object.fromEntries(CLAIM_COUNT_KEYS.map(name => [
    name,
    idbCounts[name] + local.counts[name],
  ]));
  const serializedCounts = CLAIM_COUNT_KEYS.map(name => `${name}=${counts[name]}`).join(',');
  return {
    workspaceId,
    counts,
    revision: [
      'practice-db-v2',
      encodeURIComponent(workspaceId),
      `counts:${serializedCounts}`,
      `local:${encodeURIComponent(local.revision)}`,
    ].join(':'),
  };
}

/* Boot-only capability for commitLegacyMigration(). It deliberately does not
   expose runtime SRS/event commands and does not require the ready gate. */
export function createLegacyMigrationTransactionPort(connection, {
  workspaceId,
  assertBootActive,
  inspectLocalEligibility,
} = {}) {
  if (!connection?.database || typeof connection.assertOpen !== 'function') {
    throw codedError('STORAGE_UNAVAILABLE', 'practice database connection is unavailable');
  }
  const workspace = requiredWorkspace(workspaceId);
  if (typeof assertBootActive !== 'function') {
    throw codedError('PRACTICE_ADAPTER_INCOMPLETE', 'assertBootActive must be a function');
  }
  if (typeof inspectLocalEligibility !== 'function') {
    throw codedError('PRACTICE_ADAPTER_INCOMPLETE', 'inspectLocalEligibility must be a function');
  }
  const active = () => {
    connection.assertOpen();
    assertBootActive(workspace);
  };

  const localEligibility = () => {
    const inspected = inspectLocalEligibility(workspace);
    if (inspected && typeof inspected.then === 'function') {
      throw codedError('PRACTICE_ADAPTER_INCOMPLETE', 'inspectLocalEligibility must be synchronous');
    }
    return { workspaceId: workspace, ...requiredClaimEligibility(inspected, workspace) };
  };

  const readIdbCounts = async store => {
    const countWorkspace = logical => requestPromise(
      store(logical).index('by_workspace').count(workspace),
    );
    const projectionKeys = () => requestPromise(
      store('projections').index('by_workspace').getAllKeys(workspace),
    );
    const [
      srs, events, dispositions, laneClaims, dailyCardClaims, attemptClaims, outbox,
      cursors, projections, legacyImports, quarantine, claimJournals,
    ] = await Promise.all([
      countWorkspace('srsV2'),
      countWorkspace('practiceEvents'),
      countWorkspace('eventDispositions'),
      countWorkspace('dailyLaneClaims'),
      countWorkspace('dailyCardClaims'),
      countWorkspace('attemptPhaseClaims'),
      countWorkspace('outbox'),
      countWorkspace('syncCursors'),
      projectionKeys(),
      countWorkspace('legacyImports'),
      countWorkspace('quarantine'),
      countWorkspace('claimJournals'),
    ]);
    const projectionCounts = {
      daily: 0, history: 0, achievements: 0,
      cycle: 0, remoteDays: 0, resweep: 0, state: 0,
    };
    for (const keyParts of projections) {
      const name = Array.isArray(keyParts) && typeof keyParts[1] === 'string'
        ? keyParts[1]
        : '';
      if (Object.hasOwn(projectionCounts, name)) projectionCounts[name] += 1;
      else projectionCounts.state += 1;
    }
    return {
      state: srs + projectionCounts.state,
      daily: projectionCounts.daily,
      history: projectionCounts.history,
      achievements: projectionCounts.achievements,
      events: events + dispositions + laneClaims + dailyCardClaims + attemptClaims
        + legacyImports + quarantine + claimJournals,
      outbox,
      cycle: projectionCounts.cycle,
      cursors,
      remoteDays: projectionCounts.remoteDays,
      resweep: projectionCounts.resweep,
    };
  };

  const eligibilityFrom = async store => compositeClaimEligibility(
    workspace,
    await readIdbCounts(store),
    localEligibility(),
  );

  return Object.freeze({
    workspaceId: workspace,
    async inspectClaimEligibility() {
      active();
      const physicalNames = Object.values(PRACTICE_DB_STORES);
      const transaction = connection.database.transaction(physicalNames, 'readonly');
      const done = transactionPromise(transaction);
      const store = logical => transaction.objectStore(PRACTICE_DB_STORES[logical]);
      try {
        const result = await eligibilityFrom(store);
        active();
        await done;
        active();
        return result;
      } catch (error) {
        try { transaction.abort(); } catch { /* already complete or aborted */ }
        try { await done; } catch { /* preserve the domain error */ }
        throw error;
      }
    },
    async transaction(work) {
      active();
      if (typeof work !== 'function') {
        throw codedError('PRACTICE_TRANSACTION_INVALID', 'migration transaction work is required');
      }
      const physicalNames = Object.values(PRACTICE_DB_STORES);
      let transaction;
      try {
        transaction = connection.database.transaction(physicalNames, 'readwrite', { durability: 'strict' });
      } catch {
        transaction = connection.database.transaction(physicalNames, 'readwrite');
      }
      const done = transactionPromise(transaction);
      const store = logical => transaction.objectStore(PRACTICE_DB_STORES[logical]);
      const tx = {
        async getClaimEligibility(requestedWorkspace) {
          active();
          assertWorkspaceArgument(workspace, requestedWorkspace);
          return eligibilityFrom(store);
        },
        async get(key) {
          active();
          const parts = migrationKeyParts(key, workspace);
          if (parts.group !== 'claim-journal') return null;
          const row = await requestPromise(
            store('claimJournals').get([workspace, parts.snapshotId]),
          );
          if (!row) return null;
          const { workspaceId: _workspaceId, snapshotId: _snapshotId, ...value } = row;
          return structuredClone(value);
        },
        async set(key, value) {
          active();
          const parts = migrationKeyParts(key, workspace);
          if (parts.group === 'claim-journal') {
            await requestPromise(store('claimJournals').add({
              ...structuredClone(value),
              workspaceId: workspace,
              snapshotId: parts.snapshotId,
            }));
            return;
          }
          if (parts.group === 'resolved') {
            await requestPromise(store('legacyImports').add({
              ...structuredClone(value),
              workspaceId: workspace,
              snapshotId: parts.snapshotId,
              recordId: parts.recordId,
              cardId: value.cardId || '',
            }));
            return;
          }
          await requestPromise(store('quarantine').add({
            ...structuredClone(value),
            workspaceId: workspace,
            snapshotId: parts.snapshotId,
            quarantineId: parts.recordId,
          }));
        },
        async getSrs(cardId) {
          active();
          const row = await requestPromise(store('srsV2').get([workspace, cardId]));
          return row ? structuredClone(row) : null;
        },
        async putSrs(row) {
          active();
          assertEnvelope(workspace, row);
          await requestPromise(store('srsV2').add({
            ...structuredClone(row),
            nextReviewAt: row.state?.nextReviewAt ?? 0,
          }));
        },
        async getProjection(name) {
          active();
          const row = await requestPromise(store('projections').get([workspace, name]));
          return row ? structuredClone(row) : null;
        },
        async putProjection(row) {
          active();
          assertEnvelope(workspace, row);
          await requestPromise(store('projections').add(structuredClone(row)));
        },
      };

      try {
        const result = await work(tx);
        active();
        await done;
        active();
        return result;
      } catch (error) {
        try { transaction.abort(); } catch { /* already complete or aborted */ }
        try { await done; } catch { /* preserve the domain error */ }
        throw error;
      }
    },
  });
}

export async function hydrateWorkspaceSnapshot(connection, {
  workspaceId,
  assertActive,
} = {}) {
  if (!connection?.database || typeof connection.assertOpen !== 'function') {
    throw codedError('STORAGE_UNAVAILABLE', 'practice database connection is unavailable');
  }
  const workspace = requiredWorkspace(workspaceId);
  if (typeof assertActive !== 'function') {
    throw codedError('PRACTICE_ADAPTER_INCOMPLETE', 'assertActive must be a function');
  }
  const active = () => {
    connection.assertOpen();
    assertActive(workspace);
  };
  active();
  const transaction = connection.database.transaction(
    [PRACTICE_DB_STORES.srsV2, PRACTICE_DB_STORES.projections],
    'readonly',
  );
  const done = transactionPromise(transaction);
  const srsStore = transaction.objectStore(PRACTICE_DB_STORES.srsV2);
  const projectionStore = transaction.objectStore(PRACTICE_DB_STORES.projections);
  try {
    const [srs, projections] = await Promise.all([
      requestPromise(srsStore.index('by_workspace').getAll(workspace)),
      requestPromise(projectionStore.index('by_workspace').getAll(workspace)),
    ]);
    for (const row of [...srs, ...projections]) assertEnvelope(workspace, row);
    active();
    await done;
    active();
    return structuredClone({
      kind: 'practice-workspace-hydration-v1',
      schemaVersion: 1,
      workspaceId: workspace,
      srs: srs.sort((left, right) => (
        left.cardId < right.cardId ? -1 : left.cardId > right.cardId ? 1 : 0
      )),
      projections: projections.sort((left, right) => (
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0
      )),
    });
  } catch (error) {
    try { transaction.abort(); } catch { /* already complete or aborted */ }
    try { await done; } catch { /* preserve the domain error */ }
    throw error;
  }
}
