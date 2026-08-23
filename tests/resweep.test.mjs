import assert from 'node:assert/strict';
import test from 'node:test';

const stored = new Map();
globalThis.localStorage = {
  getItem(key) { return stored.get(key) ?? null; },
  setItem(key, value) { stored.set(key, value); },
  removeItem(key) { stored.delete(key); },
};

const { loadResweepState, pickResweepBatch, advanceResweepCursor, resweepProgress } = await import('../src/resweep.js');

test('loadResweepState defaults to position 0 when nothing stored', () => {
  stored.clear();
  assert.deepEqual(loadResweepState(), { startedAt: null, position: 0 });
});

test('pickResweepBatch slices from the current position, in the given order', () => {
  stored.clear();
  const cards = [{ thai: 'a' }, { thai: 'b' }, { thai: 'c' }, { thai: 'd' }];
  assert.deepEqual(pickResweepBatch(cards, 2).map(c => c.thai), ['a', 'b']);

  advanceResweepCursor(2, cards.length);
  assert.deepEqual(pickResweepBatch(cards, 2).map(c => c.thai), ['c', 'd']);
});

test('pickResweepBatch returns empty once the cursor reaches the end', () => {
  stored.clear();
  const cards = [{ thai: 'a' }, { thai: 'b' }];
  advanceResweepCursor(2, cards.length);
  assert.deepEqual(pickResweepBatch(cards, 5), []);
});

test('pickResweepBatch never filters past an unconfirmed card', () => {
  stored.clear();
  const cards = [{ thai: 'a' }, { thai: 'blocked' }, { thai: 'later' }];

  // The caller cannot prove that the cursor card was eligible.  A later card
  // must not be returned as a substitute, or grading it would skip "blocked".
  assert.deepEqual(
    pickResweepBatch(cards, cards.length, card => card.thai !== 'blocked'),
    [{ thai: 'a' }],
  );
  assert.equal(loadResweepState().position, 0);

  // Only a separately confirmed prefix may move the position.
  advanceResweepCursor(1, cards.length);
  assert.equal(loadResweepState().position, 1);
  assert.deepEqual(
    pickResweepBatch(cards, cards.length, card => card.thai !== 'blocked'),
    [],
  );
});

test('advanceResweepCursor clamps to total and records startedAt once', () => {
  stored.clear();
  const s1 = advanceResweepCursor(3, 5);
  assert.equal(s1.position, 3);
  assert.ok(s1.startedAt > 0);

  const s2 = advanceResweepCursor(10, 5);
  assert.equal(s2.position, 5); // clamped, not 13
  assert.equal(s2.startedAt, s1.startedAt); // 不會被第二次呼叫覆蓋
});

test('resweepProgress reports position/total/done', () => {
  stored.clear();
  assert.deepEqual(resweepProgress(10), { position: 0, total: 10, done: false });
  advanceResweepCursor(10, 10);
  assert.deepEqual(resweepProgress(10), { position: 10, total: 10, done: true });
});
