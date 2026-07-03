import assert from 'node:assert/strict';
import test from 'node:test';

const {
  buildStaticAudioMap,
  computeThaiOnlyTimeline,
  planLockListenSession,
  planStaticListenBatch,
} = await import('../src/listen-static.js');

test('static listen batch resolves only baked ElevenLabs audio and never requires worker TTS', () => {
  const audioMap = buildStaticAudioMap({
    items: {
      a: { thai: 'เสียง อบ แล้ว', path: 'audio/jessica-v1/a.mp3' },
      b: { thai: 'เสียงเดิม', tts_prompt: '[warm] เสียงเดิม', path: 'audio/jessica-v3/b.mp3' },
    },
  }, 'https://example.test/app/');

  const plan = planStaticListenBatch([
    { thai: 'เสียงอบแล้ว', zh: '烘焙聲音' },
    { thai: 'เสียงเดิม', tts_prompt: '[warm] เสียงเดิม', zh: '原聲' },
    { thai: 'ไม่มีไฟล์', zh: '沒有檔案' },
  ], audioMap, { startIndex: 0, limit: 3 });

  assert.equal(plan.requiresWorkerTts, false);
  assert.deepEqual(plan.items.map(item => item.audioUrl), [
    'https://example.test/app/audio/jessica-v1/a.mp3',
    'https://example.test/app/audio/jessica-v3/b.mp3',
  ]);
  assert.deepEqual(plan.missing.map(item => item.card.thai), ['ไม่มีไฟล์']);
});

test('thai-only timeline repeats teacher and gap without Chinese segments', () => {
  const timeline = computeThaiOnlyTimeline(2000, { repeat: 2, gap: 'auto', rate: 1 });

  assert.equal(timeline.totalMs, 2000 + 3600 + 2000 + 3600);
  assert.deepEqual(timeline.segments.map(seg => seg.phase), ['teacher', 'repeat', 'teacher', 'repeat']);
  assert.equal(timeline.segments[1].durMs, 3600);
});

test('lock listen session plans a bounded static batch and next card index', () => {
  const audioMap = buildStaticAudioMap({
    items: {
      a: { thai: 'หนึ่ง', path: 'audio/a.mp3' },
      b: { thai: 'สอง', path: 'audio/b.mp3' },
      c: { thai: 'สาม', path: 'audio/c.mp3' },
    },
  }, 'https://example.test/');

  const plan = planLockListenSession([
    { thai: 'ศูนย์' },
    { thai: 'หนึ่ง' },
    { thai: 'สอง' },
    { thai: 'สาม' },
  ], audioMap, { startIndex: 1, limit: 2 });

  assert.equal(plan.requiresWorkerTts, false);
  assert.deepEqual(plan.items.map(item => item.index), [1, 2]);
  assert.equal(plan.nextIndex, 3);
  assert.deepEqual(plan.missing, []);
});
