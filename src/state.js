/* 應用狀態與持久化。所有 runtime 狀態集中在 state 物件；
   settings 跟 progress 寫進 localStorage，重新開啟能還原。 */

export const STORAGE_KEY = 'thai-review-v1';
export const LESSONS_CACHE_KEY = 'thai-review-lessons-v1';      // 舊版（full cache）
export const MANIFEST_CACHE_KEY = 'thai-review-manifest-v1';    // 新版（只 tab 列表）
export const LESSON_CACHE_PREFIX = 'thai-review-lesson-';       // 新版（單堂 cards）

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
  mode: 'card',              // 'card'（泰→中）| 'reverse'（中→泰）| 'listen'
  cardIndex: 0,
  flipped: false,
  progress: {},              // { "lessonId:thai": "good"|"ok"|"bad" }
  favorites: {},             // { "thai": 1 }
  collapsed: {},             // { "初-2": true } → 初級 2 章節收合中
  searchQuery: '',           // 搜尋虛擬課程用（不存 localStorage）
  settings: {
    sheetInput: '',          // sheet URL / ID / csv URL
    rate: 1,
    repeat: 3,
    gap: 2,                  // number | 'auto'
    theme: 'dark',           // 'auto' | 'dark' | 'light'（預設鎖深色）
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
    state.favorites = s.favorites || {};
    state.collapsed = s.collapsed || {};
    state.currentLessonId = s.currentLessonId || null;
    state.mode = s.mode || 'card';
  } catch (e) {
    // 忽略損毀的 localStorage
  }
}

export function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    settings: state.settings,
    progress: state.progress,
    favorites: state.favorites,
    collapsed: state.collapsed,
    currentLessonId: state.currentLessonId,
    mode: state.mode,
  }));
}

export function isFavorite(card) {
  return !!state.favorites[card?.thai];
}

export function toggleFavorite(card) {
  if (!card) return;
  const key = card.thai;
  if (state.favorites[key]) delete state.favorites[key];
  else state.favorites[key] = 1;
  saveState();
}

export function favoriteCount() {
  return Object.keys(state.favorites).length;
}

export function currentLesson() {
  if (state.currentLessonId === '__ALL__') {
    const all = { id: '__ALL__', title: '全部混合', cards: [] };
    for (const l of state.lessons) {
      for (const c of l.cards) all.cards.push({ ...c, _lessonId: l.id });
    }
    return all;
  }
  if (state.currentLessonId === '__FAV__') {
    const fav = { id: '__FAV__', title: '⭐ 收藏', cards: [] };
    for (const l of state.lessons) {
      for (const c of l.cards) {
        if (state.favorites[c.thai]) fav.cards.push({ ...c, _lessonId: l.id });
      }
    }
    return fav;
  }
  if (state.currentLessonId === '__SEARCH__') {
    const q = (state.searchQuery || '').trim().toLowerCase();
    const res = { id: '__SEARCH__', title: '🔍 ' + (q || '搜尋'), cards: [] };
    if (q) {
      for (const l of state.lessons) {
        for (const c of l.cards) {
          if (
            (c.thai || '').toLowerCase().includes(q) ||
            (c.zh || '').toLowerCase().includes(q) ||
            (c.karaoke || '').toLowerCase().includes(q)
          ) res.cards.push({ ...c, _lessonId: l.id });
        }
      }
    }
    return res;
  }
  return state.lessons.find(l => l.id === state.currentLessonId) || state.lessons[0];
}

export function filteredCards() {
  const lesson = currentLesson();
  return lesson ? lesson.cards : [];
}

/* 以 card.thai 當 key，這樣打亂順序或換課不會弄丟評分。 */
function progKey(cardOrIdx) {
  const lessonId = state.currentLessonId || 'x';
  if (typeof cardOrIdx === 'number') {
    const cards = currentLesson()?.cards || [];
    const c = cards[cardOrIdx];
    return c ? lessonId + ':' + c.thai : lessonId + ':idx:' + cardOrIdx;
  }
  return lessonId + ':' + cardOrIdx.thai;
}

export function gradeOf(idxOrCard) {
  return state.progress[progKey(idxOrCard)];
}

export function setGrade(idxOrCard, g) {
  const k = progKey(idxOrCard);
  if (g) state.progress[k] = g;
  else delete state.progress[k];
  saveState();
}

/* Fisher-Yates 就地打亂當前課程的 cards 陣列 */
export function shuffleCurrentLesson() {
  const lesson = currentLesson();
  if (!lesson || !lesson.cards.length) return;
  const arr = lesson.cards;
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  state.cardIndex = 0;
  state.flipped = false;
}
