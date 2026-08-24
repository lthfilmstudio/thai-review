import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const {
  loadBundledData,
  loadLessons,
  loadPublishedCatalog,
  loadTabsOnly,
  parseDialogueRows,
  rowsToCards,
} = await import('../src/data.js');
const {
  CATALOG_CACHE_SCHEMA,
  LESSONS_CACHE_KEY,
  loadLessonsCache,
  saveLessonsCache,
} = await import('../src/state.js');

const VALID_ID_1 = '550e8400-e29b-41d4-a716-446655440000';
const VALID_ID_2 = '550e8400-e29b-41d4-a716-446655440001';

function csv(cardId, lesson = '') {
  return [
    '中文,泰文,目的達拼音,課程,card_id',
    `你好,สวัสดี,sa wat di,${lesson},${cardId}`,
  ].join('\n');
}

test('rowsToCards keeps optional card_id when present and omits it for legacy headers', () => {
  const rows = [
    ['中文', '泰文', '目的達拼音', 'card_id'],
    ['你好', 'สวัสดี', 'sa wat di', '550e8400-e29b-41d4-a716-446655440000'],
  ];
  assert.equal(rowsToCards(rows)[0].card_id, '550e8400-e29b-41d4-a716-446655440000');
  assert.equal(Object.hasOwn(rowsToCards(rows.slice(0, 1).concat([rows[1].slice(0, 3)]))[0], 'card_id'), false);
});

test('production card parser fails closed on missing, invalid, or duplicate card_id', () => {
  const header = ['中文', '泰文', '目的達拼音', 'card_id'];
  const valid = '550e8400-e29b-41d4-a716-446655440000';
  assert.throws(
    () => rowsToCards([header, ['你好', 'สวัสดี', 'sa wat di', '']], { requireCardId: true }),
    /缺少 card_id/,
  );
  assert.throws(
    () => rowsToCards([header, ['你好', 'สวัสดี', 'sa wat di', valid.toUpperCase()]], { requireCardId: true }),
    /canonical lowercase UUID/,
  );
  assert.throws(
    () => rowsToCards([
      header,
      ['你好', 'สวัสดี', 'sa wat di', valid],
      ['謝謝', 'ขอบคุณ', 'khop khun', valid],
    ], { requireCardId: true }),
    /card_id 重複/,
  );
});

test('bundled data rejects cross-tab duplicate card_id before returning lessons', async () => {
  const originalFetch = globalThis.fetch;
  const card = {
    thai: 'สวัสดี', karaoke: 'sa wat di', zh: '你好',
    card_id: '550e8400-e29b-41d4-a716-446655440000',
  };
  try {
    globalThis.fetch = async () => ({
      ok: true,
      async json() {
        return {
          lessons: [
            { gid: '1', title: '一', cards: [card] },
            { gid: '2', title: '二', cards: [{ ...card }] },
          ],
        };
      },
    });
    await assert.rejects(loadBundledData(), /跨分頁 card_id 重複/);
    globalThis.fetch = async () => ({
      ok: true,
      async json() {
        return { lessons: [{ gid: '1', title: '一', cards: [{ ...card, card_id: '' }] }] };
      },
    });
    await assert.rejects(loadBundledData(), /缺少有效 canonical card_id/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

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

test('multi-source CSV rejects the entire batch when one source has an invalid card_id', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => ({
    ok: true,
    async text() {
      if (String(url).includes('good')) return csv(VALID_ID_1, '第一堂');
      if (String(url).includes('missing')) return csv('', '第二堂');
      return csv(VALID_ID_2.toUpperCase(), '第三堂');
    },
  });
  try {
    await assert.rejects(
      loadLessons([
        'https://example.com/good?output=csv',
        'https://example.com/missing?output=csv',
        'https://example.com/uppercase?output=csv',
      ].join('\n')),
      error => /missing.*缺少 card_id/.test(error.message)
        && /uppercase.*canonical lowercase UUID/.test(error.message),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('published loader preserves the original card_id failure instead of falling through', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => ({
    ok: true,
    async text() {
      if (String(url).includes('/pubhtml')) return 'items.push({name: "初 1", gid: "101"});';
      return csv('');
    },
  });
  try {
    await assert.rejects(
      loadLessons('https://docs.google.com/spreadsheets/d/e/published-id-long-enough/pubhtml'),
      /字卡識別驗證失敗.*缺少 card_id/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('complete published manifest rejects cross-tab duplicate card_id', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => ({
    ok: true,
    async text() {
      if (String(url).includes('/pubhtml')) {
        return [
          'items.push({name: "初 1", gid: "101"});',
          'items.push({name: "初 2", gid: "102"});',
        ].join('\n');
      }
      return csv(VALID_ID_2);
    },
  });
  try {
    await assert.rejects(
      loadPublishedCatalog('https://docs.google.com/spreadsheets/d/e/published-id-long-enough/pubhtml'),
      /跨分頁 card_id 重複/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('catalog cache rejects payloads without the explicit post-Gate-B schema', () => {
  const originalStorage = globalThis.localStorage;
  const values = new Map();
  globalThis.localStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
    key: index => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
  try {
    const url = 'https://example.com/catalog.csv?output=csv';
    values.set(LESSONS_CACHE_KEY, JSON.stringify({ url, lessons: [{ id: 'legacy' }] }));
    assert.equal(loadLessonsCache(url), null);

    saveLessonsCache(url, [{ id: 'current', _loaded: true }]);
    assert.equal(JSON.parse(values.get(LESSONS_CACHE_KEY)).schema, CATALOG_CACHE_SCHEMA);
    assert.equal(loadLessonsCache(url).lessons[0].id, 'current');
  } finally {
    globalThis.localStorage = originalStorage;
  }
});

test('app adopts only complete staged catalogs and updates last-sync after replacement', async () => {
  const source = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
  const smartStart = source.indexOf('async function loadLessonsSmart');
  const smartEnd = source.indexOf('\nfunction rerender', smartStart);
  const smart = source.slice(smartStart, smartEnd);
  assert.match(smart, /return loadPublishedCatalog/);
  assert.match(smart, /const ready = adopt\(catalog\);[^]*saveLessonsCache\(url, ready, catalog\)/);
  assert.doesNotMatch(smart, /Promise\.allSettled/);
  assert.match(smart, /fetchCompleteCatalog\(\)\.then\(catalog =>[^]*replaceRuntimeCatalog/);
  assert.match(smart, /if \(currentUrl !== url\) return/);
  assert.match(source, /function assertCompleteCatalog\(\)[^]*some\(lesson => !lesson\._loaded\)/);

  for (const buttonId of ['btnSaveSettings', 'btnClearCache']) {
    const start = source.indexOf(`'${buttonId}'`);
    const end = source.indexOf('\n  });', start);
    const handler = source.slice(start, end);
    assert.ok(handler.indexOf('loadLessonsSmart({ force: true })') < handler.indexOf('setLastSync('));
  }
});
