import assert from 'node:assert/strict';
import test from 'node:test';

const stored = new Map();
globalThis.localStorage = {
  getItem(key) { return stored.get(key) ?? null; },
  setItem(key, value) { stored.set(key, value); },
  removeItem(key) { stored.delete(key); },
};

const {
  invalidateCardAudioRender,
  renderCardMode,
} = await import('../src/card.js');
const { state } = await import('../src/state.js');
const { renderContent } = await import('../src/ui.js');
const { cancelSpeech, speakCard } = await import('../src/tts.js');

function makeElementStore() {
  const elements = new Map();
  const makeElement = () => ({
    listeners: new Map(),
    addEventListener(type, fn) { this.listeners.set(type, fn); },
    classList: { toggle() {}, add() {}, remove() {} },
    style: {},
    innerHTML: '',
  });
  const root = {
    html: '',
    set innerHTML(value) {
      this.html = value;
      for (const id of ['cardStage', 'playBack', 'realAudioBtn', 'sentBtn', 'sentList', 'favBtn']) {
        elements.set(id, makeElement());
      }
    },
    get innerHTML() { return this.html; },
  };
  return { elements, root };
}

const audioRequests = [];
const playedAudio = [];
class FakeAudio {
  constructor(url) {
    this.url = url;
    playedAudio.push(this);
  }
  play() {
    this.played = true;
    return Promise.resolve();
  }
}

const cards = [
  { thai: '卡 A', karaoke: 'a', zh: 'A', _lessonId: 'L1' },
  { thai: '卡 B', karaoke: 'b', zh: 'B', _lessonId: 'L1' },
];

test('delayed Card A lookup after Card B renders creates no stale Audio, while B plays', async () => {
  const { elements, root } = makeElementStore();
  globalThis.document = { getElementById(id) { return elements.get(id) || null; } };
  globalThis.Audio = FakeAudio;

  const render = card => renderCardMode(root, [card], () => {}, {
    hasRealAudio: () => true,
    getRealAudioUrl: (thai) => new Promise(resolve => audioRequests.push({ thai, resolve })),
    playAudioUrl: url => new FakeAudio(url).play(),
  });

  render(cards[0]);
  const aPromise = elements.get('realAudioBtn').listeners.get('click')({ stopPropagation() {} });
  render(cards[1]);
  const bClick = elements.get('realAudioBtn').listeners.get('click');
  const bPromise = bClick({ stopPropagation() {} });

  audioRequests.find(request => request.thai === '卡 A').resolve('a-url');
  await Promise.resolve();
  assert.equal(playedAudio.length, 0);

  audioRequests.find(request => request.thai === '卡 B').resolve('b-url');
  await aPromise;
  await bPromise;
  assert.equal(playedAudio.length, 1);
  assert.equal(playedAudio[0].url, 'b-url');
  assert.equal(playedAudio[0].played, true);
});

test('leaving card mode invalidates a pending card audio completion', async () => {
  const { elements, root } = makeElementStore();
  globalThis.document = { getElementById(id) { return elements.get(id) || null; } };
  const request = new Promise(resolve => audioRequests.push({ thai: '離開', resolve }));
  renderCardMode(root, [cards[0]], () => {}, {
    hasRealAudio: () => true,
    getRealAudioUrl: () => request,
    playAudioUrl: url => new FakeAudio(url).play(),
  });
  const click = elements.get('realAudioBtn').listeners.get('click');
  const clickPromise = click({ stopPropagation() {} });
  invalidateCardAudioRender();
  audioRequests.find(item => item.thai === '離開').resolve('stale-url');
  await clickPromise;
  assert.equal(playedAudio.some(audio => audio.url === 'stale-url'), false);
});

