import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

globalThis.localStorage = {
  getItem() { return null; },
  setItem() {},
  removeItem() {},
};

const { buildDailySentenceHref, fillDailySentence } = await import('../src/home.js');
const homeSource = await readFile(new URL('../src/home.js', import.meta.url), 'utf8');

function sentenceBox() {
  const thaiLine = { textContent: '…' };
  return {
    thaiLine,
    children: [],
    querySelector(selector) {
      return selector === '.home-sentence-thai' ? thaiLine : null;
    },
    appendChild(child) { this.children.push(child); },
  };
}

const fakeDocument = {
  createElement(tagName) {
    return { tagName: tagName.toUpperCase(), className: '', textContent: '' };
  },
};

test('daily sentence deep link safely encodes the existing card contract', () => {
  const href = buildDailySentenceHref('gid-123', 'ไป เชียงใหม่');
  assert.equal(new URLSearchParams(href.slice(1)).get('card'), 'gid-123:ไป เชียงใหม่');
  assert.match(href, /^\?card=/);
  assert.ok(!href.includes(' '));
});

test('daily sentence creates a link only for the Chinese translation', () => {
  const box = sentenceBox();
  fillDailySentence(box, {
    lesson: { id: 'lesson-1' },
    card: { thai: 'ฉันจะไปเชียงใหม่พรุ่งนี้', zh: '我明天要去清邁' },
  }, fakeDocument);

  assert.equal(box.thaiLine.textContent, 'ฉันจะไปเชียงใหม่พรุ่งนี้');
  assert.equal(box.children.length, 1);
  assert.equal(box.children[0].tagName, 'A');
  assert.equal(box.children[0].className, 'home-sentence-zh');
  assert.equal(box.children[0].textContent, '我明天要去清邁');
  assert.equal(
    new URLSearchParams(box.children[0].href.slice(1)).get('card'),
    'lesson-1:ฉันจะไปเชียงใหม่พรุ่งนี้',
  );
});

test('missing lesson id keeps the Chinese translation non-clickable', () => {
  const box = sentenceBox();
  fillDailySentence(box, {
    lesson: {},
    card: { thai: 'ฉันจะไปเชียงใหม่พรุ่งนี้', zh: '我明天要去清邁' },
  }, fakeDocument);

  assert.equal(box.children[0].tagName, 'DIV');
  assert.equal(box.children[0].href, undefined);
});

test('missing Thai leaves the placeholder and appends no translation', () => {
  const box = sentenceBox();
  const filled = fillDailySentence(box, {
    lesson: { id: 'lesson-1' },
    card: { thai: '', zh: '我明天要去清邁' },
  }, fakeDocument);

  assert.equal(filled, false);
  assert.equal(box.thaiLine.textContent, '…');
  assert.equal(box.children.length, 0);
});

test('missing Chinese renders the Thai sentence without a link', () => {
  const box = sentenceBox();
  const filled = fillDailySentence(box, {
    lesson: { id: 'lesson-1' },
    card: { thai: 'ฉันจะไปเชียงใหม่พรุ่งนี้', zh: '' },
  }, fakeDocument);

  assert.equal(filled, true);
  assert.equal(box.thaiLine.textContent, 'ฉันจะไปเชียงใหม่พรุ่งนี้');
  assert.equal(box.children.length, 0);
});

test('daily sentence appears before the home task list', () => {
  const sentenceIndex = homeSource.indexOf('<div class="home-sentence"');
  const tasksIndex = homeSource.indexOf('<div class="home-tasks"');
  assert.ok(sentenceIndex >= 0, 'daily sentence block should exist');
  assert.ok(tasksIndex > sentenceIndex, 'daily sentence should render before tasks');
});

test('home wires the third dialogue game as an enabled task', () => {
  assert.match(homeSource, /import \* as dialogueGame from '\.\/game-dialogue\.js'/);
  assert.match(homeSource, /doneGameIds\.has\('dialog'\)/);
  assert.match(homeSource, /data-home-task-btn="3"/);
  assert.doesNotMatch(homeSource, /data-home-task="3"[\s\S]{0,400}disabled type="button">準備中/);
});

test('next-game hero falls back when dialogue data is unavailable', () => {
  assert.match(homeSource, /else if \(!task3Done && state\.dialogues\.length\) startDialogue\(\);/);
  assert.match(homeSource, /else startListen\(\);/);
});
