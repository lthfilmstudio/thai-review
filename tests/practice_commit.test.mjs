import assert from 'node:assert/strict';
import test from 'node:test';

import {
  acknowledgeResweepCursor,
  commitPracticeAttempt,
  readPracticeDayContext,
} from '../src/practice-commit.js';

const IDs = {
  eventId: '11111111-1111-4111-8111-111111111111',
  roundId: '22222222-2222-4222-8222-222222222222',
  cycleId: '33333333-3333-4333-8333-333333333333',
  cardId: '44444444-4444-4444-8444-444444444444',
  attemptId: '55555555-5555-4555-8555-555555555555',
};

function attempt(overrides = {}) {
  return {
    ...IDs,
    cycleOrdinal: 1,
    dayKey: '2026-08-24',
    lane: 'sweep',
    phase: 'first',
    result: 'success',
    ...overrides,
  };
}

function transactionalPort({ failBeforeCommit = false } = {}) {
  const data = {
    events: new Map(), srs: new Map(),
    // dailyCardClaims 的實體 store 就是 v2 的 formal_due_claims（見 practice-db.js）
    dailyLaneClaims: new Map(), dailyCardClaims: new Map(),
    attemptPhaseClaims: new Map(), outbox: new Map(), projections: new Map(),
  };
  let transactionTail = Promise.resolve();
  return {
    data,
    failBeforeCommit,
    async transaction(storeNames, mode, work) {
      let releaseTransaction;
      const previousTransaction = transactionTail;
      transactionTail = new Promise(resolve => { releaseTransaction = resolve; });
      await previousTransaction;
      try {
        assert.deepEqual(storeNames, mode === 'readonly' ? [
          'dailyCardClaims', 'attemptPhaseClaims',
        ] : storeNames.length === 1 ? ['projections'] : [
          'practiceEvents', 'srsV2', 'dailyLaneClaims',
          'dailyCardClaims', 'attemptPhaseClaims', 'outbox', 'projections',
        ]);
        const draft = structuredClone(data);
        const key = (workspace, id) => `${workspace}:${id}`;
        const tx = {
          getEvent: (workspace, eventId) => draft.events.get(key(workspace, eventId)) || null,
          putEvent: (workspace, event) => {
            const k = key(workspace, event.eventId);
            if (draft.events.has(k)) throw new Error('event duplicate');
            draft.events.set(k, structuredClone(event));
          },
          getSrs: (workspace, cardId) => draft.srs.get(key(workspace, cardId)) || null,
          putSrs: (workspace, cardId, row) => {
            draft.srs.set(key(workspace, cardId), structuredClone(row));
          },
          addDailyLaneClaim: (workspace, row) => {
            const k = key(workspace, `${row.dayKey}:${row.cardId}:${row.lane}`);
            if (draft.dailyLaneClaims.has(k)) return false;
            draft.dailyLaneClaims.set(k, structuredClone(row));
            return true;
          },
          getProjection: (workspace, name) => (
            draft.projections.get(key(workspace, name)) || null
          ),
          putProjection: (workspace, name, row) => {
            draft.projections.set(key(workspace, name), structuredClone(row));
          },
          getDailyCardClaim: (workspace, dayKey, cardId) => (
            draft.dailyCardClaims.get(key(workspace, `${dayKey}:${cardId}`)) || null
          ),
          addDailyCardClaim: (workspace, row) => {
            const k = key(workspace, `${row.dayKey}:${row.cardId}`);
            if (draft.dailyCardClaims.has(k)) return false;
            draft.dailyCardClaims.set(k, structuredClone(row));
            return true;
          },
          getAttemptPhaseClaim: (workspace, attemptId, phase) => (
            draft.attemptPhaseClaims.get(key(workspace, `${attemptId}:${phase}`)) || null
          ),
          addAttemptPhaseClaim: (workspace, row) => {
            const k = key(workspace, `${row.attemptId}:${row.phase}`);
            if (draft.attemptPhaseClaims.has(k)) return false;
            draft.attemptPhaseClaims.set(k, structuredClone(row));
            return true;
          },
          putOutbox: (workspace, eventId, row) => {
            const k = key(workspace, eventId);
            if (draft.outbox.has(k)) throw new Error('outbox duplicate');
            draft.outbox.set(k, structuredClone(row));
          },
        };
        const result = await work(tx);
        if (this.failBeforeCommit) throw new Error('simulated transaction abort');
        for (const store of Object.keys(data)) data[store] = draft[store];
        return result;
      } finally {
        releaseTransaction();
      }
    },
  };
}

const options = {
  workspaceId: 'user:A',
  now: Date.parse('2026-08-24T10:00:00.000Z'),
  createId: () => IDs.eventId,
  deviceId: 'workspace-installation-A',
};

