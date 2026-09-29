import assert from 'node:assert/strict';
import test from 'node:test';

const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

let moduleId = 0;
async function setup(t) {
  const media = [], spoken = [], workers = [];
  const originals = new Map(['Audio', 'window', 'document', 'localStorage', 'fetch', 'SpeechSynthesisUtterance']
    .map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  class FakeAudio {
    constructor() { this.plays = []; this.paused = true; this.duration = 1; media.push(this); }
    play() { this.paused = false; const call = deferred(); this.plays.push(call); return call.promise; }
    pause() { this.paused = true; this.onpause?.(); }
    load() {}
  }
  const synthesis = { getVoices: () => [], cancel() {}, speak(utterance) { spoken.push(utterance); } };
  globalThis.Audio = FakeAudio;
  globalThis.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
  globalThis.window = { speechSynthesis: synthesis, SpeechSynthesisUtterance };
  globalThis.document = { hidden: false };
  globalThis.localStorage = { getItem: () => null, setItem() {} };
  globalThis.fetch = () => { const call = deferred(); workers.push(call); return call.promise; };
  const tts = await import(`../src/tts.js?playback-test=${++moduleId}`);
  t.after(() => {
    tts.cancelSpeech();
    for (const utterance of spoken) utterance.onend?.();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  const speak = (text = 'ตกลง') => tts.speakTextWithPromise({ text, voice: 'test', lang: 'th-TH', presetUrl: `${text}.mp3` });
  return { tts, media, spoken, workers, speak };
}

test('media error and rejected play advance to Worker only once, never overlapping browser speech', async t => {
  const { speak, media, workers, spoken } = await setup(t);
  const done = speak();
  await flush();
  media[0].onerror();
  media[0].plays[0].reject(new Error('NotSupportedError'));
  await flush();
  // If both errors request fallback, one successful result and one failed result
  // start the MP3 and browser speech concurrently.
  workers[0].resolve({ ok: true, json: async () => ({ audio: 'AA==' }) });
  workers[1]?.resolve({ ok: false });
  await flush();
  assert.equal(workers.length, 1);
  assert.equal(spoken.length, 0);
  media[0].onended();
  await done;
});

test('late rejected play after ended does not restart a completed card', async t => {
  const { speak, media, workers } = await setup(t);
  const done = speak();
  await flush();
  media[0].onended();
  await done;
  media[0].plays[0].reject(new Error('late error'));
  await flush();
  assert.equal(workers.length, 0);
});

test('switching to browser fallback stops the failed media first', async t => {
  const { speak, media, workers, spoken } = await setup(t);
  const done = speak();
  await flush();
  media[0].onerror();
  workers[0].resolve({ ok: false });
  await flush();
  assert.equal(spoken.length, 1);
  assert.equal(media[0].paused, true);
  spoken[0].onend();
  await done;
});

test('cancelled Worker response cannot interrupt the next card', async t => {
  const { speak, media, workers } = await setup(t);
  const first = speak('first');
  await flush();
  media[0].onerror();
  const second = speak('second');
  await flush();
  workers[0].resolve({ ok: true, json: async () => ({ audio: 'AA==' }) });
  await flush();
  assert.equal(media[0].src, 'second.mp3');
  assert.equal(media[0].plays.length, 2);
  media[0].onended();
  await Promise.all([first, second]);
});

test('cancelled cycle metadata cannot start or seek the next card', async t => {
  const { tts, speak, media } = await setup(t);
  const old = tts.playUrlWithPromise('cycle.wav', { startAtSec: 3 });
  const staleMetadata = media[0].onloadedmetadata;
  const current = speak();
  await flush();
  staleMetadata();
  assert.equal(media[0].plays.length, 1);
  assert.notEqual(media[0].currentTime, 3);
  media[0].onended();
  await Promise.all([old, current]);
});

test('cancellation resolves a pending lookup without waiting for the network', async t => {
  const { tts, workers, media } = await setup(t);
  const result = tts.speakTextWithPromise({ text: 'ตกลง', voice: 'test', lang: 'th-TH' });
  let completed = false;
  result.then(() => { completed = true; });
  tts.cancelSpeech();
  await flush();
  assert.equal(completed, true);
  workers[0].resolve({ ok: true, json: async () => ({ items: [{ text: 'ตกลง', path: 'old.mp3' }] }) });
  await flush();
  assert.equal(media.length, 0);
  assert.equal(await result, 0);
});
