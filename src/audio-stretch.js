/* 泰文老師語音變速時保留音高（WSOLA time-stretch），只套在泰文；
   中文提示完全不碰。底層用 vendor 進來的 soundtouchjs 核心 class（不是它的
   PitchShifter 即時播放包裝），同步、離線跑完就回傳一個新的 AudioBuffer。
   只設 SoundTouch.tempo（不設 .rate/.pitch）＝只走 pitch-preserving 的
   Stretch(WSOLA) pipe，不會經過會變音高的 RateTransposer pipe。 */

import { SimpleFilter, SoundTouch, WebAudioBufferSource } from './vendor/soundtouch.js';

const CHUNK_FRAMES = 4096; // 語音短片段夠用，不需要更大的批次

// vendor/soundtouch.js 的 FilterSupport.fillOutputBuffer() 每次都要求輸入 FIFO
// 先補到滿滿 8192*2=16384 frames 才會呼叫 pipe.process()；補不滿（接近來源尾端時）
// 就直接 break，尾巴那段還沒處理的真實音訊會被整段丟掉（實測過：短片段輸出長度
// 對不上任何合理的變速比例）。這裡在來源後面墊一段靜音，確保每次補值都補得滿，
// 尾音才會真的被吃進 WSOLA 處理；輸出再依原始（未加墊）長度換算回真正要的長度，
// 墊出來那段直接截掉。
const PAD_FRAMES = 32768;

export function stretchAudioBuffer(audioBuffer, tempo) {
  if (!tempo || tempo === 1) return audioBuffer;

  const numChannels = audioBuffer.numberOfChannels;
  const inputFrames = audioBuffer.length;
  const padded = new AudioBuffer({
    numberOfChannels: numChannels,
    length: inputFrames + PAD_FRAMES,
    sampleRate: audioBuffer.sampleRate,
  });
  for (let c = 0; c < numChannels; c++) {
    padded.copyToChannel(audioBuffer.getChannelData(c), c, 0);
    // 墊的那段維持 AudioBuffer 預設的 0（靜音），不用另外寫。
  }

  const source = new WebAudioBufferSource(padded);
  const soundtouch = new SoundTouch();
  soundtouch.tempo = tempo;
  soundtouch.stretch.setParameters(audioBuffer.sampleRate, 0, 0, 8);
  const filter = new SimpleFilter(source, soundtouch);

  const chunks = [];
  let totalFrames = 0;
  const pullBuf = new Float32Array(CHUNK_FRAMES * 2);
  for (;;) {
    const framesExtracted = filter.extract(pullBuf, CHUNK_FRAMES);
    if (framesExtracted <= 0) break;
    chunks.push(pullBuf.slice(0, framesExtracted * 2));
    totalFrames += framesExtracted;
  }

  // 真正要的長度：原始（未加墊）長度依 tempo 換算，墊出來的靜音／過渡段直接截掉。
  const targetFrames = Math.max(1, Math.min(totalFrames, Math.round(inputFrames / tempo)));

  const out = new AudioBuffer({
    numberOfChannels: numChannels,
    length: targetFrames,
    sampleRate: audioBuffer.sampleRate,
  });
  const chL = out.getChannelData(0);
  const chR = numChannels > 1 ? out.getChannelData(1) : null;
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= targetFrames) break;
    const frames = Math.min(chunk.length / 2, targetFrames - offset);
    for (let i = 0; i < frames; i++) {
      chL[offset + i] = chunk[i * 2];
      if (chR) chR[offset + i] = chunk[i * 2 + 1];
    }
    offset += frames;
  }
  return out;
}
