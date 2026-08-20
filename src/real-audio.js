/* 課堂真人語音 sprite 純函式：scripts/build-real-audio.py 產出的
   real-manifest.json / timing json 索引與查找。IO（fetch / decode）在 tts.js；
   結構跟 zh-sprite.js 對稱，這裡刻意不共用同一組函式，因為欄位語意不同
   （key 是卡片的 thai 原文，不是 zh 提示文字），共用會讓呼叫端搞混兩套資料。 */

export function buildRealLessonIndex(manifest) {
  const map = new Map();
  const lessons = manifest?.lessons;
  if (!lessons || typeof lessons !== 'object') return map;
  Object.entries(lessons).forEach(([lessonId, entry]) => {
    const timing = String(entry?.timing || '').trim();
    if (!timing) return;
    map.set(lessonId, { hash: String(entry?.hash || ''), timing });
  });
  return map;
}

/* timing.items: { "<泰文原文>": [fileIdx, startMs, durMs] } */
export function lookupRealSegment(timing, thaiText) {
  const items = timing?.items;
  if (!items || typeof items !== 'object') return null;
  const raw = items[String(thaiText || '').trim()];
  if (!Array.isArray(raw) || raw.length < 3) return null;
  const [fileIdx, startMs, durMs] = raw.map(Number);
  if (!Number.isInteger(fileIdx) || fileIdx < 0) return null;
  if (!Number.isFinite(startMs) || !Number.isFinite(durMs) || startMs < 0 || durMs <= 0) return null;
  return { fileIdx, startMs, durMs };
}
