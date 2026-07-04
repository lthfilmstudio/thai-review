import assert from 'node:assert/strict';
import test from 'node:test';

const {
  buildStaticAudioMap,
  computeLockTimeline,
  findLockPosition,
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

test('lock timeline without Chinese repeats teacher and gap only', () => {
  const timeline = computeLockTimeline(0, 2000, { repeat: 2, gap: 'auto', rate: 1 });

  assert.equal(timeline.totalMs, 2000 + 3600 + 2000 + 3600);
  assert.deepEqual(timeline.segments.map(seg => seg.phase), ['teacher', 'repeat', 'teacher', 'repeat']);
  assert.equal(timeline.segments[1].durMs, 3600);
});

test('lock timeline prepends one Chinese meaning segment at normal speed', () => {
  const timeline = computeLockTimeline(1200, 2000, { repeat: 2, gap: 'auto', rate: 0.8 });

  const teacherEffMs = 2000 / 0.8;
  const gapMs = teacherEffMs * 1.8;
  assert.deepEqual(timeline.segments.map(seg => seg.phase), ['meaning', 'teacher', 'repeat', 'teacher', 'repeat']);
  assert.equal(timeline.segments[0].durMs, 1200); // 中文不吃 rate
  assert.equal(timeline.segments[1].startMs, 1200);
  assert.equal(timeline.segments[1].durMs, teacherEffMs);
  assert.equal(timeline.totalMs, 1200 + (teacherEffMs + gapMs) * 2);
});

test('findLockPosition maps a playback position to the current card and segment', () => {
  const entries = [
    {
      cardIndex: 5,
      startMs: 0,
      totalMs: 4000,
      timeline: [
        { phase: 'meaning', startMs: 0, durMs: 1000 },
        { phase: 'teacher', rep: 0, startMs: 1000, durMs: 1000 },
        { phase: 'repeat', rep: 0, startMs: 2000, durMs: 2000 },
      ],
    },
    {
      cardIndex: 6,
      startMs: 4000,
      totalMs: 3000,
      timeline: [
        { phase: 'teacher', rep: 0, startMs: 4000, durMs: 1000 },
        { phase: 'repeat', rep: 0, startMs: 5000, durMs: 2000 },
      ],
    },
  ];

  assert.equal(findLockPosition(entries, 0).entry.cardIndex, 5);
  assert.equal(findLockPosition(entries, 0).segment.phase, 'meaning');
  assert.equal(findLockPosition(entries, 1500).segment.phase, 'teacher');
  assert.equal(findLockPosition(entries, 4200).entryIndex, 1);
  assert.equal(findLockPosition(entries, 4200).segment.phase, 'teacher');
  assert.equal(findLockPosition(entries, 99999).entryIndex, 1); // 超過結尾停在最後一段
  assert.equal(findLockPosition(entries, 99999).segment.phase, 'repeat');
  assert.equal(findLockPosition([], 0), null);
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
