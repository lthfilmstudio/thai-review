/* 應用狀態與持久化。所有 runtime 狀態集中在 state 物件；
   settings 跟 progress 寫進 localStorage，重新開啟能還原。 */

import { nextReview, countDue, getDueCards } from './srs.js';

export const STORAGE_KEY = 'thai-review-v1';
export const LESSONS_CACHE_KEY = 'thai-review-lessons-v1';      // 舊版（full cache）
export const MANIFEST_CACHE_KEY = 'thai-review-manifest-v1';    // 新版（只 tab 列表）
export const LESSON_CACHE_PREFIX = 'thai-review-lesson-';       // 新版（單堂 cards）
export const SYNC_TIME_KEY = 'thai-review-last-sync-v1';        // 上次手動同步成功時間

/* ===== 舊版：整份 lessons cache（保留相容，其他非 publish-to-web 模式還在用） ===== */
export function saveLessonsCache(url, lessons) {
  try {
    localStorage.setItem(LESSONS_CACHE_KEY, JSON.stringify({ url, ts: Date.now(), lessons }));
  } catch (e) {
    console.warn('lessons cache save failed:', e.message);
  }
}

export function loadLessonsCache(url) {
  try {
    const raw = localStorage.getItem(LESSONS_CACHE_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw);
    if (c.url !== url) return null;
    return { lessons: c.lessons, ts: c.ts };
  } catch {
    return null;
  }
}

export function clearLessonsCache() {
  try {
    localStorage.removeItem(LESSONS_CACHE_KEY);
    localStorage.removeItem(MANIFEST_CACHE_KEY);
    Object.keys(localStorage).forEach(k => {
      if (k.startsWith(LESSON_CACHE_PREFIX)) localStorage.removeItem(k);
    });
  } catch {}
}

/* ===== 新版 lazy：manifest（tab 列表） + 單堂 cards ===== */
export function saveManifest(url, manifest) {
  try {
    localStorage.setItem(MANIFEST_CACHE_KEY, JSON.stringify({ url, ts: Date.now(), ...manifest }));
  } catch (e) {
    console.warn('manifest save failed:', e.message);
  }
}

export function loadManifest(url) {
  try {
    const raw = localStorage.getItem(MANIFEST_CACHE_KEY);
    if (!raw) return null;
    const m = JSON.parse(raw);
    if (m.url !== url) return null;
    return m;
  } catch {
    return null;
  }
}

export function saveLessonCards(gid, cards) {
  try {
    localStorage.setItem(LESSON_CACHE_PREFIX + gid, JSON.stringify({ ts: Date.now(), cards }));
  } catch (e) {
    console.warn('lesson cards save failed:', gid, e.message);
  }
}

export function loadLessonCards(gid) {
  try {
    const raw = localStorage.getItem(LESSON_CACHE_PREFIX + gid);
    if (!raw) return null;
    return JSON.parse(raw).cards;
  } catch {
    return null;
  }
}

/* ===== 上次同步時間（按重新同步 Sheet 成功才寫） ===== */
export function setLastSync(url) {
  try {
    localStorage.setItem(SYNC_TIME_KEY, JSON.stringify({ url, ts: Date.now() }));
  } catch {}
}