test('Sweep commits event and outbox atomically without touching SRS', async () => {
  const port = transactionalPort();
  const result = await commitPracticeAttempt({ port, attempt: attempt(), ...options });
  assert.equal(result.status, 'committed');
  assert.equal(port.data.events.size, 1);
  assert.equal(port.data.outbox.size, 1);
  assert.equal(port.data.srs.size, 0);
  assert.equal(port.data.dailyCardClaims.size, 1);
  assert.equal(port.data.dailyLaneClaims.size, 1);
  assert.equal(port.data.attemptPhaseClaims.size, 1);
  assert.equal('workspaceId' in result.event, false);
});

test('Due first atomically claims the day and advances SRS exactly one version', async () => {
  const port = transactionalPort();
  const result = await commitPracticeAttempt({
    port,
    attempt: attempt({ lane: 'due', result: 'success', formalGrade: 'good' }),
    ...options,
  });
  assert.equal(result.status, 'committed');
  assert.equal(result.event.srsBeforeVersion, 0);
  assert.equal(result.event.srsAfterVersion, 1);
  assert.equal('deviceId' in result.event.srsAfter, false);
  assert.equal(result.srs.deviceId, 'workspace-installation-A');
  assert.equal(port.data.events.size, 1);
  assert.equal(port.data.outbox.size, 1);
  assert.equal(port.data.srs.size, 1);
  assert.equal(port.data.dailyCardClaims.size, 1);
  assert.equal(port.data.dailyLaneClaims.size, 0, '正式 Due 不再寫第二道 lane claim');
  const srsRow = [...port.data.srs.values()][0];
  assert.equal(srsRow.state.deviceId, 'workspace-installation-A');
  const outboxRow = [...port.data.outbox.values()][0];
  for (const ownershipField of ['deviceId', 'installationId', 'workspaceId', 'userId']) {
    assert.equal(ownershipField in result.event.srsAfter, false);
    assert.equal(ownershipField in outboxRow.event.srsAfter, false);
  }
});

test('same event ID is idempotent but a different payload is rejected', async () => {
  const port = transactionalPort();
  const input = { port, attempt: attempt(), ...options };
  await commitPracticeAttempt(input);
  const repeated = await commitPracticeAttempt(input);
  assert.equal(repeated.status, 'already-committed');
  assert.equal(port.data.events.size, 1);
  assert.equal(port.data.outbox.size, 1);
  await assert.rejects(
    commitPracticeAttempt({ ...input, attempt: attempt({ result: 'failure' }) }),
    error => error.code === 'EVENT_ID_COLLISION',
  );
});

test('exact same non-Due payload replay returns the original event without new writes', async () => {
  const port = transactionalPort();
  const exactAttempt = attempt({ occurredAt: '2026-08-24T10:00:00.000Z' });
  const first = await commitPracticeAttempt({ port, attempt: exactAttempt, ...options });
  const replay = await commitPracticeAttempt({ port, attempt: exactAttempt, ...options });
  assert.equal(first.status, 'committed');
  assert.equal(replay.status, 'already-committed');
  assert.deepEqual(replay.event, first.event);
  assert.equal(port.data.events.size, 1);
  assert.equal(port.data.outbox.size, 1);
  assert.equal(port.data.attemptPhaseClaims.size, 1);
});

test('caller-supplied derived SRS fields fail closed before any transaction writes', async () => {
  for (const derivedField of ['srsBeforeVersion', 'srsAfterVersion', 'srsAfter']) {
    const port = transactionalPort();
    await assert.rejects(commitPracticeAttempt({
      port,
      attempt: attempt({ [derivedField]: null }),
      ...options,
    }), error => error.code === 'PRACTICE_INPUT_INVALID');
    assert.equal(port.data.events.size, 0);
    assert.equal(port.data.outbox.size, 0);
  }
});

test('identity is snapshotted and canonicalized before transaction keys are chosen', async () => {
  const port = transactionalPort();
  const mutableAttempt = attempt({
    eventId: `  ${IDs.eventId.toUpperCase()}  `,
    roundId: ` ${IDs.roundId.toUpperCase()} `,
    cycleId: ` ${IDs.cycleId.toUpperCase()} `,
    cardId: `  ${IDs.cardId.toUpperCase()}  `,
    attemptId: IDs.attemptId.toUpperCase(),
    dayKey: '  2026-08-24  ',
    lane: 'due',
    formalGrade: 'good',
  });
  const pending = commitPracticeAttempt({
    port,
    attempt: mutableAttempt,
    ...options,
  });
  mutableAttempt.cardId = '99999999-9999-4999-8999-999999999999';
  mutableAttempt.dayKey = '2026-08-25';
  const result = await pending;
  assert.equal(result.event.eventId, IDs.eventId);
  assert.equal(result.event.roundId, IDs.roundId);
  assert.equal(result.event.cycleId, IDs.cycleId);
  assert.equal(result.event.cardId, IDs.cardId);
  assert.equal(result.event.attemptId, IDs.attemptId);
  assert.equal(result.event.dayKey, '2026-08-24');
  assert.equal(port.data.srs.has(`user:A:${IDs.cardId}`), true);
  assert.equal(
    port.data.dailyCardClaims.has(`user:A:2026-08-24:${IDs.cardId}`),
    true,
  );
});

