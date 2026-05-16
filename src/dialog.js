/* 對話模式：拿這堂課、收藏或指定評分的單字隨機抽 N 個 → AI 編 5-8 turn 對話 → 顯示。
   API：lth-tts-proxy /dialog
   Cache：Worker 端 KV 7 天；client 不另外 cache（reuse worker cache）
   每行對話可點 ▶ 或泰文整段唸。 */

import { state, isFavorite, saveState } from './state.js';
import { speakCard } from './tts.js';
import { escapeHtml } from './ui.js';

const DIALOG_API = 'https://thai-tts.lthfilmstudio.workers.dev/dialog';
const DEFAULT_PICK_COUNT = 6;

const SVG_PLAY = '<svg width="10" height="10" viewBox="0 0 12 12"><path d="M3 2 L9 6 L3 10 Z" fill="currentColor"/></svg>';
const SVG_REFRESH = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>';
const SVG_SPARK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/></svg>';

/* 從候選池隨機抽 N 個（去重）。pool 是 cards 陣列。 */
function pickRandomWords(pool, n) {
  if (!pool || !pool.length) return [];
  const seen = new Set();
  const result = [];
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  for (const c of shuffled) {
    const w = (c.thai || '').split('/')[0].trim(); // ครับ/ค่ะ → 取前段
    if (!w || seen.has(w)) continue;
    seen.add(w);
    result.push(w);
    if (result.length >= n) break;
  }
  return result;
}

function progressGrade(lesson, card) {
  const key = `${lesson.id}:${card._sourceThai || card.thai || ''}`;
  const entry = state.progress[key];
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry === 'object') return entry.grade;
  return '';
}

/* 取候選池：
   - source = 'lesson' → 當前課程的所有卡片
   - source = 'fav'    → 所有 isFavorite=true 的卡片（跨課程）
   - source = 'bad'    → 所有評為「差」的卡片（跨課程）
   - source = 'ok'     → 所有評為「可以」的卡片（跨課程） */
function getPool(source) {
  if (source === 'fav' || source === 'bad' || source === 'ok') {
    const all = [];
    for (const lesson of state.lessons || []) {
      for (const card of lesson.cards || []) {
        if (source === 'fav' && isFavorite(card)) all.push(card);
        if ((source === 'bad' || source === 'ok') && progressGrade(lesson, card) === source) all.push(card);
      }
    }
    return all;
  }
  // lesson
  const lesson = state.lessons?.find((l) => l.id === state.currentLessonId);
  return lesson?.cards || [];
}

async function fetchDialog(words) {
  const res = await fetch(DIALOG_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ words }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  const data = await res.json();
  if (!data.lines || !Array.isArray(data.lines) || !data.lines.length) {
    throw new Error('回傳對話格式異常');
  }
  return data.lines;
}

