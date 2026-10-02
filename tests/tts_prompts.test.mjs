import assert from 'node:assert/strict';
import test from 'node:test';

const { applyTtsPromptsToLesson, TTS_PROMPT_MANIFEST } = await import('../src/tts-prompts.js');

// 取 sidecar 裡第一個有 prompt 的列，拿來組測試卡（不寫死某課某列，資料改了也不會壞）
const [gid, bucket] = Object.entries(TTS_PROMPT_MANIFEST.lessons)
  .find(([, b]) => b.items.some(item => item.tts_prompt));
const item = bucket.items.find(entry => entry.tts_prompt);
const lessonWith = card => {
  const cards = Array.from({ length: item.row }, () => ({ thai: 'x', zh: 'x' }));
  cards[item.row - 1] = card;
  return { id: gid, title: bucket.title, cards };
};

test('泰文改了、中文沒改：不套過期 prompt（跟 gen-audio.py 同規則）', () => {
  const out = applyTtsPromptsToLesson(lessonWith({ thai: `${item.thai}ใหม่`, zh: item.zh }));
  assert.equal(out.cards[item.row - 1].tts_prompt, undefined);
});

test('泰文相符：照常套用 prompt', () => {
  const out = applyTtsPromptsToLesson(lessonWith({ thai: item.thai, zh: item.zh }));
  assert.equal(out.cards[item.row - 1].tts_prompt, item.tts_prompt);
});