test('same formal Due event ID with a changed grade is an event collision', async () => {
  const port = transactionalPort();
  await commitPracticeAttempt({
    port,
    attempt: attempt({ lane: 'due', formalGrade: 'good' }),
    ...options,
  });
  await assert.rejects(commitPracticeAttempt({
    port,
    attempt: attempt({ lane: 'due', formalGrade: 'easy' }),
    ...options,
  }), error => error.code === 'EVENT_ID_COLLISION');
  assert.equal(port.data.events.size, 1);
  assert.equal(port.data.srs.size, 1);
});

test('retry attempt+phase replay with a new event ID returns the original event', async () => {
  const port = transactionalPort();
  const first = await commitPracticeAttempt({
    port,
    attempt: attempt({ phase: 'retry-1' }),
    ...options,
  });
  const replay = await commitPracticeAttempt({
    port,
    attempt: attempt({
      eventId: '66666666-6666-4666-8666-666666666666',
      phase: 'retry-1',
    }),
    ...options,
  });
  assert.equal(first.status, 'committed');
  assert.equal(replay.status, 'already-committed');
  assert.equal(replay.event.eventId, IDs.eventId);
  assert.equal(port.data.events.size, 1);
  assert.equal(port.data.outbox.size, 1);
  assert.equal(port.data.attemptPhaseClaims.size, 1);
});

test('retry attempt+phase replay with another payload is an explicit collision', async () => {
  const port = transactionalPort();
  await commitPracticeAttempt({
    port,
    attempt: attempt({ phase: 'retry-1' }),
    ...options,
  });
  await assert.rejects(commitPracticeAttempt({
    port,
    attempt: attempt({
      eventId: '66666666-6666-4666-8666-666666666666',
      phase: 'retry-1',
      result: 'failure',
    }),
    ...options,
  }), error => error.code === 'ATTEMPT_PHASE_COLLISION');
  assert.equal(port.data.events.size, 1);
  assert.equal(port.data.outbox.size, 1);
});

test('concurrent retry claims commit exactly one event and outbox row', async () => {
  const port = transactionalPort();
  const attempts = [IDs.eventId, '66666666-6666-4666-8666-666666666666'].map(eventId => (
    commitPracticeAttempt({
      port,
      attempt: attempt({ eventId, phase: 'retry-2' }),
      ...options,
    })
  ));
  const results = await Promise.all(attempts);
  assert.deepEqual(results.map(result => result.status).sort(), [
    'already-committed', 'committed',
  ]);
  assert.equal(port.data.events.size, 1);
  assert.equal(port.data.outbox.size, 1);
  assert.equal(port.data.attemptPhaseClaims.size, 1);
});

test('同日同卡的第二筆 Due 不產生 event、outbox 或 SRS（R3 由 daily-card claim 擋下）', async () => {
  const port = transactionalPort();
  await commitPracticeAttempt({
    port,
    attempt: attempt({ lane: 'due', formalGrade: 'good' }),
    ...options,
  });
  const second = await commitPracticeAttempt({
    port,
    attempt: attempt({
      eventId: '66666666-6666-4666-8666-666666666666',
      attemptId: '77777777-7777-4777-8777-777777777777',
      lane: 'due', formalGrade: 'easy',
    }),
    ...options,
    createId: () => '66666666-6666-4666-8666-666666666666',
  });
  assert.equal(second.status, 'daily-card-already-claimed');
  assert.equal(port.data.events.size, 1);
  assert.equal(port.data.outbox.size, 1);
  assert.equal(port.data.srs.size, 1);
});

test('same card/lane/day first is deduped while retry phases remain allowed', async () => {
  const port = transactionalPort();
  await commitPracticeAttempt({ port, attempt: attempt(), ...options });
  const duplicateFirst = await commitPracticeAttempt({
    port,
    attempt: attempt({
      eventId: '66666666-6666-4666-8666-666666666666',
      attemptId: '77777777-7777-4777-8777-777777777777',
    }),
    ...options,
  });
  assert.equal(duplicateFirst.status, 'daily-card-already-claimed');

  const retry = await commitPracticeAttempt({
    port,
    attempt: attempt({
      eventId: '88888888-8888-4888-8888-888888888888',
      phase: 'retry-1', result: 'success',
    }),
    ...options,
  });
  assert.equal(retry.status, 'committed');
  assert.equal(port.data.events.size, 2);
});

