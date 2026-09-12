import assert from 'node:assert/strict';
import test from 'node:test';

/* 迴歸：虛擬課次（__ALL__ / __TODAY__ / __FAV__ / __SEARCH__）底下，卡片帶的是
   自己原本那堂課的 _lessonId，card.js 用 zhLessonIdOf(card) 去查有沒有真人音檔。
   preloadRealAudioAvailability 以前只預載 state.currentLessonId，混合模式下
   currentLessonId 是 '__ALL__'，於是每一張卡都查不到、「課堂原音」按鈕整批消失。 */

const stored = new Map();
globalThis.localStorage = {
  getItem(key) { return stored.get(key) ?? null; },
  setItem(key, value) { stored.set(key, value); },
  removeItem(key) { stored.delete(key); },
};

const domElements = new Map();
globalThis.document = {
  baseURI: 'http://example.test/',
  getElementById(id) {
    if (!domElements.has(id)) {
      domElements.set(id, {
        id, style: {}, textContent: '',
        setAttribute() {}, addEventListener() {},
        play() { return Promise.resolve(); }, pause() {},
        get offsetWidth() { return 1; },
      });
    }
    return domElements.get(id);
  },
};
Object.defineProperty(globalThis, 'location', { configurable: true, value: { href: 'http://example.test/' } });
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
globalThis.cancelAnimationFrame = () => {};
globalThis.requestAnimationFrame = () => 1;
globalThis.speechSynthesis = { cancel() {}, getVoices() { return []; }, addEventListener() {} };

const MANIFEST = {
  generated_at: '2026-09-11T23:50:37+08:00',
  lessons: {
    'gid-A': { hash: 'aaaa', timing: 'audio/real-tw/gid-A-aaaa.json' },
    'gid-B': { hash: 'bbbb', timing: 'audio/real-tw/gid-B-bbbb.json' },
  },
};
const TIMING = {
  'audio/real-tw/gid-A-aaaa.json': { files: ['a-p0.mp3'], items: { 'คำ A': [0, 100, 500] } },
  'audio/real-tw/gid-B-bbbb.json': { files: ['b-p0.mp3'], items: { 'คำ B': [0, 200, 500] } },
};

const fetched = [];
globalThis.fetch = url => {
  const path = String(url);
  fetched.push(path);
  const body = path === 'real-manifest.json' ? MANIFEST : TIMING[path];
  if (!body) return Promise.resolve({ ok: false, status: 404, json: () => Promise.reject(new Error('404')) });
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
};

const { preloadRealAudioAvailability, hasRealAudio, zhLessonIdOf } = await import('../src/tts.js');
const { state } = await import('../src/state.js');

test('preload covers every lesson in the manifest, not just the selected one', async () => {
  state.currentLessonId = '__ALL__';

  let readyCalls = 0;
  // 時限：預載沒回呼就當失敗，不要讓測試整個吊住
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('preloadRealAudioAvailability 沒有回呼 onReady')), 2000);
    preloadRealAudioAvailability(() => { readyCalls += 1; clearTimeout(timer); resolve(); });
  });

  // 混合模式：卡片帶自己那堂課的 _lessonId，兩堂課都要查得到
  assert.equal(zhLessonIdOf({ thai: 'คำ B', _lessonId: 'gid-B' }), 'gid-B');
  assert.equal(hasRealAudio('คำ A', 'gid-A'), true);
  assert.equal(hasRealAudio('คำ B', 'gid-B'), true);

  // 沒有真人音檔的課次與句子仍然是 false
  assert.equal(hasRealAudio('คำ A', 'gid-C'), false);
  assert.equal(hasRealAudio('ไม่มีจริง', 'gid-A'), false);

  assert.equal(readyCalls, 1);
  assert.equal(fetched.filter(u => u === 'real-manifest.json').length, 1);

  // 重複呼叫零成本：不再打任何 request
  const before = fetched.length;
  preloadRealAudioAvailability(() => { readyCalls += 1; });
  await new Promise(r => setTimeout(r, 0));
  assert.equal(fetched.length, before);
  assert.equal(readyCalls, 1);

  state.currentLessonId = null;
});
