/* 鎖屏長音檔拼裝：把一批卡的「中文提示 + (泰文 + 跟讀空白) × N」
   離線拼成一條十幾分鐘的 WAV 一次播，鎖屏中完全不換音檔。
   泰文只用 baked ElevenLabs MP3；中文走 worker TTS（準備一定在前景，
   大多命中 KV cache），抓不到就該卡略過中文、不擋整批。 */

import {
  buildStaticAudioMap,
  computeLockTimeline,
  planLockListenSession,
} from './listen-static.js';
import {
  CHINESE_VOICE,
  encodeWav,
  fetchAudioBuffer,
  fetchWorkerTtsBlob,
} from './tts.js';

let audioMapPromise = null;

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

/* 抓一張卡的素材：泰文 MP3（必要）＋中文 worker TTS（可缺）。 */
async function fetchCardBuffers(item) {
  const thaiBuf = await fetchAudioBuffer(item.audioUrl);
  let zhBuf = null;
  const zhText = (item.card?.zh || '').trim();
  if (zhText) {
    try {
      const zhUrl = await fetchWorkerTtsBlob(zhText, CHINESE_VOICE);
      if (zhUrl) zhBuf = await fetchAudioBuffer(zhUrl);
    } catch {} // 中文抓不到就略過，不擋整批
  }
  return { item, thaiBuf, zhBuf };
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

  const decoded = new Array(plan.items.length);
  let fetched = 0;
  const CONCURRENCY = 3;
  for (let i = 0; i < plan.items.length; i += CONCURRENCY) {
    await Promise.all(plan.items.slice(i, i + CONCURRENCY).map(async (item, offset) => {
      decoded[i + offset] = await fetchCardBuffers(item);
      fetched++;
      options.onProgress?.(fetched, plan.items.length);
    }));
  }

  let totalMs = 0;
  const entries = decoded.map(({ item, thaiBuf, zhBuf }) => {
    const timeline = computeLockTimeline(
      (zhBuf?.duration || 0) * 1000,
      thaiBuf.duration * 1000,
      options,
    );
    const startMs = totalMs;
    totalMs += timeline.totalMs;
    return {
      cardIndex: item.index,
      startMs,
      totalMs: timeline.totalMs,
      timeline: timeline.segments.map(seg => ({ ...seg, startMs: startMs + seg.startMs })),
      thaiBuf,
      zhBuf,
    };
  });

  const sampleRate = 24000;
  const offline = new OfflineAudioContext(1, Math.ceil(totalMs / 1000 * sampleRate), sampleRate);
  entries.forEach(entry => {
    entry.timeline.forEach(seg => {
      if (seg.phase === 'repeat') return; // 空白＝不排語音，靠底線訊號保持「有聲」
      const src = offline.createBufferSource();
      src.buffer = seg.phase === 'meaning' ? entry.zhBuf : entry.thaiBuf;
      if (seg.phase === 'teacher') src.playbackRate.value = options.rate;
      src.connect(offline.destination);
      src.start(seg.startMs / 1000);
    });
  });

  // 40Hz / -26dBFS 保命底線：連續 >5 秒純靜音會讓 Chrome 收回媒體身分（v54 實測）
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
    startIndex: plan.startIndex,
    nextIndex: plan.nextIndex >= cards.length ? 0 : plan.nextIndex,
    resumeMs: 0,
    entries: entries.map(({ thaiBuf, zhBuf, ...entry }) => entry),
  };
}
