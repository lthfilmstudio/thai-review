import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PRACTICE_DB_STORES,
  createLegacyMigrationTransactionPort,
  createPracticeTransactionPort,
  openPracticeDatabase,
  upgradePracticeSchema,
} from '../src/practice-db.js';

function schemaDouble(existing = []) {
  const stores = new Map();
  return {
    stores,
    objectStoreNames: { contains: name => existing.includes(name) || stores.has(name) },
    createObjectStore(name, options) {
      const indexes = [];
      const store = {
        options,
        indexes,
        createIndex(indexName, keyPath, indexOptions) {
          indexes.push({ name: indexName, keyPath, options: indexOptions });
        },
      };
      stores.set(name, store);
      return store;
    },
  };
}

test('schema creates every workspace-prefixed store and required query indexes', () => {
  const db = schemaDouble();
  upgradePracticeSchema(db);
  assert.deepEqual([...db.stores.keys()], Object.values(PRACTICE_DB_STORES));
  assert.deepEqual(db.stores.get('srs_v2').options.keyPath, ['workspaceId', 'cardId']);
  assert.deepEqual(db.stores.get('formal_due_claims').options.keyPath, [
    'workspaceId', 'cardId', 'dayKey',
  ]);
  assert.deepEqual(db.stores.get('daily_lane_claims').options.keyPath, [
    'workspaceId', 'cardId', 'dayKey', 'lane',
  ]);
  assert.deepEqual(db.stores.get('attempt_phase_claims').options.keyPath, [
    'workspaceId', 'attemptId', 'phase',
  ]);
  assert.deepEqual(
    db.stores.get('practice_events').indexes.map(index => index.name),
    ['by_workspace', 'by_day', 'by_round', 'by_cycle', 'by_card', 'by_server_seq', 'by_attempt_kind'],
  );
  assert.deepEqual(
    db.stores.get('outbox').indexes.find(index => index.name === 'by_status').keyPath,
    ['workspaceId', 'status', 'nextAttemptAt', 'eventId'],
  );
});

test('schema upgrade is additive and leaves existing stores untouched', () => {
  const db = schemaDouble(['practice_events']);
  upgradePracticeSchema(db);
  assert.equal(db.stores.has('practice_events'), false);
  assert.equal(db.stores.size, Object.keys(PRACTICE_DB_STORES).length - 1);
});

test('schema upgrade adds missing indexes to an existing store', () => {
  const db = schemaDouble(['practice_events']);
  const created = [];
  const existingStore = {
    indexNames: { contains: name => name === 'by_workspace' },
    createIndex(name, keyPath, options) { created.push({ name, keyPath, options }); },
  };
  upgradePracticeSchema(db, {
    objectStore(name) {
      assert.equal(name, 'practice_events');
      return existingStore;
    },
  });
  assert.deepEqual(created.map(index => index.name), [
    'by_day', 'by_round', 'by_cycle', 'by_card', 'by_server_seq', 'by_attempt_kind',
  ]);
});

test('IndexedDB unavailable fails closed before returning a handle', async () => {
  await assert.rejects(openPracticeDatabase({ indexedDBFactory: null }), error => {
    assert.equal(error.code, 'STORAGE_UNAVAILABLE');
    return true;
  });
  await assert.rejects(openPracticeDatabase({
    indexedDBFactory: { open() { throw new Error('blocked'); } },
  }), error => {
    assert.equal(error.code, 'STORAGE_UNAVAILABLE');
    return true;
  });
});

test('workspace port validates its capability before opening a transaction', async () => {
  let transactions = 0;
  const connection = {
    database: { transaction() { transactions += 1; throw new Error('must not open'); } },
    assertOpen() {},
  };
  assert.throws(() => createPracticeTransactionPort(connection, { workspaceId: 'wrong' }), {
    code: 'WORKSPACE_ID_INVALID',
  });
  assert.throws(() => createPracticeTransactionPort(connection, { workspaceId: 'user:A' }), {
    code: 'PRACTICE_ADAPTER_INCOMPLETE',
  });
  const port = createPracticeTransactionPort(connection, {
    workspaceId: 'user:A',
    assertActive() { throw Object.assign(new Error('stale'), { code: 'WORKSPACE_INVALIDATED' }); },
  });
  await assert.rejects(port.transaction(['practiceEvents'], 'readwrite', () => {}), {
    code: 'WORKSPACE_INVALIDATED',
  });
  assert.equal(transactions, 0);
});

