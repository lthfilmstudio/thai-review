import assert from 'node:assert/strict';
import test from 'node:test';

const {
  progressStamp, progressToRow, rowToProgress,
  mergeProgress, mergeHistory, mergeRemoteRows, collectLocalChanges,
  keysClearedByReset, HISTORY_MAX,
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