export function getLastSync(url) {
  try {
    const raw = localStorage.getItem(SYNC_TIME_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (s.url !== url) return null;
    return s.ts;
  } catch {
    return null;
  }
}

export function formatLastSync(ts) {
  if (!ts) return '尚未同步';
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear()
    && d.getMonth() === now.getMonth()
    && d.getDate() === now.getDate();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (sameDay) return `今天 ${hh}:${mm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
}

/* 預設資料來源：Nalin 的泰文課 Sheet（整份文件發佈）。
   使用者未在設定填自訂 URL 時，就用這個。 */
export const DEFAULT_SHEET_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQzG3dKsEvQSsMxu4d1cwTMyvzUaq7kPK2Nwlg2qVZvzEmVhO4IS6D9lPirt4-cRbfokXbQNgvBWo9C/pubhtml';

export const DEMO_LESSONS = [
  { id: 'demo-12', title: '第 12 堂（示範）', cards: [
    { thai: 'สวัสดีครับ', karaoke: 'sà-wàt-dee kráp', zh: '你好（男生用）', type: 'word', note: '男性使用' },
    { thai: 'ขอบคุณ', karaoke: 'kòp-kun', zh: '謝謝', type: 'word' },
    { thai: 'ไม่เป็นไร', karaoke: 'mâi pen rai', zh: '沒關係／別在意', type: 'word' },
    { thai: 'ขอโทษครับ', karaoke: 'kŏr-tôht kráp', zh: '對不起', type: 'word' },
    { thai: 'ผมชื่อจอห์น', karaoke: 'pŏm chûe John', zh: '我叫 John', type: 'sentence' },
    { thai: 'คุณสบายดีไหม', karaoke: 'kun sà-baai dee măi', zh: '你好嗎？', type: 'sentence' },
  ]},
  { id: 'demo-11', title: '第 11 堂（示範）', cards: [
    { thai: 'กินข้าว', karaoke: 'gin kâao', zh: '吃飯', type: 'word' },
    { thai: 'อร่อยมาก', karaoke: 'à-ròi mâak', zh: '很好吃', type: 'sentence' },
    { thai: 'น้ำเปล่า', karaoke: 'náam bplào', zh: '白開水', type: 'word' },
    { thai: 'ไปเที่ยว', karaoke: 'bpai tîeow', zh: '去玩／去旅遊', type: 'word' },
  ]},
];

export const state = {
  lessons: [],
  currentLessonId: null,
  mode: 'card',              // 'card' | 'reverse' | 'listen' | 'dialog' | 'srs' | 'today'
  srsToggle: false,          // card mode 下「只看待複習」開關（不存 localStorage）
  cardIndex: 0,
  flipped: false,
  progress: {},              // { "lessonId:thai": { grade, nextReviewAt, interval, easeFactor, reps, ... } }
  favorites: {},             // { "thai": 1 }
  edits: {},                 // { "lessonId:thai": { thai, karaoke, zh, note } }，只存在本機
  collapsed: {},             // { "初-2": true } → 初級 2 章節收合中
  searchQuery: '',           // 搜尋虛擬課程用（不存 localStorage）
  listFilter: 'fav',         // 'fav' | 'bad' | 'ok' | 'good'
  listOrder: 'thai',         // 'thai' | 'zh'，清單卡片主要顯示語言
  settings: {
    sheetInput: '',          // sheet URL / ID / csv URL
    rate: 1,
    repeat: 3,
    gap: 2,                  // number | 'auto'
    theme: 'dark',           // 'auto' | 'dark' | 'light'（預設鎖深色）
    voice: 'th-TH-Neural2-C',// GCP TTS voice id（thai-tts-proxy 走 Neural2 / Chirp3-HD）
    dialogSource: 'lesson',  // 'lesson' | 'fav' | 'bad' | 'ok' — 對話模式抽字來源
  },
  listen: {
    playing: false,
    phase: 'idle',
    repeatCount: 0,
    rafId: null,
    timeoutId: null,
  },
};

export function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const s = JSON.parse(raw);
    Object.assign(state.settings, s.settings || {});
    state.progress = s.progress || {};
    const migrated = migrateProgress(state.progress);
    state.favorites = s.favorites || {};
    state.edits = s.edits || {};
    state.collapsed = s.collapsed || {};
    state.currentLessonId = s.currentLessonId || null;
    state.mode = s.mode || 'card';
    state.cardIndex = typeof s.cardIndex === 'number' ? s.cardIndex : 0;
    state.listFilter = s.listFilter || 'fav';
    state.listOrder = s.listOrder || 'thai';
    // 有 migrate 到資料的話立刻寫回，避免 lazy 遺留舊格式
    if (migrated) saveState();
  } catch (e) {
    // 忽略損毀的 localStorage
  }
}

/* 把舊版 string grade 轉成 SRS 物件。
   interval=0 / nextReviewAt=0 表示「未排程」（即 due），下次評分才正式進 SRS 軌道。
   這樣升級瞬間不會讓所有舊熟字爆量 due，但仍會跑到 SRS 隊伍裡待重新評估。
   回傳是否有任何項目被 migrate（用來決定要不要立刻 saveState）。 */
function migrateProgress(progress) {
  let touched = false;
  for (const k in progress) {
    const v = progress[k];
    if (typeof v === 'string') {
      progress[k] = {
        grade: v,
        reviewedAt: 0,
        nextReviewAt: 0,
        interval: 0,
        easeFactor: 2.5,
        reps: 0,
        updatedAt: 0,
        deviceId: '',
      };
      touched = true;
    }
  }
  return touched;
}

export function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    settings: state.settings,
    progress: state.progress,
    favorites: state.favorites,
    edits: state.edits,
    collapsed: state.collapsed,
    currentLessonId: state.currentLessonId,
    mode: state.mode,
    cardIndex: state.cardIndex,
    listFilter: state.listFilter,
    listOrder: state.listOrder,
  }));
}

export function sourceThai(card) {
  return card?._sourceThai || card?.thai || '';
}

export function cardKey(card, fallbackLessonId = state.currentLessonId) {
  const lessonId = card?._lessonId || fallbackLessonId || 'x';
  return `${lessonId}:${sourceThai(card)}`;
}

export function applyCardEdit(card, lessonId) {
  if (!card) return card;
  const source = sourceThai(card);
  const key = `${lessonId || card._lessonId || state.currentLessonId || 'x'}:${source}`;
  const edited = state.edits[key];
  return {
    ...card,
    ...(edited || {}),
    _sourceThai: source,
    _lessonId: lessonId || card._lessonId,
    _cardKey: key,
    _edited: !!edited,
  };
}

export function saveCardEdit(card, patch) {
  if (!card) return;
  const key = card._cardKey || cardKey(card);
  const cleaned = {};
  for (const field of ['thai', 'karaoke', 'zh', 'note']) {
    cleaned[field] = (patch[field] || '').trim();
  }
  state.edits[key] = cleaned;
  saveState();
}

export function clearCardEdit(card) {
  if (!card) return;
  const key = card._cardKey || cardKey(card);
  delete state.edits[key];
  saveState();
}

export function isFavorite(card) {
  return !!state.favorites[sourceThai(card)];
}

export function toggleFavorite(card) {
  if (!card) return;
  const key = sourceThai(card);
  if (state.favorites[key]) delete state.favorites[key];
  else state.favorites[key] = 1;
  saveState();
}

export function favoriteCount() {
  return Object.keys(state.favorites).length;
}

export function currentLesson() {
  if (state.currentLessonId === '__ALL__') {
    return { id: '__ALL__', title: '全部混合', cards: allCardsWithLessonId() };
  }
  if (state.currentLessonId === '__FAV__') {
    const fav = { id: '__FAV__', title: '⭐ 收藏', cards: [] };
    for (const c of allCardsWithLessonId()) {
      if (isFavorite(c)) fav.cards.push(c);
    }
    return fav;
  }
  if (state.currentLessonId === '__SEARCH__') {
    const q = (state.searchQuery || '').trim().toLowerCase();
    const res = { id: '__SEARCH__', title: '🔍 ' + (q || '搜尋'), cards: [] };
    if (q) {
      for (const l of state.lessons) {
        for (const raw of l.cards) {
          const c = applyCardEdit(raw, l.id);
          if (
            (c.thai || '').toLowerCase().includes(q) ||
            (c.zh || '').toLowerCase().includes(q) ||
            (c.karaoke || '').toLowerCase().includes(q)
          ) res.cards.push(c);
        }
      }
    }
    return res;
  }
  const lesson = state.lessons.find(l => l.id === state.currentLessonId) || state.lessons[0];
  if (!lesson) return lesson;
  return { ...lesson, cards: lesson.cards.map(c => applyCardEdit(c, lesson.id)) };
}

/* SRS active：mode=srs，或 (mode=card/reverse 且 srsToggle 開)。
   active 時 filteredCards 自動只回 due 卡並按 nextReviewAt 排序。 */
export function isSrsActive() {
  if (state.mode === 'srs') return true;
  if ((state.mode === 'card' || state.mode === 'reverse') && state.srsToggle) return true;
  return false;
}

export function filteredCards() {
  const lesson = currentLesson();
  if (!lesson) return [];
  if (!isSrsActive()) return lesson.cards;
  // 真實課程的 cards 沒有 _lessonId，補上才能跑 SRS key
  const tagged = lesson.cards.map(c => c._lessonId ? c : { ...c, _lessonId: lesson.id });
  return getDueCards(tagged, state.progress);
}

/* 以「真實課程 id : card.thai」當 key，跨虛擬課程（__ALL__/__FAV__/__SEARCH__）也穩定。
   虛擬課程的 cards 已帶 _lessonId（見 currentLesson()）；真實課程 fallback 到 currentLessonId。 */
function progKey(cardOrIdx) {
  let card;
  if (typeof cardOrIdx === 'number') {
    const cards = currentLesson()?.cards || [];
    card = cards[cardOrIdx];
    if (!card) return (state.currentLessonId || 'x') + ':idx:' + cardOrIdx;
  } else {
    card = cardOrIdx;
  }
  return cardKey(card);
}

export function gradeOf(idxOrCard) {
  const v = state.progress[progKey(idxOrCard)];
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') return v.grade;
  return undefined;
}

export function srsEntryOf(idxOrCard) {
  const v = state.progress[progKey(idxOrCard)];
  return (v && typeof v === 'object') ? v : null;
}

export function setGrade(idxOrCard, gradeStr) {
  const k = progKey(idxOrCard);
  if (!gradeStr) {
    delete state.progress[k];
  } else {
    const prev = state.progress[k];
    const prevObj = (prev && typeof prev === 'object') ? prev : {};
    state.progress[k] = nextReview(gradeStr, prevObj);
  }
  saveState();
}

/* 攤平 state.lessons 成單一 cards 陣列，每張都帶 _lessonId（給 SRS 跨課程查詢用）。
   未載入的課程會被 ensureAllLoaded 補上，這裡單純取現有 cards。 */
export function allCardsWithLessonId() {
  const out = [];
  for (const l of state.lessons) {
    for (const c of l.cards) {
      out.push(applyCardEdit(c, l.id));
    }
  }
  return out;
}

export function findCardByKey(key) {
  for (const l of state.lessons) {
    for (let i = 0; i < l.cards.length; i++) {
      const card = applyCardEdit(l.cards[i], l.id);
      if (card._cardKey === key) return { card, lessonId: l.id, index: i, lessonTitle: l.title };
    }
  }
  return null;
}

export function getDueCount(lessonId) {
  return countDue(allCardsWithLessonId(), state.progress, lessonId);
}

/* Fisher-Yates 就地打亂當前課程的 cards 陣列 */
export function shuffleCurrentLesson() {
  const lesson = ['__ALL__', '__FAV__', '__SEARCH__'].includes(state.currentLessonId)
    ? currentLesson()
    : state.lessons.find(l => l.id === state.currentLessonId);
  if (!lesson || !lesson.cards.length) return;
  const arr = lesson.cards;
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  state.cardIndex = 0;
  state.flipped = false;
}
