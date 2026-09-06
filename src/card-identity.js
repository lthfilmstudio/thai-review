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

/* 「同一個 stable card ID 在整份 catalog 裡出現幾次」的統計，跟 alias 無關。
   拿來判 duplicate_stable_card_id——那是防止把兩張不同的卡認成同一張的安全閘門。 */
export function countCardIds(aliasIndex) {
  const counts = new Map();
  if (!(aliasIndex instanceof Map)) return counts;
  for (const value of aliasIndex.values()) {
    for (const entry of Array.isArray(value) ? value : []) {
      if (entry?.cardId) counts.set(entry.cardId, (counts.get(entry.cardId) || 0) + 1);
    }
  }
  return counts;
}

/* cardIdCounts 是整個 index 的統計，但呼叫端是每個 alias 叫一次。不傳就每次重數一遍
   ＝O(alias 數 × 卡片數)：13,738 張卡下約 1 ms／alias，一次採納 2,000 張就是主執行緒
   卡住 1.6 秒（手機更久）。所以迴圈式的呼叫端要在迴圈外算一次傳進來。

   曾經改成用 WeakMap 照 index 物件快取，帶 size 當防呆——但 size 一樣、內容變了的
   mutation 擋不住（獨立審查實測：把某個 alias 的 entries 換成指向另一張卡，本該
   quarantine 的會變成 resolved），而註解卻寫得像有守衛。與其留一個假的守衛，不如
   讓「這份統計是誰算的、什麼時候算的」在呼叫端看得見。 */
export function resolveLegacyAlias(alias, index, cardIdCounts = null) {
  const aliasIndex = Array.isArray(index) ? indexLegacyAliases(index) : index;
  const candidates = aliasIndex?.get(alias);
  const entries = Array.isArray(candidates) ? candidates : [];
  const resolvedIds = [...new Set(entries.map(entry => entry?.cardId).filter(Boolean))];
  const counts = cardIdCounts instanceof Map ? cardIdCounts : countCardIds(aliasIndex);

  if (entries.length === 1 && resolvedIds.length === 1 && entries.every(entry => entry?.cardId)) {
    const cardId = resolvedIds[0];
    if ((counts.get(cardId) || 0) > 1) {
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
