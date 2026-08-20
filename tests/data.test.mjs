import assert from 'node:assert/strict';
import test from 'node:test';

const { loadTabsOnly, parseDialogueRows } = await import('../src/data.js');

test('parseDialogueRows groups one complete 6-turn A/B scenario', () => {
  const rows = [['情境 ID', '情境名稱', '順序', '說話者', '泰文', '目的達拼音', '中文']];
  for (let order = 1; order <= 6; order++) {
    rows.push([
      'D01', '初次見面', String(order), order % 2 ? 'A' : 'B',
      `thai-${order}`, `karaoke-${order}`, `zh-${order}`,
    ]);
  }

  const dialogues = parseDialogueRows(rows);
  assert.equal(dialogues.length, 1);
  assert.equal(dialogues[0].id, 'D01');
  assert.equal(dialogues[0].title, '初次見面');
  assert.deepEqual(dialogues[0].turns.map(turn => turn.speaker), ['A', 'B', 'A', 'B', 'A', 'B']);
  assert.equal(dialogues[0].turns[5].zh, 'zh-6');
});

test('parseDialogueRows rejects an incomplete scenario', () => {
  const rows = [
    ['情境 ID', '情境名稱', '順序', '說話者', '泰文', '目的達拼音', '中文'],
    ['D01', '初次見面', '1', 'A', 'thai', 'karaoke', 'zh'],
  ];
  assert.throws(() => parseDialogueRows(rows), /6 句/);
});

test('parseDialogueRows rejects inconsistent scenario titles', () => {
  const rows = [['情境 ID', '情境名稱', '順序', '說話者', '泰文', '目的達拼音', '中文']];
  for (let order = 1; order <= 6; order++) {
    rows.push([
      'D01', order < 6 ? '初次見面' : '另一個名稱', String(order), order % 2 ? 'A' : 'B',
      `thai-${order}`, `karaoke-${order}`, `zh-${order}`,
    ]);
  }
  assert.throws(() => parseDialogueRows(rows), /情境名稱不一致/);
});

test('loadTabsOnly separates the dialogue tab from lesson tabs in one manifest fetch', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount++;
    return {
      ok: true,
      async text() {
        return [
          'items.push({name: "初 1", gid: "101"});',
          'items.push({name: "生活對話", gid: "20260820"});',
        ].join('\n');
      },
    };
  };
  try {
    const manifest = await loadTabsOnly(
      'https://docs.google.com/spreadsheets/d/e/test-published-sheet-id/pubhtml',
    );
    assert.equal(fetchCount, 1);
    assert.deepEqual(manifest.tabs, [{ name: '初 1', gid: '101' }]);
    assert.deepEqual(manifest.dialogueTab, { name: '生活對話', gid: '20260820' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