test('transaction abort leaves no half-written Due claim, event, SRS, or outbox', async () => {
  const port = transactionalPort({ failBeforeCommit: true });
  await assert.rejects(commitPracticeAttempt({
    port,
    attempt: attempt({ lane: 'due', formalGrade: 'hard', result: 'partial' }),
    ...options,
  }), /simulated transaction abort/);
  assert.deepEqual(Object.fromEntries(
    Object.entries(port.data).map(([name, store]) => [name, store.size]),
  ), {
    events: 0,
    srs: 0,
    dailyLaneClaims: 0,
    dailyCardClaims: 0,
    attemptPhaseClaims: 0,
    outbox: 0,
    projections: 0,
  });
});

test('retry and non-Due lanes never update SRS even when a formalGrade is supplied', async () => {
  const port = transactionalPort();
  await assert.rejects(commitPracticeAttempt({
    port,
    attempt: attempt({ lane: 'weak', phase: 'retry-1', formalGrade: 'good' }),
    ...options,
  }), /only formal Due first/);
  assert.equal(port.data.srs.size, 0);
});

test('formal Due refuses device-global fallback when workspace installation ID is missing', async () => {
  const port = transactionalPort();
  await assert.rejects(commitPracticeAttempt({
    ...options,
    port,
    deviceId: '',
    attempt: attempt({ lane: 'due', formalGrade: 'good' }),
  }), error => error.code === 'PRACTICE_INPUT_INVALID');
  assert.equal(port.data.events.size, 0);
  assert.equal(port.data.srs.size, 0);
});

const OTHER = {
  eventId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  roundId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  cycleId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  attemptId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
};

test('first attempt 立起跨 lane 的 daily-card claim，並保存完整 attempt context', async () => {
  const port = transactionalPort();
  const result = await commitPracticeAttempt({
    port, workspaceId: 'user:A', createId: () => IDs.eventId, deviceId: 'device-1',
    attempt: attempt({ lane: 'sweep' }),
  });

  assert.equal(result.status, 'committed');
  const claim = port.data.dailyCardClaims.get('user:A:2026-08-24:' + IDs.cardId);
  assert.equal(claim.lane, 'sweep');
  assert.equal(claim.attemptId, IDs.attemptId);
  assert.equal(claim.roundId, IDs.roundId);
  assert.equal(claim.cycleId, IDs.cycleId);
  assert.equal(claim.cycleOrdinal, 1);
  assert.equal(claim.eventId, IDs.eventId);
});

test('Today 與 All 同時評同一張卡：只成立一筆 first，另一筆拿到既有 context', async () => {
  // AE3。dailyCardClaims 的 key 不含 lane，所以 All 的 sweep 也擋得住 Today 的 due。
  const port = transactionalPort();
  const [today, all] = await Promise.all([
    commitPracticeAttempt({
      port, workspaceId: 'user:A', createId: () => IDs.eventId, deviceId: 'device-1',
      attempt: attempt({ lane: 'due', formalGrade: 'good' }),
    }),
    commitPracticeAttempt({
      port, workspaceId: 'user:A', createId: () => OTHER.eventId, deviceId: 'device-1',
      attempt: attempt({ ...OTHER, lane: 'sweep' }),
    }),
  ]);

  const statuses = [today.status, all.status].sort();
  assert.deepEqual(statuses, ['committed', 'daily-card-already-claimed']);
  assert.equal(port.data.events.size, 1, '同日同卡只准一筆 first event');
  assert.equal(port.data.dailyCardClaims.size, 1);

  const loser = today.status === 'committed' ? all : today;
  const winner = today.status === 'committed' ? today : all;
  assert.deepEqual(loser.context.phases, ['first']);
  assert.equal(loser.context.lane, winner.event.lane, '輸的那邊要沿用 first 的 lane');
  assert.equal(loser.context.attemptId, winner.event.attemptId);
  assert.equal(loser.context.roundId, winner.event.roundId);
  assert.equal(loser.event, null);
  assert.equal(loser.srs, null);
});

test('拿到既有 context 之後以 retry-1 重送：沿用 first 的 attempt，不再碰 SRS', async () => {
  const port = transactionalPort();
  const first = await commitPracticeAttempt({
    port, workspaceId: 'user:A', createId: () => IDs.eventId, deviceId: 'device-1',
    attempt: attempt({ lane: 'due', formalGrade: 'good' }),
  });
  const srsAfterFirst = structuredClone(port.data.srs.get('user:A:' + IDs.cardId));

  const blocked = await commitPracticeAttempt({
    port, workspaceId: 'user:A', createId: () => OTHER.eventId, deviceId: 'device-1',
    attempt: attempt({ ...OTHER, lane: 'sweep' }),
  });
  const retry = await commitPracticeAttempt({
    port, workspaceId: 'user:A', createId: () => OTHER.eventId, deviceId: 'device-1',
    attempt: attempt({
      eventId: OTHER.eventId,
      cardId: IDs.cardId,
      lane: blocked.context.lane,
      roundId: blocked.context.roundId,
      cycleId: blocked.context.cycleId,
      attemptId: blocked.context.attemptId,
      phase: 'retry-1',
    }),
  });

  assert.equal(retry.status, 'committed');
  assert.equal(retry.event.attemptId, first.event.attemptId, 'retry 沿用 first 的 attempt');
  assert.equal(Object.hasOwn(retry.event, 'srsAfter'), false, 'retry 的 event 不帶 SRS 欄位');
  assert.equal(retry.srs, null);
  assert.deepEqual(port.data.srs.get('user:A:' + IDs.cardId), srsAfterFirst,
    'retry 不得動到 first 寫下的 SRS');
  assert.equal(port.data.dailyCardClaims.size, 1, 'retry 不另立 daily-card claim');
});

