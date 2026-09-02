import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildPracticeRuntimeAttempt,
  capturePracticeOperation,
  classifyPracticeLane,
  gradeToPracticeResult,
  operationStillCurrent,
  resolvePracticePhase,
} from '../src/practice-runtime.js';

const IDS = {
  cardId: '11111111-1111-4111-8111-111111111111',
  roundId: '22222222-2222-4222-8222-222222222222',
  cycleId: '33333333-3333-4333-8333-333333333333',
  attemptId: '44444444-4444-4444-8444-444444444444',
};

function base(overrides = {}) {
  return {
    currentLessonId: '__TODAY__',
    card: { card_id: IDS.cardId, _cardKey: 'L1:\u0e44\u0e17\u0e22' },
    cardKey: 'L1:\u0e44\u0e17\u0e22',
    todayLaneByCardKey: new Map([['L1:\u0e44\u0e17\u0e22', 'due']]),
    grade: 'good',
    dayKey: '2026-09-02',
    runtimeContext: {
      roundId: IDS.roundId,
      cycleId: IDS.cycleId,
      cycleOrdinal: 1,
    },
    createId: () => IDS.attemptId,
    ...overrides,
  };
}

test('maps four formal grades to practice results and rejects unknown grades', () => {
  assert.equal(gradeToPracticeResult('again'), 'failure');
  assert.equal(gradeToPracticeResult('hard'), 'partial');
  assert.equal(gradeToPracticeResult('good'), 'success');
  assert.equal(gradeToPracticeResult('easy'), 'success');
  assert.throws(() => gradeToPracticeResult('ok'), error => error.code === 'PRACTICE_GRADE_INVALID');
});

test('classifies Today from the immutable queue lane snapshot, with Due winning overlap', () => {
  for (const lane of ['due', 'sweep', 'weak']) {
    assert.equal(classifyPracticeLane({
      currentLessonId: '__TODAY__',
      cardKey: 'L1:x',
      todayLaneByCardKey: new Map([['L1:x', lane]]),
      resweepKeys: lane === 'due' ? new Set(['L1:x']) : new Set(),
    }), lane);
  }
  assert.equal(classifyPracticeLane({
    currentLessonId: '__TODAY__',
    cardKey: 'L1:x',
    todayLaneByCardKey: { 'L1:x': 'due' },
    resweepKeys: new Set(['L1:x']),
  }), 'due');
});

test('classifies All from an audited authoritative baseline and fails closed without it', () => {
  const now = 1_000;
  assert.equal(classifyPracticeLane({
    currentLessonId: '__ALL__', now,
    authoritativeSrs: { status: 'ready', state: { nextReviewAt: now } },
  }), 'due');
  assert.equal(classifyPracticeLane({
    currentLessonId: '__ALL__', now,
    authoritativeSrs: { status: 'ready', state: { nextReviewAt: now + 1 } },
  }), 'sweep');
  assert.equal(classifyPracticeLane({
    currentLessonId: '__ALL__', now,
    authoritativeSrs: { status: 'ready', state: null },
  }), 'sweep');
  assert.throws(() => classifyPracticeLane({
    currentLessonId: '__ALL__', now, authoritativeSrs: null,
  }), error => error.code === 'PRACTICE_BASELINE_NOT_READY');
});

test('rejects non-ledger lessons and missing Today queue evidence', () => {
  assert.throws(() => classifyPracticeLane({ currentLessonId: 'L1' }), error => (
    error.code === 'PRACTICE_CONTEXT_INELIGIBLE'
  ));
  assert.throws(() => classifyPracticeLane({
    currentLessonId: '__TODAY__', cardKey: 'L1:x', todayLaneByCardKey: new Map(),
  }), error => error.code === 'PRACTICE_LANE_UNRESOLVED');
});

