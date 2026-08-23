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

export function resolveLegacyAlias(alias, index) {
  const aliasIndex = Array.isArray(index) ? indexLegacyAliases(index) : index;
  const candidates = aliasIndex?.get(alias);
  const entries = Array.isArray(candidates) ? candidates : [];
  const resolvedIds = [...new Set(entries.map(entry => entry?.cardId).filter(Boolean))];
  const allEntries = aliasIndex instanceof Map
    ? [...aliasIndex.values()].flatMap(value => Array.isArray(value) ? value : [])
    : [];
  const cardIdCounts = new Map();
  for (const entry of allEntries) {
    if (entry?.cardId) cardIdCounts.set(entry.cardId, (cardIdCounts.get(entry.cardId) || 0) + 1);
  }

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
