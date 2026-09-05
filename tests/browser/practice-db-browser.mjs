import {
  PRACTICE_DB_VERSION,
  openPracticeDatabase,
  createPracticeTransactionPort,
  createLegacyMigrationTransactionPort,
  hydrateWorkspaceSnapshot,
} from '../../src/practice-db.js';
import { acknowledgeResweepCursor, commitPracticeAttempt } from '../../src/practice-commit.js';
import { buildPracticeAttemptEvent } from '../../src/practice-events.js';
import {
  commitRuntimeSrsBaseline,
  commitLegacyMigration,
  evaluateLegacyClaim,
  planLegacyMigration,
  planRuntimeSrsBaseline,
} from '../../src/storage-scope.js';
import { projectHydratedWorkspaceState } from '../../src/state.js';

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

function rawIndexGetAll(database, storeName, indexName, key) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction([storeName], 'readonly');
    const request = transaction.objectStore(storeName).index(indexName).getAll(key);
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

/* 模擬線上（codex/hybrid-mastery-release 的 0726965）真正建出來的 v2：13 個實體 store
   全在。新版跟它同名同版本，所以開起來不該觸發任何 onupgradeneeded。index 也要照抄——
   正因為不觸發 upgrade，fixture 少建的 index 之後補不回來，拿它當「回滾真的開得起來」
   的證據就會失真。 */
const PRODUCTION_V2_STORES = Object.freeze({
  workspace_meta: [['workspaceId', 'key'], []],
  practice_events: [['workspaceId', 'eventId'], [
    ['by_day', ['workspaceId', 'dayKey', 'eventId']],
    ['by_round', ['workspaceId', 'roundId', 'eventId']],
    ['by_cycle', ['workspaceId', 'cycleId', 'eventId']],
    ['by_card', ['workspaceId', 'cardId', 'eventId']],
    ['by_server_seq', ['workspaceId', 'serverSeq']],
    ['by_attempt_kind', ['workspaceId', 'attemptId', 'eventKind']],
  ]],
  event_dispositions: [['workspaceId', 'eventId'], []],
  formal_due_claims: [['workspaceId', 'cardId', 'dayKey'], []],
  daily_lane_claims: [['workspaceId', 'cardId', 'dayKey', 'lane'], []],
  attempt_phase_claims: [['workspaceId', 'attemptId', 'phase'], []],
  outbox: [['workspaceId', 'eventId'], [
    ['by_status', ['workspaceId', 'status', 'nextAttemptAt', 'eventId']],
  ]],
  sync_cursors: [['workspaceId', 'name'], []],
  legacy_imports: [['workspaceId', 'snapshotId', 'recordId'], [
    ['by_snapshot', ['workspaceId', 'snapshotId', 'recordId']],
    ['by_card', ['workspaceId', 'cardId', 'recordId']],
  ]],
  quarantine: [['workspaceId', 'quarantineId'], [
    ['by_snapshot', ['workspaceId', 'snapshotId', 'quarantineId']],
    ['by_reason', ['workspaceId', 'reason', 'quarantineId']],
  ]],
  claim_journals: [['workspaceId', 'snapshotId'], []],
});

