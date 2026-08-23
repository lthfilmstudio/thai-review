import assert from 'node:assert/strict';
import test from 'node:test';

const {
  progressStamp, progressToRow, rowToProgress,
  mergeProgress, mergeHistory, mergeRemoteRows, collectLocalChanges,
  keysClearedByReset, HISTORY_MAX,
  remoteDaysFromRows, mergedDays, ownDaysToRows, mergeAchievements, mergeFavorites,
  normalizeCardRows, changedDayRows, CARD_ROW_DEFAULTS,
} = await import('../src/cloud-merge.js');

function entry(overrides = {}) {
  return {
    grade: 'good', reviewedAt: 1000, nextReviewAt: 5000,
    interval: 3, easeFactor: 2.5, reps: 2,
    updatedAt: 1000, deviceId: 'devA',
    ...overrides,
  };
}

/* ===== last-write-wins：兩個方向都要測，只測一邊會漏掉「反過來就爛掉」 ===== */

test('較舊的遠端進度不會蓋掉較新的本機進度', () => {
  const local = entry({ grade: 'easy', updatedAt: 9000 });
  const remote = entry({ grade: 'again', updatedAt: 3000 });
  assert.equal(mergeProgress(local, remote).grade, 'easy');
});

test('較新的遠端進度會蓋掉較舊的本機進度', () => {
  const local = entry({ grade: 'again', updatedAt: 3000 });
  const remote = entry({ grade: 'easy', updatedAt: 9000 });
  assert.equal(mergeProgress(local, remote).grade, 'easy');
});

test('合併可交換：誰先誰後結果一樣', () => {
  const a = entry({ grade: 'hard', updatedAt: 4000 });
  const b = entry({ grade: 'easy', updatedAt: 8000 });
  assert.deepEqual(mergeProgress(a, b), mergeProgress(b, a));
});

test('時間戳平手時保留本機，避免每次同步都判定成有變動', () => {
  const local = entry({ grade: 'good', updatedAt: 5000 });
  const remote = entry({ grade: 'hard', updatedAt: 5000 });
  assert.equal(mergeProgress(local, remote).grade, 'good');
});

test('本機還沒有這張卡時直接收下遠端；遠端沒有時保留本機', () => {
  const remote = entry();
  assert.equal(mergeProgress(undefined, remote), remote);
  const local = entry();
  assert.equal(mergeProgress(local, null), local);
});

test('舊資料沒有 updatedAt 時退回 reviewedAt，再退回 0', () => {
  assert.equal(progressStamp({ reviewedAt: 777 }), 777);
  assert.equal(progressStamp({}), 0);
  assert.equal(progressStamp(undefined), 0);
  // 沒有 updatedAt 的舊卡不該無條件贏過有時間戳的新卡
  const merged = mergeProgress({ grade: 'again', reviewedAt: 100 }, entry({ grade: 'easy', updatedAt: 900 }));
  assert.equal(merged.grade, 'easy');
});

/* ===== 欄位轉換 round-trip ===== */

test('progress entry 轉成 DB 列再轉回來，欄位不走樣', () => {
  const e = entry();
  const back = rowToProgress(progressToRow('L1:ก', e));
  assert.deepEqual(back, e);
});

test('interval 在 DB 端叫 interval_days（Postgres 保留字）', () => {
  const row = progressToRow('L1:ก', entry({ interval: 21 }));
  assert.equal(row.interval_days, 21);
  assert.equal(row.interval, undefined);
});

test('沒評過分的列轉不出 progress entry', () => {
  assert.equal(rowToProgress({ card_key: 'L1:ก', grade: null }), null);
  assert.equal(rowToProgress(null), null);
});

/* ===== 評分歷史：累積而非覆蓋 ===== */

test('兩台各自評過的歷史都保留，依時間排序', () => {
  const local = [[0, 100], [2, 300]];
  const remote = [[1, 200], [3, 400]];
  assert.deepEqual(mergeHistory(local, remote), [[0, 100], [1, 200], [2, 300], [3, 400]]);
});

test('同一秒同一評分只留一筆，重複合併不會膨脹（冪等）', () => {
  const h = [[2, 100], [3, 200]];
  const once = mergeHistory(h, h);
  assert.deepEqual(once, h);
  assert.deepEqual(mergeHistory(once, h), h);
});

