/* Pure runtime adapter for ledger-eligible grading.
   This module deliberately has no DOM, storage, IndexedDB, or network access. */

import { cardIdOf, isStableCardId } from './card-identity.js';

const LEDGER_LESSONS = Object.freeze(['__TODAY__', '__ALL__']);
const RUNTIME_LANES = Object.freeze(['due', 'sweep', 'weak']);
const FORMAL_GRADES = Object.freeze(['again', 'hard', 'good', 'easy']);
const RESULT_BY_GRADE = Object.freeze({
  again: 'failure',
  hard: 'partial',
  good: 'success',
  easy: 'success',
});
const PHASE_PREFIX = Object.freeze(['first', 'retry-1', 'retry-2']);
const OPERATION_FIELDS = Object.freeze([
  'workspaceId',
  'workspaceGeneration',
  'cardId',
  'currentLessonId',
  'mode',
  'contextEpoch',
  'catalogDigest',
  'attemptId',
]);

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requiredText(value, label, code = 'PRACTICE_CONTEXT_INVALID') {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || /[\u0000-\u001f\u007f]/.test(text)) throw codedError(code, `${label} is required`);
  return text;
}

function requiredUuid(value, label) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!isStableCardId(text)) throw codedError('PRACTICE_CONTEXT_INVALID', `${label} must be a UUID`);
  return text;
}

function requiredLane(value) {
  if (!RUNTIME_LANES.includes(value)) {
    throw codedError('PRACTICE_LANE_UNRESOLVED', 'runtime lane must be due, sweep, or weak');
  }
  return value;
}

function requiredCycleOrdinal(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw codedError('PRACTICE_CONTEXT_INVALID', 'cycleOrdinal must be a positive integer');
  }
  return value;
}

function laneFromSnapshot(snapshot, cardKey) {
  if (snapshot instanceof Map) return snapshot.get(cardKey);
  if (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)) {
    return snapshot[cardKey];
  }
  return undefined;
}

function canonicalExistingPhases(phases) {
  if (!Array.isArray(phases) || phases.length < 1 || phases.length > PHASE_PREFIX.length) {
    throw codedError('PRACTICE_CONTEXT_INVALID', 'existing attempt phases are invalid');
  }
  for (let index = 0; index < phases.length; index += 1) {
    if (phases[index] !== PHASE_PREFIX[index]) {
      throw codedError('PRACTICE_CONTEXT_INVALID', 'existing attempt phases must be contiguous');
    }
  }
  return phases;
}

function canonicalAttemptContext(context, phase) {
  return Object.freeze({
    phase,
    lane: requiredLane(context.lane),
    roundId: requiredUuid(context.roundId, 'roundId'),
    cycleId: requiredUuid(context.cycleId, 'cycleId'),
    cycleOrdinal: requiredCycleOrdinal(context.cycleOrdinal),
    attemptId: requiredUuid(context.attemptId, 'attemptId'),
  });
}

function runtimeCardId(card, identityResolution) {
  if (identityResolution != null) {
    if (identityResolution?.status !== 'resolved') {
      throw codedError(
        'PRACTICE_CARD_ID_AMBIGUOUS',
        'runtime card identity is quarantined or ambiguous',
      );
    }
    const resolved = requiredUuid(identityResolution.cardId, 'identityResolution.cardId');
    const embedded = cardIdOf(card);
    if (embedded && embedded !== resolved) {
      throw codedError('PRACTICE_CARD_ID_AMBIGUOUS', 'runtime card identity evidence disagrees');
    }
    return resolved;
  }
  const embedded = cardIdOf(card);
  if (!embedded) {
    throw codedError('PRACTICE_CARD_ID_UNRESOLVED', 'runtime card requires a stable card ID');
  }
  return embedded;
}

export function gradeToPracticeResult(grade) {
  if (!FORMAL_GRADES.includes(grade)) {
    throw codedError('PRACTICE_GRADE_INVALID', 'practice grade must be again, hard, good, or easy');
  }
  return RESULT_BY_GRADE[grade];
}