test('phase resolver reuses first context across entry points and stops at retry-limit', () => {
  const firstContext = {
    ...IDS,
    lane: 'due',
    cycleOrdinal: 1,
    phases: ['first'],
  };
  const retry1 = resolvePracticePhase({ existingContext: firstContext, candidateLane: 'sweep' });
  assert.deepEqual(retry1, {
    phase: 'retry-1',
    lane: 'due',
    roundId: IDS.roundId,
    cycleId: IDS.cycleId,
    cycleOrdinal: 1,
    attemptId: IDS.attemptId,
  });
  assert.equal(resolvePracticePhase({
    existingContext: { ...firstContext, phases: ['first', 'retry-1'] },
    candidateLane: 'weak',
  }).phase, 'retry-2');
  assert.equal(resolvePracticePhase({
    existingContext: { ...firstContext, phases: ['first', 'retry-1', 'retry-2'] },
    candidateLane: 'sweep',
  }).phase, 'retry-limit');
});

test('new first uses supplied round/cycle and creates one stable attempt id', () => {
  assert.deepEqual(resolvePracticePhase({
    candidateLane: 'weak',
    runtimeContext: {
      roundId: IDS.roundId,
      cycleId: IDS.cycleId,
      cycleOrdinal: 1,
    },
    createId: () => IDS.attemptId,
  }), {
    phase: 'first',
    lane: 'weak',
    roundId: IDS.roundId,
    cycleId: IDS.cycleId,
    cycleOrdinal: 1,
    attemptId: IDS.attemptId,
  });
});

test('builds formal fields only for Due first and rejects missing or ambiguous identity', () => {
  const formal = buildPracticeRuntimeAttempt(base());
  assert.equal(formal.formalGrade, 'good');
  assert.equal(formal.lane, 'due');
  assert.equal(formal.phase, 'first');
  assert.equal(formal.result, 'success');
  assert.equal(Object.isFrozen(formal), true);

  const retry = buildPracticeRuntimeAttempt(base({
    currentLessonId: '__ALL__',
    authoritativeSrs: { status: 'ready', state: { nextReviewAt: 0 } },
    existingContext: {
      ...IDS, lane: 'due', cycleOrdinal: 1, phases: ['first'],
    },
  }));
  assert.equal(retry.phase, 'retry-1');
  assert.equal(retry.formalGrade, null);

  assert.throws(() => buildPracticeRuntimeAttempt(base({
    card: { _cardKey: 'L1:x' },
  })), error => error.code === 'PRACTICE_CARD_ID_UNRESOLVED');
  assert.throws(() => buildPracticeRuntimeAttempt(base({
    identityResolution: {
      status: 'quarantine', reason: 'ambiguous_legacy_alias', candidates: [IDS.cardId],
    },
  })), error => error.code === 'PRACTICE_CARD_ID_AMBIGUOUS');
});

test('retry-limit returns a non-event decision with the original context', () => {
  const decision = buildPracticeRuntimeAttempt(base({
    existingContext: {
      ...IDS, lane: 'due', cycleOrdinal: 1,
      phases: ['first', 'retry-1', 'retry-2'],
    },
  }));
  assert.equal(decision.kind, 'retry-limit');
  assert.equal(decision.attemptId, IDS.attemptId);
  assert.equal('formalGrade' in decision, false);
});

test('operation snapshot is immutable and detects card, epoch, workspace, and digest drift', () => {
  const current = {
    workspaceId: 'user:A',
    workspaceGeneration: 3,
    cardId: IDS.cardId,
    currentLessonId: '__TODAY__',
    mode: 'card',
    contextEpoch: 7,
    catalogDigest: 'sha256:catalog-a',
    attemptId: IDS.attemptId,
  };
  const operation = capturePracticeOperation(current);
  assert.equal(Object.isFrozen(operation), true);
  assert.equal(operationStillCurrent(operation, { ...current }), true);
  for (const drift of [
    { cardId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    { contextEpoch: 8 },
    { workspaceGeneration: 4 },
    { catalogDigest: 'sha256:catalog-b' },
  ]) {
    assert.equal(operationStillCurrent(operation, { ...current, ...drift }), false);
  }
});
