import assert from 'node:assert/strict';
import test from 'node:test';

const {
  isStableCardId,
  cardIdOf,
  legacyAliasOf,
  indexLegacyAliases,
  resolveLegacyAlias,
  countCardIds,
} = await import('../src/card-identity.js');

const ID_A = '550e8400-e29b-41d4-a716-446655440000';
const ID_B = '6ba7b810-9dad-41d1-80b4-00c04fd430c8';

test('accepts UUID card IDs and normalizes card field aliases', () => {
  assert.equal(isStableCardId(ID_A), true);
  assert.equal(isStableCardId(ID_A.toUpperCase()), true);
  assert.equal(isStableCardId('not-an-id'), false);
  assert.equal(cardIdOf({ card_id: ID_A.toUpperCase() }), ID_A);
  assert.equal(cardIdOf({ cardId: ID_B }), ID_B);
  assert.equal(cardIdOf({ card_id: 'bad' }), null);
});

test('legacy alias uses source Thai and lesson identity without changing runtime state', () => {
  assert.equal(
    legacyAliasOf({ _lessonId: 'gid-1', _sourceThai: '原始泰文', thai: '編輯後' }),
    'gid-1:原始泰文',
  );
  assert.equal(legacyAliasOf({ lessonId: 'L1', thai: 'สวัสดี' }), 'L1:สวัสดี');
  assert.equal(legacyAliasOf({ thai: '缺課程' }), null);
});

test('unique legacy alias resolves to its stable card ID', () => {
  const index = indexLegacyAliases([
    { _lessonId: 'L1', thai: 'a', card_id: ID_A },
    { _lessonId: 'L1', thai: 'b', card_id: ID_B },
  ]);
  assert.deepEqual(resolveLegacyAlias('L1:a', index), {
    status: 'resolved', cardId: ID_A, alias: 'L1:a',
  });
});

test('ambiguous legacy alias is quarantined and never guesses a candidate', () => {
  const cards = [
    { _lessonId: 'L1', thai: '重複', card_id: ID_A },
    { _lessonId: 'L1', thai: '重複', card_id: ID_B },
  ];
  const result = resolveLegacyAlias('L1:重複', indexLegacyAliases(cards));
  assert.equal(result.status, 'quarantine');
  assert.equal(result.reason, 'ambiguous_legacy_alias');
  assert.deepEqual(result.candidates, [ID_A, ID_B]);
  assert.equal('cardId' in result, false);
});

test('duplicate source rows with the same alias and stable ID are not unique evidence', () => {
  const cards = [
    { _lessonId: 'L1', thai: '重複', card_id: ID_A },
    { _lessonId: 'L1', thai: '重複', card_id: ID_A },
  ];
  const result = resolveLegacyAlias('L1:重複', indexLegacyAliases(cards));
  assert.equal(result.status, 'quarantine');
  assert.equal(result.reason, 'ambiguous_legacy_alias');
  assert.deepEqual(result.candidates, [ID_A]);
  assert.equal('cardId' in result, false);
});

test('a stable ID repeated under different aliases is quarantined globally', () => {
  const index = indexLegacyAliases([
    { _lessonId: 'L1', thai: '甲', card_id: ID_A },
    { _lessonId: 'L1', thai: '乙', card_id: ID_A },
  ]);
  const result = resolveLegacyAlias('L1:甲', index);
  assert.deepEqual(result, {
    status: 'quarantine', reason: 'duplicate_stable_card_id',
    alias: 'L1:甲', candidates: [ID_A],
  });
});

test('missing or unidentified legacy aliases stay unresolved or quarantined', () => {
  const index = indexLegacyAliases([
    { _lessonId: 'L1', thai: '沒有 ID' },
  ]);
  assert.deepEqual(resolveLegacyAlias('L1:不存在', index), {
    status: 'unresolved', reason: 'legacy_alias_not_found',
    alias: 'L1:不存在', candidates: [],
  });
  const result = resolveLegacyAlias('L1:沒有 ID', index);
  assert.equal(result.status, 'quarantine');
  assert.equal(result.reason, 'unidentified_legacy_alias');
});

test('countCardIds 數的是整份 index 裡每個 stable ID 出現幾次', () => {
  const index = indexLegacyAliases([
    { _lessonId: 'L1', thai: '甲', card_id: ID_A },
    { _lessonId: 'L1', thai: '乙', card_id: ID_A },
    { _lessonId: 'L1', thai: '丙', card_id: ID_B },
    { _lessonId: 'L1', thai: '丁' },
  ]);
  const counts = countCardIds(index);
  assert.equal(counts.get(ID_A), 2, '跨 alias 重複的要數到 2，那是 duplicate 閘門的依據');
  assert.equal(counts.get(ID_B), 1);
  assert.equal(counts.size, 2, '沒有 card_id 的卡不進統計');
  assert.deepEqual(countCardIds(null), new Map(), 'index 不是 Map 就是空統計');
});

test('傳進來的 cardIdCounts 會被採用（迴圈式呼叫端在迴圈外算一次）', () => {
  /* 這份統計是「整份 catalog 裡這個 ID 出現幾次」，跟 alias 無關，所以呼叫端每個
     alias 叫一次的話會變成 O(alias × 卡片)。允許外面算好傳進來，但那也表示這個參數
     必須真的被採用——不採用的話效能修正是假的，而且沒有任何行為差異看得出來。 */
  const index = indexLegacyAliases([{ _lessonId: 'L1', thai: '甲', card_id: ID_A }]);
  assert.deepEqual(resolveLegacyAlias('L1:甲', index), { status: 'resolved', cardId: ID_A, alias: 'L1:甲' });

  const claimsDuplicate = new Map([[ID_A, 2]]);
  assert.deepEqual(resolveLegacyAlias('L1:甲', index, claimsDuplicate), {
    status: 'quarantine',
    reason: 'duplicate_stable_card_id',
    alias: 'L1:甲',
    candidates: [ID_A],
  });

  // 不是 Map 的東西一律當沒傳，回去自己數；不能拿垃圾當統計用
  assert.equal(resolveLegacyAlias('L1:甲', index, { [ID_A]: 2 }).status, 'resolved');
  assert.equal(resolveLegacyAlias('L1:甲', index, null).status, 'resolved');
});