test('renderContent SRS empty state invalidates a pending card audio completion', async () => {
  const { elements, root } = makeElementStore();
  elements.set('content', root);
  globalThis.document = {
    getElementById(id) { return elements.get(id) || null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  const request = new Promise(resolve => audioRequests.push({ thai: 'SRS 空狀態', resolve }));
  renderCardMode(root, [cards[0]], () => {}, {
    hasRealAudio: () => true,
    getRealAudioUrl: () => request,
    playAudioUrl: url => new FakeAudio(url).play(),
  });
  const click = elements.get('realAudioBtn').listeners.get('click');
  const clickPromise = click({ stopPropagation() {} });

  state.mode = 'srs';
  state.currentLessonId = 'L1';
  state.lessons = [{ id: 'L1', cards: [cards[0]] }];
  state.progress = {};
  renderContent(() => {});

  audioRequests.find(item => item.thai === 'SRS 空狀態').resolve('srs-stale-url');
  await clickPromise;
  assert.equal(playedAudio.some(audio => audio.url === 'srs-stale-url'), false);

  state.mode = 'card';
  state.currentLessonId = null;
  state.lessons = [];
  state.progress = {};
});

test('teacher audio repeat clicks and AI playback share one active media source in both directions', async t => {
  const { elements, root } = makeElementStore();
  const media = [];
  globalThis.document = { getElementById(id) { return elements.get(id) || null; }, hidden: false };
  globalThis.window = { speechSynthesis: { cancel() {} } };
  globalThis.Audio = class {
    constructor(url) { this.src = url; this.paused = true; media.push(this); }
    play() { this.paused = false; return Promise.resolve(); }
    pause() { this.paused = true; this.onpause?.(); }
  };
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ items: [{ text: '卡 A', path: 'ai.mp3' }] }) });
  t.after(() => cancelSpeech());
  renderCardMode(root, [cards[0]], () => {}, { hasRealAudio: () => true, getRealAudioUrl: async () => 'teacher.mp3' });
  const click = id => elements.get(id).listeners.get('click')({ stopPropagation() {} });
  await click('realAudioBtn');
  await click('realAudioBtn');
  assert.equal(media.filter(audio => !audio.paused).length, 1, 'repeated original-audio clicks overlap');
  click('playBack');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(media.filter(audio => !audio.paused).length, 1, 'AI overlaps original audio');
  assert.equal(media.find(audio => !audio.paused).src, 'ai.mp3');
  await click('realAudioBtn');
  assert.equal(media.filter(audio => !audio.paused).length, 1, 'original audio overlaps AI');
  assert.equal(media.find(audio => !audio.paused).src, 'teacher.mp3');
});

test('AI click invalidates a pending teacher lookup on the same card', async () => {
  const { elements, root } = makeElementStore();
  globalThis.document = { getElementById(id) { return elements.get(id) || null; }, hidden: false };
  let resolveLookup;
  const played = [];
  globalThis.Audio = class {
    constructor(url) { played.push(url); }
    play() { return Promise.resolve(); }
  };
  renderCardMode(root, [cards[0]], () => {}, {
    hasRealAudio: () => true,
    getRealAudioUrl: () => new Promise(resolve => { resolveLookup = resolve; }),
    playAudioUrl: url => played.push(url),
  });
  const pending = elements.get('realAudioBtn').listeners.get('click')({ stopPropagation() {} });
  elements.get('playBack').listeners.get('click')({ stopPropagation() {} });
  resolveLookup('stale-teacher.mp3');
  await pending;
  assert.deepEqual(played, []);
  await new Promise(resolve => setImmediate(resolve));
  cancelSpeech();
});

for (const action of ['keyboard P', 'cancelSpeech']) {
  test(`${action} invalidates a pending teacher lookup outside card click handlers`, async () => {
    const { elements, root } = makeElementStore();
    globalThis.document = { getElementById(id) { return elements.get(id) || null; }, hidden: false };
    let resolveLookup;
    const played = [];
    renderCardMode(root, [cards[0]], () => {}, {
      hasRealAudio: () => true,
      getRealAudioUrl: () => new Promise(resolve => { resolveLookup = resolve; }),
      playAudioUrl: url => played.push(url),
    });
    const pending = elements.get('realAudioBtn').listeners.get('click')({ stopPropagation() {} });
    // app.js keyboard P directly invokes speakCard, bypassing playBack's handler.
    if (action === 'keyboard P') speakCard(cards[0]);
    else cancelSpeech();
    resolveLookup('stale-teacher.mp3');
    await pending;
    assert.deepEqual(played, []);
    await new Promise(resolve => setImmediate(resolve));
    cancelSpeech();
  });
}