/* 主 render：從零畫整個對話面板（替代原本的卡片區）。 */
export function renderDialogMode(el, _ignoredCards) {
  const source = ['lesson', 'fav', 'bad', 'ok'].includes(state.settings.dialogSource)
    ? state.settings.dialogSource
    : 'lesson';

  const lessonName = state.lessons?.find((l) => l.id === state.currentLessonId)?.title || '—';
  const favCount = countFavorites();
  const badCount = countByGrade('bad');
  const okCount = countByGrade('ok');

  el.innerHTML = `
    <div class="dialog-wrap">
      <div class="dialog-header">
        <div class="dialog-title">
          ${SVG_SPARK}<span>情境對話</span>
        </div>
        <div class="dialog-source">
          <button class="dlg-src-btn${source === 'lesson' ? ' on' : ''}" data-src="lesson">
            這堂課<span class="dlg-src-meta">${escapeHtml(lessonName)}</span>
          </button>
          <button class="dlg-src-btn${source === 'fav' ? ' on' : ''}" data-src="fav">
            我的收藏<span class="dlg-src-meta">${favCount} 個字</span>
          </button>
          <button class="dlg-src-btn${source === 'bad' ? ' on' : ''}" data-src="bad">
            差<span class="dlg-src-meta">${badCount} 個字</span>
          </button>
          <button class="dlg-src-btn${source === 'ok' ? ' on' : ''}" data-src="ok">
            可以<span class="dlg-src-meta">${okCount} 個字</span>
          </button>
        </div>
      </div>

      <div class="dialog-status" id="dlgStatus"></div>
      <div class="dialog-words" id="dlgWords"></div>
      <div class="dialog-lines" id="dlgLines"></div>

      <div class="dialog-foot">
        <button class="dlg-go-btn" id="dlgGo">
          ${SVG_REFRESH}<span>生成對話</span>
        </button>
      </div>
    </div>
  `;

  // 切換 source
  el.querySelectorAll('.dlg-src-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const src = btn.dataset.src;
      state.settings.dialogSource = src;
      saveState();
      el.querySelectorAll('.dlg-src-btn').forEach((x) => x.classList.toggle('on', x.dataset.src === src));
    });
  });

  // 生成 / 換一組
  document.getElementById('dlgGo').addEventListener('click', () => generate());

  // 進來不自動跑；先讓使用者選字源，按下方「生成對話」才開始（避免每次進來就自動消耗 API）
  document.getElementById('dlgStatus').innerHTML =
    `<div class="dlg-empty">選好字源後，按下方「生成對話」開始。</div>`;

  async function generate() {
    const src = state.settings.dialogSource || 'lesson';
    const pool = getPool(src);
    const words = pickRandomWords(pool, DEFAULT_PICK_COUNT);

    const statusEl = document.getElementById('dlgStatus');
    const wordsEl = document.getElementById('dlgWords');
    const linesEl = document.getElementById('dlgLines');
    const goBtn = document.getElementById('dlgGo');

    if (!words.length) {
      const emptyMsg = {
        fav: '收藏還沒有單字。<br>到卡片模式點 ☆ 收藏 6 個以上再回來。',
        bad: '目前沒有評為「差」的單字。<br>先在複習頁按幾張「差」再回來。',
        ok: '目前沒有評為「可以」的單字。<br>先在複習頁按幾張「可以」再回來。',
        lesson: '這堂課沒有可用單字。',
      };
      statusEl.innerHTML = `<div class="dlg-empty">${emptyMsg[src] || emptyMsg.lesson}</div>`;
      wordsEl.innerHTML = '';
      linesEl.innerHTML = '';
      return;
    }
    if (words.length < 3) {
      statusEl.innerHTML = `<div class="dlg-empty">字數太少（${words.length} 個），對話會很單薄。<br>建議收藏到 6 個以上再用。</div>`;
      wordsEl.innerHTML = '';
      linesEl.innerHTML = '';
      return;
    }

    statusEl.innerHTML = '';
    wordsEl.innerHTML = words
      .map((w) => `<span class="dlg-chip">${escapeHtml(w)}</span>`)
      .join('');
    linesEl.innerHTML = '<div class="dlg-loading">AI 編對話中… 約 3-5 秒</div>';
    goBtn.disabled = true;
    goBtn.innerHTML = `${SVG_REFRESH}<span>產生中…</span>`;

    try {
      const lines = await fetchDialog(words);
      linesEl.innerHTML = lines
        .map(
          (ln, i) => `
            <div class="dlg-line dlg-${ln.speaker === 'B' ? 'b' : 'a'}">
              <div class="dlg-avatar">${ln.speaker || 'A'}</div>
              <div class="dlg-bubble">
                <div class="dlg-thai-row">
                  <button class="dlg-play" data-i="${i}" aria-label="播放">${SVG_PLAY}</button>
                  <span class="dlg-thai" data-i="${i}">${escapeHtml(ln.thai || '')}</span>
                </div>
                <div class="dlg-karaoke">${escapeHtml(ln.karaoke || '')}</div>
                <div class="dlg-zh">${escapeHtml(ln.zh || '')}</div>
              </div>
            </div>
          `,
        )
        .join('');

      // 喇叭 + 點泰文都唸
      linesEl.querySelectorAll('.dlg-play').forEach((b) => {
        b.addEventListener('click', () => {
          const i = Number(b.dataset.i);
          speakCard({ thai: lines[i]?.thai || '' });
        });
      });
      linesEl.querySelectorAll('.dlg-thai').forEach((s) => {
        s.addEventListener('click', () => {
          const i = Number(s.dataset.i);
          speakCard({ thai: lines[i]?.thai || '' });
        });
      });

      goBtn.innerHTML = `${SVG_REFRESH}<span>換一組</span>`;
    } catch (err) {
      linesEl.innerHTML = `<div class="dlg-error">產生失敗：${escapeHtml(err.message || '請稍後再試')}</div>`;
      goBtn.innerHTML = `${SVG_REFRESH}<span>重試</span>`;
    } finally {
      goBtn.disabled = false;
    }
  }
}

function countFavorites() {
  let n = 0;
  for (const lesson of state.lessons || []) {
    for (const card of lesson.cards || []) {
      if (isFavorite(card)) n++;
    }
  }
  return n;
}

function countByGrade(grade) {
  let n = 0;
  for (const lesson of state.lessons || []) {
    for (const card of lesson.cards || []) {
      if (progressGrade(lesson, card) === grade) n++;
    }
  }
  return n;
}