function openVersionTwoFixture() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      for (const [name, [keyPath, indexes]] of Object.entries(PRODUCTION_V2_STORES)) {
        const created = request.result.createObjectStore(name, { keyPath });
        created.createIndex('by_workspace', 'workspaceId');
        for (const [indexName, indexKeyPath] of indexes) {
          created.createIndex(indexName, indexKeyPath);
        }
      }
      const store = request.result.createObjectStore('srs_v2', {
        keyPath: ['workspaceId', 'cardId'],
      });
      store.createIndex('by_workspace', 'workspaceId');
      store.createIndex('by_due', ['workspaceId', 'nextReviewAt', 'cardId']);
      store.add({
        workspaceId: 'user:upgrade',
        cardId: '10101010-1010-4010-8010-101010101010',
        version: 7,
        nextReviewAt: 99,
        state: { grade: 'easy', interval: 21 },
        sourceEventId: 'pre-v3-event',
      });
      const projections = request.result.createObjectStore('projections', {
        keyPath: ['workspaceId', 'name'],
      });
      projections.createIndex('by_workspace', 'workspaceId');
      projections.add({
        workspaceId: 'user:upgrade',
        name: 'daily',
        schemaVersion: 1,
        projectorVersion: 'pre-v3-fixture',
        facts: [{ preserved: true }],
      });
    };
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
  const versionTwo = await openVersionTwoFixture();
  versionTwo.close();
  const connection = trackConnection(await openPracticeDatabase({ name: DB_NAME }));
  const preservedVersionTwoRow = await rawGet(
    connection.database,
    'srs_v2',
    ['user:upgrade', '10101010-1010-4010-8010-101010101010'],
  );
  const preservedVersionTwoProjection = await rawGet(
    connection.database,
    'projections',
    ['user:upgrade', 'daily'],
  );
  if (connection.database.version !== 2
      || connection.database.objectStoreNames.contains('daily_card_claims')
      || !connection.database.objectStoreNames.contains('formal_due_claims')
      || preservedVersionTwoRow?.version !== 7
      || preservedVersionTwoProjection?.facts?.[0]?.preserved !== true) {
    throw new Error('開既有的 production v2 不該升版，也不該多開 store');
  }
  const portA = createPracticeTransactionPort(connection, {
    workspaceId: 'user:A',
    assertActive: workspaceId => {
      if (workspaceId !== 'user:A') throw new Error('browser workspace is stale');
    },
  });

  // 這段只是驗 store 本身的唯一性，要用另一張卡——用 IDS.cardId 會把後面平行 Due
  // 測試（AE3）要搶的 (day, card) 先占走，那個測試就永遠看不到 committed。
  const dailyClaim = {
    workspaceId: 'user:A',
    dayKey: '2026-08-24',
    cardId: '12121212-1212-4121-8121-121212121212',
    attemptId: IDS.attemptId,
    lane: 'due',
    roundId: IDS.roundId,
    cycleId: IDS.cycleId,
  };
  const dailyCardFirst = await portA.transaction(
    ['dailyCardClaims'],
    'readwrite',
    tx => tx.addDailyCardClaim('user:A', dailyClaim),
  );
  const dailyCardSecond = await portA.transaction(
    ['dailyCardClaims'],
    'readwrite',
    async tx => ({
      added: await tx.addDailyCardClaim('user:A', { ...dailyClaim, lane: 'sweep' }),
      existing: await tx.getDailyCardClaim('user:A', dailyClaim.dayKey, dailyClaim.cardId),
    }),
  );
  if (dailyCardFirst !== true
      || dailyCardSecond.added !== false
      || dailyCardSecond.existing?.lane !== 'due') {
    throw new Error('daily-card claim did not enforce cross-lane uniqueness');
  }

  const baselineWorkspace = 'user:runtime-baseline';
  const baselinePort = createPracticeTransactionPort(connection, {
    workspaceId: baselineWorkspace,
    assertActive: workspaceId => {
      if (workspaceId !== baselineWorkspace) throw new Error('baseline workspace is stale');
    },
  });
  const baselineLineage = {
    lineageEvidence: {
      kind: 'production-lineage-evidence-v1',
      evidenceId: 'browser-runtime-baseline:r1+r2',
      completeness: 'complete',
      expectedRevisions: ['r1', 'r2'],
      snapshots: ['r1', 'r2'].map(revision => ({
        revision,
        complete: true,
        aliases: { 'L1:seed': ['30303030-3030-4030-8030-303030303030'] },
      })),
    },
    trustedRevisionManifest: {
      kind: 'trusted-lineage-revision-manifest-v1',
      revisions: ['r1', 'r2'],
      allowHistoricalSnapshotEvidence: true,
    },
  };
  const baselinePlan = planRuntimeSrsBaseline({
    progress: { 'L1:seed': { grade: 'hard', interval: 3, reps: 2 } },
    currentCatalog: {
      lessons: [{
        id: 'L1',
        cards: [{ thai: 'seed', card_id: '30303030-3030-4030-8030-303030303030' }],
      }],
    },
    catalogDigest: 'sha256:browser-catalog-a',
    ...baselineLineage,
  });
  const baselineFirst = await commitRuntimeSrsBaseline({
    port: baselinePort, workspaceId: baselineWorkspace, plan: baselinePlan,
  });
  const baselineSecond = await commitRuntimeSrsBaseline({
    port: baselinePort, workspaceId: baselineWorkspace, plan: baselinePlan,
  });
  if (baselineFirst.status !== 'applied'
      || baselineFirst.summary.seeded !== 1
      || baselineSecond.status !== 'no-op'
      || baselineSecond.summary.seeded !== 0
      || baselineSecond.summary.skipped !== baselineFirst.summary.seeded) {
    throw new Error('runtime baseline was not add-only and idempotent');
  }

  /* 規模探針。lineage 規則放寬之後，開機第一次 seed 從 94 列變成 12324 列，而 seeding
     是「每列兩個 sequential await」跑在同一個 IDB readwrite transaction 裡。IDB 的交易
     會在事件迴圈回到 task 時自動 commit，列數一多就可能中途 TransactionInactiveError；
     就算撐住了，這段是擋在第一次 render 前面的。所以在真的瀏覽器裡量一次。 */
  const scaleCount = 12324;
  const scaleWorkspace = 'user:runtime-baseline-scale';
  const scalePort = createPracticeTransactionPort(connection, {
    workspaceId: scaleWorkspace,
    assertActive: workspaceId => {
      if (workspaceId !== scaleWorkspace) throw new Error('scale workspace is stale');
    },
  });
  const scaleId = index => `${index.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
  const scaleProgress = {};
  const scaleAliases = {};
  const scaleCards = [];
  for (let index = 0; index < scaleCount; index += 1) {
    const alias = `L9:card-${index}`;
    const cardId = scaleId(index);
    scaleProgress[alias] = { grade: 'good', interval: 3, reps: 2 };
    scaleAliases[alias] = [cardId];
    scaleCards.push({ thai: `card-${index}`, card_id: cardId });
  }
  const scalePlan = planRuntimeSrsBaseline({
    progress: scaleProgress,
    currentCatalog: { lessons: [{ id: 'L9', cards: scaleCards }] },
    catalogDigest: 'sha256:browser-catalog-scale',
    lineageEvidence: {
      kind: 'production-lineage-evidence-v1',
      evidenceId: 'browser-runtime-baseline-scale:r1+r2',
      completeness: 'complete',
      expectedRevisions: ['r1', 'r2'],
      snapshots: ['r1', 'r2'].map(revision => ({ revision, complete: true, aliases: scaleAliases })),
    },
    trustedRevisionManifest: {
      kind: 'trusted-lineage-revision-manifest-v1',
      revisions: ['r1', 'r2'],
      allowHistoricalSnapshotEvidence: true,
    },
  });
  if (scalePlan.summary.seedable !== scaleCount) {
    throw new Error(`scale plan seedable ${scalePlan.summary.seedable} != ${scaleCount}`);
  }
  const scaleStartedAt = performance.now();
  const scaleResult = await commitRuntimeSrsBaseline({
    port: scalePort, workspaceId: scaleWorkspace, plan: scalePlan,
  });
  const scaleMs = Math.round(performance.now() - scaleStartedAt);
  if (scaleResult.status !== 'applied' || scaleResult.summary.seeded !== scaleCount) {
    throw new Error(`scale seed failed: ${JSON.stringify(scaleResult)}`);
  }
  const scaleRows = await rawIndexCount(connection.database, 'srs_v2', 'by_workspace', scaleWorkspace);
  if (scaleRows !== scaleCount) {
    throw new Error(`scale seed wrote ${scaleRows} rows, expected ${scaleCount}`);
  }
  // 第二次才是常態成本：不再寫 srs_v2，但仍要讀寫 12324 筆的 seededAliases 帳
  const replayStartedAt = performance.now();
  const scaleReplay = await commitRuntimeSrsBaseline({
    port: scalePort, workspaceId: scaleWorkspace, plan: scalePlan,
  });
  const replayMs = Math.round(performance.now() - replayStartedAt);
  if (scaleReplay.status !== 'no-op' || scaleReplay.summary.skipped !== scaleCount) {
    throw new Error(`scale replay was not a no-op: ${JSON.stringify(scaleReplay)}`);
  }
  console.log(`[scale] seed ${scaleCount} rows: first ${scaleMs}ms, replay ${replayMs}ms`);

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
  // R3 之後擋在最外層的是跨 lane 的 daily-card claim，不再是 formal Due claim。
  if (statuses.join(',') !== 'committed,daily-card-already-claimed') {
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
  // R9：retry-limit 的游標 ack 走真的 IndexedDB transaction，重播不得多推。
  const resweepReceipt = {
    expectedCardId: IDS.cardId, expectedPosition: 0, catalogDigest: 'sha256:browser-catalog-a',
  };
  const resweepAcked = await acknowledgeResweepCursor({
    port: portA, workspaceId: 'user:A', receipt: resweepReceipt,
  });
  let resweepReplayError = null;
  try {
    await acknowledgeResweepCursor({ port: portA, workspaceId: 'user:A', receipt: resweepReceipt });
  } catch (error) {
    resweepReplayError = error.code || error.message;
  }
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
  // AE5：commit 完、localStorage mirror 之前掛掉，reload 要從 IDB 看到一樣的投影。
  const dailyRow = await rawGet(
    reopened.database, 'projections', ['user:A', 'daily:2026-08-24'],
  );
  const historyRow = await rawGet(
    reopened.database, 'projections', ['user:A', `history:${IDS.cardId}`],
  );
  const counts = {
    events: await rawCount(reopened.database, 'practice_events'),
    srs: await rawIndexCount(reopened.database, 'srs_v2', 'by_workspace', 'user:A'),
    /* formal_due_claims 現在就是 daily-card claim 的實體 store，前面那個獨立的
       跨 lane 測試也在裡面留了一列（不同卡），所以只數這次 commit 那張卡。 */
    claims: await rawGet(
      reopened.database, 'formal_due_claims', ['user:A', IDS.cardId, '2026-08-24'],
    ) ? 1 : 0,
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

  const addCollisionWorkspace = 'user:add-collision';
  const addCollisionPort = createLegacyMigrationTransactionPort(reopened, {
    workspaceId: addCollisionWorkspace,
    assertBootActive: workspaceId => {
      if (workspaceId !== addCollisionWorkspace) throw new Error('add collision workspace is stale');
    },
    inspectLocalEligibility: emptyLocalEligibility,
  });
  const addCollisionSrs = {
    workspaceId: addCollisionWorkspace,
    cardId: '19191919-1919-4919-8919-191919191919',
    version: 0,
    state: { grade: 'good' },
    sourceEventId: null,
  };
  let authoritativeAddCollisionError = null;
  try {
    await addCollisionPort.transaction(async tx => {
      await tx.putSrs(addCollisionSrs);
      await tx.putProjection({
        workspaceId: addCollisionWorkspace,
        name: 'daily',
        schemaVersion: 1,
        projectorVersion: 'browser-add-collision-v1',
        facts: [],
      });
      await tx.putSrs(addCollisionSrs);
    });
  } catch (error) {
    authoritativeAddCollisionError = error.code || error.name;
  }
  if (!authoritativeAddCollisionError) {
    throw new Error('authoritative duplicate add did not abort');
  }
  closeConnection(reopened);
  reopened = trackConnection(await openPracticeDatabase({ name: DB_NAME }));
  const authoritativeAddRollback = {
    srs: await rawIndexCount(
      reopened.database, 'srs_v2', 'by_workspace', addCollisionWorkspace,
    ),
    projections: await rawIndexCount(
      reopened.database, 'projections', 'by_workspace', addCollisionWorkspace,
    ),
  };
  if (authoritativeAddRollback.srs !== 0 || authoritativeAddRollback.projections !== 0) {
    throw new Error(
      `authoritative add collision leaked rows: ${JSON.stringify(authoritativeAddRollback)}`,
    );
  }
  const legacySnapshot = {
    snapshotId: 'browser-legacy-copy-1',
    facts: [
      {
        sourceStore: 'state', sourceKey: 'progress/unique', legacyAlias: 'L1:unique',
        value: {
          grade: 'hard', reviewedAt: 1, nextReviewAt: 2,
          interval: 3, easeFactor: 2.2, reps: 2, updatedAt: 1,
          deviceId: 'legacy-device',
        },
      },
      {
        sourceStore: 'history', sourceKey: 'cards/collision', legacyAlias: 'L1:collision',
        value: [[0, 123]],
      },
      {
        sourceStore: 'daily', sourceKey: '2026-08-24', identityKind: 'workspace',
        value: { reviewed: 1 },
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
      // 這份 fixture 用歷史 snapshot（v1）格式；production 的 manifest 不開這個旗標。
      allowHistoricalSnapshotEvidence: true,
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
  const conflictPlanRow = migrationPlan.resolved.find(row => row.sourceStore === 'state');
  if (!conflictPlanRow || migrationPlan.resolved.length !== 2) {
    throw new Error('browser migration fixture must have SRS and workspace resolved rows');
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
    srsCount: await rawIndexCount(
      reopened.database, 'srs_v2', 'by_workspace', 'user:B',
    ),
    projectionCount: await rawIndexCount(
      reopened.database, 'projections', 'by_workspace', 'user:B',
    ),
  };
  if (migrationRollbackReadBack.conflict?.marker !== 'migration-add-conflict'
      || migrationRollbackReadBack.resolvedCount !== 1
      || migrationRollbackReadBack.quarantineCount !== 0
      || migrationRollbackReadBack.journalCount !== 0
      || migrationRollbackReadBack.srsCount !== 0
      || migrationRollbackReadBack.projectionCount !== 0) {
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
  const hydration = await hydrateWorkspaceSnapshot(migrationReload, {
    workspaceId: 'user:B',
    assertActive: workspaceId => {
      if (workspaceId !== 'user:B') throw new Error('hydration workspace is stale');
    },
  });
  const hydratedState = projectHydratedWorkspaceState(hydration);
  const migrationSecond = await commitLegacyMigration({
    ...migrationInput, transactionalPort: migrationPortReloaded,
  });
  const migratedPracticePort = createPracticeTransactionPort(migrationReload, {
    workspaceId: 'user:B',
    assertActive: workspaceId => {
      if (workspaceId !== 'user:B') throw new Error('migrated practice workspace is stale');
    },
  });
  const migratedDueEventId = '20202020-2020-4020-8020-202020202020';
  const migratedDue = await commitPracticeAttempt({
    port: migratedPracticePort,
    workspaceId: 'user:B',
    attempt: {
      eventId: migratedDueEventId,
      roundId: '21212121-2121-4121-8121-212121212121',
      cycleId: '23232323-2323-4323-8323-232323232323',
      cycleOrdinal: 1,
      cardId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      attemptId: '24242424-2424-4424-8424-242424242424',
      dayKey: '2026-08-25',
      lane: 'due',
      phase: 'first',
      result: 'success',
      formalGrade: 'good',
    },
    now: Date.parse('2026-08-25T10:00:00.000Z'),
    createId: () => migratedDueEventId,
    deviceId: 'workspace-installation-B',
  });
  const migratedDueSrs = await rawGet(
    migrationReload.database,
    'srs_v2',
    ['user:B', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'],
  );
  const migrationCounts = {
    resolved: await rawCount(migrationReload.database, 'legacy_imports'),
    quarantined: await rawCount(migrationReload.database, 'quarantine'),
    journals: await rawCount(migrationReload.database, 'claim_journals'),
    materializedSrs: await rawIndexCount(
      migrationReload.database, 'srs_v2', 'by_workspace', 'user:B',
    ),
    // 同一個 workspace 現在也有 U3 寫的 ledger 投影，光數總數已經不能代表
    // 「migration 產出幾份」了，要按 projectorVersion 分開數。
    materializedProjections: (await rawIndexGetAll(
      migrationReload.database, 'projections', 'by_workspace', 'user:B',
    )).filter(row => row.projectorVersion === 'legacy-workspace-facts-v1').length,
    ledgerProjections: (await rawIndexGetAll(
      migrationReload.database, 'projections', 'by_workspace', 'user:B',
    )).map(row => row.projectorVersion).filter(v => v !== 'legacy-workspace-facts-v1').sort(),
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
    // 回滾能不能活，就看這裡：版本沒動、沒開新 store、舊資料還在
    rollbackSafe: {
      openedVersion: connection.database.version,
      expectedVersion: PRACTICE_DB_VERSION,
      newStoreCreated: connection.database.objectStoreNames.contains('daily_card_claims'),
      preservedSrsVersion: preservedVersionTwoRow?.version ?? null,
      preservedProjection: preservedVersionTwoProjection?.facts?.[0]?.preserved === true,
    },
    dailyCardClaim: {
      first: dailyCardFirst,
      second: dailyCardSecond.added,
      lane: dailyCardSecond.existing?.lane || null,
    },
    runtimeBaseline: {
      firstStatus: baselineFirst.status,
      secondStatus: baselineSecond.status,
      seeded: baselineFirst.summary.seeded,
      replaySkipped: baselineSecond.summary.skipped,
    },
    abortObserved,
    parallelDueStatuses: statuses,
    dueAtomicRollback: {
      status: 'passed',
      observedError: dueRollbackError,
      presetOutboxSurvived: dueRollbackReadBack.outbox?.marker === 'due-outbox-conflict',
    },
    authoritativeAddRollback: {
      status: 'passed',
      observedError: authoritativeAddCollisionError,
      ...authoritativeAddRollback,
    },
    ledgerProjections: {
      dailyReviewed: dailyRow?.reviewed ?? null,
      dailyPractice: dailyRow?.practice ?? null,
      dailyGood: dailyRow?.good ?? null,
      historyEntries: historyRow?.entries?.length ?? null,
      historyEventId: historyRow?.entries?.[0]?.[2] ?? null,
      resweepAfterAck: resweepAcked?.position ?? null,
      resweepReplayError: resweepReplayError,
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
      hydration: {
        srsCardIds: hydration.srs.map(row => row.cardId),
        projectionNames: hydration.projections.map(row => row.name),
        progressKeys: Object.keys(hydratedState.progress),
      },
      legacyDueUpgrade: {
        status: migratedDue.status,
        beforeVersion: migratedDue.event?.srsBeforeVersion ?? null,
        afterVersion: migratedDue.event?.srsAfterVersion ?? null,
        storedVersion: migratedDueSrs?.version ?? null,
        interval: migratedDueSrs?.state?.interval ?? null,
        reps: migratedDueSrs?.state?.reps ?? null,
        easeFactor: migratedDueSrs?.state?.easeFactor ?? null,
      },
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
  if (output.rollbackSafe.preservedSrsVersion !== 7
      || output.rollbackSafe.preservedProjection !== true
      || output.rollbackSafe.openedVersion !== 2
      || output.rollbackSafe.expectedVersion !== 2
      || output.rollbackSafe.newStoreCreated !== false
      || output.dailyCardClaim.first !== true
      || output.dailyCardClaim.second !== false
      || output.dailyCardClaim.lane !== 'due'
      || output.runtimeBaseline.firstStatus !== 'applied'
      || output.runtimeBaseline.secondStatus !== 'no-op'
      || output.runtimeBaseline.seeded !== 1
      || output.runtimeBaseline.replaySkipped !== 1
      || output.ledgerProjections.dailyReviewed !== 1
      || output.ledgerProjections.dailyGood !== 1
      || output.ledgerProjections.dailyPractice !== 0
      || output.ledgerProjections.historyEntries !== 1
      || output.ledgerProjections.historyEventId !== winner.event.eventId
      || output.ledgerProjections.resweepAfterAck !== 1
      || output.ledgerProjections.resweepReplayError !== 'RESWEEP_RECEIPT_POSITION_STALE'
      || output.reloadReadBack.eventId !== winner.event.eventId
      || output.reloadReadBack.srsVersion !== 1
      || output.reloadReadBack.sourceEventId !== winner.event.eventId
      || output.reloadReadBack.claimEventId !== winner.event.eventId
      || output.reloadReadBack.outboxStatus !== 'pending'
      || Object.values(counts).some(count => count !== 1)
      || foreignRow !== null
      || output.authoritativeAddRollback.srs !== 0
      || output.authoritativeAddRollback.projections !== 0
      || output.migration.firstStatus !== 'applied'
      || output.migration.secondStatus !== 'already-applied'
      || output.migration.summary.resolved !== 2
      || output.migration.summary.quarantined !== 1
      || output.migration.summary.materializedSrs !== 1
      || output.migration.summary.materializedProjectionFacts !== 1
      || migrationCounts.resolved !== 2
      || migrationCounts.quarantined !== 1
      || migrationCounts.journals !== 1
      || migrationCounts.materializedSrs !== 1
      || migrationCounts.materializedProjections !== 1
      || migrationCounts.ledgerProjections.join(',') !== 'practice-daily-v1,practice-history-v1'
      || output.migration.hydration.srsCardIds.join(',')
        !== 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
      || output.migration.hydration.progressKeys.join(',')
        !== 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
      || output.migration.hydration.projectionNames.join(',') !== 'daily'
      || output.migration.legacyDueUpgrade.status !== 'committed'
      || output.migration.legacyDueUpgrade.beforeVersion !== 0
      || output.migration.legacyDueUpgrade.afterVersion !== 1
      || output.migration.legacyDueUpgrade.storedVersion !== 1
      || output.migration.legacyDueUpgrade.interval !== 7
      || output.migration.legacyDueUpgrade.reps !== 3
      || output.migration.legacyDueUpgrade.easeFactor !== 2.2
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
