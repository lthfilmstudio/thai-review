import {
  buildStaticAudioMap,
  computeThaiOnlyTimeline,
  planLockListenSession,
} from './listen-static.js';

let audioMapPromise = null;

function encodeWav(buffer) {
  const data = buffer.getChannelData(0);
  const dataSize = data.length * 2;
  const out = new ArrayBuffer(44 + dataSize);
  const view = new DataView(out);
  const writeStr = (off, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i));
  };
  writeStr(0, 'RIFF'); view.setUint32(4, 36 + dataSize, true); writeStr(8, 'WAVE');
  writeStr(12, 'fmt '); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, buffer.sampleRate, true); view.setUint32(28, buffer.sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  writeStr(36, 'data'); view.setUint32(40, dataSize, true);
  for (let i = 0; i < data.length; i++) {
    const s = Math.max(-1, Math.min(1, data[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 32768 : s * 32767, true);
  }
  return new Blob([out], { type: 'audio/wav' });
}

async function loadStaticAudioMap() {
  if (!audioMapPromise) {
    audioMapPromise = fetch('audio-manifest.json', { cache: 'no-store' })
      .then(res => {
        if (!res.ok) throw new Error(`audio manifest HTTP ${res.status}`);
        return res.json();
      })
      .then(manifest => buildStaticAudioMap(manifest, location.href));
  }
  return audioMapPromise;
}

async function fetchAudioBuffer(ctx, url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`audio HTTP ${res.status}`);
  return await ctx.decodeAudioData(await res.arrayBuffer());
}

export async function prepareLockListenSession(cards, options) {
  const audioMap = await loadStaticAudioMap();
  const plan = planLockListenSession(cards, audioMap, {
    startIndex: options.startIndex,
    limit: options.limit,
  });
  if (!plan.items.length) throw new Error('沒有可用的 ElevenLabs 靜態音檔');
  if (plan.missing.length) {
    const first = plan.missing[0];
    throw new Error(`第 ${first.index + 1} 張找不到 ElevenLabs 靜態音檔`);
  }

  const decodeCtx = new (window.AudioContext || window.webkitAudioContext)();
  try {
    const decoded = [];
    for (const item of plan.items) {
      decoded.push({ item, buffer: await fetchAudioBuffer(decodeCtx, item.audioUrl) });
    }

    let totalMs = 0;
    const entries = decoded.map(({ item, buffer }) => {
      const timeline = computeThaiOnlyTimeline(buffer.duration * 1000, options);
      const startMs = totalMs;
      totalMs += timeline.totalMs;
      return {
        cardIndex: item.index,
        startMs,
        totalMs: timeline.totalMs,
        timeline: timeline.segments.map(seg => ({ ...seg, startMs: startMs + seg.startMs })),
        buffer,
      };
    });

    const sampleRate = 24000;
    const offline = new OfflineAudioContext(1, Math.ceil(totalMs / 1000 * sampleRate), sampleRate);
    entries.forEach(entry => {
      entry.timeline.forEach(seg => {
        if (seg.phase !== 'teacher') return;
        const src = offline.createBufferSource();
        src.buffer = entry.buffer;
        src.playbackRate.value = options.rate;
        src.connect(offline.destination);
        src.start(seg.startMs / 1000);
      });
    });

    const keepAlive = offline.createOscillator();
    keepAlive.frequency.value = 40;
    const keepAliveGain = offline.createGain();
    keepAliveGain.gain.value = 0.05;
    keepAlive.connect(keepAliveGain).connect(offline.destination);
    keepAlive.start(0);

    const rendered = await offline.startRendering();
    return {
      url: URL.createObjectURL(encodeWav(rendered)),
      totalMs,
      count: plan.items.length,
      nextIndex: plan.nextIndex >= cards.length ? 0 : plan.nextIndex,
      entries: entries.map(({ buffer, ...entry }) => entry),
    };
  } finally {
    await decodeCtx.close().catch(() => {});
  }
}
