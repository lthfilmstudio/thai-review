/* CSV 抓取 + 多工作表自動載入。
   支援三種輸入：
   1. 多行 CSV URL（每行一個 tab 的 publish-to-web CSV）→ 每個 URL 一堂課
   2. 單一 publish-to-web HTML URL（整份 Sheet 都發佈）→ 自動列出所有 tab
   3. 單一 CSV URL → 依 CSV 內的 lesson 欄分組（原型行為）
*/

import { applyTtsPromptsToLesson, applyTtsPromptsToLessons } from './tts-prompts.js';
import { isStableCardId } from './card-identity.js';

export const DIALOGUE_SHEET_TITLE = '生活對話';

function isCanonicalCardId(value) {
  return typeof value === 'string'
    && value === value.trim()
    && value === value.toLowerCase()
    && isStableCardId(value);
}

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
      else if (c === '\r') { /* skip */ }
      else cur += c;
    }
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

/* 欄位別名：第一個命中的 header 就用。中文在先因為使用者的 Sheet 大多是中文 header。 */
const COL_ALIASES = {
  thai:      ['泰文', 'thai', 'th'],
  karaoke:   ['泰式karaoke拼音', 'karaoke拼音', '目的達拼音', '拼音', 'karaoke', 'pronunciation'],
  zh:        ['中文', '中文翻譯', '翻譯', 'zh', 'chinese', 'cn'],
  type:      ['類型', 'type', '分類'],
  note:      ['備註', 'note', '說明'],
  audio_url: ['音檔', 'audio_url', 'audio', '音檔網址'],
  lesson:    ['課程', '課', '堂', 'lesson'],
  start_ms:  ['start_ms', 'start', '開始毫秒', '起始毫秒'],
  end_ms:    ['end_ms', 'end', '結束毫秒'],
  card_id:   ['card_id', 'card id', '卡片 id', '卡片id', '卡片ID'],
  scenario_id:    ['情境 id', 'scenario id', 'scenario_id'],
  scenario_title: ['情境名稱', 'scenario title', 'scenario_title'],
  order:          ['順序', 'order', 'turn'],
  speaker:        ['說話者', 'speaker'],
};

function findCol(header, key) {
  const aliases = COL_ALIASES[key] || [key];
  for (const a of aliases) {
    const i = header.indexOf(a.toLowerCase());
    if (i >= 0) return i;
  }
  return -1;
}

export function rowsToCards(rows, { requireCardId = false } = {}) {
  if (!rows.length) return [];
  const header = rows[0].map(h => h.trim().toLowerCase());
  const iT = findCol(header, 'thai');
  const iK = findCol(header, 'karaoke');
  const iZ = findCol(header, 'zh');
  const iType = findCol(header, 'type');
  const iNote = findCol(header, 'note');
  const iAudio = findCol(header, 'audio_url');
  const iLesson = findCol(header, 'lesson');
  const iStart = findCol(header, 'start_ms');
  const iEnd = findCol(header, 'end_ms');
  const iCardId = findCol(header, 'card_id');
  if (iT < 0 || iK < 0 || iZ < 0) {
    throw new Error(`CSV 缺少必要欄位（泰文/拼音/中文）。目前 header：${rows[0].join(' | ')}`);
  }
  if (requireCardId && iCardId < 0) throw new Error('CSV 缺少必要欄位 card_id');
  const toMs = v => {
    const n = Number((v || '').toString().trim());
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  const cards = [];
  const seenCardIds = new Set();
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || !row[iT]) continue;
    const card = {
      thai: (row[iT] || '').trim(),
      karaoke: (row[iK] || '').trim(),
      zh: (row[iZ] || '').trim(),
      type: iType >= 0 ? ((row[iType] || 'word').trim().toLowerCase()) : 'word',
      note: iNote >= 0 ? (row[iNote] || '').trim() : '',
      audio_url: iAudio >= 0 ? (row[iAudio] || '').trim() : '',
      lesson: iLesson >= 0 ? (row[iLesson] || '').trim() : '',
      start_ms: iStart >= 0 ? toMs(row[iStart]) : null,
      end_ms: iEnd >= 0 ? toMs(row[iEnd]) : null,
    };
    const cardId = iCardId >= 0 ? String(row[iCardId] || '').trim() : '';
    if (requireCardId) {
      if (!cardId) throw new Error(`第 ${r + 1} 列缺少 card_id`);
      if (!isCanonicalCardId(cardId)) {
        throw new Error(`第 ${r + 1} 列 card_id 不是 canonical lowercase UUID`);
      }
      if (seenCardIds.has(cardId)) throw new Error(`第 ${r + 1} 列 card_id 重複：${cardId}`);
      seenCardIds.add(cardId);
    }
    if (cardId) {
      card.card_id = cardId;
    }
    cards.push(card);
  }
  return cards;
}

