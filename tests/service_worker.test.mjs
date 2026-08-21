import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const sw = await readFile(new URL('../sw.js', import.meta.url), 'utf8');

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

test('service worker cache version invalidates the stale v74 home bundle', () => {
  assert.ok(sw.includes("const CACHE = 'thai-review-v79';"));
});
