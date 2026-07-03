import assert from 'node:assert/strict';
import test from 'node:test';

const stored = new Map();
globalThis.localStorage = {
  getItem(key) { return stored.get(key) ?? null; },
  setItem(key, value) { stored.set(key, value); },
  removeItem(key) { stored.delete(key); },
};

const domElements = new Map();
function element(id) {
  if (!domElements.has(id)) {
    domElements.set(id, {
      id,
      style: {},
      textContent: '',
      setAttribute() {},
      addEventListener() {},
      play() { return Promise.resolve(); },
      pause() {},
      get offsetWidth() { return 1; },
    });
  }
  return domElements.get(id);
}

globalThis.document = { baseURI: 'http://example.test/', getElementById: element };
Object.defineProperty(globalThis, 'location', {
  configurable: true,
  value: { href: 'http://example.test/' },
});
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {},
});
globalThis.cancelAnimationFrame = () => {};
globalThis.requestAnimationFrame = () => 1;
globalThis.speechSynthesis = {
  cancel() {},
  getVoices() { return []; },
  addEventListener() {},
};

let blobCounter = 0;
URL.createObjectURL = () => `blob:test-${++blobCounter}`;

const requests = [];
let audioManifest = {
  version: 1,
  items: {
    baked1: {
      thai: 'เสียงอบแล้ว',
      path: 'audio/jessica-v1/baked1.mp3',
    },
    prompted1: {
      thai: 'เสียงอบแล้ว',
      tts_prompt: '[warm, natural] เสียงอบแล้ว',
      path: 'audio/jessica-v3/prompted1.mp3',
    },
    spaced1: {
      thai: 'ฟัง แล้ว อยาก ย้าย ไป อยู่ ด้วย เลย',
      path: 'audio/jessica-v1/spaced1.mp3',
    },
  },
};
globalThis.fetch = async (url, init) => {
  if (String(url).endsWith('audio-manifest.json')) {
    if (!audioManifest) return new Response('', { status: 404 });
    return new Response(JSON.stringify(audioManifest), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  requests.push(JSON.parse(init.body));
  return new Response(JSON.stringify({ audio: 'YXVkaW8=' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

let playedUrls = [];
let pausedUrls = [];
let autoEnd = true;
let stopAfterPlayCount = 0;
let stateRef;

class FakeAudio {
  constructor(src) {
    this.src = src;
    this.duration = 2;
    this.playbackRate = 1;
    this.defaultPlaybackRate = 1;
  }

  play() {
    playedUrls.push(this.src);
    if (stopAfterPlayCount && playedUrls.length === stopAfterPlayCount && stateRef) {
      stateRef.listen.playing = false;
    }
    if (autoEnd) queueMicrotask(() => this.onended?.());
    return Promise.resolve();
  }

  pause() {
    pausedUrls.push(this.src);
  }
}
globalThis.Audio = FakeAudio;

const stateModule = await import('../src/state.js');
const ttsModule = await import('../src/tts.js');
const listenModule = await import('../src/listen.js');
const { state, loadState, STORAGE_KEY } = stateModule;
const { speakWithPromise, getSilenceUrl } = ttsModule;
const { startListen, stopListen } = listenModule;
stateRef = state;

function resetRuntime() {
  requests.length = 0;
  blobCounter = 0;
  playedUrls = [];
  pausedUrls = [];
  autoEnd = true;
  stopAfterPlayCount = 0;
  state.listen.playing = false;
  state.listen.repeatCount = 0;
  state.cardIndex = 0;
  state.settings.voiceProvider = 'elevenlabs';
  state.settings.rate = 1;
  state.settings.repeat = 1;
  state.settings.gap = 0;
}

test('baked Thai audio plays from manifest without worker TTS', async () => {
  resetRuntime();

  const durationMs = await speakWithPromise({ thai: 'เสียงอบแล้ว' });

  assert.equal(Math.round(durationMs), 2000);
  assert.deepEqual(requests, []);
  assert.deepEqual(playedUrls, ['http://example.test/audio/jessica-v1/baked1.mp3']);
});

test('ElevenLabs prompt cards play prompted baked audio without changing display Thai', async () => {
  resetRuntime();

  const durationMs = await speakWithPromise({
    thai: 'เสียงอบแล้ว',
    tts_prompt: '[warm, natural] เสียงอบแล้ว',
  });

  assert.equal(Math.round(durationMs), 2000);
  assert.deepEqual(requests, []);
  assert.deepEqual(playedUrls, ['http://example.test/audio/jessica-v3/prompted1.mp3']);
});

test('baked Thai audio survives whitespace-only Sheet edits', async () => {
  resetRuntime();

  const durationMs = await speakWithPromise({ thai: 'ฟังแล้วอยากย้ายไปอยู่ด้วยเลย' });

  assert.equal(Math.round(durationMs), 2000);
  assert.deepEqual(requests, []);
  assert.deepEqual(playedUrls, ['http://example.test/audio/jessica-v1/spaced1.mp3']);
});

test('GCP provider skips baked Thai audio and uses worker TTS', async () => {
  resetRuntime();
  state.settings.voiceProvider = 'gcp';

  const durationMs = await speakWithPromise({
    thai: 'เสียงอบแล้ว',
    tts_prompt: '[warm, natural] เสียงอบแล้ว',
  });

  assert.equal(Math.round(durationMs), 2000);
  assert.deepEqual(requests.map(item => [item.text, item.voice]), [
    ['เสียงอบแล้ว', 'th-TH-Neural2-C'],
  ]);
  assert.deepEqual(playedUrls, ['blob:test-1']);
});

test('locally edited cards ignore stale ElevenLabs prompts', async () => {
  resetRuntime();

  const durationMs = await speakWithPromise({
    thai: 'เสียงแก้เอง',
    tts_prompt: '[warm, natural] เสียงอบแล้ว',
    _edited: true,
  });

  assert.equal(Math.round(durationMs), 2000);
  assert.deepEqual(requests.map(item => [item.text, item.voice]), [
    ['เสียงแก้เอง', 'th-TH-Neural2-C'],
  ]);
  assert.deepEqual(playedUrls, ['blob:test-1']);
});

test('old saved 2-second gap migrates to auto once', () => {
  resetRuntime();
  stored.set(STORAGE_KEY, JSON.stringify({ settings: { gap: 2 } }));

  loadState();

  assert.equal(state.settings.gap, 'auto');
  assert.equal(JSON.parse(stored.get(STORAGE_KEY)).settingsVersion, 2);
});

test('teacher playback resolves with duration adjusted for playback rate', async () => {
  resetRuntime();
  state.settings.rate = 1.2;

  const durationMs = await speakWithPromise({ thai: 'ระยะเวลาทดสอบ' });

  assert.equal(Math.round(durationMs), 1667);
});

test('stopping listen mode pauses the current cloud audio', async () => {
  resetRuntime();
  autoEnd = false;

  void speakWithPromise({ thai: 'หยุดเสียงทดสอบ' });
  await new Promise(resolve => setTimeout(resolve, 0));
  const pausedBeforeStop = pausedUrls.length;
  stopListen();

  assert.equal(pausedUrls.length, pausedBeforeStop + 1);
});

test('a card plays Chinese once, then Thai for every repetition', async () => {
  resetRuntime();
  state.lessons = [{
    id: 'test',
    title: 'Test',
    cards: [{ thai: 'สวัสดี', karaoke: 'sawatdee', zh: '你好' }],
  }];
  state.currentLessonId = 'test';
  state.settings.repeat = 2;
  stopAfterPlayCount = 4; // 解鎖靜音 + 中文 + 泰文 ×2

  startListen();
  for (let i = 0; i < 20 && playedUrls.length < 4; i++) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  assert.deepEqual(requests.map(item => [item.text, item.voice]), [
    ['你好', 'cmn-TW-Wavenet-A'],
    ['สวัสดี', 'th-TH-Neural2-C'],
  ]);
  assert.deepEqual(playedUrls, [
    getSilenceUrl(100),
    'blob:test-2',
    'blob:test-3',
    'blob:test-3',
  ]);
});

test('auto gap plays adaptive silence sized to teacher duration', async () => {
  resetRuntime();
  state.lessons = [{
    id: 'test-auto',
    title: 'TestAuto',
    cards: [{ thai: 'เสียงอบแล้ว', karaoke: 'siang op laeo', zh: '烘焙測試' }],
  }];
  state.currentLessonId = 'test-auto';
  state.settings.repeat = 1;
  state.settings.gap = 'auto';
  stopAfterPlayCount = 3; // 中文 + 泰文 + 跟讀靜音（已解鎖，不再播解鎖靜音）

  startListen();
  for (let i = 0; i < 20 && playedUrls.length < 3; i++) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  // 老師音檔 2 秒 → 跟讀空白 = 2000 × 1.8 = 3600ms 的真靜音
  assert.equal(playedUrls.length, 3);
  assert.equal(playedUrls[1], 'http://example.test/audio/jessica-v1/baked1.mp3');
  assert.equal(playedUrls[2], getSilenceUrl(3600));
  assert.notEqual(playedUrls[2], getSilenceUrl(1500));
});
