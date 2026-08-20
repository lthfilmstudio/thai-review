import assert from 'node:assert/strict';
import test from 'node:test';

globalThis.localStorage = {
  getItem() { return null; },
  setItem() {},
  removeItem() {},
};

const {
  buildDialogueRound,
  playDialogueTurns,
} = await import('../src/game-dialogue.js');

function scenario(id, title = `情境 ${id}`) {
  return {
    id,
    title,
    turns: Array.from({ length: 6 }, (_, index) => ({
      order: index + 1,
      speaker: index % 2 ? 'B' : 'A',
      thai: `${id}-thai-${index + 1}`,
      karaoke: `${id}-karaoke-${index + 1}`,
      zh: `${id}-zh-${index + 1}`,
    })),
  };
}

test('buildDialogueRound picks one complete 6-turn A/B scenario', () => {
  const round = buildDialogueRound([scenario('D01'), scenario('D02')], { rng: () => 0.99 });
  assert.equal(round.id, 'D02');
  assert.equal(round.turns.length, 6);
  assert.deepEqual(round.turns.map(turn => turn.speaker), ['A', 'B', 'A', 'B', 'A', 'B']);
});

test('buildDialogueRound excludes malformed scenarios and can avoid the previous id', () => {
  const malformed = { ...scenario('bad'), turns: scenario('bad').turns.slice(0, 5) };
  const round = buildDialogueRound([malformed, scenario('D01'), scenario('D02')], {
    excludeId: 'D01',
    rng: () => 0,
  });
  assert.equal(round.id, 'D02');
  assert.equal(buildDialogueRound([malformed]), null);
});

test('playDialogueTurns awaits all six lines in order', async () => {
  const played = [];
  await playDialogueTurns(scenario('D01'), async turn => {
    played.push(turn.order);
  });
  assert.deepEqual(played, [1, 2, 3, 4, 5, 6]);
});

test('playDialogueTurns stops before the next line after cancellation', async () => {
  const played = [];
  let active = true;
  const completed = await playDialogueTurns(
    scenario('D01'),
    async turn => {
      played.push(turn.order);
      active = false;
    },
    () => active,
  );
  assert.equal(completed, false);
  assert.deepEqual(played, [1]);
});
