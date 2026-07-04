import assert from 'node:assert/strict';
import test from 'node:test';

import { buildZhLessonIndex, lookupZhSegment, sliceRange } from '../src/zh-sprite.js';

test('buildZhLessonIndex maps lessons and tolerates missing manifest', () => {
  const index = buildZhLessonIndex({
    version: 1,
    lessons: {
      'gid-1': { hash: 'ab12cd34', timing: 'audio/zh-tw/gid-1-ab12cd34.json' },
      'gid-broken': { hash: 'ff' }, // 沒 timing → 略過
    },
  });
  assert.deepEqual(index.get('gid-1'), { hash: 'ab12cd34', timing: 'audio/zh-tw/gid-1-ab12cd34.json' });
  assert.equal(index.has('gid-broken'), false);

  assert.equal(buildZhLessonIndex(null).size, 0);
  assert.equal(buildZhLessonIndex({}).size, 0);
});

test('lookupZhSegment finds trimmed text and rejects malformed entries', () => {
  const timing = {
    files: ['audio/zh-tw/gid-1-ab12cd34-p0.mp3'],
    items: {
      '你好': [0, 60, 1500],
      '壞掉': [0, -5, 1500],
      '短陣列': [0, 60],
    },
  };
  assert.deepEqual(lookupZhSegment(timing, ' 你好 '), { fileIdx: 0, startMs: 60, durMs: 1500 });
  assert.equal(lookupZhSegment(timing, '不存在'), null);
  assert.equal(lookupZhSegment(timing, '壞掉'), null);
  assert.equal(lookupZhSegment(timing, '短陣列'), null);
  assert.equal(lookupZhSegment(null, '你好'), null);
});

test('sliceRange clamps to buffer bounds', () => {
  // 24kHz：60ms → 1440 samples、1500ms → 36000 samples
  assert.deepEqual(sliceRange(60, 1500, 24000, 100000), { offset: 1440, length: 36000 });
  // 尾段超出 buffer → clamp 到結尾
  assert.deepEqual(sliceRange(60, 1500, 24000, 20000), { offset: 1440, length: 18560 });
  // 完全超出 → 空範圍
  assert.deepEqual(sliceRange(10000, 500, 24000, 1000), { offset: 1000, length: 0 });
});
