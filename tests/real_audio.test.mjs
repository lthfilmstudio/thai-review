import assert from 'node:assert/strict';
import test from 'node:test';

import { buildRealLessonIndex, lookupRealSegment } from '../src/real-audio.js';

test('buildRealLessonIndex maps lessons and tolerates missing manifest', () => {
  const index = buildRealLessonIndex({
    generated_at: '2026-08-20',
    lessons: {
      'gid-1786078251': { hash: '01257d9b', timing: 'audio/real-tw/gid-1786078251-01257d9b.json' },
      'gid-broken': { hash: 'ff' }, // 沒 timing → 略過
    },
  });
  assert.deepEqual(index.get('gid-1786078251'), { hash: '01257d9b', timing: 'audio/real-tw/gid-1786078251-01257d9b.json' });
  assert.equal(index.has('gid-broken'), false);

  assert.equal(buildRealLessonIndex(null).size, 0);
  assert.equal(buildRealLessonIndex({}).size, 0);
});

test('lookupRealSegment finds trimmed thai text and rejects malformed entries', () => {
  const timing = {
    files: ['audio/real-tw/gid-1786078251-01257d9b-p0.mp3'],
    items: {
      'สมัคร': [0, 96220, 840],
      'บวก': [0, -5, 840],
      '短陣列': [0, 60],
    },
  };
  assert.deepEqual(lookupRealSegment(timing, ' สมัคร '), { fileIdx: 0, startMs: 96220, durMs: 840 });
  assert.equal(lookupRealSegment(timing, 'ไม่มีจริง'), null);
  assert.equal(lookupRealSegment(timing, 'บวก'), null);
  assert.equal(lookupRealSegment(timing, '短陣列'), null);
  assert.equal(lookupRealSegment(null, 'สมัคร'), null);
});
