import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildPracticeAttemptEvent,
  canonicalEventJson,
  samePracticeEvent,
} from '../src/practice-events.js';

const IDs = {
  eventId: '11111111-1111-4111-8111-111111111111',
  roundId: '22222222-2222-4222-8222-222222222222',
  cycleId: '33333333-3333-4333-8333-333333333333',
  cardId: '44444444-4444-4444-8444-444444444444',
  attemptId: '55555555-5555-4555-8555-555555555555',
};

function base(overrides = {}) {
  return {
    ...IDs,
    cycleOrdinal: 1,
    dayKey: '2026-08-24',
    lane: 'sweep',
    phase: 'first',
    result: 'success',
    occurredAt: '2026-08-24T10:00:00.000Z',
    ...overrides,
  };
}

test('canonical practice attempt excludes ownership envelope', () => {
  const event = buildPracticeAttemptEvent({
    ...base(),
    workspaceId: 'user:A',
    userId: 'A',
    installationId: 'device-A',
  });
  assert.equal(event.eventKind, 'practice-attempt');
  assert.equal(event.payloadVersion, 1);
  assert.equal('workspaceId' in event, false);
  assert.equal('userId' in event, false);
  assert.equal('installationId' in event, false);
});

test('only Due first may carry a one-version SRS after-state', () => {
  const srsAfter = {
    grade: 'good',
    interval: 3,
    deviceId: 'workspace-installation-A',
    installationId: 'workspace-installation-A',
    workspaceId: 'user:A',
    userId: 'A',
  };
  const event = buildPracticeAttemptEvent(base({
    lane: 'due', formalGrade: 'good', srsBeforeVersion: 4,
    srsAfterVersion: 5, srsAfter,
  }));
  assert.equal(event.srsAfterVersion, 5);
  assert.notStrictEqual(event.srsAfter, srsAfter);
  assert.deepEqual(event.srsAfter, { grade: 'good', interval: 3 });
  for (const ownershipField of ['deviceId', 'installationId', 'workspaceId', 'userId']) {
    assert.equal(ownershipField in event.srsAfter, false);
  }

  assert.throws(() => buildPracticeAttemptEvent(base({ formalGrade: 'good' })), /only formal Due/);
  assert.throws(() => buildPracticeAttemptEvent(base({
    lane: 'due', formalGrade: 'good', srsBeforeVersion: 4,
    srsAfterVersion: 6, srsAfter,
  })), /advance exactly once/);
});

test('retry phases and fixed enums fail closed', () => {
  assert.equal(buildPracticeAttemptEvent(base({ phase: 'retry-2', result: 'failure' })).phase, 'retry-2');
  assert.throws(() => buildPracticeAttemptEvent(base({ phase: 'retry-3' })), /phase is invalid/);
  assert.throws(() => buildPracticeAttemptEvent(base({ lane: 'game' })), /lane is invalid/);
  assert.throws(() => buildPracticeAttemptEvent(base({ cardId: 'legacy:thai' })), /cardId must be a UUID/);
});

test('canonical JSON is stable across object key order and detects payload drift', () => {
  const event = buildPracticeAttemptEvent(base());
  const reordered = Object.fromEntries(Object.entries(event).reverse());
  assert.equal(canonicalEventJson(event), canonicalEventJson(reordered));
  assert.equal(samePracticeEvent(event, reordered), true);
  assert.equal(samePracticeEvent(event, { ...event, result: 'partial' }), false);
});