test('readPracticeDayContext 從 claim 與已提交的 phase 推出 existingContext', async () => {
  const port = transactionalPort();
  assert.equal(
    await readPracticeDayContext({
      port, workspaceId: 'user:A', dayKey: '2026-08-24', cardId: IDs.cardId,
    }),
    null,
    '還沒人評過就是 null',
  );

  await commitPracticeAttempt({
    port, workspaceId: 'user:A', createId: () => IDs.eventId, deviceId: 'device-1',
    attempt: attempt({ lane: 'due', formalGrade: 'good' }),
  });
  const afterFirst = await readPracticeDayContext({
    port, workspaceId: 'user:A', dayKey: '2026-08-24', cardId: IDs.cardId,
  });
  assert.deepEqual(afterFirst, {
    phases: ['first'],
    lane: 'due',
    roundId: IDs.roundId,
    cycleId: IDs.cycleId,
    cycleOrdinal: 1,
    attemptId: IDs.attemptId,
  });

  await commitPracticeAttempt({
    port, workspaceId: 'user:A', createId: () => OTHER.eventId, deviceId: 'device-1',
    attempt: attempt({ eventId: OTHER.eventId, lane: 'due', phase: 'retry-1' }),
  });
  const afterRetry = await readPracticeDayContext({
    port, workspaceId: 'user:A', dayKey: '2026-08-24', cardId: IDs.cardId,
  });
  assert.deepEqual(afterRetry.phases, ['first', 'retry-1']);
});

test('沿用 v2 的 formal_due_claims：既有的 formal Due 紀錄仍然擋得住同日同卡', async () => {
  /* daily-card claim 的實體 store 就是 v2 就存在的 formal_due_claims（practice-db.js
     裡有說明為什麼要借用它——不借就得動 PRACTICE_DB_VERSION，一動回滾就會壞）。
     所以舊版寫下的 formal Due 紀錄不會變成升級空窗，它直接就是 daily-card claim，
     由外層那道閘門擋下來。保護沒有消失，只是換成外層在擋。 */
  const port = transactionalPort();
  port.data.dailyCardClaims.set(`user:A:2026-08-24:${IDs.cardId}`, {
    workspaceId: 'user:A',
    cardId: IDs.cardId,
    dayKey: '2026-08-24',
    lane: 'due',
    claimKind: 'formal-due',
    attemptId: IDs.attemptId,
    eventId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
  });

  const result = await commitPracticeAttempt({
    port, workspaceId: 'user:A', createId: () => IDs.eventId, deviceId: 'device-1',
    attempt: attempt({ lane: 'due', formalGrade: 'good' }),
  });

  assert.equal(result.status, 'daily-card-already-claimed');
  assert.equal(port.data.events.size, 0);
  assert.equal(port.data.srs.size, 0);
});

function dailyOf(port, workspace = 'user:A', dayKey = '2026-08-24') {
  return port.data.projections.get(`${workspace}:daily:${dayKey}`) || null;
}

test('AE1：Due first 記進 daily projection 的 reviewed 與該 grade，不算 practice', async () => {
  const port = transactionalPort();
  const result = await commitPracticeAttempt({
    port, workspaceId: 'user:A', createId: () => IDs.eventId, deviceId: 'device-1',
    attempt: attempt({ lane: 'due', formalGrade: 'good' }),
  });

  assert.equal(result.status, 'committed');
  const daily = dailyOf(port);
  assert.equal(daily.name, 'daily:2026-08-24');
  assert.equal(daily.projectorVersion, 'practice-daily-v1');
  assert.equal(daily.reviewed, 1);
  assert.equal(daily.good, 1);
  assert.equal(daily.again + daily.hard + daily.easy, 0);
  assert.equal(daily.practice, 0, 'formal Due 不重複算成 practice attendance');
  assert.deepEqual(result.daily, daily, 'commit 要把投影一起回傳');
});

