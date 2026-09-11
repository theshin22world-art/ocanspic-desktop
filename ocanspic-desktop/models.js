/* ===== 음성 모델 관리 — 최초 1회 내려받아 userData/models 에 둔다 =====
   업스트림(k2-fsa/sherpa-onnx 릴리스)에서 직접 받는다. 나중에 자체 호스팅으로 바꾸려면 PACKS 의 url 만 바꾸면 된다. */
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const tar = require('tar');
const bz2 = require('unbzip2-stream');

const PACKS = [
  { id: 'vad', name: '말소리 감지 (Silero VAD)', url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx', size: 643854, kind: 'file', out: 'silero_vad.onnx', check: ['silero_vad.onnx'] },
  { id: 'asr', name: '음성 인식 (Whisper base.en)', url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-base.en.tar.bz2', size: 208576005, kind: 'tar.bz2',
    check: ['sherpa-onnx-whisper-base.en/base.en-encoder.int8.onnx', 'sherpa-onnx-whisper-base.en/base.en-decoder.int8.onnx', 'sherpa-onnx-whisper-base.en/base.en-tokens.txt'],
    keep: /base\.en-(encoder|decoder)\.int8\.onnx$|base\.en-tokens\.txt$/ },     // fp32 는 안 푼다 (200MB 절약)
  { id: 'tts', name: '영어 음성 (Kokoro)', url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-en-v0_19.tar.bz2', size: 319625534, kind: 'tar.bz2',
    check: ['kokoro-en-v0_19/model.onnx', 'kokoro-en-v0_19/voices.bin', 'kokoro-en-v0_19/tokens.txt', 'kokoro-en-v0_19/espeak-ng-data/phontab'] }
];

function paths(dir) {
  return {
    dir,
    vad: path.join(dir, 'silero_vad.onnx'),
    whisper: path.join(dir, 'sherpa-onnx-whisper-base.en'),
    kokoro: path.join(dir, 'kokoro-en-v0_19')
  };
}

function isReady(dir, pack) { return pack.check.every(f => fs.existsSync(path.join(dir, f))); }
function status(dir) {
  const missing = PACKS.filter(p => !isReady(dir, p));
  return { ready: missing.length === 0, missing: missing.map(p => ({ id: p.id, name: p.name, size: p.size })), totalBytes: missing.reduce((a, p) => a + p.size, 0) };
}

/* 리다이렉트 따라가며 스트림으로 받기 */
function fetchStream(url, onResp, depth) {
  depth = depth || 0;
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'OCansPic-Desktop' } }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && depth < 6) {
        res.resume();
        return fetchStream(new URL(res.headers.location, url).toString(), onResp, depth + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode + ' for ' + url)); }
      onResp(res, resolve, reject);
    });
    req.on('error', reject);
  });
}

/**
 * 빠진 팩을 순서대로 받는다. onProgress({id, name, received, total, phase, overall}) — phase: 'download' | 'extract'
 */
async function ensure(dir, onProgress, signal) {
  fs.mkdirSync(dir, { recursive: true });
  const st = status(dir);
  const total = st.totalBytes || 1;
  let doneBytes = 0;
  for (const pack of PACKS) {
    if (isReady(dir, pack)) continue;
    if (signal && signal.aborted) throw new Error('aborted');
    const tmp = path.join(dir, pack.id + '.part');
    let received = 0;
    const report = (phase) => onProgress && onProgress({ id: pack.id, name: pack.name, received, total: pack.size, phase, overall: Math.min(1, (doneBytes + received) / total) });
    await fetchStream(pack.url, (res, resolve, reject) => {
      res.on('data', c => { received += c.length; report('download'); });
      res.on('error', reject);
      if (signal) signal.addEventListener('abort', () => { res.destroy(new Error('aborted')); });
      let sink;
      if (pack.kind === 'file') {
        sink = fs.createWriteStream(tmp);
        sink.on('finish', () => { fs.renameSync(tmp, path.join(dir, pack.out)); resolve(); });
        sink.on('error', reject);
        res.pipe(sink);
      } else {
        // tar.bz2 → 스트리밍 해제 (디스크에 압축 파일을 남기지 않는다)
        const extract = tar.x({ cwd: dir, filter: (p) => !pack.keep || pack.keep.test(p) || /\/$/.test(p) });
        extract.on('finish', resolve); extract.on('close', resolve); extract.on('error', reject);
        const un = bz2(); un.on('error', reject);
        res.pipe(un).pipe(extract);
      }
    });
    if (!isReady(dir, pack)) throw new Error(pack.name + ' 파일이 완전하지 않습니다. 다시 시도해 주세요.');
    doneBytes += pack.size;
    report('done');
  }
  return status(dir);
}

module.exports = { PACKS, paths, status, ensure };
