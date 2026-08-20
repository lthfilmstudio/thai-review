import assert from 'node:assert/strict';
import test from 'node:test';

const stored = new Map();
globalThis.localStorage = {
  getItem(key) { return stored.get(key) ?? null; },
  setItem(key, value) { stored.set(key, value); },
  removeItem(key) { stored.delete(key); },
};

const { buildListenChallenge } = await import('../src/game-listen.js');

function seqRng(seq) {
  let i = 0;
  return () => seq[i++ % seq.length];
}

function makeLesson(n) {
  return {
    id: 'L1',
    cards: Array.from({ length: n }, (_, i) => ({ thai: `t${i}`, zh: `zh${i}` })),
  };
}

test('prefers new cards (no progress entry) over already-learned cards', () => {
  const lesson = makeLesson(10);
  const progress = {
    'L1:t0': { grade: 'good' },
    'L1:t1': { grade: 'good' },
    'L1:t2': { grade: 'good' },
  };
  const q = buildListenChallenge(lesson, progress, { count: 5 });
  assert.equal(q.length, 5);
  const usedThai = q.map(x => x.card.thai);
  // 7 張新卡，5 題應該全部來自新卡（t3..t9），一張已學過的卡（t0/t1/t2）都不用
  for (const t of usedThai) assert.ok(!['t0', 't1', 't2'].includes(t));
});

test('falls back to learned cards when not enough new cards', () => {
  const lesson = makeLesson(4);
  const progress = {
    'L1:t0': { grade: 'good' },
    'L1:t1': { grade: 'good' },
    'L1:t2': { grade: 'good' },
  };
  // 只有 t3 是新卡，湊 5 題必須補已學過的
  const q = buildListenChallenge(lesson, progress, { count: 5 });
  assert.equal(q.length, 4); // 總共只有 4 張候選卡
  const usedThai = q.map(x => x.card.thai).sort();
  assert.deepEqual(usedThai, ['t0', 't1', 't2', 't3']);
});

test('each question has exactly 4 options and the answer index points at the correct zh', () => {
  const lesson = makeLesson(10);
  const q = buildListenChallenge(lesson, {}, { count: 5 });
  for (const item of q) {
    assert.equal(item.options.length, 4);
    assert.equal(item.options[item.answerIndex], item.card.zh);
  }
});

test('distractors never share zh with the correct answer (no synonym confusion)', () => {
  const lesson = {
    id: 'L1',
    cards: [
      { thai: 'a', zh: '同義' },
      { thai: 'b', zh: '同義' }, // 跟 a 同一個 zh，不該同時出現在 a 的選項裡
      { thai: 'c', zh: '不同1' },
      { thai: 'd', zh: '不同2' },
      { thai: 'e', zh: '不同3' },
    ],
  };
  const q = buildListenChallenge(lesson, {}, { count: 5 });
  const qa = q.find(x => x.card.thai === 'a');
  assert.ok(qa);
  const zhCounts = qa.options.filter(zh => zh === '同義').length;
  assert.equal(zhCounts, 1); // 正解本身那一個，不會多一個重複的干擾項
});

test('does not crash when candidates are fewer than 4 (small lesson)', () => {
  const lesson = makeLesson(2);
  const q = buildListenChallenge(lesson, {}, { count: 5 });
  assert.equal(q.length, 2);
  for (const item of q) {
    assert.ok(item.options.length <= 4);
    assert.ok(item.options.length >= 1);
    assert.equal(item.options[item.answerIndex], item.card.zh);
  }
});

test('cards missing thai or zh are excluded from candidates', () => {
  const lesson = {
    id: 'L1',
    cards: [
      { thai: 'a', zh: '' },
      { thai: '', zh: 'b' },
      { thai: 'c', zh: 'd' },
    ],
  };
  const q = buildListenChallenge(lesson, {}, { count: 5 });
  assert.equal(q.length, 1);
  assert.equal(q[0].card.thai, 'c');
});

test('rng injection makes the result deterministic', () => {
  const lesson = makeLesson(6);
  const rng1 = seqRng([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]);
  const rng2 = seqRng([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]);
  const a = buildListenChallenge(lesson, {}, { count: 3, rng: rng1 });
  const b = buildListenChallenge(lesson, {}, { count: 3, rng: rng2 });
  assert.deepEqual(a.map(x => x.card.thai), b.map(x => x.card.thai));
});