test('AE2：Sweep／Weak 與 All 非 Due 只加 practice attendance，不動 reviewed 或 grade', async () => {
  const port = transactionalPort();
  for (const [index, lane] of ['sweep', 'weak'].entries()) {
    // eslint-disable-next-line no-await-in-loop
    await commitPracticeAttempt({
      port, workspaceId: 'user:A', deviceId: 'device-1',
      createId: () => `0000000${index}-0000-4000-8000-00000000000${index}`,
      attempt: attempt({
        lane,
        eventId: `0000000${index}-0000-4000-8000-00000000000${index}`,
        cardId: `9999999${index}-9999-4999-8999-99999999999${index}`,
        attemptId: `8888888${index}-8888-4888-8888-88888888888${index}`,
      }),
    });
  }

  const daily = dailyOf(port);
  assert.equal(daily.practice, 2);
  assert.equal(daily.reviewed, 0, 'practice 不得冒充正式複習');
  assert.equal(daily.again + daily.hard + daily.good + daily.easy, 0);
  assert.equal(port.data.srs.size, 0);
});

test('retry 也算 practice attendance，但不動 reviewed', async () => {
  const port = transactionalPort();
  await commitPracticeAttempt({
    port, workspaceId: 'user:A', createId: () => IDs.eventId, deviceId: 'device-1',
    attempt: attempt({ lane: 'due', formalGrade: 'easy' }),
  });
  await commitPracticeAttempt({
    port, workspaceId: 'user:A', createId: () => OTHER.eventId, deviceId: 'device-1',
    attempt: attempt({ eventId: OTHER.eventId, lane: 'due', phase: 'retry-1' }),
  });

  const daily = dailyOf(port);
  assert.equal(daily.reviewed, 1, 'retry 不再加一次正式複習');
  assert.equal(daily.easy, 1);
  assert.equal(daily.practice, 1);
});

test('已提交過的 event 重播：回傳同一份投影，計數不重複加', async () => {
  const port = transactionalPort();
  const options = {
    port, workspaceId: 'user:A', createId: () => IDs.eventId, deviceId: 'device-1',
    attempt: attempt({ lane: 'due', formalGrade: 'hard' }),
  };
  const first = await commitPracticeAttempt(options);
  const replay = await commitPracticeAttempt(options);

  assert.equal(replay.status, 'already-committed');
  assert.deepEqual(replay.daily, first.daily, 'already-committed 要回傳一致的投影');
  assert.equal(dailyOf(port).reviewed, 1);
  assert.equal(dailyOf(port).hard, 1);
});

test('不同日期各自一份 daily projection', async () => {
  const port = transactionalPort();
  await commitPracticeAttempt({
    port, workspaceId: 'user:A', createId: () => IDs.eventId, deviceId: 'device-1',
    attempt: attempt({ lane: 'due', formalGrade: 'good' }),
  });
  await commitPracticeAttempt({
    port, workspaceId: 'user:A', createId: () => OTHER.eventId, deviceId: 'device-1',
    attempt: attempt({ ...OTHER, dayKey: '2026-08-25', lane: 'due', formalGrade: 'again' }),
  });

  assert.equal(dailyOf(port, 'user:A', '2026-08-24').good, 1);
  assert.equal(dailyOf(port, 'user:A', '2026-08-25').again, 1);
  assert.equal(dailyOf(port, 'user:A', '2026-08-25').good, 0);
});

test('搶輸 daily-card claim 的一方也拿得到當下的投影', async () => {
  const port = transactionalPort();
  await commitPracticeAttempt({
    port, workspaceId: 'user:A', createId: () => IDs.eventId, deviceId: 'device-1',
    attempt: attempt({ lane: 'due', formalGrade: 'good' }),
  });
  const blocked = await commitPracticeAttempt({
    port, workspaceId: 'user:A', createId: () => OTHER.eventId, deviceId: 'device-1',
    attempt: attempt({ ...OTHER, lane: 'sweep' }),
  });

  assert.equal(blocked.status, 'daily-card-already-claimed');
  assert.equal(blocked.daily.reviewed, 1);
});

test('舊 projectorVersion 少寫的欄位要補齊，不能累加成 NaN', async () => {
  const port = transactionalPort();
  // 模擬更早的 projector 寫下、還沒有 practice 這欄的那份投影
  port.data.projections.set('user:A:daily:2026-08-24', {
    workspaceId: 'user:A',
    name: 'daily:2026-08-24',
    schemaVersion: 1,
    projectorVersion: 'practice-daily-v0',
    dayKey: '2026-08-24',
    reviewed: 3, again: 0, hard: 1, good: 2, easy: 0,
  });

  const result = await commitPracticeAttempt({
    port, workspaceId: 'user:A', createId: () => IDs.eventId, deviceId: 'device-1',
    attempt: attempt({ lane: 'sweep' }),
  });

  assert.equal(result.daily.practice, 1);
  assert.equal(result.daily.reviewed, 3, '既有計數要留著');
  assert.equal(result.daily.good, 2);
  assert.equal(result.daily.projectorVersion, 'practice-daily-v1');
});