test('歷史超過上限時保留最近的幾筆', () => {
  const local = [[0, 1], [0, 2], [0, 3]];
  const remote = [[1, 4], [1, 5], [1, 6], [1, 7]];
  const merged = mergeHistory(local, remote);
  assert.equal(merged.length, HISTORY_MAX);
  assert.deepEqual(merged.at(-1), [1, 7]);
  assert.deepEqual(merged.at(0), [0, 3]);
});

test('歷史裡的壞資料被濾掉，不會炸開', () => {
  assert.deepEqual(mergeHistory([['x', 1], [2], null, [3, 400]], undefined), [[3, 400]]);
  assert.deepEqual(mergeHistory(undefined, undefined), []);
});

/* ===== 拉下來的批次合併 ===== */

test('mergeRemoteRows 只回報真的有變動的卡', () => {
  const localProgress = {
    'L1:a': entry({ grade: 'easy', updatedAt: 9000 }),   // 本機較新 → 不該出現
    'L1:b': entry({ grade: 'again', updatedAt: 1000 }),  // 遠端較新 → 該出現
  };
  const rows = [
    { card_key: 'L1:a', grade: 'again', progress_updated_at: 3000 },
    { card_key: 'L1:b', grade: 'good', progress_updated_at: 8000 },
  ];
  const { progress } = mergeRemoteRows(rows, localProgress, {});
  assert.deepEqual(Object.keys(progress), ['L1:b']);
  assert.equal(progress['L1:b'].grade, 'good');
});

test('mergeRemoteRows 帶進本機沒有的新卡', () => {
  const rows = [{ card_key: 'L9:z', grade: 'hard', progress_updated_at: 100 }];
  const { progress } = mergeRemoteRows(rows, {}, {});
  assert.equal(progress['L9:z'].grade, 'hard');
});

test('mergeRemoteRows 的歷史沒變就不回報（避免無謂寫檔）', () => {
  const rows = [{ card_key: 'L1:a', grade: 'good', progress_updated_at: 1, history: [[2, 100]] }];
  const unchanged = mergeRemoteRows(rows, {}, { 'L1:a': [[2, 100]] });
  assert.deepEqual(unchanged.history, {});
  const changed = mergeRemoteRows(rows, {}, { 'L1:a': [[0, 50]] });
  assert.deepEqual(changed.history['L1:a'], [[0, 50], [2, 100]]);
});

/* ===== 上傳挑選 ===== */

test('collectLocalChanges 只挑 watermark 之後改過的卡', () => {
  const localProgress = {
    'L1:old': entry({ updatedAt: 1000 }),
    'L1:new': entry({ updatedAt: 5000 }),
  };
  const rows = collectLocalChanges(localProgress, {}, 3000);
  assert.deepEqual(rows.map(r => r.card_key), ['L1:new']);
});

test('collectLocalChanges 把該卡的歷史一起帶上去', () => {
  const localProgress = { 'L1:a': entry({ updatedAt: 5000 }) };
  const rows = collectLocalChanges(localProgress, { 'L1:a': [[2, 10]] }, 0);
  assert.deepEqual(rows[0].history, [[2, 10]]);
  assert.equal(rows[0].history_updated_at, 5000);
});

test('collectLocalChanges 跳過壞掉的 entry，不讓整次同步失敗', () => {
  const localProgress = { 'L1:a': null, 'L1:b': 'legacy-string', 'L1:c': entry({ updatedAt: 9 }) };
  const rows = collectLocalChanges(localProgress, {}, 0);
  assert.deepEqual(rows.map(r => r.card_key), ['L1:c']);
});

/* ===== 重置 epoch：這是刪除語意，錯了就是真的丟資料 ===== */

test('keysClearedByReset 只清掉 epoch 之前的卡，之後評的留著', () => {
  const localProgress = {
    'L1:before': entry({ updatedAt: 1000 }),
    'L1:onEpoch': entry({ updatedAt: 5000 }),   // 剛好等於 epoch，算被清掉
    'L1:after': entry({ updatedAt: 9000 }),
  };
  assert.deepEqual(keysClearedByReset(localProgress, 5000).sort(), ['L1:before', 'L1:onEpoch']);
});

test('沒重置過（epoch=0）時什麼都不清', () => {
  const localProgress = { 'L1:a': entry({ updatedAt: 1000 }) };
  assert.deepEqual(keysClearedByReset(localProgress, 0), []);
});