function successfulRequest(result) {
  const request = { result, error: null };
  queueMicrotask(() => request.onsuccess?.());
  return request;
}

function transactionDatabase(counts = {}) {
  const logicalByPhysical = Object.fromEntries(
    Object.entries(PRACTICE_DB_STORES).map(([logical, physical]) => [physical, logical]),
  );
  return {
    transaction() {
      const transaction = {
        error: null,
        abort() {},
        objectStore(physicalName) {
          const logicalName = logicalByPhysical[physicalName];
          return {
            index() {
              return {
                count: () => successfulRequest(counts[logicalName] || 0),
                getAllKeys: () => successfulRequest(counts.projectionKeys || []),
              };
            },
          };
        },
      };
      setImmediate(() => transaction.oncomplete?.());
      return transaction;
    },
  };
}

const EMPTY_COUNTS = Object.freeze({
  state: 0, daily: 0, history: 0, achievements: 0, events: 0,
  outbox: 0, cycle: 0, cursors: 0, remoteDays: 0, resweep: 0,
});

test('migration port requires both boot and local eligibility capabilities', () => {
  const connection = { database: transactionDatabase(), assertOpen() {} };
  assert.throws(() => createLegacyMigrationTransactionPort(connection, {
    workspaceId: 'user:A',
  }), { code: 'PRACTICE_ADAPTER_INCOMPLETE' });
  assert.throws(() => createLegacyMigrationTransactionPort(connection, {
    workspaceId: 'user:A', assertBootActive() {},
  }), { code: 'PRACTICE_ADAPTER_INCOMPLETE' });
});

test('offer inspection and transaction recheck share one composite eligibility producer', async () => {
  const idbCounts = { legacyImports: 1, quarantine: 1, claimJournals: 1 };
  let localRevision = 'local-empty-1';
  const port = createLegacyMigrationTransactionPort({
    database: transactionDatabase(idbCounts),
    assertOpen() {},
  }, {
    workspaceId: 'user:A',
    assertBootActive() {},
    inspectLocalEligibility: workspaceId => ({
      workspaceId, counts: EMPTY_COUNTS, revision: localRevision,
    }),
  });
  const offered = await port.inspectClaimEligibility();
  const rechecked = await port.transaction(tx => tx.getClaimEligibility('user:A'));
  assert.deepEqual(rechecked, offered);
  assert.equal(offered.counts.events, 3, 'prior import, quarantine and journal all make target non-empty');

  localRevision = 'local-empty-2';
  const changed = await port.inspectClaimEligibility();
  assert.deepEqual(changed.counts, offered.counts);
  assert.notEqual(changed.revision, offered.revision);
});

test('runtime and migration ports recheck workspace after native transaction completes', async () => {
  const staleAfterCompletion = () => {
    let checks = 0;
    return () => {
      checks += 1;
      if (checks === 3) {
        throw Object.assign(new Error('stale after completion'), { code: 'WORKSPACE_INVALIDATED' });
      }
    };
  };
  const connection = { database: transactionDatabase(), assertOpen() {} };
  const runtimePort = createPracticeTransactionPort(connection, {
    workspaceId: 'user:A', assertActive: staleAfterCompletion(),
  });
  await assert.rejects(
    runtimePort.transaction(['practiceEvents'], 'readonly', () => 'done'),
    { code: 'WORKSPACE_INVALIDATED' },
  );

  const migrationPort = createLegacyMigrationTransactionPort(connection, {
    workspaceId: 'user:A',
    assertBootActive: staleAfterCompletion(),
    inspectLocalEligibility: workspaceId => ({
      workspaceId, counts: EMPTY_COUNTS, revision: 'local-empty-1',
    }),
  });
  await assert.rejects(
    migrationPort.transaction(() => 'done'),
    { code: 'WORKSPACE_INVALIDATED' },
  );
});
