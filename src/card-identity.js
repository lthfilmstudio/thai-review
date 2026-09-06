/* Stable card identity helpers.
   This module is intentionally pure and is not wired into runtime consumers yet.
   Until the source Sheet contains card_id, legacy aliases remain a migration
   input only; ambiguous aliases are quarantined rather than guessed. */

export function isStableCardId(value) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.trim());
}

export function cardIdOf(card) {
  const value = card?.card_id ?? card?.cardId ?? card?._cardId ?? '';
  return isStableCardId(value) ? value.trim().toLowerCase() : null;
}

export function legacyAliasOf(card, lessonId = card?._lessonId ?? card?.lessonId) {
  const lesson = String(lessonId ?? '').trim();
  const thai = String(card?._sourceThai ?? card?.thai ?? '').trim();
  return lesson && thai ? `${lesson}:${thai}` : null;
}

export function indexLegacyAliases(cards = []) {
  const index = new Map();
  for (const card of cards || []) {
    const alias = legacyAliasOf(card);
    if (!alias) continue;
    const entries = index.get(alias) || [];
    const cardId = cardIdOf(card);
    // Keep every source row.  A repeated alias with the same stable ID is
    // still duplicate source evidence and must not collapse into a unique
    // candidate during migration.
    const key = `${cardId || 'unidentified'}:${entries.length}`;
    entries.push({ key, cardId, card });
    index.set(alias, entries);
  }
  return index;
}

/* cardIdCounts 是「整個 index」的統計，跟 alias 無關，但呼叫端是每個 alias 叫一次。
   原本每次都重數一遍＝O(alias 數 × 卡片數)：13,738 張卡下量到約 1 ms／alias，
   一次採納 2,000 張就是主執行緒卡住 2 秒（手機更久）。這裡照 index 物件記住結果。
   size 一起記是防呆：index 被加過東西就重算，不要拿舊統計去判 duplicate。 */
const cardIdCountsCache = new WeakMap();

function countCardIds(aliasIndex) {
  if (!(aliasIndex instanceof Map)) return new Map();
  const cached = cardIdCountsCache.get(aliasIndex);
  if (cached && cached.size === aliasIndex.size) return cached.counts;
  const counts = new Map();
  for (const value of aliasIndex.values()) {
    for (const entry of Array.isArray(value) ? value : []) {
      if (entry?.cardId) counts.set(entry.cardId, (counts.get(entry.cardId) || 0) + 1);
    }
  }
  cardIdCountsCache.set(aliasIndex, { size: aliasIndex.size, counts });
  return counts;
}

export function resolveLegacyAlias(alias, index) {
  const aliasIndex = Array.isArray(index) ? indexLegacyAliases(index) : index;
  const candidates = aliasIndex?.get(alias);
  const entries = Array.isArray(candidates) ? candidates : [];
  const resolvedIds = [...new Set(entries.map(entry => entry?.cardId).filter(Boolean))];
  const cardIdCounts = countCardIds(aliasIndex);

  if (entries.length === 1 && resolvedIds.length === 1 && entries.every(entry => entry?.cardId)) {
    const cardId = resolvedIds[0];
    if ((cardIdCounts.get(cardId) || 0) > 1) {
      return {
        status: 'quarantine',
        reason: 'duplicate_stable_card_id',
        alias,
        candidates: [cardId],
      };
    }
    return { status: 'resolved', cardId: resolvedIds[0], alias };
  }
  if (entries.length > 1 || resolvedIds.length > 1) {
    return {
      status: 'quarantine',
      reason: 'ambiguous_legacy_alias',
      alias,
      candidates: resolvedIds,
    };
  }
  if (entries.length === 1 && resolvedIds.length === 0) {
    return {
      status: 'quarantine',
      reason: 'unidentified_legacy_alias',
      alias,
      candidates: [],
    };
  }
  return { status: 'unresolved', reason: 'legacy_alias_not_found', alias, candidates: [] };
}