test('第一次登入的新裝置不會把已重置的舊資料拉回來', () => {
  // 新裝置 watermark 是空的，雲端所有列都會被拉下來
  const rows = [
    { card_key: 'L1:old', grade: 'good', progress_updated_at: 3000 },   // 重置前
    { card_key: 'L1:new', grade: 'easy', progress_updated_at: 7000 },   // 重置後
  ];
  const { progress } = mergeRemoteRows(rows, {}, {}, 5000);
  assert.deepEqual(Object.keys(progress), ['L1:new']);
});

test('離線裝置重新上線時，不會把重置前的紀錄推回雲端', () => {
  const localProgress = {
    'L1:stale': entry({ updatedAt: 3000 }),   // 這台離線時評的，但已被重置蓋掉
    'L1:fresh': entry({ updatedAt: 8000 }),
  };
  const rows = collectLocalChanges(localProgress, {}, 0, 5000);
  assert.deepEqual(rows.map(r => r.card_key), ['L1:fresh']);
});

test('重置後又評同一張卡，新評分不會被 epoch 吃掉', () => {
  const regraded = entry({ grade: 'again', updatedAt: 6000 });
  assert.deepEqual(keysClearedByReset({ 'L1:a': regraded }, 5000), []);
  const { progress } = mergeRemoteRows(
    [{ card_key: 'L1:a', grade: 'again', progress_updated_at: 6000 }], {}, {}, 5000);
  assert.equal(progress['L1:a'].grade, 'again');
});

/* ===== Phase B：每日日誌 =====
   最容易做錯的是「自己加自己」——本機推上去的那列會再被拉回來，
   如果沒有排除自己的 device_id，當天數字直接翻倍。 */

function row(date, deviceId, over = {}) {
  return {
    date, device_id: deviceId,
    reviewed: 0, again: 0, hard: 0, good: 0, easy: 0, games: 0, seconds: 0,
    game_ids: [], bridged: false, ...over,
  };
}

test('remoteDaysFromRows 排除自己那台，不會自己加自己', () => {
  const rows = [
    row('2026-08-22', 'me', { reviewed: 10 }),
    row('2026-08-22', 'phone', { reviewed: 4 }),
  ];
  const remote = remoteDaysFromRows(rows, 'me');
  assert.equal(remote['2026-08-22'].reviewed, 4, '自己那台的 10 不該算進 remote');
});

test('多台裝置同一天的計數相加、gameIds 聯集去重、bridged 取 OR', () => {
  const rows = [
    row('2026-08-22', 'phone', { reviewed: 4, seconds: 600, game_ids: ['listen', 'combo'] }),
    row('2026-08-22', 'pad', { reviewed: 6, seconds: 300, game_ids: ['combo'], bridged: true }),
  ];
  const d = remoteDaysFromRows(rows, 'me')['2026-08-22'];
  assert.equal(d.reviewed, 10);
  assert.equal(d.seconds, 900);
  assert.deepEqual(d.gameIds.sort(), ['combo', 'listen']);
  assert.equal(d.bridged, true);
});

test('mergedDays 把自己的跟別台的相加，不動原物件', () => {
  const own = { '2026-08-22': { reviewed: 3, games: 1, gameIds: ['listen'] } };
  const remote = { '2026-08-22': { reviewed: 5, games: 1, gameIds: ['combo'], bridged: true } };
  const m = mergedDays(own, remote);
  assert.equal(m['2026-08-22'].reviewed, 8);
  assert.equal(m['2026-08-22'].games, 2);
  assert.deepEqual(m['2026-08-22'].gameIds.sort(), ['combo', 'listen']);
  assert.equal(m['2026-08-22'].bridged, true);
  assert.equal(own['2026-08-22'].reviewed, 3, '不能就地改到自己的紀錄');
});

test('沒有 remote 時 mergedDays 等同原本的 days（未登入回歸的硬條件）', () => {
  const own = { '2026-08-22': { reviewed: 3 } };
  assert.equal(mergedDays(own, {}), own);
  assert.equal(mergedDays(own, null), own);
});

test('mergedDays 帶進只有別台有的日子（這才會讓連續天數變長）', () => {
  const m = mergedDays({}, { '2026-08-20': { reviewed: 2 } });
  assert.equal(m['2026-08-20'].reviewed, 2);
});

