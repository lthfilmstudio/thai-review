/* CSV 抓取 + 多工作表自動載入。
   支援三種輸入：
   1. 多行 CSV URL（每行一個 tab 的 publish-to-web CSV）→ 每個 URL 一堂課
   2. 單一 publish-to-web HTML URL（整份 Sheet 都發佈）→ 自動列出所有 tab
   3. 單一 CSV URL → 依 CSV 內的 lesson 欄分組（原型行為）
*/

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
  karaoke:   ['泰式karaoke拼音', 'karaoke拼音', '拼音', 'karaoke', 'pronunciation'],
  zh:        ['中文', '中文翻譯', '翻譯', 'zh', 'chinese', 'cn'],
  type:      ['類型', 'type', '分類'],
  note:      ['備註', 'note', '說明'],
  audio_url: ['音檔', 'audio_url', 'audio', '音檔網址'],
  lesson:    ['課程', '課', '堂', 'lesson'],
};

function findCol(header, key) {
  const aliases = COL_ALIASES[key] || [key];
  for (const a of aliases) {
    const i = header.indexOf(a.toLowerCase());
    if (i >= 0) return i;
  }
  return -1;
}

function rowsToCards(rows) {
  if (!rows.length) return [];
  const header = rows[0].map(h => h.trim().toLowerCase());
  const iT = findCol(header, 'thai');
  const iK = findCol(header, 'karaoke');
  const iZ = findCol(header, 'zh');
  const iType = findCol(header, 'type');
  const iNote = findCol(header, 'note');
  const iAudio = findCol(header, 'audio_url');
  const iLesson = findCol(header, 'lesson');
  if (iT < 0 || iK < 0 || iZ < 0) {
    throw new Error(`CSV 缺少必要欄位（泰文/拼音/中文）。目前 header：${rows[0].join(' | ')}`);
  }
  const cards = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || !row[iT]) continue;
    cards.push({
      thai: (row[iT] || '').trim(),
      karaoke: (row[iK] || '').trim(),
      zh: (row[iZ] || '').trim(),
      type: iType >= 0 ? ((row[iType] || 'word').trim().toLowerCase()) : 'word',
      note: iNote >= 0 ? (row[iNote] || '').trim() : '',
      audio_url: iAudio >= 0 ? (row[iAudio] || '').trim() : '',
      lesson: iLesson >= 0 ? (row[iLesson] || '').trim() : '',
    });
  }
  return cards;
}

async function fetchCsvCards(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return rowsToCards(parseCsv(await res.text()));
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
async function loadMultipleCsvs(urls) {
  const lessons = [];
  for (let i = 0; i < urls.length; i++) {
    try {
      const cards = await fetchCsvCards(urls[i]);
      const lessonName = (cards[0] && cards[0].lesson) || `Lesson ${i + 1}`;
      const gid = extractGid(urls[i]) || String(i);
      lessons.push({ id: 'csv-' + gid, title: lessonName, cards });
    } catch (e) {
      console.warn('CSV load failed:', urls[i], e);
    }
  }
  if (!lessons.length) throw new Error('所有 CSV 都讀取失敗');
  return lessons;
}

/* 只抓 tab 列表（不抓 CSV），給 lazy 載入用。 */
export async function loadTabsOnly(input) {
  input = (input || '').trim();
  if (!input) return null;
  const lines = input.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length !== 1) return null;
  const one = lines[0];
  if (!/\/d\/e\//.test(one) || /output=csv/i.test(one)) return null;

  const base = one.replace(/[?#].*$/, '').replace(/\/pub(html)?$/, '');
  const res = await fetch(base + '/pubhtml');
  if (!res.ok) throw new Error('pubhtml HTTP ' + res.status);
  const html = await res.text();
  const tabs = parsePubTabs(html);
  if (!tabs.length) throw new Error('找不到 tab，請確認 Sheet 已「發佈整個文件」');
  return { baseUrl: base, tabs };
}

/* 抓單一 tab 的 cards。 */
export async function fetchLessonCards(baseUrl, gid) {
  const csvUrl = `${baseUrl}/pub?gid=${gid}&single=true&output=csv`;
  return await fetchCsvCards(csvUrl);
}

/* 方案 2：publish-to-web 整份 Sheet。抓 pubhtml 解析 tab 列表，
   每個 tab 再抓成 CSV。需使用者在 Google Sheets 選「發佈整個文件」。 */
async function loadFromPublishedSheet(pubUrl) {
  // 正規化：去掉 query / fragment / 結尾 /pub 或 /pubhtml
  const base = pubUrl.replace(/[?#].*$/, '').replace(/\/pub(html)?$/, '');
  const htmlUrl = base + '/pubhtml';
  const res = await fetch(htmlUrl);
  if (!res.ok) throw new Error('pubhtml HTTP ' + res.status);
  const html = await res.text();
  const tabs = parsePubTabs(html);
  if (!tabs.length) throw new Error('找不到 tab，請確認 Sheet 已「發佈整個文件」');
  // 並行抓所有 tab（28 個 × 300ms 依序 ≈ 10s，並行 <1s）
  const results = await Promise.allSettled(tabs.map(async tab => {
    const csvUrl = `${base}/pub?gid=${tab.gid}&single=true&output=csv`;
    const cards = await fetchCsvCards(csvUrl);
    return { id: 'gid-' + tab.gid, title: tab.name, cards };
  }));
  const lessons = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value.cards.length) lessons.push(r.value);
    else if (r.status === 'rejected') console.warn('tab skipped:', tabs[i].name, r.reason);
  });
  if (!lessons.length) throw new Error('所有 tab 都讀取失敗');
  return lessons;
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
async function loadSingleCsv(url) {
  const cards = await fetchCsvCards(url);
  const byLesson = new Map();
  for (const c of cards) {
    const name = c.lesson || '未分類';
    if (!byLesson.has(name)) byLesson.set(name, []);
    byLesson.get(name).push(c);
  }
  return [...byLesson.entries()].map(([title, cards], idx) => ({
    id: 'csv-' + idx + '-' + title.replace(/\s+/g, '_'),
    title,
    cards,
  }));
}

/* 主入口：依輸入型態挑對應方案 */
export async function loadLessons(input) {
  input = (input || '').trim();
  if (!input) return null;

  const lines = input.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  // 多行 → 每行一堂課
  if (lines.length > 1) return loadMultipleCsvs(lines);

  const one = lines[0];

  // publish-to-web 整份（含 /pub 或 /pubhtml 且不是 output=csv）
  if (/\/d\/e\//.test(one) && !/output=csv/i.test(one)) {
    try { return await loadFromPublishedSheet(one); }
    catch (e) { console.warn('publish-to-web 整份抓取失敗：', e.message); }
  }

  // 單一 CSV URL
  if (/output=csv/i.test(one)) return loadSingleCsv(one);

  // 編輯 URL / 純 Sheet ID → 提示使用者切到 publish-to-web
  const id = extractSheetId(one);
  if (id) {
    throw new Error('請到 Google Sheets → 檔案 → 分享 → 發佈到網路 → 選「整個文件」，再把產生的 URL 貼過來');
  }

  throw new Error('無法辨識：請貼 publish-to-web URL 或 CSV URL');
}
