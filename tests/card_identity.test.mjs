import assert from 'node:assert/strict';
import test from 'node:test';

const {
  isStableCardId,
  cardIdOf,
  legacyAliasOf,
  indexLegacyAliases,
  resolveLegacyAlias,
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