test('未知 schemaVersion 的 daily projection 不硬寫，直接失敗', async () => {
  const port = transactionalPort();
  port.data.projections.set('user:A:daily:2026-08-24', {
    workspaceId: 'user:A', name: 'daily:2026-08-24', schemaVersion: 2, dayKey: '2026-08-24',
  });
  await assert.rejects(commitPracticeAttempt({
    port, workspaceId: 'user:A', createId: () => IDs.eventId, deviceId: 'device-1',
    attempt: attempt({ lane: 'sweep' }),
  }), { code: 'PRACTICE_PROJECTION_INCOMPATIBLE' });
  assert.equal(port.data.events.size, 0, '投影不相容時整筆 transaction 都不留下');
});

function historyOf(port, cardId = IDs.cardId, workspace = 'user:A') {
  return port.data.projections.get(`${workspace}:history:${cardId}`) || null;
}

test('R8：Due first 寫進 history projection，第三欄是 eventId', async () => {
  const port = transactionalPort();
  const result = await commitPracticeAttempt({
    port, workspaceId: 'user:A', createId: () => IDs.eventId, deviceId: 'device-1',
    now: Date.parse('2026-08-24T10:00:00.000Z'),
    attempt: attempt({ lane: 'due', formalGrade: 'hard' }),
  });

  const history = historyOf(port);
  assert.equal(history.projectorVersion, 'practice-history-v1');
  assert.deepEqual(history.entries, [[
    1, Math.round(Date.parse('2026-08-24T10:00:00.000Z') / 1000), IDs.eventId,
  ]], 'hard 的 code 是 1，時間存秒');
  assert.deepEqual(result.history, history);
});

test('R5：Sweep 與 retry 不碰 formal history', async () => {
  const port = transactionalPort();
  await commitPracticeAttempt({
    port, workspaceId: 'user:A', createId: () => IDs.eventId, deviceId: 'device-1',
    attempt: attempt({ lane: 'sweep' }),
  });
  assert.equal(historyOf(port), null, 'sweep 不建 history 投影');

  await commitPracticeAttempt({
    port, workspaceId: 'user:A', createId: () => OTHER.eventId, deviceId: 'device-1',
    attempt: attempt({ eventId: OTHER.eventId, lane: 'sweep', phase: 'retry-1' }),
  });
  assert.equal(historyOf(port), null, 'retry 也不寫');
});

test('R8：同一個 event 重播不重複 append（靠 event-exists 早退，不靠事後去重）', async () => {
  const port = transactionalPort();
  const options = {
    port, workspaceId: 'user:A', createId: () => IDs.eventId, deviceId: 'device-1',
    attempt: attempt({ lane: 'due', formalGrade: 'good' }),
  };
  const first = await commitPracticeAttempt(options);
  const replay = await commitPracticeAttempt(options);

  assert.equal(replay.status, 'already-committed');
  assert.equal(historyOf(port).entries.length, 1);
  assert.deepEqual(replay.history.entries, first.history.entries);
});

test('R8：舊的兩欄 [code, ts] tuple 照收，超過 5 筆丟最舊的', async () => {
  const port = transactionalPort();
  // 別台裝置同步回來的都是兩欄，沒有 eventId
  port.data.projections.set(`user:A:history:${IDs.cardId}`, {
    workspaceId: 'user:A',
    name: `history:${IDs.cardId}`,
    schemaVersion: 1,
    projectorVersion: 'practice-history-v1',
    cardId: IDs.cardId,
    entries: [[0, 1000], [1, 2000], [2, 3000], [3, 4000], [0, 5000]],
  });

  const result = await commitPracticeAttempt({
    port, workspaceId: 'user:A', createId: () => IDs.eventId, deviceId: 'device-1',
    now: Date.parse('2026-08-24T10:00:00.000Z'),
    attempt: attempt({ lane: 'due', formalGrade: 'easy' }),
  });

  const entries = result.history.entries;
  assert.equal(entries.length, 5, '每張卡最多留 5 筆');
  assert.deepEqual(entries[0], [1, 2000], '最舊的那筆被丟掉，其餘兩欄 tuple 原樣保留');
  assert.equal(entries[4][0], 3);
  assert.equal(entries[4][2], IDs.eventId);
});

const RECEIPT = { expectedCardId: IDs.cardId, expectedPosition: 0, catalogDigest: 'sha256:cat-a' };

function resweepOf(port, workspace = 'user:A') {
  return port.data.projections.get(`${workspace}:resweep`) || null;
}

