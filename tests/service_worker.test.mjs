import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const sw = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
const root = fileURLToPath(new URL('../', import.meta.url));

async function staticModuleGraph(entry) {
  const visited = new Set();
  async function visit(filePath) {
    const modulePath = relative(root, filePath).split(sep).join('/');
    if (visited.has(modulePath)) return;
    visited.add(modulePath);
    const source = await readFile(filePath, 'utf8');
    const imports = [
      ...source.matchAll(
        /(?:import|export)\s+(?:[^'";]*?\sfrom\s*)?['"](\.[^'"]+\.js)['"]/g,
      ),
      ...source.matchAll(/import\s*\(\s*['"](\.[^'"]+\.js)['"]\s*\)/g),
    ];
    for (const match of imports) {
      await visit(resolve(dirname(filePath), match[1]));
    }
  }
  await visit(entry);
  return visited;
}

test('service worker fetches mutable deployment metadata network-first', () => {
  const networkFirstBlock = [
    "url.pathname.endsWith('/data.json')",
    "url.pathname.endsWith('/zh-manifest.json')",
    "url.pathname.endsWith('/deploy-info.json')",
    'e.respondWith(networkFirst(e.request));',
  ];

  for (const needle of networkFirstBlock) {
    assert.ok(sw.includes(needle), `missing ${needle}`);
  }

  const manifestRule = sw.indexOf("url.pathname.endsWith('/deploy-info.json')");
  const cacheFirstRule = sw.indexOf('// 同源：cache-first');
  assert.ok(manifestRule > 0, 'deploy info rule should exist');
  assert.ok(cacheFirstRule > manifestRule, 'mutable metadata must be handled before same-origin cache-first');
});

test('service worker refreshes mutable Thai audio indexes before using cache', () => {
  const mutableAudioIndexes = [
    "url.pathname.endsWith('/src/tts-prompts.js')",
    "url.pathname.endsWith('/audio-manifest.json')",
  ];
  const cacheFirstRule = sw.indexOf('// 同源：cache-first');

  for (const needle of mutableAudioIndexes) {
    const rule = sw.indexOf(needle);
    assert.ok(rule > 0, `missing ${needle}`);
    assert.ok(cacheFirstRule > rule, `${needle} must be handled before same-origin cache-first`);
  }
});

test('service worker cache version invalidates the stale v92 home bundle', () => {
  assert.ok(sw.includes("const CACHE = 'thai-review-v93';"));
  assert.ok(sw.includes("'./src/storage-scope.js'"),
    'app boot dependency must be available in the offline shell');
  assert.ok(sw.includes("'./src/practice-db.js'"),
    'workspace hydration dependency must be available in the offline shell');
  assert.ok(sw.includes("'./src/legacy-claim-flow.js'"),
    'legacy claim controller must be available in the offline shell');
  assert.ok(sw.includes("'./src/remote-workspace-probe.js'"),
    'legacy claim remote probe must be available in the offline shell');
  assert.ok(sw.includes("'./src/production-lineage-trust.js'"),
    'legacy claim trust manifest must be available in the offline shell');
  assert.ok(sw.includes("'./src/card-identity.js'"),
    'card identity dependency must be available in the offline shell');
  assert.ok(sw.includes("'./data/card-id-lineage.json'"),
    'legacy claim evidence must be available in the offline shell');
});

test('service worker precaches the complete static app import graph', async () => {
  const modules = await staticModuleGraph(resolve(root, 'src/app.js'));
  for (const modulePath of modules) {
    assert.ok(
      sw.includes(`'./${modulePath}'`),
      `${modulePath} must be available in the offline shell`,
    );
  }
});

test('service worker refreshes production lineage evidence before using cache', () => {
  const lineageRule = sw.indexOf("url.pathname.endsWith('/data/card-id-lineage.json')");
  const cacheFirstRule = sw.indexOf('// 同源：cache-first');
  assert.ok(lineageRule > 0, 'production lineage evidence needs an explicit rule');
  assert.ok(cacheFirstRule > lineageRule,
    'production lineage evidence must be handled before same-origin cache-first');
});
