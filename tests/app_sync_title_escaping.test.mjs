import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

/* app.js 是 DOM 耦合的入口，沒辦法直接跑行為測試，用同一套「比對原始碼字串」
   的方式釘住：cur.title 來自 Google Sheet 分頁名（未經任何伺服器端清理），
   showLoading() 是用 innerHTML 塞字串，沒有 escapeHtml 包住就是儲存型 XSS。 */
const appSource = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
const appCode = appSource.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

test('重新同步時 showLoading 顯示的分頁名稱要經過 escapeHtml', () => {
  const line = appCode.indexOf('if (cur) showLoading(');
  assert.ok(line > 0, '找不到重新同步的 showLoading 呼叫，程式碼位置可能改了');
  const call = appCode.slice(line, appCode.indexOf('\n', line));
  assert.match(
    call,
    /escapeHtml\(cur\.title\)/,
    'cur.title 是 Sheet 分頁名（未過濾），直接塞進 showLoading 的 innerHTML 會是儲存型 XSS',
  );
});

test('escapeHtml 有從 ui.js import 進來', () => {
  assert.match(appSource, /import\s*{[^}]*\bescapeHtml\b[^}]*}\s*from\s*['"]\.\/ui\.js['"]/s);
});
