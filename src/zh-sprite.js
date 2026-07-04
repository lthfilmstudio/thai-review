/* zh sprite 純函式：課程中文合輯（scripts/gen-zh-audio.py 產出）的
   manifest 索引、時間表查找、切片範圍計算。
   IO（fetch / decode）在 tts.js；這裡保持純函式方便 node 測試。 */

export function buildZhLessonIndex(manifest) {
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

/* timing.items: { "中文": [fileIdx, startMs, durMs] } */
export function lookupZhSegment(timing, zhText) {
  const items = timing?.items;
  if (!items || typeof items !== 'object') return null;
  const raw = items[String(zhText || '').trim()];
  if (!Array.isArray(raw) || raw.length < 3) return null;
  const [fileIdx, startMs, durMs] = raw.map(Number);
  if (!Number.isInteger(fileIdx) || fileIdx < 0) return null;
  if (!Number.isFinite(startMs) || !Number.isFinite(durMs) || startMs < 0 || durMs <= 0) return null;
  return { fileIdx, startMs, durMs };
}

/* 毫秒範圍 → 樣本範圍，clamp 到 buffer 邊界。 */
export function sliceRange(startMs, durMs, sampleRate, bufferLength) {
  const offset = Math.max(0, Math.min(bufferLength, Math.round(startMs * sampleRate / 1000)));
  const end = Math.max(offset, Math.min(bufferLength, Math.round((startMs + durMs) * sampleRate / 1000)));
  return { offset, length: end - offset };
}
