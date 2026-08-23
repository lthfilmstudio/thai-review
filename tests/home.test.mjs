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
      if (selector === '.home-sentence-thai') return thaiLine;
      if (selector === '.home-sentence-zh') {
        return this.children.find(c => c.className === 'home-sentence-zh') || null;
      }
      return null;
    },
    appendChild(child) {
      child.remove = () => {
        const i = this.children.indexOf(child);
        if (i >= 0) this.children.splice(i, 1);
      };
      this.children.push(child);
    },
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

test('filling the same box twice keeps one translation, not two', () => {
  // 今日分頁會 render 兩次（進分頁 + ensureAllLoaded 後），共用同一個 daily
  // sentence promise，兩個 callback 都會塞進當下那個 box。
  const box = sentenceBox();
  const result = {
    lesson: { id: 'lesson-1' },
    card: { thai: 'ฉันจะไปเชียงใหม่พรุ่งนี้', zh: '我明天要去清邁' },
  };
  fillDailySentence(box, result, fakeDocument);
  fillDailySentence(box, result, fakeDocument);

  assert.equal(box.children.length, 1);
  assert.equal(box.children[0].textContent, '我明天要去清邁');
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

/* 2026-08-22：「練功」分頁併進「今日」。這組測試守住合併結果，避免之後又被
   拆回兩個分頁、或漏掉某個入口。 */

test('練功 mode is fully removed — no home mode entry points remain', async () => {
  const indexHtml = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(indexHtml, /data-mode="home"/);
  assert.doesNotMatch(indexHtml, /data-drawer-mode="home"/);
  assert.doesNotMatch(indexHtml, /練功/);

  const uiSource = await readFile(new URL('../src/ui.js', import.meta.url), 'utf8');
  assert.doesNotMatch(uiSource, /renderHomeMode/);

  const appSource = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(appSource, /state\.mode === 'home'/);
  assert.doesNotMatch(appSource, /m === 'home'/);
});

test('今日 is the landing tab: first in every mode picker and the mode init falls back to it', async () => {
  const indexHtml = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  for (const cls of ['mode-tab', 'mp-btn', 'drawer-item']) {
    const firstMode = indexHtml.match(new RegExp(`class="${cls}[^"]*"[^>]*data-(?:drawer-)?mode="([^"]+)"`));
    assert.equal(firstMode?.[1], 'today', `${cls} 的第一顆該是今日`);
  }

  const appSource = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
  assert.match(appSource, /state\.mode = 'today';/);
});

test('today.js owns the merged shell and delegates the action panel to home.js', async () => {
  const todaySource = await readFile(new URL('../src/today.js', import.meta.url), 'utf8');
  // 遊戲進行中要整頁接管；離開遊戲或從行動面板 rerender 時都必須保留同一 storage port。
  assert.match(todaySource, /renderActiveGame\(el, \(\) => renderTodayMode\(el, storage\)\)/);
  assert.match(todaySource, /homePanelHtml\(/);
  assert.match(todaySource, /wireHomePanel\(el, todayLog, \(\) => renderTodayMode\(el, storage\)\)/);
  // home.js 不能再反過來 import today.js，否則循環相依會變成真的取值循環
  assert.doesNotMatch(homeSource, /from '\.\/today\.js'/);
});