function validateLessonCardIds(lessons) {
  const seen = new Map();
  for (const lesson of lessons || []) {
    const title = String(lesson?.title || lesson?.gid || 'unknown');
    for (let index = 0; index < (lesson?.cards || []).length; index++) {
      const cardId = lesson.cards[index]?.card_id;
      if (!isCanonicalCardId(cardId)) {
        throw new Error(`${title} 第 ${index + 1} 張缺少有效 canonical card_id`);
      }
      if (seen.has(cardId)) {
        throw new Error(`跨分頁 card_id 重複：${cardId}（${seen.get(cardId)} / ${title}）`);
      }
      seen.set(cardId, title);
    }
  }
}

export function parseDialogueRows(rows) {
  if (!rows.length) return [];
  const header = rows[0].map(h => String(h || '').trim().toLowerCase());
  const keys = ['scenario_id', 'scenario_title', 'order', 'speaker', 'thai', 'karaoke', 'zh'];
  const indexes = Object.fromEntries(keys.map(key => [key, findCol(header, key)]));
  const missing = keys.filter(key => indexes[key] < 0);
  if (missing.length) throw new Error(`生活對話分頁缺少欄位：${missing.join(', ')}`);

  const grouped = new Map();
  for (const row of rows.slice(1)) {
    const id = String(row?.[indexes.scenario_id] || '').trim();
    if (!id) continue;
    const order = Number(String(row[indexes.order] || '').trim());
    if (!Number.isInteger(order)) throw new Error(`${id} 有無效順序`);
    if (!grouped.has(id)) {
      grouped.set(id, {
        id,
        title: String(row[indexes.scenario_title] || '').trim(),
        turns: [],
      });
    }
    const title = String(row[indexes.scenario_title] || '').trim();
    if (grouped.get(id).title !== title) throw new Error(`${id} 情境名稱不一致`);
    grouped.get(id).turns.push({
      order,
      speaker: String(row[indexes.speaker] || '').trim(),
      thai: String(row[indexes.thai] || '').trim(),
      karaoke: String(row[indexes.karaoke] || '').trim(),
      zh: String(row[indexes.zh] || '').trim(),
    });
  }

  const dialogues = [...grouped.values()];
  for (const scenario of dialogues) {
    scenario.turns.sort((a, b) => a.order - b.order);
    if (scenario.turns.length !== 6) throw new Error(`${scenario.id} 必須是完整 6 句`);
    if (!scenario.turns.every((turn, index) => turn.order === index + 1)) {
      throw new Error(`${scenario.id} 順序必須是 1 到 6`);
    }
    const expectedSpeakers = ['A', 'B', 'A', 'B', 'A', 'B'];
    if (!scenario.turns.every((turn, index) => turn.speaker === expectedSpeakers[index])) {
      throw new Error(`${scenario.id} 必須 A/B 各 3 句並交替`);
    }
    if (!scenario.title || scenario.turns.some(turn => !turn.thai || !turn.karaoke || !turn.zh)) {
      throw new Error(`${scenario.id} 有空白必填欄位`);
    }
  }
  return dialogues;
}

async function fetchCsvRows(url, { force = false } = {}) {
  const finalUrl = force
    ? url + (url.includes('?') ? '&' : '?') + '_=' + Date.now()
    : url;
  const res = await fetch(finalUrl, force ? { cache: 'no-store' } : {});
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return parseCsv(await res.text());
}

async function fetchCsvCards(url, { force = false } = {}) {
  return rowsToCards(await fetchCsvRows(url, { force }), { requireCardId: true });
}

function extractSheetId(url) {
  const m = url.match(/\/d\/(?:e\/)?([a-zA-Z0-9_-]{20,})/);
  return m ? m[1] : null;
}