test('ownDaysToRows 跳過空白日，不佔一列', () => {
  const rows = ownDaysToRows({
    '2026-08-20': { reviewed: 0, games: 0, seconds: 0, gameIds: [] },
    '2026-08-21': { reviewed: 0, games: 0, seconds: 0, gameIds: [], bridged: true },
    '2026-08-22': { reviewed: 5, gameIds: ['listen'] },
  }, 'me');
  assert.deepEqual(rows.map(r => r.date).sort(), ['2026-08-21', '2026-08-22']);
  assert.equal(rows.every(r => r.device_id === 'me'), true);
});

test('推上去再拉回來，數字不會膨脹（自己那列被排除）', () => {
  const own = { '2026-08-22': { reviewed: 7, games: 1, seconds: 60, gameIds: ['listen'] } };
  const uploaded = ownDaysToRows(own, 'me');
  const remote = remoteDaysFromRows(uploaded, 'me');   // 只有自己那列
  assert.deepEqual(mergedDays(own, remote)['2026-08-22'].reviewed, 7);
});

/* ===== Phase B：成就與收藏 ===== */

test('成就聯集，同一個取較早的解鎖時間，不會被較晚的蓋掉', () => {
  const m = mergeAchievements({ streak7: 5000 }, { streak7: 8000, daily50: 7000 });
  assert.equal(m.streak7, 5000);
  assert.equal(m.daily50, 7000);
});

test('取消收藏能傳播出去（tombstone，不是聯集）', () => {
  const local = { 'กิน': { v: 1, ts: 100 } };
  const remote = { 'กิน': { v: 0, ts: 300 } };
  assert.equal(mergeFavorites(local, remote)['กิน'].v, 0);
  // 反過來：較舊的取消不能蓋掉較新的收藏
  assert.equal(mergeFavorites({ 'กิน': { v: 1, ts: 500 } }, remote)['กิน'].v, 1);
});

test('收藏合併可交換', () => {
  const a = { 'กิน': { v: 1, ts: 100 }, 'น้ำ': { v: 1, ts: 400 } };
  const b = { 'กิน': { v: 0, ts: 300 } };
  assert.deepEqual(mergeFavorites(a, b), mergeFavorites(b, a));
});

/* ===== Phase B：卡片編輯 ===== */

test('編輯有自己的時間戳，較新的一方勝出', () => {
  const localEdits = { 'L1:a': { zh: '本機版', updatedAt: 9000 } };
  const rows = [{ card_key: 'L1:a', edit: { zh: '遠端舊版', updatedAt: 3000 } }];
  assert.deepEqual(mergeRemoteRows(rows, {}, {}, 0, localEdits).edits, {}, '較舊的不該收下');

  const newer = [{ card_key: 'L1:a', edit: { zh: '遠端新版', updatedAt: 99999 } }];
  assert.equal(mergeRemoteRows(newer, {}, {}, 0, localEdits).edits['L1:a'].zh, '遠端新版');
});

test('編輯不受重置 epoch 影響（重置清的是評分，不是卡片內容）', () => {
  const rows = [{
    card_key: 'L1:a',
    grade: 'good', progress_updated_at: 1000,      // 重置前的評分 → 該被濾掉
    edit: { zh: '我的翻譯', updatedAt: 1000 },      // 編輯 → 該保留
  }];
  const r = mergeRemoteRows(rows, {}, {}, 5000, {});
  assert.deepEqual(Object.keys(r.progress), [], '評分要被 epoch 濾掉');
  assert.equal(r.edits['L1:a'].zh, '我的翻譯', '編輯不該被 epoch 濾掉');
});

test('只有編輯、從沒評過分的卡也會被上傳', () => {
  const rows = collectLocalChanges({}, {}, 0, 0, { 'L1:neverGraded': { zh: '譯', updatedAt: 500 } });
  assert.deepEqual(rows.map(r => r.card_key), ['L1:neverGraded']);
  assert.equal(rows[0].edit_updated_at, 500);
});

test('同一張卡的評分與編輯合併成同一列上傳，不會拆成兩列', () => {
  const rows = collectLocalChanges(
    { 'L1:a': entry({ updatedAt: 5000 }) }, {}, 0, 0,
    { 'L1:a': { zh: '譯', updatedAt: 6000 } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].grade, 'good');
  assert.equal(rows[0].edit_updated_at, 6000);
});

test('編輯沒有變動時不上傳（watermark 之前的）', () => {
  const rows = collectLocalChanges({}, {}, 3000, 0, { 'L1:a': { zh: '舊', updatedAt: 1000 } });
  assert.deepEqual(rows, []);
});


