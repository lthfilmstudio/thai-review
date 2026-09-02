import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const appSource = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');

test('App 在 runWorkspaceBoot migrate 內接 production legacy claim flow', () => {
  const initStart = appSource.indexOf('async function init()');
  const boot = appSource.indexOf('await runWorkspaceBoot({', initStart);
  const migrate = appSource.indexOf('migrate: async', boot);
  const readyGate = appSource.indexOf("if (bootResult.status !== 'ready')", boot);

  assert.match(appSource, /import \{[^}]*\bcreateLegacyClaimFlow\b[^}]*\} from '\.\/legacy-claim-flow\.js';/);
  assert.ok(boot > initStart && migrate > boot && readyGate > migrate);
  assert.match(appSource.slice(migrate, readyGate), /\{ workspaceId, session, migrationStorage \}/);
  assert.match(appSource.slice(migrate, readyGate), /rootStorage: localStorage/);
  assert.match(appSource.slice(migrate, readyGate), /eligibilityStorage: migrationStorage/);
  assert.doesNotMatch(appSource.slice(migrate, readyGate), /workspaceStorage: storage/);
  assert.match(appSource.slice(migrate, readyGate), /practiceConnection/);
  assert.match(appSource.slice(migrate, readyGate), /requestDecision: renderLegacyClaimOffer/);
});

test('claim DOM 使用安全 API、精確按鈕文案、saving disable 與合理 focus', () => {
  const start = appSource.indexOf('function renderLegacyClaimOffer(');
  const end = appSource.indexOf('function showLegacyMigrationSummary(', start);
  const source = appSource.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(source, /textContent/);
  assert.match(source, /replaceChildren/);
  assert.doesNotMatch(source, /innerHTML/);
  assert.match(source, /將這台裝置的進度加入此帳號/);
  assert.match(source, /先不要/);
  assert.match(source, /儲存中…/);
  assert.match(source, /button\.disabled = true/);
  assert.match(source, /claimButton\.focus\(\)/);
});

test('migration summary 在 daily/streak 前 await，且只靠本次 bootResult', () => {
  const readyGate = appSource.indexOf("if (bootResult.status !== 'ready')");
  const summary = appSource.indexOf('await showLegacyMigrationSummary(', readyGate);
  const daily = appSource.indexOf('initDailyLog(state.progress, storage)', readyGate);
  const streak = appSource.indexOf('settleStreakOnOpen(undefined, storage)', readyGate);
  const summaryFunction = appSource.indexOf('function showLegacyMigrationSummary(');
  const source = appSource.slice(
    summaryFunction,
    appSource.indexOf('function applyHydratedWorkspace(', summaryFunction),
  );

  assert.ok(summary > readyGate && daily > summary && streak > daily);
  assert.match(appSource.slice(summary, daily), /bootResult\.migration\?\.summary/);
  assert.match(source, /原始紀錄/);
  assert.match(source, /已解析/);
  assert.match(source, /待重新掃描/);
  assert.match(source, /保守不亂猜/);
  assert.match(source, /進入今日/);
  assert.doesNotMatch(source, /localStorage|setItem/);
});

test('versionchange、boot failure 與 logout 都 invalidate legacy claim flow', () => {
  assert.match(appSource, /onVersionChange: \(\) => \{\s*legacyClaimFlow\?\.invalidate\(\);/);
  const failedBoot = appSource.indexOf("if (bootResult.status !== 'ready')");
  assert.match(appSource.slice(failedBoot, failedBoot + 300), /legacyClaimFlow\?\.invalidate\(\)/);
  const logout = appSource.indexOf("btn.dataset.cloudAction === 'logout'");
  assert.match(appSource.slice(logout, logout + 900), /legacyClaimFlow\?\.invalidate\(\)/);
});

test('hydration 保留 scoped progress、legacy daily 只在空 workspace 套用一次', () => {
  assert.match(appSource, /mergeWorkspaceHydration\(\{[\s\S]*runtimeProgressFromHydration/);
  assert.match(appSource, /runtimeProgressFromHydration\(projected\.progress, catalog\)/);
  assert.match(appSource, /keyByCardId\.set\(card\.card_id/);
  assert.match(appSource, /hydrationStorage\.getItem\(DAILY_KEY\) != null/);
  assert.match(appSource, /if \(!dailyStateExists\s*&& daily\?\.schemaVersion === 1/);
});

test('production logout 清掉帳號 handle 後 reload 成匿名 workspace', () => {
  assert.match(appSource, /await logoutToAnonymous\(\{/);
  assert.match(appSource, /clearAuth: cloudAuth\.logout/);
  assert.match(appSource, /cleanup: \(\) => \{/);
  assert.match(appSource, /reload: \(\) => location\.reload\(\)/);
});