test('R9：帶 receipt 的 sweep 推進游標，並綁住卡片、位置與 catalog digest', async () => {
  const port = transactionalPort();
  const result = await commitPracticeAttempt({
    port, workspaceId: 'user:A', createId: () => IDs.eventId, deviceId: 'device-1',
    attempt: attempt({ lane: 'sweep', resweep: RECEIPT }),
  });

  assert.equal(result.status, 'committed');
  assert.equal(result.resweep.position, 1);
  assert.equal(result.resweep.catalogDigest, 'sha256:cat-a');
  assert.equal(result.resweep.lastCardId, IDs.cardId);
  assert.equal(result.resweep.lastEventId, IDs.eventId);
  assert.equal(resweepOf(port).position, 1);
});

test('R9：receipt 指到別張卡就整筆不落地', async () => {
  const port = transactionalPort();
  await assert.rejects(commitPracticeAttempt({
    port, workspaceId: 'user:A', createId: () => IDs.eventId, deviceId: 'device-1',
    attempt: attempt({
      lane: 'sweep',
      resweep: { ...RECEIPT, expectedCardId: '99999999-9999-4999-8999-999999999999' },
    }),
  }), { code: 'RESWEEP_RECEIPT_CARD_MISMATCH' });
  assert.equal(port.data.events.size, 0, 'event 不能留下來');
  assert.equal(resweepOf(port), null);
});

test('R9：別的 tab 先推過了，位置對不上就不重複推', async () => {
  const port = transactionalPort();
  await commitPracticeAttempt({
    port, workspaceId: 'user:A', createId: () => IDs.eventId, deviceId: 'device-1',
    attempt: attempt({ lane: 'sweep', resweep: RECEIPT }),
  });
  await assert.rejects(commitPracticeAttempt({
    port, workspaceId: 'user:A', createId: () => OTHER.eventId, deviceId: 'device-1',
    attempt: attempt({
      ...OTHER, lane: 'sweep',
      cardId: '99999999-9999-4999-8999-999999999999',
      resweep: { ...RECEIPT, expectedCardId: '99999999-9999-4999-8999-999999999999' },
    }),
  }), { code: 'RESWEEP_RECEIPT_POSITION_STALE' });
  assert.equal(resweepOf(port).position, 1, '游標停在原地');
  assert.equal(port.data.events.size, 1);
});

test('R9：背景換了 catalog，舊 receipt 不套用', async () => {
  const port = transactionalPort();
  await commitPracticeAttempt({
    port, workspaceId: 'user:A', createId: () => IDs.eventId, deviceId: 'device-1',
    attempt: attempt({ lane: 'sweep', resweep: RECEIPT }),
  });
  await assert.rejects(commitPracticeAttempt({
    port, workspaceId: 'user:A', createId: () => OTHER.eventId, deviceId: 'device-1',
    attempt: attempt({
      ...OTHER, lane: 'sweep',
      cardId: '99999999-9999-4999-8999-999999999999',
      resweep: {
        expectedCardId: '99999999-9999-4999-8999-999999999999',
        expectedPosition: 1,
        catalogDigest: 'sha256:cat-b',
      },
    }),
  }), { code: 'RESWEEP_RECEIPT_DIGEST_STALE' });
  assert.equal(resweepOf(port).position, 1);
});

test('R9：retry-limit 可以 ack 游標但不造 event', async () => {
  const port = transactionalPort();
  const acked = await acknowledgeResweepCursor({
    port, workspaceId: 'user:A', receipt: RECEIPT,
  });
  assert.equal(acked.position, 1);
  assert.equal(acked.lastEventId, null, 'ack 不綁 event');
  assert.equal(port.data.events.size, 0);
  assert.equal(port.data.outbox.size, 0);

  await assert.rejects(acknowledgeResweepCursor({
    port, workspaceId: 'user:A', receipt: RECEIPT,
  }), { code: 'RESWEEP_RECEIPT_POSITION_STALE' }, '重播不多推');
  assert.equal(resweepOf(port).position, 1);
});

test('沒帶 receipt 的 attempt 不動游標', async () => {
  const port = transactionalPort();
  const result = await commitPracticeAttempt({
    port, workspaceId: 'user:A', createId: () => IDs.eventId, deviceId: 'device-1',
    attempt: attempt({ lane: 'due', formalGrade: 'good' }),
  });
  assert.equal(result.resweep.position, 0);
  assert.equal(resweepOf(port), null, '沒事就不要寫一份空投影出來');
});

test('resweep receipt 是 caller 的輸入，不得混進 event payload', async () => {
  const port = transactionalPort();
  const result = await commitPracticeAttempt({
    port, workspaceId: 'user:A', createId: () => IDs.eventId, deviceId: 'device-1',
    attempt: attempt({ lane: 'sweep', resweep: RECEIPT }),
  });
  assert.equal(Object.hasOwn(result.event, 'resweep'), false);
  assert.equal(
    Object.hasOwn(port.data.events.get(`user:A:${IDs.eventId}`), 'resweep'),
    false,
  );
});
