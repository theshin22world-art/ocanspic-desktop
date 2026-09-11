/* ===== 음성 엔진 (별도 유틸리티 프로세스) — Kokoro TTS · Whisper ASR · Silero VAD =====
   UI 프로세스를 막지 않도록 여기서만 모델을 돌린다. 메시지로 요청/응답. */
'use strict';
const path = require('path');
const sherpa = require('sherpa-onnx-node');

const port = process.parentPort || null;                       // Electron utilityProcess
const send = (m) => { if (port) port.postMessage(m); else if (process.send) process.send(m); else if (module.exports.onMessage) module.exports.onMessage(m); };

let tts = null, rec = null, vadModel = null, P = null;
const THREADS = Math.max(1, Math.min(4, (require('os').cpus().length || 2) - 1));

function init(dir) {
  P = {
    vad: path.join(dir, 'silero_vad.onnx'),
    whisper: path.join(dir, 'sherpa-onnx-whisper-base.en'),
    kokoro: path.join(dir, 'kokoro-en-v0_19')
  };
  const t0 = Date.now();
  tts = new sherpa.OfflineTts({ model: { kokoro: { model: path.join(P.kokoro, 'model.onnx'), voices: path.join(P.kokoro, 'voices.bin'), tokens: path.join(P.kokoro, 'tokens.txt'), dataDir: path.join(P.kokoro, 'espeak-ng-data') }, numThreads: THREADS, debug: 0 }, maxNumSentences: 1 });
  rec = new sherpa.OfflineRecognizer({ modelConfig: { whisper: { encoder: path.join(P.whisper, 'base.en-encoder.int8.onnx'), decoder: path.join(P.whisper, 'base.en-decoder.int8.onnx'), language: 'en', task: 'transcribe', tailPaddings: 1500 }, tokens: path.join(P.whisper, 'base.en-tokens.txt'), numThreads: THREADS, debug: 0 } });
  vadModel = P.vad;
  send({ type: 'ready', ms: Date.now() - t0, speakers: tts.numSpeakers, sampleRate: tts.sampleRate });
}

/* ---------- TTS ---------- */
const ttsCache = new Map();   // text|sid|speed → {samples, sampleRate}
function doTts(m) {
  try {
    const key = m.text + '|' + (m.sid | 0) + '|' + (m.speed || 1);
    let a = ttsCache.get(key);
    if (!a) {
      const g = tts.generate({ text: m.text, sid: m.sid | 0, speed: m.speed || 1.0, enableExternalBuffer: false });   // Electron 은 external buffer 금지
      // Electron utilityProcess 는 ArrayBuffer 전송을 막는다 → 16bit PCM 을 base64 문자열로 보낸다
      const n = g.samples.length, i16 = Buffer.alloc(n * 2);
      for (let i = 0; i < n; i++) { let v = g.samples[i]; v = v > 1 ? 1 : (v < -1 ? -1 : v); i16.writeInt16LE((v * 32767) | 0, i * 2); }
      a = { pcm16: i16.toString('base64'), sampleRate: g.sampleRate, n };
      if (ttsCache.size > 200) ttsCache.delete(ttsCache.keys().next().value);
      ttsCache.set(key, a);
    }
    send({ type: 'tts', id: m.id, sampleRate: a.sampleRate, pcm16: a.pcm16, n: a.n });
  } catch (e) { send({ type: 'tts', id: m.id, error: String(e && e.message || e) }); }
}

/* ---------- ASR 세션 (VAD 로 자르고 조각마다 디코드) ---------- */
const sessions = new Map();
function sttStart(m) {
  const vad = new sherpa.Vad({ sileroVad: { model: vadModel, threshold: 0.5, minSilenceDuration: 0.55, minSpeechDuration: 0.25, maxSpeechDuration: 25, windowSize: 512 }, sampleRate: 16000, numThreads: 1, debug: 0 }, 90);
  sessions.set(m.sid, { vad, speaking: false, carry: new Float32Array(0) });
  send({ type: 'stt-started', sid: m.sid });
}
function decodeSeg(sid, samples) {
  const st = rec.createStream();
  st.acceptWaveform({ samples, sampleRate: 16000 });
  rec.decode(st);
  const r = rec.getResult(st);
  let text = (r.text || '').trim();
  // Whisper 가 무음에서 내는 환청 제거
  if (/^[\s.,!?\-–—…]*$/.test(text) || /^\(?\s*(music|silence|blank[_ ]audio|inaudible|applause|laughter)\s*\)?\.?$/i.test(text)) text = '';
  send({ type: 'stt-result', sid, text, final: true, dur: samples.length / 16000 });
}
function drain(s, sid) {
  while (!s.vad.isEmpty()) { const seg = s.vad.front(false); decodeSeg(sid, seg.samples); s.vad.pop(); }
}
function sttPush(m) {
  const s = sessions.get(m.sid); if (!s) return;
  const pcm = m.pcm instanceof Float32Array ? m.pcm : new Float32Array(m.pcm.buffer, m.pcm.byteOffset, m.pcm.byteLength / 4);
  // 512 샘플 단위로 VAD 에 공급
  let buf = s.carry.length ? concat(s.carry, pcm) : pcm;
  let i = 0;
  for (; i + 512 <= buf.length; i += 512) s.vad.acceptWaveform(buf.subarray(i, i + 512));
  s.carry = buf.subarray(i).slice();
  const sp = s.vad.isDetected();
  if (sp !== s.speaking) { s.speaking = sp; send({ type: 'stt-speech', sid: m.sid, speaking: sp }); }
  drain(s, m.sid);
}
function sttStop(m) {
  const s = sessions.get(m.sid); if (!s) return;
  try { if (s.carry.length) { const pad = new Float32Array(512); pad.set(s.carry.subarray(0, 512)); s.vad.acceptWaveform(pad); } s.vad.flush(); drain(s, m.sid); } catch (e) {}
  sessions.delete(m.sid);
  send({ type: 'stt-ended', sid: m.sid });
}
function concat(a, b) { const o = new Float32Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; }

function onMessage(m) {
  try {
    switch (m.type) {
      case 'init': return init(m.dir);
      case 'tts': return doTts(m);
      case 'stt-start': return sttStart(m);
      case 'stt-push': return sttPush(m);
      case 'stt-stop': return sttStop(m);
      case 'stt-abort': sessions.delete(m.sid); return send({ type: 'stt-ended', sid: m.sid });
    }
  } catch (e) { send({ type: 'error', error: String(e && e.stack || e), at: m && m.type }); }
}
if (port) port.on('message', (e) => onMessage(e.data));
else if (process.send) process.on('message', onMessage);
module.exports = { onMessage: null, handle: onMessage };