function extractGid(url) {
  const m = url.match(/[?&#]gid=(\d+)/);
  return m ? m[1] : null;
}

/* 方案 1：多行 CSV URL，每行一堂課 */
async function loadMultipleCsvs(urls, { force = false } = {}) {
  const lessons = [];
  const failures = [];
  for (let i = 0; i < urls.length; i++) {
    try {
      const cards = await fetchCsvCards(urls[i], { force });
      const lessonName = (cards[0] && cards[0].lesson) || `Lesson ${i + 1}`;
      const gid = extractGid(urls[i]) || String(i);
      lessons.push({ id: 'csv-' + gid, gid, title: lessonName, cards });
    } catch (e) {
      console.warn('CSV load failed:', urls[i], e);
      failures.push(`${urls[i]}：${e.message}`);
    }
  }
  if (failures.length) throw new Error(`CSV 批次載入失敗：${failures.join('；')}`);
  if (!lessons.length) throw new Error('CSV 批次沒有可用課程');
  validateLessonCardIds(lessons);
  return applyTtsPromptsToLessons(lessons);
}

/* 只抓 tab 列表（不抓 CSV），給 lazy 載入用。 */
export async function loadTabsOnly(input, { force = false } = {}) {
  input = (input || '').trim();
  if (!input) return null;
  const lines = input.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length !== 1) return null;
  const one = lines[0];
  if (!/\/d\/e\//.test(one) || /output=csv/i.test(one)) return null;

  const base = one.replace(/[?#].*$/, '').replace(/\/pub(html)?$/, '');
  const htmlUrl = base + '/pubhtml' + (force ? '?_=' + Date.now() : '');
  const res = await fetch(htmlUrl, force ? { cache: 'no-store' } : {});
  if (!res.ok) throw new Error('pubhtml HTTP ' + res.status);
  const html = await res.text();
  const allTabs = parsePubTabs(html);
  const dialogueTab = allTabs.find(tab => tab.name === DIALOGUE_SHEET_TITLE) || null;
  const tabs = allTabs.filter(tab => tab.name !== DIALOGUE_SHEET_TITLE);
  if (!tabs.length) throw new Error('找不到 tab，請確認 Sheet 已「發佈整個文件」');
  return { baseUrl: base, tabs, dialogueTab };
}

export async function fetchDialogues(baseUrl, tab, { force = false } = {}) {
  if (!baseUrl || !tab?.gid) return [];
  const csvUrl = `${baseUrl}/pub?gid=${tab.gid}&single=true&output=csv`;
  return parseDialogueRows(await fetchCsvRows(csvUrl, { force }));
}

/* 抓單一 tab 的 cards。 */
export async function fetchLessonCards(baseUrl, gid, { force = false, id = '', title = '' } = {}) {
  const csvUrl = `${baseUrl}/pub?gid=${gid}&single=true&output=csv`;
  const cards = await fetchCsvCards(csvUrl, { force });
  return applyTtsPromptsToLesson({ id: id || ('gid-' + gid), gid, title, cards }).cards;
}

/* 方案 2：publish-to-web 整份 Sheet。所有課程與生活對話先放在暫存結果，
   全部通過後才交給 app 採用，避免半套 catalog 汙染 runtime 或 cache。 */
export async function loadPublishedCatalog(pubUrl, {
  force = false,
  requireDialogues = false,
} = {}) {
  const manifest = await loadTabsOnly(pubUrl, { force });
  if (!manifest) throw new Error('無法讀取整份已發佈 Sheet');

  const results = await Promise.allSettled(manifest.tabs.map(async tab => {
    const cards = await fetchLessonCards(manifest.baseUrl, tab.gid, {
      force,
      id: 'gid-' + tab.gid,
      title: tab.name,
    });
    if (!cards.length) throw new Error('沒有可用字卡');
    return { id: 'gid-' + tab.gid, gid: tab.gid, title: tab.name, cards };
  }));
  const failures = results.flatMap((result, index) => result.status === 'rejected'
    ? [{ tab: manifest.tabs[index].name, reason: result.reason }]
    : []);
  if (failures.length) {
    const details = failures.map(({ tab, reason }) => `${tab}：${reason?.message || reason}`).join('；');
    const identityFailure = failures.some(({ reason }) => /card_id|canonical/i.test(reason?.message || ''));
    throw new Error(`${identityFailure ? '字卡識別驗證失敗' : '分頁抓取失敗'}：${details}`);
  }

  const lessons = results.map(result => result.value);
  validateLessonCardIds(lessons);

  let dialogues = [];
  if (manifest.dialogueTab) {
    try {
      dialogues = await fetchDialogues(manifest.baseUrl, manifest.dialogueTab, { force });
      if (!dialogues.length) throw new Error('沒有完整情境');
    } catch (e) {
      throw new Error(`生活對話載入失敗：${e.message}`);
    }
  } else if (requireDialogues) {
    throw new Error('找不到生活對話分頁');
  }

  return {
    ...manifest,
    lessons: applyTtsPromptsToLessons(lessons),
    dialogues,
  };
}

function parsePubTabs(html) {
  const tabs = [];
  // Google 把 tab 清單塞在 JS：
  // items.push({name: "3-1", pageUrl: "...gid=XXX", gid: "1979220085", initialSheet: ...})
  const jsRe = /items\.push\(\{\s*name:\s*"((?:\\.|[^"\\])*)"[^}]*?\bgid:\s*"(\d+)"/g;
  let mm;
  while ((mm = jsRe.exec(html))) {
    const name = mm[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    tabs.push({ gid: mm[2], name });
  }
  if (tabs.length) return dedupeTabs(tabs);

  // 後援：DOM 結構（如果 Google 改版）
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const nodes = doc.querySelectorAll('li[id^="sheet-button-"] a, #sheet-menu li a, ul.sheets-list li a');
    for (const a of nodes) {
      const href = a.getAttribute('href') || '';
      const m = href.match(/gid=(\d+)/);
      if (m) tabs.push({ gid: m[1], name: (a.textContent || '').trim() });
    }
  } catch (e) {}
  return dedupeTabs(tabs);
}

function dedupeTabs(tabs) {
  const seen = new Set();
  return tabs.filter(t => {
    if (seen.has(t.gid)) return false;
    seen.add(t.gid);
    return true;
  });
}

/* 方案 3：單一 CSV URL，依 lesson 欄分組 */
async function loadSingleCsv(url, { force = false } = {}) {
  const cards = await fetchCsvCards(url, { force });
  const byLesson = new Map();
  for (const c of cards) {
    const name = c.lesson || '未分類';
    if (!byLesson.has(name)) byLesson.set(name, []);
    byLesson.get(name).push(c);
  }
  const lessons = [...byLesson.entries()].map(([title, cards], idx) => ({
    id: 'csv-' + idx + '-' + title.replace(/\s+/g, '_'),
    title,
    cards,
  }));
  validateLessonCardIds(lessons);
  return applyTtsPromptsToLessons(lessons);
}

/* 方案 0：bundled JSON（GitHub Action 預生成）。
   開 App 預設走這條：同源、CDN cache、< 50ms。
   若 force=true 表示使用者按了「重新同步 Sheet」想要最新資料 → 跳過 bundled、走 live。 */
export async function loadBundledData() {
  // base 用相對路徑，讓 GitHub Pages 子目錄部署也能 work
  const url = './data.json?_=' + Date.now(); // 加版本碼避開 SW stale cache
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error('bundled JSON HTTP ' + res.status);
  const data = await res.json();
  if (!data || !Array.isArray(data.lessons) || !data.lessons.length) {
    throw new Error('bundled JSON 格式異常');
  }
  validateLessonCardIds(data.lessons);
  // 規範成跟 loadFromPublishedSheet 一樣的回傳格式：{ id, gid, title, cards }
  const lessons = applyTtsPromptsToLessons(data.lessons.map((l) => ({
    id: l.id || ('gid-' + (l.gid || '')),
    gid: l.gid || '',
    title: l.title || '',
    cards: Array.isArray(l.cards) ? l.cards : [],
  })));
  return { lessons, dialogues: Array.isArray(data.dialogues) ? data.dialogues : [] };
}

/* 主入口：依輸入型態挑對應方案 */
export async function loadLessons(input, { force = false } = {}) {
  input = (input || '').trim();
  if (!input) return null;

  const lines = input.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  // 多行 → 每行一堂課
  if (lines.length > 1) return loadMultipleCsvs(lines, { force });

  const one = lines[0];

  // publish-to-web 整份（含 /pub 或 /pubhtml 且不是 output=csv）
  if (/\/d\/e\//.test(one) && !/output=csv/i.test(one)) {
    const { lessons } = await loadPublishedCatalog(one, { force });
    return lessons;
  }

  // 單一 CSV URL
  if (/output=csv/i.test(one)) return loadSingleCsv(one, { force });

  // 編輯 URL / 純 Sheet ID → 提示使用者切到 publish-to-web
  const id = extractSheetId(one);
  if (id) {
    throw new Error('請到 Google Sheets → 檔案 → 分享 → 發佈到網路 → 選「整個文件」，再把產生的 URL 貼過來');
  }

  throw new Error('無法辨識：請貼 publish-to-web URL 或 CSV URL');
}
