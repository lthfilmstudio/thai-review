function normalizeThaiAudioText(text) {
  return String(text || '').trim().replace(/\s+/g, '');
}

function absoluteAudioUrl(path, baseHref) {
  try {
    return new URL(path, baseHref || globalThis.location?.href || document.baseURI).href;
  } catch {
    return path;
  }
}

export function buildStaticAudioMap(manifest, baseHref) {
  const map = new Map();
  const items = manifest?.items || manifest?.entries || manifest?.audio;
  const entries = Array.isArray(items) ? items : Object.values(items || {});
  entries.forEach(entry => {
    if (!entry || typeof entry !== 'object') return;
    const path = String(entry.path || entry.url || '').trim();
    if (!path) return;
    const url = absoluteAudioUrl(path, baseHref);
    const promptText = String(entry.tts_prompt || entry.ttsPrompt || '').trim();
    const texts = (
      promptText
        ? [promptText]
        : [entry.text, entry.thai]
    ).map(value => String(value || '').trim()).filter(Boolean);
    texts.forEach(text => {
      map.set(text, url);
      const normalized = normalizeThaiAudioText(text);
      if (normalized && !map.has(normalized)) map.set(normalized, url);
    });
  });
  return map;
}

export function resolveStaticAudioUrl(card, audioMap) {
  const text = String(card?.tts_prompt || card?.thai || '').trim();
  if (!text) return null;
  return audioMap.get(text) || audioMap.get(normalizeThaiAudioText(text)) || null;
}

/* 單卡時間軸：中文提示（zhMs > 0 時，原速）→ (老師泰文 + 跟讀空白) × repeat。
   公式與一般模式 tts.js computeCycleTimeline 一致。 */
export function computeLockTimeline(zhMs, teacherMs, { repeat = 1, gap = 'auto', rate = 1 } = {}) {
  const teacherEffMs = teacherMs / rate;
  const gapMs = gap === 'auto' ? Math.max(1500, teacherEffMs * 1.8) : Number(gap) * 1000;
  const segments = [];
  let t = 0;
  if (zhMs > 0) {
    segments.push({ phase: 'meaning', startMs: 0, durMs: zhMs });
    t = zhMs;
  }
  for (let r = 0; r < repeat; r++) {
    segments.push({ phase: 'teacher', rep: r, startMs: t, durMs: teacherEffMs });
    t += teacherEffMs;
    segments.push({ phase: 'repeat', rep: r, startMs: t, durMs: gapMs });
    t += gapMs;
  }
  return { segments, totalMs: t, gapMs, teacherEffMs };
}

/* 從播放位置（毫秒）找出目前在哪張卡的哪個 segment。
   entries 的 startMs / timeline[].startMs 都是整條長音檔的絕對時間。 */
export function findLockPosition(entries, ms) {
  const list = Array.isArray(entries) ? entries : [];
  if (!list.length) return null;
  let entryIndex = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    if (ms >= list[i].startMs) { entryIndex = i; break; }
  }
  const entry = list[entryIndex];
  const timeline = entry.timeline || [];
  let segment = timeline[0] || null;
  for (let i = timeline.length - 1; i >= 0; i--) {
    if (ms >= timeline[i].startMs) { segment = timeline[i]; break; }
  }
  return { entryIndex, entry, segment };
}

export function planStaticListenBatch(cards, audioMap, { startIndex = 0, limit = 10 } = {}) {
  const list = Array.isArray(cards) ? cards : [];
  const selected = list.slice(startIndex, startIndex + limit);
  const items = [];
  const missing = [];
  selected.forEach((card, offset) => {
    const audioUrl = resolveStaticAudioUrl(card, audioMap);
    const entry = { card, index: startIndex + offset, audioUrl };
    if (audioUrl) items.push(entry);
    else missing.push(entry);
  });
  return { items, missing, requiresWorkerTts: false };
}

export function planLockListenSession(cards, audioMap, { startIndex = 0, limit = 40 } = {}) {
  const plan = planStaticListenBatch(cards, audioMap, { startIndex, limit });
  return {
    ...plan,
    startIndex,
    nextIndex: Math.min(cards?.length || 0, startIndex + plan.items.length),
  };
}
