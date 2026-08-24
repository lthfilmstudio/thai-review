import {
  PRACTICE_DB_VERSION,
  openPracticeDatabase,
  createPracticeTransactionPort,
  createLegacyMigrationTransactionPort,
} from '../../src/practice-db.js';
import { commitPracticeAttempt } from '../../src/practice-commit.js';
import { buildPracticeAttemptEvent } from '../../src/practice-events.js';
import {
  commitLegacyMigration,
  evaluateLegacyClaim,
  planLegacyMigration,
} from '../../src/storage-scope.js';

const DB_NAME = 'thai-review-practice-browser-acceptance-v1';
const resultEl = document.getElementById('result');
const openConnections = new Set();
const EMPTY_LOCAL_COUNTS = Object.freeze({
  state: 0, daily: 0, history: 0, achievements: 0, events: 0,
  outbox: 0, cycle: 0, cursors: 0, remoteDays: 0, resweep: 0,
});

function emptyLocalEligibility(workspaceId) {
  return { workspaceId, counts: EMPTY_LOCAL_COUNTS, revision: 'browser-local-empty-1' };
}

function deleteDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('test database delete was blocked'));
  });
}

function trackConnection(connection) {
  openConnections.add(connection);
  return connection;
}

function closeConnection(connection) {
  if (!connection) return;
  connection.close();
  openConnections.delete(connection);
}

async function cleanupDatabase() {
  for (const connection of openConnections) connection.close();
  openConnections.clear();
  await deleteDatabase();
}

function rawGet(database, storeName, key) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction([storeName], 'readonly');
    const request = transaction.objectStore(storeName).get(key);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
  });
}

function rawCount(database, storeName) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction([storeName], 'readonly');
    const request = transaction.objectStore(storeName).count();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function rawIndexCount(database, storeName, indexName, key) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction([storeName], 'readonly');
    const request = transaction.objectStore(storeName).index(indexName).count(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function rawWrite(database, storeName, write) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction([storeName], 'readwrite');
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error || new Error('raw write aborted'));
    transaction.onerror = () => { /* transaction.onabort owns rejection */ };
    write(transaction.objectStore(storeName));
  });
}

function rawAdd(database, storeName, row) {
  return rawWrite(database, storeName, store => store.add(structuredClone(row)));
}

function rawDelete(database, storeName, key) {
  return rawWrite(database, storeName, store => store.delete(key));
}

function openHigherVersion(version) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, version);
    request.onblocked = () => reject(new Error('higher-version open was blocked'));
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

function migrationResolvedRecordId(workspaceId, snapshotId, row, index) {
  return [
    'workspace', encodeURIComponent(workspaceId),
    'snapshot', encodeURIComponent(snapshotId), 'resolved',
    encodeURIComponent(row.sourceStore || 'unknown'),
    encodeURIComponent(row.cardId || row.sourceKey || 'workspace-fact'),
    encodeURIComponent(row.sourceKey || 'no-source-key'),
    String(index),
  ].join(':');
}

const IDS = Object.freeze({
  roundId: '22222222-2222-4222-8222-222222222222',
  cycleId: '33333333-3333-4333-8333-333333333333',
  cardId: '44444444-4444-4444-8444-444444444444',
  attemptId: '55555555-5555-4555-8555-555555555555',
});

function dueAttempt(eventId, formalGrade = 'good') {
  return {
    ...IDS,
    eventId,
    cycleOrdinal: 1,
    dayKey: '2026-08-24',
    lane: 'due',
    phase: 'first',
    result: 'success',
    formalGrade,
  };
}

function commitInput(port, eventId, formalGrade, attemptId = IDS.attemptId) {
  return {
    port,
    workspaceId: 'user:A',
    attempt: { ...dueAttempt(eventId, formalGrade), attemptId },
    now: Date.parse('2026-08-24T10:00:00.000Z'),
    createId: () => eventId,
    deviceId: 'workspace-installation-A',
  };
}

