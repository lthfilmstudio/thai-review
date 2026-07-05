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
