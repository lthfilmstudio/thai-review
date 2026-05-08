/* AI 造句模組。
   主路徑：lth-tts-proxy Worker /sentence → Gemini 2.5 Flash → 3 個泰文例句
   client 端 cache：同一個詞短期內已造過就不再 fetch（in-memory + localStorage 24h）。
   失敗時顯示錯誤訊息，不影響主卡片功能。 */

import { speakCard } from './tts.js';
import { escapeHtml } from './ui.js';

const SENTENCE_API = 'https://thai-tts.lthfilmstudio.workers.dev/sentence';
const SENTENCE_LS_PREFIX = 'thai-review-sentence-';
const SENTENCE_LS_TTL_MS = 24 * 60 * 60 * 1000; // 24 小時

const SVG_PLAY = '<svg width="10" height="10" viewBox="0 0 12 12"><path d="M3 2 L9 6 L3 10 Z" fill="currentColor"/></svg>';
const SVG_SPARK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/></svg>';

const memCache = new Map(); // word → sentences[]

function lsGet(word) {
  try {
    const raw = localStorage.getItem(SENTENCE_LS_PREFIX + word);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (Date.now() - obj.ts > SENTENCE_LS_TTL_MS) {
      localStorage.removeItem(SENTENCE_LS_PREFIX + word);
      return null;
    }
    return obj.sentences;
  } catch {
    return null;
  }
}

function lsSet(word, sentences) {
  try {
    localStorage.setItem(
      SENTENCE_LS_PREFIX + word,
      JSON.stringify({ ts: Date.now(), sentences }),
    );
  } catch {
    // localStorage 滿了忽略，下次再 fetch 就好
  }
}

export async function fetchSentences(word, count = 3) {
  if (!word) return [];
  if (memCache.has(word)) return memCache.get(word);
  const ls = lsGet(word);
  if (ls) {
    memCache.set(word, ls);
    return ls;
  }
  const res = await fetch(SENTENCE_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ word, count }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!data.sentences || !Array.isArray(data.sentences)) {
    throw new Error('回傳格式異常');
  }
  memCache.set(word, data.sentences);
  lsSet(word, data.sentences);
  return data.sentences;
}

/* 把例句陣列 render 成 HTML 字串。每句包含可播放的泰文 + 拼音 + 中譯。 */
export function renderSentencesHtml(sentences) {
  return sentences
    .map(
      (s, i) => `
        <div class="sent-item" data-i="${i}">
          <div class="sent-thai-row">
            <button class="sent-play" aria-label="播放" data-i="${i}">${SVG_PLAY}</button>
            <span class="sent-thai">${escapeHtml(s.thai || '')}</span>
          </div>
          <div class="sent-karaoke">${escapeHtml(s.karaoke || '')}</div>
          <div class="sent-zh">${escapeHtml(s.zh || '')}</div>
        </div>
      `,
    )
    .join('');
}

/* 替按鈕 + 容器接行為：點按鈕 → fetch → render。
   container 是放例句的 div、btn 是觸發按鈕。 */
export function wireSentenceButton(btn, container, word) {
  btn.addEventListener('click', async (e) => {
    e.stopPropagation(); // 不要觸發卡片翻面
    if (!word) return;

    btn.disabled = true;
    btn.innerHTML = `${SVG_SPARK}<span>載入中…</span>`;
    container.innerHTML = '<div class="sent-loading">AI 造句中…</div>';

    try {
      const sentences = await fetchSentences(word, 3);
      container.innerHTML = renderSentencesHtml(sentences);
      btn.style.display = 'none'; // 載完就把按鈕收起來

      // 為每個 sent-play 接 click → 唸該句
      container.querySelectorAll('.sent-play').forEach((playBtn) => {
        playBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          const idx = Number(playBtn.dataset.i);
          const card = { thai: sentences[idx]?.thai || '' };
          speakCard(card);
        });
      });

      // 點泰文整段也唸
      container.querySelectorAll('.sent-thai').forEach((span, idx) => {
        span.addEventListener('click', (ev) => {
          ev.stopPropagation();
          speakCard({ thai: sentences[idx]?.thai || '' });
        });
      });

      // 容器吃掉所有 click 不要冒泡到卡片（避免翻面）
      container.addEventListener('click', (ev) => ev.stopPropagation());
    } catch (err) {
      container.innerHTML = `<div class="sent-error">造句失敗：${escapeHtml(err.message || '請稍後再試')}</div>`;
      btn.disabled = false;
      btn.innerHTML = `${SVG_SPARK}<span>重試</span>`;
    }
  });
}

export const SVG_SPARK_ICON = SVG_SPARK;
