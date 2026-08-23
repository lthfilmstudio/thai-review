import assert from 'node:assert/strict';
import test from 'node:test';

test('listen module evaluation survives blocked device preference storage', async () => {
  globalThis.localStorage = {
    getItem() { throw new Error('storage blocked'); },
    setItem() { throw new Error('storage blocked'); },
  };

  await assert.doesNotReject(() => import('../src/listen.js?blocked-device-preference'));
});
