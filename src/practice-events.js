/* Immutable practice-event contract.
   Ownership (workspace/user/installation) lives outside the canonical payload,
   so moving a locally confirmed event between an anonymous and account workspace
   never changes its identity. */

import { isStableCardId } from './card-identity.js';

export const PRACTICE_EVENT_PAYLOAD_VERSION = 1;
export const PRACTICE_LANES = Object.freeze(['sweep', 'due', 'weak', 'output']);
export const PRACTICE_PHASES = Object.freeze(['first', 'retry-1', 'retry-2']);
export const PRACTICE_RESULTS = Object.freeze(['success', 'partial', 'failure']);
export const FORMAL_GRADES = Object.freeze(['again', 'hard', 'good', 'easy']);
const CANONICAL_SRS_AFTER_FIELDS = Object.freeze([
  'grade', 'reviewedAt', 'nextReviewAt', 'interval', 'easeFactor', 'reps', 'updatedAt',
]);

function requiredText(value, label) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new TypeError(`${label} is required`);
  }
  return text;
}

function requiredUuid(value, label) {
  const text = requiredText(value, label).toLowerCase();
  if (!isStableCardId(text)) throw new TypeError(`${label} must be a UUID`);
  return text;
}

function oneOf(value, allowed, label) {
  if (!allowed.includes(value)) throw new TypeError(`${label} is invalid`);
  return value;
}

function requiredOrdinal(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return value;
}

function requiredOccurredAt(value) {
  const text = requiredText(value, 'occurredAt');
  if (Number.isNaN(Date.parse(text))) throw new TypeError('occurredAt must be an ISO timestamp');
  return text;
}

function requiredDayKey(value) {
  const text = requiredText(value, 'dayKey');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new TypeError('dayKey must be YYYY-MM-DD');
  return text;
}

function canonicalSrsAfter(value) {
  return Object.fromEntries(CANONICAL_SRS_AFTER_FIELDS
    .filter(field => Object.hasOwn(value, field))
    .map(field => [field, structuredClone(value[field])]));
}

export function buildPracticeAttemptEvent({
  eventId,
  roundId,
  cycleId,
  cycleOrdinal,
  cardId,
  dayKey,
  attemptId,
  lane,
  phase,
  result,
  occurredAt,
  formalGrade = null,
  srsBeforeVersion = null,
  srsAfterVersion = null,
  srsAfter = null,
} = {}) {
  const normalizedLane = oneOf(lane, PRACTICE_LANES, 'lane');
  const normalizedPhase = oneOf(phase, PRACTICE_PHASES, 'phase');
  const isFormalDue = normalizedLane === 'due' && normalizedPhase === 'first';

  if (isFormalDue) {
    oneOf(formalGrade, FORMAL_GRADES, 'formalGrade');
    if (!Number.isSafeInteger(srsBeforeVersion) || srsBeforeVersion < 0) {
      throw new TypeError('srsBeforeVersion must be a non-negative integer');
    }
    if (srsAfterVersion !== srsBeforeVersion + 1) {
      throw new TypeError('srsAfterVersion must advance exactly once');
    }
    if (!srsAfter || typeof srsAfter !== 'object' || Array.isArray(srsAfter)) {
      throw new TypeError('srsAfter is required for formal Due first');
    }
  } else if (formalGrade !== null || srsBeforeVersion !== null
      || srsAfterVersion !== null || srsAfter !== null) {
    throw new TypeError('only formal Due first may carry SRS fields');
  }

  const event = {
    eventId: requiredUuid(eventId, 'eventId'),
    eventKind: 'practice-attempt',
    payloadVersion: PRACTICE_EVENT_PAYLOAD_VERSION,
    roundId: requiredUuid(roundId, 'roundId'),
    cycleId: requiredUuid(cycleId, 'cycleId'),
    cycleOrdinal: requiredOrdinal(cycleOrdinal, 'cycleOrdinal'),
    cardId: requiredUuid(cardId, 'cardId'),
    dayKey: requiredDayKey(dayKey),
    attemptId: requiredUuid(attemptId, 'attemptId'),
    lane: normalizedLane,
    phase: normalizedPhase,
    result: oneOf(result, PRACTICE_RESULTS, 'result'),
    occurredAt: requiredOccurredAt(occurredAt),
  };
  if (isFormalDue) {
    event.formalGrade = formalGrade;
    event.srsBeforeVersion = srsBeforeVersion;
    event.srsAfterVersion = srsAfterVersion;
    event.srsAfter = canonicalSrsAfter(srsAfter);
  }
  return Object.freeze(event);
}

function normalizeJson(value) {
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, normalizeJson(value[key])]));
  }
  return value;
}

export function canonicalEventJson(event) {
  return JSON.stringify(normalizeJson(event));
}

export function samePracticeEvent(left, right) {
  return canonicalEventJson(left) === canonicalEventJson(right);
}