export function classifyPracticeLane({
  currentLessonId,
  cardKey,
  todayLaneByCardKey,
  authoritativeSrs,
  now = Date.now(),
} = {}) {
  if (!LEDGER_LESSONS.includes(currentLessonId)) {
    throw codedError('PRACTICE_CONTEXT_INELIGIBLE', 'only Today and All enter the practice ledger');
  }
  if (!Number.isFinite(now)) {
    throw codedError('PRACTICE_CONTEXT_INVALID', 'now must be finite');
  }

  if (currentLessonId === '__TODAY__') {
    const key = requiredText(cardKey, 'cardKey');
    return requiredLane(laneFromSnapshot(todayLaneByCardKey, key));
  }

  if (authoritativeSrs?.status !== 'ready') {
    throw codedError(
      'PRACTICE_BASELINE_NOT_READY',
      'All cards grading requires an audited authoritative SRS baseline',
    );
  }
  const state = authoritativeSrs.state;
  if (state == null) return 'sweep';
  if (typeof state !== 'object' || Array.isArray(state)) {
    throw codedError('PRACTICE_BASELINE_NOT_READY', 'authoritative SRS state is invalid');
  }
  const nextReviewAt = state.nextReviewAt ?? 0;
  if (!Number.isFinite(nextReviewAt) || nextReviewAt < 0) {
    throw codedError('PRACTICE_BASELINE_NOT_READY', 'authoritative SRS schedule is invalid');
  }
  return nextReviewAt <= now ? 'due' : 'sweep';
}

export function resolvePracticePhase({
  existingContext = null,
  candidateLane,
  runtimeContext,
  createId,
} = {}) {
  if (existingContext) {
    const phases = canonicalExistingPhases(existingContext.phases);
    const phase = phases.length === PHASE_PREFIX.length
      ? 'retry-limit'
      : PHASE_PREFIX[phases.length];
    return canonicalAttemptContext(existingContext, phase);
  }

  const makeId = typeof createId === 'function' ? createId : null;
  if (!makeId) throw codedError('PRACTICE_CONTEXT_INVALID', 'createId is required for a first attempt');
  return canonicalAttemptContext({
    lane: requiredLane(candidateLane),
    roundId: runtimeContext?.roundId,
    cycleId: runtimeContext?.cycleId,
    cycleOrdinal: runtimeContext?.cycleOrdinal,
    attemptId: makeId(),
  }, 'first');
}

export function buildPracticeRuntimeAttempt({
  currentLessonId,
  card,
  cardKey,
  identityResolution = null,
  todayLaneByCardKey,
  authoritativeSrs,
  grade,
  dayKey,
  now = Date.now(),
  existingContext = null,
  runtimeContext,
  createId,
} = {}) {
  const cardId = runtimeCardId(card, identityResolution);
  const normalizedDayKey = requiredText(dayKey, 'dayKey');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedDayKey)) {
    throw codedError('PRACTICE_CONTEXT_INVALID', 'dayKey must be YYYY-MM-DD');
  }
  const candidateLane = classifyPracticeLane({
    currentLessonId,
    cardKey,
    todayLaneByCardKey,
    authoritativeSrs,
    now,
  });
  const context = resolvePracticePhase({
    existingContext,
    candidateLane,
    runtimeContext,
    createId,
  });
  if (context.phase === 'retry-limit') {
    return Object.freeze({ kind: 'retry-limit', cardId, dayKey: normalizedDayKey, ...context });
  }

  gradeToPracticeResult(grade);
  const normalizedGrade = grade;
  const formalGrade = context.lane === 'due' && context.phase === 'first'
    ? normalizedGrade
    : null;
  return Object.freeze({
    kind: 'attempt',
    cardId,
    dayKey: normalizedDayKey,
    ...context,
    result: gradeToPracticeResult(normalizedGrade),
    formalGrade,
  });
}

export function capturePracticeOperation(input = {}) {
  const workspaceId = requiredText(input.workspaceId, 'workspaceId');
  if (!workspaceId.startsWith('anon:') && !workspaceId.startsWith('user:')) {
    throw codedError('PRACTICE_CONTEXT_INVALID', 'workspaceId is invalid');
  }
  if (!Number.isSafeInteger(input.workspaceGeneration) || input.workspaceGeneration < 0
      || !Number.isSafeInteger(input.contextEpoch) || input.contextEpoch < 0) {
    throw codedError('PRACTICE_CONTEXT_INVALID', 'operation generations must be non-negative integers');
  }
  if (!LEDGER_LESSONS.includes(input.currentLessonId)) {
    throw codedError('PRACTICE_CONTEXT_INELIGIBLE', 'operation lesson is not ledger eligible');
  }
  return Object.freeze({
    workspaceId,
    workspaceGeneration: input.workspaceGeneration,
    cardId: requiredUuid(input.cardId, 'cardId'),
    currentLessonId: input.currentLessonId,
    mode: requiredText(input.mode, 'mode'),
    contextEpoch: input.contextEpoch,
    catalogDigest: requiredText(input.catalogDigest, 'catalogDigest'),
    attemptId: requiredUuid(input.attemptId, 'attemptId'),
  });
}

export function operationStillCurrent(operation, current) {
  if (!operation || !current) return false;
  return OPERATION_FIELDS.every(field => operation[field] === current[field]);
}
