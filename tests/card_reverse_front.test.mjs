import assert from 'node:assert/strict';
import test from 'node:test';

const stored = new Map();
globalThis.localStorage = {
  getItem(key) { return stored.get(key) ?? null; },
  setItem(key, value) { stored.set(key, value); },
  removeItem(key) { stored.delete(key); },
};
globalThis.Audio = class {};

const { renderCardMode } = await import('../src/card.js');
const { state } = await import('../src/state.js');

function makeElementStore() {
  const elements = new Map();
  const makeElement = () => ({
    listeners: new Map(),
    classes: new Set(),
    addEventListener(type, fn) { this.listeners.set(type, fn); },
    classList: null,
    style: {},
    innerHTML: '',
  });
  const root = {
    html: '',
    set innerHTML(value) {
      this.html = value;
      for (const id of ['cardStage', 'playBack', 'playFront', 'zhRevealBtn', 'zhRevealSlot', 'sentBtn', 'sentList', 'favBtn']) {
        const el = makeElement();
        el.classList = {
          add: c => el.classes.add(c),
          remove: c => el.classes.delete(c),
          toggle() {},
        };
        elements.set(id, el);
      }
    },
    get innerHTML() { return this.html; },
  };
  globalThis.document = { getElementById(id) { return elements.get(id) || null; } };
  return { elements, root };
}

const cardA = { thai: 'สวัสดี', karaoke: 'sa-wat-dii', zh: '中文答案甲', note: '打招呼', _cardKey: 'L1:A', _lessonId: 'L1' };
const cardB = { thai: 'ขอบคุณ', karaoke: 'khoop-khun', zh: '中文答案乙', _cardKey: 'L1:B', _lessonId: 'L1' };

const render = (root, card, reverse) => renderCardMode(root, [card], () => {}, {
  reverse,
  hasRealAudio: () => false,
});

test('reverse front starts with play + reveal button and hides Chinese', () => {
  state.zhRevealedKey = null;
  state.cardIndex = 0;
  const { elements, root } = makeElementStore();
  render(root, cardA, true);
  assert.equal(root.html.includes('中文答案甲'), false);
  assert.equal(root.html.includes('打招呼'), false);
  assert.ok(root.html.includes('id="playFront"'));
  assert.ok(root.html.includes('id="zhRevealBtn"'));
  assert.ok(elements.get('playFront').listeners.has('click'));
});

test('reveal button fades Chinese in place without flipping', () => {
  state.zhRevealedKey = null;
  state.flipped = false;
  const { elements, root } = makeElementStore();
  render(root, cardA, true);
  const slot = elements.get('zhRevealSlot');
  let stopped = false;
  elements.get('zhRevealBtn').listeners.get('click')({ stopPropagation() { stopped = true; } });
  assert.equal(stopped, true);
  assert.equal(state.zhRevealedKey, 'L1:A');
  assert.ok(slot.innerHTML.includes('中文答案甲'));
  assert.ok(slot.innerHTML.includes('打招呼'));
  assert.ok(slot.classes.has('zh-fade-in'));
  assert.equal(state.flipped, false);
});

test('rerendering the same card keeps Chinese open without replaying the fade', () => {
  state.zhRevealedKey = 'L1:A';
  const { root } = makeElementStore();
  render(root, cardA, true);
  assert.ok(root.html.includes('中文答案甲'));
  assert.equal(root.html.includes('id="zhRevealBtn"'), false);
  assert.equal(root.html.includes('zh-fade-in'), false);
});

test('changing card covers Chinese again, including coming back to the revealed card', () => {
  state.zhRevealedKey = 'L1:A';
  const { root } = makeElementStore();
  render(root, cardB, true);
  assert.equal(root.html.includes('中文答案乙'), false);
  assert.ok(root.html.includes('id="zhRevealBtn"'));
  render(root, cardA, true);
  assert.equal(root.html.includes('中文答案甲'), false);
  assert.ok(root.html.includes('id="zhRevealBtn"'));
});

test('reverse back face stays Thai + karaoke only', () => {
  state.zhRevealedKey = null;
  const { root } = makeElementStore();
  render(root, cardA, true);
  const back = root.html.slice(root.html.indexOf('class="card back"'));
  assert.ok(back.includes('สวัสดี'));
  assert.ok(back.includes('sa-wat-dii'));
  assert.equal(back.includes('中文答案甲'), false);
});

test('Thai card mode front is unchanged', () => {
  state.zhRevealedKey = null;
  const { root } = makeElementStore();
  render(root, cardA, false);
  const front = root.html.slice(root.html.indexOf('class="card front"'), root.html.indexOf('class="card back"'));
  assert.ok(front.includes('class="thai-main"'));
  assert.equal(front.includes('id="playFront"'), false);
  assert.equal(front.includes('id="zhRevealBtn"'), false);
});