async function run() {
  await deleteDatabase();
  const connection = trackConnection(await openPracticeDatabase({ name: DB_NAME }));
  const portA = createPracticeTransactionPort(connection, {
    workspaceId: 'user:A',
    assertActive: workspaceId => {
      if (workspaceId !== 'user:A') throw new Error('browser workspace is stale');
    },
  });

  const [first, second] = await Promise.all([
    commitPracticeAttempt(commitInput(
      portA, '11111111-1111-4111-8111-111111111111', 'good',
    )),
    commitPracticeAttempt(commitInput(
      portA,
      '66666666-6666-4666-8666-666666666666',
      'easy',
      '77777777-7777-4777-8777-777777777777',
    )),
  ]);
  const statuses = [first.status, second.status].sort();
  if (statuses.join(',') !== 'committed,formal-due-already-claimed') {
    throw new Error(`parallel Due claim mismatch: ${statuses.join(',')}`);
  }

  const winner = first.status === 'committed' ? first : second;
  const abortedEvent = buildPracticeAttemptEvent({
    eventId: '88888888-8888-4888-8888-888888888888',
    roundId: IDS.roundId,
    cycleId: IDS.cycleId,
    cycleOrdinal: 1,
    cardId: '99999999-9999-4999-8999-999999999999',
    dayKey: '2026-08-24',
    attemptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    lane: 'sweep',
    phase: 'first',
    result: 'success',
    occurredAt: '2026-08-24T10:01:00.000Z',
  });
  let abortObserved = false;
  try {
    await portA.transaction(['practiceEvents'], 'readwrite', async tx => {
      await tx.putEvent('user:A', abortedEvent);
      throw new Error('intentional browser transaction abort');
    });
  } catch (error) {
    abortObserved = error.message === 'intentional browser transaction abort';
  }
  if (!abortObserved) throw new Error('browser transaction abort was not observed');
  closeConnection(connection);

  let reopened = trackConnection(await openPracticeDatabase({ name: DB_NAME }));
  const eventRow = await rawGet(
    reopened.database, 'practice_events', ['user:A', winner.event.eventId],
  );
  const srsRow = await rawGet(reopened.database, 'srs_v2', ['user:A', IDS.cardId]);
  const claimRow = await rawGet(
    reopened.database, 'formal_due_claims', ['user:A', IDS.cardId, '2026-08-24'],
  );
  const outboxRow = await rawGet(reopened.database, 'outbox', ['user:A', winner.event.eventId]);
  const foreignRow = await rawGet(
    reopened.database, 'practice_events', ['user:B', winner.event.eventId],
  );
  const counts = {
    events: await rawCount(reopened.database, 'practice_events'),
    srs: await rawCount(reopened.database, 'srs_v2'),
    claims: await rawCount(reopened.database, 'formal_due_claims'),
    outbox: await rawCount(reopened.database, 'outbox'),
  };
  const dueRollbackIds = {
    eventId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    roundId: '12121212-1212-4212-8212-121212121212',
    cycleId: '13131313-1313-4313-8313-131313131313',
    cardId: '14141414-1414-4414-8414-141414141414',
    attemptId: '15151515-1515-4515-8515-151515151515',
  };
  const dueRollbackWorkspace = 'user:abort';
  await rawAdd(reopened.database, 'outbox', {
    workspaceId: dueRollbackWorkspace,
    eventId: dueRollbackIds.eventId,
    status: 'preset-conflict',
    nextAttemptAt: 0,
    marker: 'due-outbox-conflict',
  });
  const dueRollbackPort = createPracticeTransactionPort(reopened, {
    workspaceId: dueRollbackWorkspace,
    assertActive: workspaceId => {
      if (workspaceId !== dueRollbackWorkspace) throw new Error('rollback workspace is stale');
    },
  });
  let dueRollbackError = null;
  try {
    await commitPracticeAttempt({
      port: dueRollbackPort,
      workspaceId: dueRollbackWorkspace,
      attempt: {
        ...dueRollbackIds,
        cycleOrdinal: 1,
        dayKey: '2026-08-24',
        lane: 'due',
        phase: 'first',
        result: 'success',
        formalGrade: 'good',
      },
      now: Date.parse('2026-08-24T10:02:00.000Z'),
      createId: () => dueRollbackIds.eventId,
      deviceId: 'workspace-installation-abort',
    });
  } catch (error) {
    dueRollbackError = error.code || error.name;
  }
  if (!dueRollbackError) throw new Error('Due outbox collision did not abort');
  closeConnection(reopened);

  reopened = trackConnection(await openPracticeDatabase({ name: DB_NAME }));
  const dueRollbackReadBack = {
    event: await rawGet(
      reopened.database, 'practice_events', [dueRollbackWorkspace, dueRollbackIds.eventId],
    ),
    srs: await rawGet(
      reopened.database, 'srs_v2', [dueRollbackWorkspace, dueRollbackIds.cardId],
    ),
    formalClaim: await rawGet(
      reopened.database, 'formal_due_claims',
      [dueRollbackWorkspace, dueRollbackIds.cardId, '2026-08-24'],
    ),
    attemptPhaseClaim: await rawGet(
      reopened.database, 'attempt_phase_claims',
      [dueRollbackWorkspace, dueRollbackIds.attemptId, 'first'],
    ),
    outbox: await rawGet(
      reopened.database, 'outbox', [dueRollbackWorkspace, dueRollbackIds.eventId],
    ),
  };
  if (dueRollbackReadBack.event !== null
      || dueRollbackReadBack.srs !== null
      || dueRollbackReadBack.formalClaim !== null
      || dueRollbackReadBack.attemptPhaseClaim !== null
      || dueRollbackReadBack.outbox?.marker !== 'due-outbox-conflict') {
    throw new Error(`Due rollback leaked partial rows: ${JSON.stringify(dueRollbackReadBack)}`);
  }
  const legacySnapshot = {
    snapshotId: 'browser-legacy-copy-1',
    facts: [
      {
        sourceStore: 'state', sourceKey: 'progress/unique', legacyAlias: 'L1:unique',
        value: { grade: 'good' },
      },
      {
        sourceStore: 'history', sourceKey: 'cards/collision', legacyAlias: 'L1:collision',
        value: [[0, 123]],
      },
    ],
  };
  const lineageEvidence = {
    kind: 'production-lineage-evidence-v1',
    evidenceId: 'browser-fixture:r1+r2',
    completeness: 'complete',
    expectedRevisions: ['r1', 'r2'],
    snapshots: [
      {
        revision: 'r1', complete: true,
        aliases: {
          'L1:unique': ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'],
          'L1:collision': [
            'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          ],
        },
      },
      {
        revision: 'r2', complete: true,
        aliases: {
          'L1:unique': ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'],
          'L1:collision': ['cccccccc-cccc-4ccc-8ccc-cccccccccccc'],
        },
      },
    ],
  };
  const migrationPlan = planLegacyMigration({
    legacySnapshot,
    lineageEvidence,
    trustedRevisionManifest: {
      kind: 'trusted-lineage-revision-manifest-v1', revisions: ['r1', 'r2'],
    },
  });
  let migrationPort = createLegacyMigrationTransactionPort(reopened, {
    workspaceId: 'user:B',
    assertBootActive: workspaceId => {
      if (workspaceId !== 'user:B') throw new Error('browser boot workspace is stale');
    },
    inspectLocalEligibility: emptyLocalEligibility,
  });
  const localEligibility = await migrationPort.inspectClaimEligibility();
  const remotePull = {
    completed: true, rowCount: 0, workspaceId: 'user:B', receiptId: 'browser-remote-empty-1',
  };
  const claimInput = {
    accountLabel: 'browser@example.test',
    namespacedLocalCounts: localEligibility,
    firstRemotePull: remotePull,
    legacyFactCount: legacySnapshot.facts.length,
    targetWorkspaceId: 'user:B',
    legacySnapshot,
    migrationPlan,
  };
  const offer = evaluateLegacyClaim(claimInput);
  if (offer.status !== 'offer') {
    throw new Error(`legacy claim was not offered: ${JSON.stringify({ offer, localEligibility })}`);
  }
  const confirmation = evaluateLegacyClaim({
    ...claimInput, decision: 'claim', offerToken: offer.offerToken,
  });
  if (confirmation.status !== 'confirmed') {
    throw new Error(`legacy claim was not confirmed: ${JSON.stringify(confirmation)}`);
  }
  const migrationInput = {
    transactionalPort: migrationPort,
    eligibilityGuard: {
      async verifyRemotePull(candidate) {
        return candidate.workspaceId === 'user:B'
          && candidate.receiptId === 'browser-remote-empty-1';
      },
    },
    workspaceId: 'user:B',
    plan: migrationPlan,
    authorization: confirmation.authorization,
  };
  const conflictPlanRow = migrationPlan.resolved[0];
  if (!conflictPlanRow || migrationPlan.resolved.length !== 1) {
    throw new Error('browser migration fixture must have exactly one resolved row');
  }
  const migrationConflictRecordId = migrationResolvedRecordId(
    'user:B', legacySnapshot.snapshotId, conflictPlanRow, 0,
  );
  const migrationConflictKey = [
    'user:B', legacySnapshot.snapshotId, migrationConflictRecordId,
  ];
  await rawAdd(reopened.database, 'legacy_imports', {
    workspaceId: 'user:B',
    snapshotId: legacySnapshot.snapshotId,
    recordId: migrationConflictRecordId,
    cardId: conflictPlanRow.cardId,
    marker: 'migration-add-conflict',
  });

  // The production guard now rejects any non-empty target before writing. Freeze
  // the just-issued empty evidence only in this fault harness so the real IDB
  // adapter reaches an add() collision and proves native transaction rollback.
  const collisionPort = {
    transaction(work) {
      return migrationPort.transaction(tx => work({
        ...tx,
        getClaimEligibility: async workspaceId => {
          if (workspaceId !== 'user:B') throw new Error('fault harness workspace mismatch');
          return structuredClone(localEligibility);
        },
      }));
    },
  };
  let migrationRollbackError = null;
  try {
    await commitLegacyMigration({ ...migrationInput, transactionalPort: collisionPort });
  } catch (error) {
    migrationRollbackError = error.code || error.name;
  }
  if (!migrationRollbackError) throw new Error('migration add collision did not abort');
  closeConnection(reopened);

  reopened = trackConnection(await openPracticeDatabase({ name: DB_NAME }));
  const migrationRollbackReadBack = {
    conflict: await rawGet(reopened.database, 'legacy_imports', migrationConflictKey),
    resolvedCount: await rawIndexCount(
      reopened.database, 'legacy_imports', 'by_workspace', 'user:B',
    ),
    quarantineCount: await rawIndexCount(
      reopened.database, 'quarantine', 'by_workspace', 'user:B',
    ),
    journalCount: await rawIndexCount(
      reopened.database, 'claim_journals', 'by_workspace', 'user:B',
    ),
  };
  if (migrationRollbackReadBack.conflict?.marker !== 'migration-add-conflict'
      || migrationRollbackReadBack.resolvedCount !== 1
      || migrationRollbackReadBack.quarantineCount !== 0
      || migrationRollbackReadBack.journalCount !== 0) {
    throw new Error(
      `migration rollback leaked partial rows: ${JSON.stringify(migrationRollbackReadBack)}`,
    );
  }
  await rawDelete(reopened.database, 'legacy_imports', migrationConflictKey);
  migrationPort = createLegacyMigrationTransactionPort(reopened, {
    workspaceId: 'user:B',
    assertBootActive: workspaceId => {
      if (workspaceId !== 'user:B') throw new Error('browser boot workspace is stale');
    },
    inspectLocalEligibility: emptyLocalEligibility,
  });
  const migrationFirst = await commitLegacyMigration({
    ...migrationInput, transactionalPort: migrationPort,
  });
  closeConnection(reopened);

  const migrationReload = trackConnection(await openPracticeDatabase({ name: DB_NAME }));
  const migrationPortReloaded = createLegacyMigrationTransactionPort(migrationReload, {
    workspaceId: 'user:B',
    assertBootActive: workspaceId => {
      if (workspaceId !== 'user:B') throw new Error('browser boot workspace is stale');
    },
    inspectLocalEligibility: emptyLocalEligibility,
  });
  const migrationSecond = await commitLegacyMigration({
    ...migrationInput, transactionalPort: migrationPortReloaded,
  });
  const migrationCounts = {
    resolved: await rawCount(migrationReload.database, 'legacy_imports'),
    quarantined: await rawCount(migrationReload.database, 'quarantine'),
    journals: await rawCount(migrationReload.database, 'claim_journals'),
  };
  const journal = await rawGet(
    migrationReload.database, 'claim_journals', ['user:B', legacySnapshot.snapshotId],
  );
  closeConnection(migrationReload);

  let versionChangeObserved = false;
  const versionConnection = trackConnection(await openPracticeDatabase({
    name: DB_NAME,
    onVersionChange() { versionChangeObserved = true; },
  }));
  const stalePort = createPracticeTransactionPort(versionConnection, {
    workspaceId: 'user:version',
    assertActive: workspaceId => {
      if (workspaceId !== 'user:version') throw new Error('version workspace is stale');
    },
  });
  const higherVersionDatabase = await openHigherVersion(PRACTICE_DB_VERSION + 1);
  openConnections.add(higherVersionDatabase);
  let stalePortError = null;
  try {
    await stalePort.transaction(['practiceEvents'], 'readonly', async () => null);
  } catch (error) {
    stalePortError = error.code || error.name;
  }
  closeConnection(higherVersionDatabase);
  closeConnection(versionConnection);
  if (!versionChangeObserved || stalePortError !== 'PRACTICE_DB_INVALIDATED') {
    throw new Error(`versionchange did not invalidate old port: ${JSON.stringify({
      versionChangeObserved, stalePortError,
    })}`);
  }

  const output = {
    status: 'passed',
    abortObserved,
    parallelDueStatuses: statuses,
    dueAtomicRollback: {
      status: 'passed',
      observedError: dueRollbackError,
      presetOutboxSurvived: dueRollbackReadBack.outbox?.marker === 'due-outbox-conflict',
    },
    reloadReadBack: {
      eventId: eventRow?.event?.eventId || null,
      srsVersion: srsRow?.version ?? null,
      sourceEventId: srsRow?.sourceEventId || null,
      claimEventId: claimRow?.eventId || null,
      outboxStatus: outboxRow?.status || null,
    },
    counts,
    foreignWorkspaceRow: foreignRow,
    migration: {
      firstStatus: migrationFirst.status,
      secondStatus: migrationSecond.status,
      summary: migrationFirst.summary,
      counts: migrationCounts,
      journalStatus: journal?.status || null,
      atomicRollback: {
        status: 'passed',
        observedError: migrationRollbackError,
        presetConflictSurvived:
          migrationRollbackReadBack.conflict?.marker === 'migration-add-conflict',
        retryStatus: migrationFirst.status,
      },
    },
    versionChange: {
      status: 'passed',
      callbackObserved: versionChangeObserved,
      stalePortError,
    },
  };
  if (output.reloadReadBack.eventId !== winner.event.eventId
      || output.reloadReadBack.srsVersion !== 1
      || output.reloadReadBack.sourceEventId !== winner.event.eventId
      || output.reloadReadBack.claimEventId !== winner.event.eventId
      || output.reloadReadBack.outboxStatus !== 'pending'
      || Object.values(counts).some(count => count !== 1)
      || foreignRow !== null
      || output.migration.firstStatus !== 'applied'
      || output.migration.secondStatus !== 'already-applied'
      || output.migration.summary.resolved !== 1
      || output.migration.summary.quarantined !== 1
      || Object.values(migrationCounts).some(count => count !== 1)
      || output.migration.journalStatus !== 'completed') {
    throw new Error(`reload read-back mismatch: ${JSON.stringify(output)}`);
  }
  return output;
}

window.practiceDbAcceptance = (async () => {
  try {
    return await run();
  } finally {
    await cleanupDatabase();
  }
})().then(result => {
  resultEl.textContent = JSON.stringify(result, null, 2);
  resultEl.dataset.status = 'passed';
  return result;
}).catch(error => {
  resultEl.textContent = `${error.name}: ${error.message}\n${error.stack || ''}`;
  resultEl.dataset.status = 'failed';
  throw error;
});