/* ===== PostgREST 批次上傳的形狀（2026-08-23 抓到的線上 bug）=====
   PostgREST 要求同一個 POST body 裡每個物件的 key 完全一致，不一致會回
   PGRST102「All object keys must match」——是整批 400，不是跳過那一列。
   同步失敗時 watermark 不前進，下次會送同一批、再 400，永遠卡死。 */

test('collectLocalChanges 本來就會產出三種不同形狀的列（這就是 400 的來源）', () => {
  const rows = collectLocalChanges(
    {
      有歷史: entry({ updatedAt: 100 }),
      沒歷史: entry({ updatedAt: 100 }),
    },
    { 有歷史: [[2, 1]] },
    0, 0,
    { 只有編輯: { 中文: '新的', updatedAt: 100 } },
  );
  const shapes = new Set(rows.map(r => Object.keys(r).sort().join(',')));
  assert.equal(rows.length, 3);
  assert.ok(shapes.size > 1, '前提要成立：沒補齊的話形狀本來就不只一種');
});

test('normalizeCardRows 補完之後每一列的 key 集合完全相同', () => {
  const rows = normalizeCardRows(collectLocalChanges(
    {
      有歷史: entry({ updatedAt: 100 }),
      沒歷史: entry({ updatedAt: 100 }),
    },
    { 有歷史: [[2, 1]] },
    0, 0,
    { 只有編輯: { 中文: '新的', updatedAt: 100 } },
  ));
  const shapes = new Set(rows.map(r => Object.keys(r).sort().join(',')));
  assert.equal(shapes.size, 1);
  assert.equal([...shapes][0], Object.keys(CARD_ROW_DEFAULTS).sort().join(','));
});

test('補齊用的三個時間戳是 0 不是 null：DB 那三欄是 NOT NULL，而且 trigger 拿它比大小決定要不要覆蓋', () => {
  const [row] = normalizeCardRows([{ card_key: 'k', edit: { 中文: 'x' }, edit_updated_at: 5 }]);
  assert.equal(row.progress_updated_at, 0);
  assert.equal(row.history_updated_at, 0);
  assert.equal(row.grade, null);
  assert.equal(row.history, null);
  // 真正帶了值的欄位不能被預設值蓋掉
  assert.equal(row.edit_updated_at, 5);
});

test('normalizeCardRows 不動原本的列（呼叫端還要拿它比對）', () => {
  const original = { card_key: 'k', grade: 'good', progress_updated_at: 9 };
  normalizeCardRows([original]);
  assert.deepEqual(Object.keys(original), ['card_key', 'grade', 'progress_updated_at']);
});

/* ===== 只推有變動的日子 ===== */

test('changedDayRows 只挑出跟雲端不一樣的日子', () => {
  const own = [
    { date: '2026-08-20', device_id: 'A', reviewed: 5, games: 0, seconds: 100, game_ids: [], bridged: false },
    { date: '2026-08-21', device_id: 'A', reviewed: 3, games: 0, seconds: 50, game_ids: [], bridged: false },
    { date: '2026-08-22', device_id: 'A', reviewed: 1, games: 0, seconds: 10, game_ids: [], bridged: false },
  ];
  const remote = [
    { date: '2026-08-20', device_id: 'A', reviewed: 5, games: 0, seconds: 100, game_ids: [], bridged: false },
    { date: '2026-08-21', device_id: 'A', reviewed: 2, games: 0, seconds: 50, game_ids: [], bridged: false },
  ];
  const out = changedDayRows(own, remote);
  assert.deepEqual(out.map(r => r.date), ['2026-08-21', '2026-08-22']);
});

test('changedDayRows 抓得到只有 bridged 或 game_ids 變動的日子（結算蓋章就是這種）', () => {
  const base = { date: '2026-08-20', device_id: 'A', reviewed: 0, again: 0, hard: 0, good: 0, easy: 0, games: 0, seconds: 0 };
  assert.equal(changedDayRows(
    [{ ...base, game_ids: [], bridged: true }],
    [{ ...base, game_ids: [], bridged: false }]).length, 1);
  assert.equal(changedDayRows(
    [{ ...base, game_ids: ['combo'], bridged: false }],
    [{ ...base, game_ids: [], bridged: false }]).length, 1);
  assert.equal(changedDayRows(
    [{ ...base, game_ids: ['combo', 'listen'], bridged: false }],
    [{ ...base, game_ids: ['listen', 'combo'], bridged: false }]).length, 0,
    'game_ids 只是順序不同不算變動');
});
